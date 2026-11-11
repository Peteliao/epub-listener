# Vendored foliate-js

Source: https://github.com/johnfactotum/foliate-js
Commit: 78914aef4466eb960965702401634c2cb348e9b1 (2026-05-01)

Only the format parsers are vendored:

- `fb2.js` — FictionBook 2 parser
- `mobi.js` — MOBI / KF8 (AZW3) parser
- `vendor/fflate.js` — minified fflate build (`unzlibSync`), used by `mobi.js`
  for KF8 HUFF/CDIC and compressed fonts

`foliate-js` is MIT licensed, see `LICENSE`.
`fflate` is MIT licensed, see `vendor/FFLATE_LICENSE.txt`.

The rendering layer (`view.js`, `paginator.js`, `epub.js`, `zip.js`, etc.) is
intentionally not vendored: this app renders `section.load()` output in its own
iframe so sentence highlighting and TTS stay in one place.
