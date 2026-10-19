# @runmarks/opencode-plugin

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
