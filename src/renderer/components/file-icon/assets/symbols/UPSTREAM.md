# Symbols assets

The SVG files in this directory are vendored from
[miguelsolorio/symbols](https://github.com/miguelsolorio/symbols), version
`0.0.25`, commit `296ef1b62287fb2315cb5651e552e09e8c8e1de8`.

- License: MIT; the unmodified upstream license is retained in `LICENSE`.
- Source paths: `src/icons/files/*.svg` and `src/icons/folders/*.svg`.
- Runtime: local static assets bundled by Vite. MyAgents never downloads them
  at runtime and does not depend on VS Code.
- Scope: only assets referenced by MyAgents' typed file-icon registry are
  vendored.
- Audit: `CHECKSUMS.sha256` records the bytes reviewed against the pinned
  upstream checkout. Contract tests fail if an SVG is added, removed, or
  changed without an explicit provenance update.

`files/presentation.svg` is a minimal derivative of upstream `files/image.svg`:
the geometry is unchanged and the purple resource color is replaced with the
Symbols amber used by presentation-oriented resources. It fills the only
common Office-family gap in the upstream set while preserving one visual
language. The derivative remains under the same MIT terms.
