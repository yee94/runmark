# @runmarks/runmark

## 0.1.10

### Patch Changes

- Installers write `~/.config/runmark/env` with `RUNMARK_ENDPOINT` / `RUNMARK_API_KEY`, never create a default config that shadows existing legacy credentials, and fall back to the old path read-only.
- OpenCode: migrate the legacy plugin entry, de-duplicate, and keep JSONC comments, plugin options, other settings, and symlinks. The plugin ships the `runmark` Skill.

## 0.1.8

### Patch Changes

- Hook launchers resolve bun, then `~/.bun/bin/bun`, then node and version managers, and bake the absolute path at install time.
- Install fails closed when neither Bun nor Node is available.

## 0.1.7

### Patch Changes

- Add Grok Build client plugin (`@runmarks/grok-plugin`) with user-level hooks and session-file ingest; wire `grok` into `@runmarks/runmark` install entry.
