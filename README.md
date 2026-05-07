# Comment-Language-Injection

Inject embedded language highlighting into comments using static TextMate grammars and a `language={id}` tag.

## Usage

Use the target language identifier immediately after the opening comment marker:

```ts
/* language=json
{
  "test": 1
}
*/
```

Line comments work too:

```ts
// language=json { "test": 1 }

// language=json
// {
//   "test": 1
// }
```

Block comments still work:

```ts
// language=json
/* language=json
{
  "test": 1
}
*/
```

The extension provides **inline** highlighting for a fixed built-in set of embedded languages:

`md`, `json`, `xml`, `html`, `css`, `js`, `py`, `c`, `cpp`, `cmd`, `bash`, `ps1`, `csv`, `env`, `dot`, `yaml`, `ini`, `toml`, `ts`, `tex`, `latex`, `makefile`

It also supports common host comment styles across many languages, including:

`//`, `#`, `;`, `%`, `'`, `::`, `REM`, `/* */`, `<!-- -->`, `(* *)`, `--[[ ]]`

The grammar is static, so embedded languages outside that list are not injected.

For editors with semantic tokens, the extension keeps semantic highlighting enabled and overlays tagged comment payloads with VS Code's TextMate grammars using the active theme's token colors, so semantic highlighting does not repaint injected code as plain comments after the language server finishes loading. Editors without semantic tokens use the normal TextMate injections only.

## Development

1. Run `npm install`.
2. Press `F5` in VS Code to launch an Extension Development Host.
3. Add or update logic in `src`.
