# Third-party notices

Tokori's own source code is licensed under the [GNU AGPL-3.0-or-later](./LICENSE).
It also **bundles and downloads third-party data and depends on
third-party packages** that are covered by their own licenses. Those
licenses apply to that material, not the AGPL license above.

This file is maintained on a best-effort basis. If you believe something
is missing or inaccurate, please open an issue.

## Bundled in this repository

### CJK stroke-order data — `src-tauri/assets/hanzi-writer-data/`

The per-character stroke and median data shipped for offline handwriting
practice and stroke-order display is the
[`hanzi-writer-data`](https://github.com/chanind/hanzi-writer-data)
dataset, which is derived from the
[Make Me a Hanzi](https://github.com/skishore/makemeahanzi) project by
Shaunak Kishore.

That data is itself derived from the Arphic PL fonts and is distributed
under **two licenses**:

- The character graphics data: **Arphic Public License**
- The accompanying generation code/tooling: **GNU LGPL v3**

When you redistribute Tokori (source or binaries) you must keep this
attribution and comply with those licenses for the bundled data. See the
upstream projects above for the full license texts.

## Downloaded at runtime (not stored in this repository)

Tokori does **not** ship dictionary databases in this repository. The
built-in dictionaries are fetched on demand from their canonical sources
at the user's request and stored in the local app database. They remain
under their original licenses, for example:

- **CC-CEDICT** (Chinese–English) — Creative Commons **Attribution-ShareAlike** (CC BY-SA).
- **JMdict / JMnedict** (Japanese) — distributed by the
  [Electronic Dictionary Research and Development Group (EDRDG)](https://www.edrdg.org/edrdg/licence.html)
  under the EDRDG License Agreement (CC BY-SA).
- Other per-language dictionaries are downloaded from their respective
  upstreams under their own open licenses.

See the [dictionaries guide](https://tokori.ai/docs/guides/dictionaries)
for the source and license of each pack, and
`src/lib/dictionaries/registry.ts` for the catalog.

## Build- and run-time dependencies

JavaScript/TypeScript and Rust dependencies are declared in
[`package.json`](./package.json) and
[`src-tauri/Cargo.toml`](./src-tauri/Cargo.toml) and retain their own
licenses (e.g. `hanzi-writer` — MIT; `lucide-react` icons — ISC; the
Inter and JetBrains Mono fonts via `@fontsource` — SIL Open Font
License). Their license texts ship inside each package.
