# @runmarks/opencode-plugin

## 0.2.13

### Patch Changes

- Keep the initial memory index stable after writes; notify on background consolidation changes instead of rebuilding system context.
- Add a cancellable, non-blocking semantic recall alternative, disabled by default and mutually exclusive with index injection.
- Tighten foreground memory admission to explicit real-user requests with cross-task value; update the bundled `runmark` Skill and API contract.

## 0.2.12

### Patch Changes

- Layered memory (global / project / named Agent): one short index per session and Agent, details read on demand, save / update / forget / refresh tools. The memory service being unreachable never blocks a conversation (the first read waits at most 1s).
- Enable it with `options.memoryEnabled` on the plugin entry in `opencode.jsonc`; plugin options beat `~/.config/runmark/env`, real environment variables still win. Requires server 0.2.41 or newer.
- Capture is isolated by the real session directory, user messages are tied to the Agent that actually ran, and repository identity is cleared for sessions without a Git remote.
- Build and `prepack` bundle the single-source `skills/runmark/` directory; V2 registers it through `skill.transform`, V1 adds the skill path. The Skill updates with the plugin.
- Read `~/.config/runmark/env` and `RUNMARK_*` (legacy names stay read-only fallbacks). Models named `unknown` are no longer recorded as a model.

## 0.2.8

### Patch Changes

- Report billable OpenCode tool-call steps (`finish=tool-calls`) so input, cache, output, and reasoning tokens in a tool-call chain are included in cost.
- Cover tool-call rounds together with the final answer, and dedupe events. Add the OpenCode SDK type dependency.

## 0.2.7

### Patch Changes

- OpenCode 2.0.12: default export is `{ id, server, setup }`. v1 still uses `server`; v2 reports session / turn / tool through `ctx.event.subscribe`.

## 0.2.6

### Patch Changes

- Filter OpenCode SmartFetch temporary sessions titled `smartfetch-secondary` from telemetry ingest and Dashboard session list.

## 0.2.5

### Patch Changes

- Prevent telemetry timeouts from blocking OpenCode lifecycle hooks.
