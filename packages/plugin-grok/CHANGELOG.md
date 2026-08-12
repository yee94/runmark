# @runmarks/grok-plugin

## 0.1.1

### Patch Changes

- Fix turn cost: only emit turn.completed from Grok `turn_completed` usage (with costUsdTicks); ignore `_meta.totalTokens` noise and stop treating per-turn usage as cumulative.

## 0.1.0


### Minor Changes

- Add Grok Build client plugin (`@runmarks/grok-plugin`) with user-level hooks and session-file ingest; wire `grok` into `@runmarks/runmark` install entry.
