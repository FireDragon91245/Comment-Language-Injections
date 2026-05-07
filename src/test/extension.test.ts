import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectInjectedCommentHighlights, collectInjectedCommentRegions } from '../extension';

suite('Extension Test Suite', () => {
	test('package contributes a static injection grammar', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			activationEvents?: string[];
			contributes?: {
				grammars?: Array<{ scopeName?: string; injectTo?: string[]; embeddedLanguages?: Record<string, string> }>;
				configuration?: { properties?: Record<string, { default?: unknown }> };
				configurationDefaults?: unknown;
			};
		};
		const grammars = packageJson.contributes?.grammars ?? [];
		assert.ok(packageJson.activationEvents?.includes('onStartupFinished'));
		assert.strictEqual(grammars.length, 2);
		assert.ok(grammars.some((grammar) => grammar.scopeName === 'comment-language-injection.line'));
		assert.ok(grammars.some((grammar) => grammar.scopeName === 'comment-language-injection.block'));
		assert.ok(grammars.every((grammar) => grammar.injectTo?.includes('source.cpp')));
		assert.ok(grammars.every((grammar) => grammar.injectTo?.includes('source.al')));
		assert.ok(grammars.every((grammar) => grammar.embeddedLanguages?.['meta.embedded.block.comment-language-injection.json'] === 'json'));
		assert.strictEqual(
			packageJson.contributes?.configuration?.properties?.['commentLanguageInjection.alSemanticOverlay.enabled']?.default,
			undefined,
		);
		assert.strictEqual(
			packageJson.contributes?.configuration?.properties?.['commentLanguageInjection.semanticOverlay.enabled']?.default,
			true,
		);
		assert.strictEqual(packageJson.contributes?.configurationDefaults, undefined);
	});

	test('AL semantic overlay detects tagged line comments', () => {
		const regions = collectInjectedCommentRegions(
			[
				'// language=json',
				'// {',
				'//   "name": "value",',
				'//   "enabled": true',
				'// }',
				'procedure StillGetsAlSemanticHighlighting();',
			].join('\n'),
		);

		assert.strictEqual(regions.length, 1);
		assert.strictEqual(regions[0].language, 'json');
		assert.deepStrictEqual(
			regions[0].lines.map((line) => line.line),
			[1, 2, 3, 4],
		);
	});

	test('AL semantic overlay tokenizes tagged XML block comments with the built-in grammar', async () => {
		const highlights = await collectInjectedCommentHighlights(
			[
				'/* language=xml',
				'    <cac:AccountingSupplierParty>',
				'        <cac:Party>',
				'            <cbc:ID schemeID="0088">GLN aus Firmendaten</cbc:ID>',
				'        </cac:Party>',
				'    </cac:AccountingSupplierParty>',
				'    */',
			].join('\n'),
		);
		const ranges = Object.values(highlights).flat();

		assert.ok(Object.keys(highlights).length > 1);
		assert.ok(ranges.some((highlight) => highlight.line === 1));
		assert.ok(ranges.some((highlight) => highlight.line === 3));
	});

	test('semantic overlay applies bracket colors generically', async () => {
		const source = [
			'// language=json',
			'// { "items": [1] }',
		].join('\n');
		const highlights = await collectInjectedCommentHighlights(source);
		const lines = source.split('\n');
		const bracketRanges = Object.values(highlights)
			.flat()
			.filter((highlight) => {
				return highlight.end === highlight.start + 1 && '{}[]()'.includes(lines[highlight.line][highlight.start]);
			});

		assert.ok(bracketRanges.some((highlight) => lines[highlight.line][highlight.start] === '{'));
		assert.ok(bracketRanges.some((highlight) => lines[highlight.line][highlight.start] === '['));
		assert.ok(bracketRanges.some((highlight) => lines[highlight.line][highlight.start] === ']'));
		assert.ok(bracketRanges.some((highlight) => lines[highlight.line][highlight.start] === '}'));
	});

	test('grammar repository contains core embedded languages', () => {
		const lineGrammar = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '..', '..', 'syntaxes', 'comment-language-injection-line.tmGrammar.json'), 'utf8'),
		) as {
			injectionSelector?: string;
			repository?: Record<
				string,
				{
					begin?: string;
					while?: string;
					end?: string;
					match?: string;
					beginCaptures?: Record<string, { name?: string }>;
					whileCaptures?: Record<string, { name?: string }>;
				}
			>;
		};
		const blockGrammar = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '..', '..', 'syntaxes', 'comment-language-injection-block.tmGrammar.json'), 'utf8'),
		) as {
			repository?: Record<string, { begin?: string; while?: string; end?: string; match?: string }>;
		};
		assert.ok(lineGrammar.repository?.['line-multiline-json']);
		assert.ok(lineGrammar.repository?.['line-inline-json']);
		assert.ok(lineGrammar.repository?.['line-inline-bash']);
		assert.ok(lineGrammar.repository?.['line-inline-makefile']);
		assert.ok(lineGrammar.repository?.['line-multiline-bash']);
		assert.ok(lineGrammar.repository?.['line-multiline-makefile']);
		assert.ok(lineGrammar.injectionSelector?.includes('L:source'));
		assert.ok(lineGrammar.repository?.['line-multiline-json']?.begin?.includes('language='));
		assert.ok(lineGrammar.repository?.['line-multiline-json']?.begin?.includes('\\s*$'));
		assert.ok(!lineGrammar.repository?.['line-multiline-json']?.begin?.includes('?:('));
		assert.ok(lineGrammar.repository?.['line-inline-json']?.end === '$');
		assert.ok(lineGrammar.repository?.['line-inline-json']?.begin?.endsWith('\\s+(?=\\S)'));
		assert.strictEqual(lineGrammar.repository?.['line-inline-json']?.beginCaptures?.['0']?.name, 'comment.line.comment-language-injection');
		assert.strictEqual(lineGrammar.repository?.['line-multiline-json']?.whileCaptures?.['0']?.name, 'comment.line.comment-language-injection');
		assert.strictEqual(
			lineGrammar.repository?.['line-multiline-json']?.while,
			"^(\\s*)(//+|#+|;+|--+|%+|'+|::|(?i:rem)\\b)\\s?",
		);
		assert.ok(lineGrammar.repository?.['line-inline-bash']?.begin?.includes('language=(?:bash|sh|shell|shellscript|zsh|fish|ksh|csh)'));
		assert.ok(
			Object.entries(lineGrammar.repository ?? {})
				.filter(([key]) => key.startsWith('line-multiline-'))
				.every(([, rule]) => !rule.while?.includes(')?')),
		);
		assert.ok(blockGrammar.repository?.['block-json']);
		assert.ok(blockGrammar.repository?.['block-ts']);
		assert.ok(blockGrammar.repository?.['block-json']?.begin?.startsWith('(?:'));
		assert.ok(blockGrammar.repository?.['block-json']?.end?.startsWith('(?='));
		assert.ok(blockGrammar.repository?.['block-leading-asterisk']?.match?.includes('(?!'));
	});
});
