# Changelog

## Unreleased

## 0.2.38 (Server) - 2026-10-27

- Add an OTLP/HTTP JSON ingestion endpoint `/v1/traces` for magpie and other OpenTelemetry exporters: sessions, models, usage, and optional prompt/reply bodies, authenticated with the same API key. `/v1/metrics` is accepted and discarded (no metrics storage yet).
- OTLP input tokens are `input + cache_read + cache_write` on the wire; they are normalized to uncached input so cached tokens are not billed twice.
- Only `generation` spans become turns; agent root and tool spans just create the session. A revised span with the same `spanId` updates token/cost by delta when `total_tokens` grows.
- The session model list no longer includes the `unknown` placeholder.
- README and the Dashboard help center gain an OTLP / magpie setup section (`#/help/otlp`).
- Known limits: Langfuse SDK default protobuf / Basic auth is not supported, `/v1/metrics` is not stored, and body content requires the exporter to enable it.

## 0.2.37 (Server) - 2026-10-19

- Stats presets `today` / `month` / `last_month` and daily grouping follow the Beijing calendar (UTC+8) instead of UTC or the browser timezone. The dashboard sends only `range` for presets; custom dates send Beijing-time full-day bounds.
- Displayed yuan uses a live USD→CNY rate (open.er-api.com, cached 12 hours). Falls back to the last known rate, then to 7. Storage stays in USD.

## 0.2.36 (Server) - 2026-10-19

Catch-up from 0.2.27. Public installs keep DeepSeek defaults (`https://api.deepseek.com`, `deepseek-chat` / `deepseek-reasoner`) and the `@runmarks/*` packages.

- Price GPT-6, GPT-6 Astra, Sol, Luna, and GPT-6.1 Sol independently, including the above-272K context tier. An exact model id wins over a fuzzy cross-provider match.
- Reprice supports a single session, dry-run, and tiered prices. Codex `output_tokens` already include reasoning and are not charged twice.
- Stats APIs accept last month and a custom inclusive `from` / `to`. The dashboard uses a two-month calendar and shows a loading state beside the range control.
- Session traces support filters, stable deep links, and ranged shares.
- Collect `function_call` / `function_call_result`, subagent transcripts, and `reasoning` / `tool` roles (Claude-compat plugin 0.2.20).
- Send `X-API-Key` only to Astra hosts. Other OpenAI-compatible endpoints get Bearer auth only.
- Updater: reflink database snapshots with a SQLite online-backup fallback, Bun lockfile v2 installs, and no false timeout while a long update is still running.
- OpenCode plugin 0.2.8 reports billable `finish=tool-calls` steps. Client hook launchers fall back from bun to node and record git metadata with `node:child_process`.

## 0.2.35 (Server) - 2026-10-18

- Fixed GPT-6 Astra long-context pricing: when one request's input including cache exceeds 272K, the whole request uses the higher tier for Standard and Fast names.
- Bill Astra reasoning tokens separately, and skip a second reasoning charge when Codex output already includes it.
- Persist context tiers on the price table. Historical reprice supports a session filter and dry-run, and updates cost inside a transaction without resetting token or request totals.

## 0.2.34 (Server) - 2026-10-18

- Fixed a false update failure after three minutes. The dashboard keeps polling while the server reports backup, install, or health-check progress.

## 0.2.33 (Server) - 2026-10-18

- Stats APIs accept last month and a custom inclusive range via timezone-aware `from` / `to` on all four stats endpoints.
- Date filtering uses a two-month calendar and adds this year, this quarter, last quarter, and the previous three months.
- The updater can reflink a database snapshot and falls back to SQLite's online backup. Server packaging tolerates Bun lockfile v2.

## 0.2.32 (Server) - 2026-09-23

- Added Grok 4.7 / 4.6, GPT-6, Opus 5.5, and Cursor `gemini-3.8-flash` prices.
- Fixed model-id normalization so a context marker in the middle of an id (for example `grok-4.7-256k-fast`) still matches the Fast price.
- Delayed session-agent retries after `AgentRunBusyError` by 250ms instead of spinning on the ready queue.
- Server packages now generate a real `bun.lock` under Bun 1.4 (`--lockfile-only` without `--production`).

## 0.2.31 (Server) - 2026-08-20

- Unified trace filters and stable deep links for sessions and public shares.
- Added ranged shares and restored full share search resources.

## 0.2.30 (Server) - 2026-08-13

- Updated DeepSeek V4 Flash / Pro peak prices to the official 2026-08-17 peak/off-peak schedule (CNY / 7).

## 0.2.29 (Server) - 2026-08-13

- Store `function_call` / `function_call_result`, including CodeBuddy CLI and Claude tool-call cache handling.
- Support subagent sessions: SessionStart mapping, PostToolUse `call_id`, and subagent transcript dispatch.
- Session detail shows `reasoning` and `tool` roles.

## 0.2.28 (Server) - 2026-08-13

- Attach `X-API-Key` only for the Astra gateway. Standard OpenAI-compatible endpoints send Bearer only.

## 0.2.27 (Server) - 2026-08-08

- Public Session Share defaults to summary-first, with on-demand search/JSONL detail resources.
- Public share pages show summaries with progressive reading guidance for agents.
- Escaped LIKE wildcard searches and sanitized public Markdown XSS.
- Synced public API/Skill documentation.

## 0.2.26 (Server) - 2026-08-06

- Added copy-link entry in the active shares list and generated verifiable human-readable links for historical shares.
- Opening a public API URL from an Agent Prompt in a browser now redirects to the same-token read-only share page; curl keeps JSON responses.
- Share dialog expands a link input when HTTP copy is restricted, supporting manual copy.

## 0.2.25 (Server) - 2026-08-06

- Fixed copy link and Agent Prompt feedback in the share dialog: fallback completes focus and copy inside the dialog, showing a manual copy hint on failure.

## 0.2.24 (Server) - 2026-08-06

- Agent Prompt now mentions appending `-o runmark-session-context.json` to the curl command to save larger full context to a local file for analysis.

## 0.2.23 (Server) - 2026-08-06

- Public share pages gained a "Copy for Agent" action to copy a context prompt with temporary access credentials.
- Agent Prompt guides viewing the AISummary first and saving full context to a local file when responses are large.
- Added an icon to session summary actions and moved the share entry to the far right of the action area.

## 0.2.22 (Server) - 2026-08-06

- Added time-limited session sharing with 1h, 6h, 12h, 3-day, and 7-day expiration.
- Share pages reuse the full call-chain detail in read-only mode for messages, turns, and tool calls, plus a concise Agent Prompt.
- Added an active shares list with revoke support, distinguishing revoked versus expired link states.
- Share tokens are stored as random values with hashing; public session info uses a field whitelist.

## 0.2.20 (Server) - 2026-07-28

- Extended the shared pricing table with Gemini 3.6 Flash, Gemini 3.5 Flash, Claude Sonnet 5, Kimi K3, and BoxAI proxy model prices.

## 0.2.19 (Server) - 2026-07-26

- Corrected Grok 4.5 and Composer 2.5 pricing per the xAI / Cursor official API rates (including cache / reasoning).
- Added `grok-build` provider pricing entries; ingest forces server-side estimation for `grok-build` / `xai` / `grok` to avoid missing cache costs for open-grok-build.
- Added `POST /v1/pricing/reprice` and `scripts/reprice-grok.ts` to recompute historical turns from the pricing table.
- `seedPricing` stays aligned with `DEFAULT_PRICING` (upsert) at startup.

## 0.2.18 (Server) - 2026-07-23

- Dashboard supports the Grok Build client: `agent-icons/grok.svg`, help center `grok.md`, and agent tags in the session list.
- Shared pricing table now includes xAI / Grok models (`xai` / `grok` providers) for server-side estimation when no native cost exists.
- skip-tools now includes common Grok tool names (`run_terminal_command` / `search_path` / `grep_search`).

## 0.2.17 (Server) - 2026-07-18

- Matter AI search prioritizes recently updated archives and limits model calls to at most two rounds.
- Search results record the actual number of scanned items for reviewing candidate coverage and call cost.

## 0.2.16 (Server) - 2026-07-18

- Added an AI search agent for matters and session lists, with normal and AI search entries, thinking states, and semantic result display.
- Session AI search uses keyword recall, time-range recognition, and semantic ranking to bound candidate count and model calls.
- Call chains keep only tool execution summaries; tool inputs/outputs are no longer persisted and legacy tool payloads are cleaned up.
- Task retries store the minimal short query and session ID in lightweight task-level inputs.

## 0.2.15 (Server) - 2026-07-18

- Matter archive list supports searching by id, type, title, topic, summary, result, and archived body.
- Matter summary and archived lists support 50 items per page, keyword clearing, and paging.

## 0.2.13 (Server) - 2026-07-17

- Session Summary skips OpenCode / Cursor subagent sessions (`parent_session_id` or `metadata.is_subagent`) to avoid sub-agents generating their own titles and summaries.
- Filters OpenCode SmartFetch temporary sessions `smartfetch-secondary`: excluded from ingest and hidden from the Dashboard session list by default.

## 0.2.12 (Server) - 2026-07-17

- Fixed image push failure from a missing registry login in the Docker release job; the release stage now logs into the Docker registry explicitly.

## 0.2.11 (Server) - 2026-07-17

- Added a multi-stage Docker image for the Runmark Server, published via `server-vX.Y.Z`.
- The Docker runtime uses a non-root user, a persistent SQLite data volume, health checks, and enforced API key validation.
- Split the macOS release pipeline into trigger and artifact-download responsibilities.

## 0.2.10 (Server) - 2026-07-15

- The agent config Schedule input is now free-form and only validated on save.
- Added small protocol hints below the Schedule input (debounce/throttle, global/session dimensions).
- Adjusted Schedule input width and row layout so it no longer crowds the description text.

## 0.2.9 (Server) - 2026-07-15

- Session summary schedules support per-session debounce: `session:debounce:5m` (token order flexible, e.g. `debounce:session:5m`); different sessions no longer reset each other's wait window.
- Built-in defaults: Session Summary uses `session:debounce:5m`, Matter Archive uses `throttle:10m` (affects only fresh installs or unset wait durations; never rewrites existing custom intervals).

## 0.2.8 (Server) - 2026-07-14

- The updater now backs up the database via SQLite consistent snapshots, rejecting empty databases and failed snapshot integrity to avoid unrecoverable backups.
- After release, verifies database integrity and session/turn counts; validation failure automatically rolls back code and database snapshot.
- Fixed the post-update cleanup branch that could wrongly restart the service after a successful update.

## 0.2.7 (Server) - 2026-07-14

- Fixed the agent config page not reading the `schedule` string; the page now shows and edits trigger configs such as `debounce:1m` and `throttle:5m`.

## 0.2.6 (Server) - 2026-07-14

- Session summary triggers now use debounce scheduling; matter archive keeps throttle aggregation to reduce duplicate summaries during continuous conversation.
- Trigger config is unified as a `schedule` string, e.g. `debounce:1m` and `throttle:5m`.
- On startup, migrates legacy `debounce` / `throttle` config of built-in agents to `schedule`, preserving existing wait durations.

## 0.2.5 (Server) - 2026-07-10

- Added an Agent Run list and call-chain detail showing Prompt, Tool Calls, LLM output, model, tokens, cost, and related sessions.
- Automatic triggers use per-agent fixed throttle windows; long tasks use single-flight to avoid duplicate or overlapping runs.
- Hardened LLM retry and ReAct protocol recovery to reduce failures from transient network errors and incomplete model responses.
- Fixed multi-session summary interleaving, concurrent run conflicts, and missing session names in run records.
- Fixed the "Update success" button staying in the sidebar after a successful update: historical `completed` states and silent checks no longer get stuck on success.
- Automatic updates are enabled by default with a built-in manifest URL; no need to manually configure `AGENT_TRACKER_UPDATE_*`.

## 0.2.4 (Server) - 2026-07-10

- Added an Agent Run list and call-chain detail showing Prompt, Tool Calls, LLM output, model, tokens, cost, and related sessions.
- Automatic triggers use per-agent fixed throttle windows; long tasks use single-flight to avoid duplicate or overlapping runs.
- Hardened LLM retry and ReAct protocol recovery to reduce failures from transient network errors and incomplete model responses.
- Fixed multi-session summary interleaving, concurrent run conflicts, and missing session names in run records.

## 0.2.3 (Server) - 2026-07-10

- Added server-side automatic updates: release package, checksum file, update manifest, and Dashboard update banner.
- Fixed updater sync, production dependency install, and Linux systemd upgrade flow.

## Earlier releases

- 0.2.0–0.2.2: introduced built-in agents, matter archiving, session summaries, Cursor usage reconciliation, and Dashboard improvements.
- 0.2.4–0.2.10 (clients): improved collection and install experience for Cursor, Codex, Claude Code, CodeBuddy, WorkBuddy.
- 0.1.x (Runmark): released the unified client install entry `@runmarks/runmark`.
