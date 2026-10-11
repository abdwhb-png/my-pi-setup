# Pi subagent workflow and consumer inventory

Read-only scout report. No source, settings, or package files were changed. The report records repository facts and historical use to support the migration investigation; it does not recommend a package or define a final architecture.

## Session corpus and method

Pi session recall was used first. `pi_session_search` with `scope=all` scanned 200 primary sessions; recall is useful for navigation but does not expose an aggregate of all recorded tool calls and their arguments. To distinguish executed tool calls from quoted documentation and discussion, I streamed JSONL records from the 200 top-level primary session files under `/home/abdwhb/.pi/agent/sessions`, across 22 project roots. The session dates span 2026-06-08 to 2026-10-10. Nested child-session files were excluded. The scan inspected only assistant `toolCall` records and did not print task text or secrets.

Forked session histories repeat prior tool-call IDs. Deduplicating by globally repeated tool-call ID reduced 1,287 raw `subagent` records to 709 unique calls across 34 parent sessions. Including `subagents_enable`, `subagent_supervisor`, `subagent_wait`, and `bg_wait` yielded 1,323 raw records and 745 unique calls. Duplicate counts are 578 for `subagent` and 578 across the full family. These are recorded attempts, not confirmed successful launches.

Within the `.pi` session root, recall indexed 47 primary sessions; 49 direct session files are present locally, so recall indexing is short by two. The direct-file scan found 422 raw `subagent` records, reduced to 328 unique calls across 16 sessions. It found 97 unique launches (107 raw, including 10 fork-history repeats): 71 used `workflowScript`, one used the alternate `workflow` field, and 25 directly named an agent. Among these 97 launches, `async` was `true` in 83, `false` in 9, and omitted in 5.

For `.pi`, other unique `subagent` actions include status 121, steer 21, interrupt 6, stop 7, list 24, get 14, models 11, resume 4, wait 1, create 3, and the remaining diagnostic/help actions. Workflow script source contains 39 `runs.all(...)` and 186 `runs.run(...)` occurrences; these are static code-occurrence counts, not child-run counts.

Across all project roots there were 246 unique launches, including 185 workflow-form launches; `async` was true for 219, false for 13, and omitted for 14. The corpus therefore shows that subagent use extends beyond the `.pi` project itself.

Only 7 of the 97 `.pi` launch arguments supplied a `model`; none supplied `fallbackModels`, `tools`, or `extensions`. Model and tool policies therefore primarily come from settings and agent definitions, rather than per-launch overrides. This does not establish whether any launch successfully followed a fallback.

## Local production consumers

- `/home/abdwhb/.pi/agent/extensions/_shared/subagents/rpc-client.ts:3` defines the local `subagents:rpc:v1` protocol events. Its public methods cover ping, spawn, status, manage, steer, interrupt, stop, resume, and async completion (`:152`, `:180`, `:193`, `:200`, `:207`, `:214`, `:221`, `:228`, `:235`, `:242`). Brainstorm and the wait guard use this helper.
- `/home/abdwhb/.pi/agent/extensions/pi-subagents-addons/pi-subagents-overview/rpc-client.ts:3` independently defines the same RPC version and request/reply transport (`:136`). This is a second copy of the local async RPC client and overlaps with the shared implementation.
- `/home/abdwhb/.pi/agent/extensions/sdd-orchestrator/delegation-contract.ts:1` and `/home/abdwhb/.pi/agent/extensions/sdd-orchestrator/delegation-client.ts:1` use `pi-subagents/delegation`, a distinct foreground contract with started/update/response/cancel events (`delegation-client.ts:303`, `:310`, `:317`, `:396`, `:400`, `:412`). SDD needs request identity, structured results, progress, deadlines, and cancellation.
- `/home/abdwhb/.pi/agent/extensions/brainstorm-forcer/research-runner.ts:147` spawns an asynchronous child with an output schema, tracks completion by run ID, and stops the exact run (`:152`, `:175`).
- `/home/abdwhb/.pi/agent/extensions/brainstorm-forcer/verification-runner.ts:417` starts an asynchronous `workflowScript` (`:428`) to coordinate verification nodes, and supports attach, stop, and status for restored/running work (`:449`, `:464`, `:476`).
- `/home/abdwhb/.pi/agent/extensions/brainstorm-forcer/index.ts:25` imports the package capability ceiling; its dynamic preflight import is at `:517` and contract resolution at `:542`.
- `/home/abdwhb/.pi/agent/extensions/pi-subagents-addons/index.ts:6` imports the capability-ceiling API and registers a default-deny gate while generating tool overrides (`:60`–`:89`).
- `/home/abdwhb/.pi/agent/extensions/pi-subagents-addons/subagent-wait-guard/status.ts:12` parses the package's versioned async snapshot and treats omitted or malformed status as insufficient proof of settlement (`:18`–`:35`). The owning extension requests status through the shared RPC client (`subagent-wait-guard/index.ts:60`, `:72`).
- `/home/abdwhb/.pi/agent/extensions/pi-subagents-addons/pi-subagents-overview/live-runtime.ts:1` listens to package foreground and async lifecycle events (`:79`–`:96`), reads async artifact metadata, and controls runs via RPC (`:128`–`:143`).
- `/home/abdwhb/.pi/agent/extensions/_shared/subagents/workflow-agents.ts:5` documents and implements the file-based gate for workflow agents. It writes and removes Markdown definitions with ref-counted lifecycle (`:121`–`:140`) because runtime agent registration has a different override contract. Brainstorm and SDD both call this helper through their agent modules.
- `/home/abdwhb/.pi/agent/extensions/pi-subagents-addons/fallback-advice.ts:315` observes foreground tool results; `:323` observes async completion events. This is request-local advice, not an automatic retry mechanism.
- `/home/abdwhb/.pi/agent/settings.json:29` loads `npm:pi-subagents@0.73.1`; `:35` onward holds default model and per-agent overrides. The README describes package ownership boundaries at `/home/abdwhb/.pi/agent/extensions/pi-subagents-addons/README.md:3` and Brainstorm’s execution split at `/home/abdwhb/.pi/agent/extensions/brainstorm-forcer/README.md:51`–`:61`.

Search covered production extension sources under `/home/abdwhb/.pi/agent/extensions` and independent repositories under `/home/abdwhb/engineering/pi-integrations`, excluding tests, vendored modules, and the pi-subagents source checkout itself. Local production API imports are concentrated in the consumers above; there are no other production imports from sibling pi-integrations repositories in the search scope. The local package installation remains separately configured in `agent/settings.json`.

## Implication for the requested single source of truth

The observed workflow needs an owned interface for both foreground structured requests and async/scripted work, including progress, completion, status, run controls, and errors. Policy features such as capability ceilings and launch preflight also appear as package-facing contracts. The existing shared RPC helper covers some async/control functions but not SDD’s foreground delegation or the package-facing policy APIs. The overview’s second RPC implementation duplicates transport behavior. This gives a concrete migration target for a later design: centralize package-specific transport and normalization behind one owned integration boundary, while leaving SDD and Brainstorm’s domain workflow coordination with their current owners.

## Limits

The session scan distinguishes recorded tool-call arguments from prose, but it does not join every tool call to its result or prove task success. Script counts are lexical occurrences, not executed child counts. The `.pi` history corpus has two direct files beyond recall’s indexed set. No current package-release or upstream-version claims are made here.
