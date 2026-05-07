import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parse as parseJsonc } from 'jsonc-parser';
import { INITIAL, parseRawGrammar, Registry, type IGrammar, type IRawGrammar, type IRawTheme, type StateStack } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

type ColorRangeMap = Record<string, InjectedCommentLine[]>;

interface BracketColorization {
	colors: readonly string[];
	enabled: boolean;
}

export interface InjectedCommentLine {
	line: number;
	start: number;
	end: number;
	text: string;
}

export interface InjectedCommentRegion {
	language: string;
	lines: InjectedCommentLine[];
}

interface GrammarContribution {
	scopeName?: string;
	path?: string;
	language?: string;
}

interface LanguageContribution {
	id?: string;
	aliases?: string[];
}

interface PackageJsonWithGrammarContributions {
	contributes?: {
		grammars?: GrammarContribution[];
		languages?: LanguageContribution[];
		themes?: ThemeContribution[];
	};
}

interface ThemeContribution {
	id?: string;
	label?: string;
	path?: string;
}

interface ThemeFile {
	colors?: Record<string, string>;
	include?: string;
	settings?: IRawTheme['settings'];
	tokenColors?: IRawTheme['settings'] | string;
}

interface ThemeData {
	colors: Record<string, string>;
	settings: IRawTheme['settings'];
}

const languageScopeAliases = new Map<string, string>([
	['md', 'text.html.markdown'],
	['markdown', 'text.html.markdown'],
	['json', 'source.json'],
	['xml', 'text.xml'],
	['html', 'text.html.derivative'],
	['htm', 'text.html.derivative'],
	['xhtml', 'text.html.derivative'],
	['css', 'source.css'],
	['js', 'source.js'],
	['javascript', 'source.js'],
	['py', 'source.python'],
	['python', 'source.python'],
	['c', 'source.c'],
	['cpp', 'source.cpp'],
	['c++', 'source.cpp'],
	['cc', 'source.cpp'],
	['cxx', 'source.cpp'],
	['cmd', 'source.batchfile'],
	['bat', 'source.batchfile'],
	['batch', 'source.batchfile'],
	['bash', 'source.shell'],
	['sh', 'source.shell'],
	['shell', 'source.shell'],
	['shellscript', 'source.shell'],
	['zsh', 'source.shell'],
	['fish', 'source.shell'],
	['ksh', 'source.shell'],
	['csh', 'source.shell'],
	['ps1', 'source.powershell'],
	['ps', 'source.powershell'],
	['powershell', 'source.powershell'],
	['pwsh', 'source.powershell'],
	['csv', 'text.csv'],
	['env', 'source.dotenv'],
	['dotenv', 'source.dotenv'],
	['dot', 'source.dot'],
	['graphviz', 'source.dot'],
	['yaml', 'source.yaml'],
	['yml', 'source.yaml'],
	['ini', 'source.ini'],
	['cfg', 'source.ini'],
	['config', 'source.ini'],
	['toml', 'source.toml'],
	['ts', 'source.ts'],
	['typescript', 'source.ts'],
	['tex', 'text.tex.latex'],
	['latex', 'text.tex.latex'],
	['makefile', 'source.makefile'],
	['make', 'source.makefile'],
	['mk', 'source.makefile'],
]);

const foregroundMask = 0x1ff8000;
const foregroundOffset = 15;
const defaultBracketPairColors = ['#FFD700', '#DA70D6', '#179FFF', '#FFD700', '#DA70D6', '#179FFF'] as const;
const openingBrackets = new Set(['(', '[', '{']);
const closingBrackets = new Set([')', ']', '}']);

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(new SemanticCommentOverlay(new TextMateGrammarTokenizer()));
}

export function deactivate(): void {}

export function collectInjectedCommentRegions(text: string): InjectedCommentRegion[] {
	const regions: InjectedCommentRegion[] = [];
	const lines = text.split(/\r?\n/);
	let blockRegion: InjectedCommentRegion | undefined;

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber];

		if (!blockRegion) {
			const lineComment = /^(?<prefix>\s*\/\/+\s*)language=(?<language>[a-zA-Z0-9_+#.-]+)\b(?<rest>.*)$/.exec(line);
			if (lineComment?.groups) {
				const region: InjectedCommentRegion = { language: lineComment.groups.language, lines: [] };
				const restStart = line.length - lineComment.groups.rest.length;
				const contentStart = restStart + countLeadingWhitespace(line.slice(restStart));

				if (contentStart < line.length) {
					pushInjectedLine(region, line, lineNumber, contentStart, line.length);
				} else {
					lineNumber = collectLineCommentBlock(lines, lineNumber + 1, region) - 1;
				}

				if (region.lines.length > 0) {
					regions.push(region);
				}
				continue;
			}
		}

		let cursor = 0;
		while (cursor < line.length) {
			if (!blockRegion) {
				const blockStart = line.indexOf('/*', cursor);
				if (blockStart === -1) {
					break;
				}

				cursor = blockStart + 2;
			}

			const blockEnd = line.indexOf('*/', cursor);
			const segmentEnd = blockEnd === -1 ? line.length : blockEnd;

			if (!blockRegion) {
				const segment = line.slice(cursor, segmentEnd);
				const blockTag = /language=(?<language>[a-zA-Z0-9_+#.-]+)\b(?<rest>.*)$/.exec(segment);
				if (blockTag?.groups) {
					blockRegion = { language: blockTag.groups.language, lines: [] };
					const restStart = cursor + segment.length - blockTag.groups.rest.length;
					const contentStart = restStart + countLeadingWhitespace(line.slice(restStart, segmentEnd));
					pushInjectedLine(blockRegion, line, lineNumber, contentStart, segmentEnd);
				}
			} else {
				const contentStart = skipBlockCommentLinePrefix(line, cursor, segmentEnd);
				pushInjectedLine(blockRegion, line, lineNumber, contentStart, segmentEnd);
			}

			if (blockEnd === -1) {
				break;
			}

			if (blockRegion && blockRegion.lines.length > 0) {
				regions.push(blockRegion);
			}
			blockRegion = undefined;
			cursor = blockEnd + 2;
		}
	}

	return regions;
}

export async function collectInjectedCommentHighlights(
	text: string,
	tokenizer = new TextMateGrammarTokenizer(),
): Promise<ColorRangeMap> {
	const rangesByColor: ColorRangeMap = {};

	for (const region of collectInjectedCommentRegions(text)) {
		const tokenizedLines = await tokenizer.tokenize(region);
		for (const [color, lines] of Object.entries(tokenizedLines)) {
			rangesByColor[color] ??= [];
			rangesByColor[color].push(...lines);
		}
	}

	return rangesByColor;
}

class SemanticCommentOverlay implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[];
	private readonly decorationStore = new ColorDecorationStore();
	private readonly semanticRetryCounts = new WeakMap<vscode.TextEditor, number>();
	private readonly semanticRetryTimers = new Set<NodeJS.Timeout>();
	private readonly updateSequences = new WeakMap<vscode.TextEditor, number>();

	public constructor(private readonly tokenizer: TextMateGrammarTokenizer) {
		this.disposables = [
			vscode.window.onDidChangeVisibleTextEditors((editors) => {
				for (const editor of editors) {
					void this.updateEditor(editor);
				}
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					void this.updateEditor(editor);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				for (const editor of vscode.window.visibleTextEditors) {
					if (editor.document === event.document) {
						void this.updateEditor(editor);
					}
				}
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('commentLanguageInjection.semanticOverlay.enabled') ||
					event.affectsConfiguration('commentLanguageInjection.alSemanticOverlay.enabled') ||
					event.affectsConfiguration('editor.semanticHighlighting.enabled') ||
					event.affectsConfiguration('workbench.colorTheme') ||
					event.affectsConfiguration('workbench.colorCustomizations') ||
					event.affectsConfiguration('editor.tokenColorCustomizations') ||
					event.affectsConfiguration('editor.bracketPairColorization.enabled')
				) {
					this.tokenizer.invalidateTheme();
					this.updateVisibleEditors();
				}
			}),
			this.tokenizer,
			this.decorationStore,
		];
		this.updateVisibleEditors();
	}

	public dispose(): void {
		for (const timer of this.semanticRetryTimers) {
			clearTimeout(timer);
		}
		this.semanticRetryTimers.clear();

		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private updateVisibleEditors(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			void this.updateEditor(editor);
		}
	}

	private async updateEditor(editor: vscode.TextEditor): Promise<void> {
		const sequence = (this.updateSequences.get(editor) ?? 0) + 1;
		this.updateSequences.set(editor, sequence);
		const documentVersion = editor.document.version;
		let rangesByColor: ColorRangeMap = {};
		const injectedRegions = collectInjectedCommentRegions(editor.document.getText());

		if (injectedRegions.length > 0 && await shouldUseSemanticOverlay(editor.document)) {
			this.semanticRetryCounts.delete(editor);
			rangesByColor = await collectInjectedCommentHighlights(editor.document.getText(), this.tokenizer);
		} else if (injectedRegions.length > 0 && isSemanticOverlayEnabled(editor.document)) {
			this.scheduleSemanticRetry(editor);
		}

		if (this.updateSequences.get(editor) !== sequence || editor.document.version !== documentVersion) {
			return;
		}

		for (const [color, decoration] of this.decorationStore.getDecorations(rangesByColor)) {
			editor.setDecorations(
				decoration,
				(rangesByColor[color] ?? []).map((range) => new vscode.Range(range.line, range.start, range.line, range.end)),
			);
		}
	}

	private scheduleSemanticRetry(editor: vscode.TextEditor): void {
		const retryCount = this.semanticRetryCounts.get(editor) ?? 0;
		if (retryCount >= 4) {
			return;
		}

		this.semanticRetryCounts.set(editor, retryCount + 1);
		const timer = setTimeout(() => {
			this.semanticRetryTimers.delete(timer);
			if (vscode.window.visibleTextEditors.includes(editor)) {
				void this.updateEditor(editor);
			}
		}, 750 * (retryCount + 1));
		this.semanticRetryTimers.add(timer);
	}
}

class ColorDecorationStore implements vscode.Disposable {
	private readonly decorationsByColor = new Map<string, vscode.TextEditorDecorationType>();

	public getDecorations(rangesByColor: ColorRangeMap): Array<[string, vscode.TextEditorDecorationType]> {
		for (const color of Object.keys(rangesByColor)) {
			if (!this.decorationsByColor.has(color)) {
				this.decorationsByColor.set(color, vscode.window.createTextEditorDecorationType({ color }));
			}
		}

		return [...this.decorationsByColor.entries()];
	}

	public dispose(): void {
		for (const decoration of this.decorationsByColor.values()) {
			decoration.dispose();
		}
		this.decorationsByColor.clear();
	}
}

class TextMateGrammarTokenizer implements vscode.Disposable {
	private readonly grammarPathsByScope = new Map<string, string>();
	private readonly scopeByLanguage = new Map(languageScopeAliases);
	private bracketColorization: BracketColorization = { colors: defaultBracketPairColors, enabled: true };
	private registry: Registry | undefined;
	private initialization: Promise<void> | undefined;
	private appliedThemeFingerprint: string | undefined;

	public async tokenize(region: InjectedCommentRegion): Promise<ColorRangeMap> {
		await this.initialize();
		this.applyActiveTheme();

		const scopeName = this.scopeByLanguage.get(region.language.toLowerCase());
		const grammar = scopeName ? await this.registry?.loadGrammar(scopeName) : undefined;
		if (!grammar) {
			return {};
		}

		return tokenizeRegionWithGrammar(region, grammar, this.registry?.getColorMap() ?? [], this.bracketColorization);
	}

	public dispose(): void {}

	public invalidateTheme(): void {
		this.appliedThemeFingerprint = undefined;
	}

	private async initialize(): Promise<void> {
		this.initialization ??= this.createRegistry();
		await this.initialization;
	}

	private async createRegistry(): Promise<void> {
		await loadWASM(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')).buffer);
		this.collectGrammarContributions();

		this.registry = new Registry({
			onigLib: Promise.resolve({
				createOnigScanner: (sources) => new OnigScanner(sources),
				createOnigString: (content) => new OnigString(content),
			}),
			loadGrammar: async (scopeName) => {
				const grammarPath = this.grammarPathsByScope.get(scopeName);
				if (!grammarPath) {
					return null;
				}

				return parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath);
			},
		});
	}

	private applyActiveTheme(): void {
		const themeName = vscode.workspace.getConfiguration('workbench').get('colorTheme', '');
		const editorConfiguration = vscode.workspace.getConfiguration('editor');
		const tokenCustomizations = editorConfiguration.get('tokenColorCustomizations', {});
		const bracketPairColorizationEnabled = editorConfiguration.get('bracketPairColorization.enabled', true);
		const colorCustomizations = vscode.workspace.getConfiguration('workbench').get('colorCustomizations', {});
		const fingerprint = `${themeName}\n${JSON.stringify(tokenCustomizations)}\n${JSON.stringify(colorCustomizations)}\n${bracketPairColorizationEnabled}`;

		if (!this.registry || this.appliedThemeFingerprint === fingerprint) {
			return;
		}

		this.registry.setTheme({
			name: themeName,
			settings: this.loadActiveThemeSettings(themeName, tokenCustomizations, colorCustomizations, bracketPairColorizationEnabled),
		});
		this.appliedThemeFingerprint = fingerprint;
	}

	private loadActiveThemeSettings(
		themeName: string,
		tokenCustomizations: unknown,
		colorCustomizations: unknown,
		bracketPairColorizationEnabled: unknown,
	): IRawTheme['settings'] {
		let themeData: ThemeData = { colors: {}, settings: [] };

		for (const extension of vscode.extensions.all) {
			const packageJson = extension.packageJSON as PackageJsonWithGrammarContributions;
			const theme = packageJson.contributes?.themes?.find((candidate) => candidate.id === themeName || candidate.label === themeName);
			if (theme?.path) {
				themeData = this.loadThemeFile(path.join(extension.extensionPath, theme.path), new Set<string>());
				break;
			}
		}

		const colors = {
			...themeData.colors,
			...extractColorCustomizationRules(colorCustomizations, themeName),
		};
		const settings: IRawTheme['settings'] = [...themeData.settings];
		if (colors['editor.foreground']) {
			settings.push({ settings: { foreground: colors['editor.foreground'] } });
		}
		this.bracketColorization = {
			colors: collectBracketPairColors(colors),
			enabled: bracketPairColorizationEnabled !== false,
		};

		settings.push(...extractTextMateCustomizationRules(tokenCustomizations, themeName));
		return settings;
	}

	private loadThemeFile(themePath: string, seen: Set<string>): ThemeData {
		const normalizedPath = path.normalize(themePath);
		if (seen.has(normalizedPath) || !fs.existsSync(normalizedPath)) {
			return { colors: {}, settings: [] };
		}
		seen.add(normalizedPath);

		const themeFile = parseJsonc(fs.readFileSync(normalizedPath, 'utf8')) as ThemeFile;
		const data: ThemeData = { colors: {}, settings: [] };

		if (themeFile.include) {
			const includedData = this.loadThemeFile(path.resolve(path.dirname(normalizedPath), themeFile.include), seen);
			data.colors = { ...data.colors, ...includedData.colors };
			data.settings.push(...includedData.settings);
		}

		if (themeFile.colors) {
			data.colors = { ...data.colors, ...themeFile.colors };
		}

		if (Array.isArray(themeFile.settings)) {
			data.settings.push(...themeFile.settings);
		}

		if (typeof themeFile.tokenColors === 'string') {
			const tokenColorsPath = path.resolve(path.dirname(normalizedPath), themeFile.tokenColors);
			if (tokenColorsPath.endsWith('.json')) {
				const tokenColorData = this.loadThemeFile(tokenColorsPath, seen);
				data.colors = { ...data.colors, ...tokenColorData.colors };
				data.settings.push(...tokenColorData.settings);
			}
		} else if (Array.isArray(themeFile.tokenColors)) {
			data.settings.push(...themeFile.tokenColors);
		}

		return data;
	}

	private collectGrammarContributions(): void {
		for (const extension of vscode.extensions.all) {
			const packageJson = extension.packageJSON as PackageJsonWithGrammarContributions;

			for (const grammar of packageJson.contributes?.grammars ?? []) {
				if (grammar.scopeName && grammar.path && !this.grammarPathsByScope.has(grammar.scopeName)) {
					this.grammarPathsByScope.set(grammar.scopeName, path.join(extension.extensionPath, grammar.path));
				}
			}

			for (const language of packageJson.contributes?.languages ?? []) {
				if (!language.id) {
					continue;
				}

				const grammar = packageJson.contributes?.grammars?.find((candidate) => candidate.scopeName && candidate.language === language.id);
				if (grammar?.scopeName) {
					this.scopeByLanguage.set(language.id.toLowerCase(), grammar.scopeName);
					for (const alias of language.aliases ?? []) {
						this.scopeByLanguage.set(alias.toLowerCase(), grammar.scopeName);
					}
				}
			}
		}
	}
}

function tokenizeRegionWithGrammar(
	region: InjectedCommentRegion,
	grammar: IGrammar,
	colorMap: readonly string[],
	bracketColorization: BracketColorization,
): ColorRangeMap {
	const rangesByColor: ColorRangeMap = {};
	let ruleStack: StateStack | null = INITIAL;
	let bracketDepth = 0;

	for (const line of region.lines) {
		const tokenizedLine = grammar.tokenizeLine2(line.text, ruleStack);
		ruleStack = tokenizedLine.ruleStack;

		for (let index = 0; index < tokenizedLine.tokens.length; index += 2) {
			const startIndex = tokenizedLine.tokens[index];
			const nextStartIndex = index + 2 < tokenizedLine.tokens.length ? tokenizedLine.tokens[index + 2] : line.text.length;
			const color = getTokenForeground(tokenizedLine.tokens[index + 1], colorMap);

			if (!color) {
				continue;
			}

			const tokenEndIndex = Math.min(nextStartIndex, line.text.length);
			const shouldColorizeBrackets = bracketColorization.enabled && colorsEqual(color, colorMap[1]);
			let plainStartIndex = startIndex;

			if (shouldColorizeBrackets) {
				for (let characterIndex = startIndex; characterIndex < tokenEndIndex; characterIndex++) {
					const character = line.text[characterIndex];
					if (!openingBrackets.has(character) && !closingBrackets.has(character)) {
						continue;
					}

					pushColorRange(rangesByColor, color, line, plainStartIndex, characterIndex);
					if (closingBrackets.has(character)) {
						bracketDepth = Math.max(0, bracketDepth - 1);
					}

					const bracketColor = bracketColorization.colors[bracketDepth % bracketColorization.colors.length] ?? color;
					pushColorRange(rangesByColor, bracketColor, line, characterIndex, characterIndex + 1);
					if (openingBrackets.has(character)) {
						bracketDepth++;
					}
					plainStartIndex = characterIndex + 1;
				}
			}

			pushColorRange(rangesByColor, color, line, plainStartIndex, tokenEndIndex);
		}
	}

	return rangesByColor;
}

function pushColorRange(rangesByColor: ColorRangeMap, color: string, line: InjectedCommentLine, startIndex: number, endIndex: number): void {
	const start = line.start + startIndex;
	const end = line.start + endIndex;
	if (end <= start) {
		return;
	}

	rangesByColor[color] ??= [];
	rangesByColor[color].push({ ...line, start, end });
}

function collectLineCommentBlock(lines: readonly string[], startLine: number, region: InjectedCommentRegion): number {
	let lineNumber = startLine;

	for (; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber];
		const continuation = /^(\s*\/\/+\s?)/.exec(line);
		if (!continuation) {
			break;
		}

		pushInjectedLine(region, line, lineNumber, continuation[0].length, line.length);
	}

	return lineNumber;
}

function pushInjectedLine(region: InjectedCommentRegion, line: string, lineNumber: number, start: number, end: number): void {
	if (end <= start || line.slice(start, end).trim().length === 0) {
		return;
	}

	region.lines.push({
		line: lineNumber,
		start,
		end,
		text: line.slice(start, end),
	});
}

function getTokenForeground(metadata: number, colorMap: readonly string[]): string | undefined {
	const foregroundId = (metadata & foregroundMask) >>> foregroundOffset;
	return colorMap[foregroundId] ?? colorMap[1];
}

function collectBracketPairColors(colors: Record<string, string>): readonly string[] {
	const bracketColors = defaultBracketPairColors.map((defaultColor, index) => {
		return colors[`editorBracketHighlight.foreground${index + 1}`] ?? defaultColor;
	});

	return bracketColors.filter((color) => color.length > 0);
}

function colorsEqual(left: string | undefined, right: string | undefined): boolean {
	return left?.toLowerCase() === right?.toLowerCase();
}

function extractColorCustomizationRules(customizations: unknown, themeName: string): Record<string, string> {
	if (!isRecord(customizations)) {
		return {};
	}

	const colors: Record<string, string> = {};
	copyStringColorValues(colors, customizations);

	const themeSpecific = customizations[`[${themeName}]`];
	if (isRecord(themeSpecific)) {
		copyStringColorValues(colors, themeSpecific);
	}

	return colors;
}

function copyStringColorValues(target: Record<string, string>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === 'string') {
			target[key] = value;
		}
	}
}

function extractTextMateCustomizationRules(customizations: unknown, themeName: string): IRawTheme['settings'] {
	if (!isRecord(customizations)) {
		return [];
	}

	const rules: IRawTheme['settings'] = [];
	const textMateRules = customizations.textMateRules;
	if (Array.isArray(textMateRules)) {
		rules.push(...(textMateRules as IRawTheme['settings']));
	}

	const themeSpecific = customizations[`[${themeName}]`];
	if (isRecord(themeSpecific) && Array.isArray(themeSpecific.textMateRules)) {
		rules.push(...(themeSpecific.textMateRules as IRawTheme['settings']));
	}

	return rules;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

async function shouldUseSemanticOverlay(document: vscode.TextDocument): Promise<boolean> {
	if (!isSemanticOverlayEnabled(document)) {
		return false;
	}

	const semanticHighlightingEnabled = vscode.workspace
		.getConfiguration('editor', document.uri)
		.get<boolean | string>('semanticHighlighting.enabled', 'configuredByTheme');
	if (semanticHighlightingEnabled === false) {
		return false;
	}

	try {
		const semanticTokens = await vscode.commands.executeCommand<unknown>('vscode.provideDocumentSemanticTokens', document.uri);
		return isSemanticTokens(semanticTokens);
	} catch {
		return false;
	}
}

function isSemanticOverlayEnabled(document?: vscode.TextDocument): boolean {
	const configuration = vscode.workspace.getConfiguration('commentLanguageInjection', document?.uri);
	return configuration.get('semanticOverlay.enabled', configuration.get('alSemanticOverlay.enabled', true));
}

function isSemanticTokens(value: unknown): value is vscode.SemanticTokens {
	return value instanceof vscode.SemanticTokens && value.data.length > 0;
}

function countLeadingWhitespace(text: string): number {
	return /^\s*/.exec(text)?.[0].length ?? 0;
}

function skipBlockCommentLinePrefix(line: string, start: number, end: number): number {
	const prefix = /^\s*\*(?!\/)\s?/.exec(line.slice(start, end));
	return prefix ? start + prefix[0].length : start;
}
