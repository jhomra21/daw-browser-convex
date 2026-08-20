# Model-Independent Control Platform Compatibility Tracker

## Checkpoint 1 — Compatibility baseline

This tracker records the current compatibility surfaces before any executor
architecture simplification. Canonicalization happens early at each boundary;
deletion of an older surface is allowed only after conformance and compatibility
proof. Unresolved deployment or external-consumer evidence is explicitly
marked rather than inferred.

### Category definitions

- **A** — source-only generation
- **B** — compatibility entry point
- **C** — durable data-format marker
- **D** — machine discovery contract

The category applies only to a versioned compatibility artifact. Runtime
boundaries, tests, documentation, and unresolved inventory surfaces use
`n/a` and are described by the Surface kind/status fields.

| Surface | Surface kind/status | Current owner | Intended canonical owner | Compatibility category | Compatibility requirement / evidence | Migration status | Parity tests | Final disposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Generated API and contract source surfaces | source generation; external consumer evidence unresolved | `convex/_generated`, package source, schema definitions | No canonical owner selected; generation remains source-owned | A | Generated output is not itself a compatibility entry point. Regeneration must preserve the checked-in source contracts. | No deletion or generator migration in Checkpoint 1 | package/API/Convex type checks | Preserve generated sources; verify deployment consumers before changing generators |
| `@daw-browser/control` V1/V2 snapshots, requests, approvals, commits, history, recoveries | versioned package compatibility entry point | `packages/control/src` | Intended schema/parser owner not yet canonicalized | B | V1 remains parseable; V2 snapshot and local control capability are current. Package tests cover canonical JSON, planner, snapshots, and recovery payloads. | Baseline established; no deletion | `packages/control/src/index.test.ts`, local-control service/execution tests | Keep V1 compatibility; canonicalize early before later deletion |
| `@daw-browser/control-sdk` REST client | versioned REST compatibility entry point | `packages/control-sdk/src/index.ts` | `@daw-browser/control-sdk`; canonical ownership not yet proven externally | B | `/api/control/{v1,v2}` URL construction, bearer transport, response/error parsing, and origin validation are tested. | External consumer evidence unresolved | `packages/control-sdk/src/index.test.ts` | Keep entry point until consumer conformance is proven |
| `@daw-browser/control-mcp` tools | versioned MCP compatibility entry point | `packages/control-mcp/src` | MCP adapter over control schemas; external ownership unresolved | B | Tool inputs/outputs normalize through control schemas; host/cloud target selection and preview/approval/commit workflow are explicit. | External MCP consumer evidence unresolved | `packages/control-mcp/src/index.test.ts` | Keep adapter; do not duplicate control validation |
| `@daw-browser/control-cli` REST and desktop host commands | versioned CLI compatibility entry point | `packages/control-cli/src` | CLI layer plus `control-sdk`; canonical split not yet proven | B | CLI auth, redaction, REST calls, desktop negotiation, and host errors are covered. | External installed-version evidence unresolved | `packages/control-cli/src/*.test.ts` | Keep CLI entry points pending consumer matrix |
| Desktop protocol V1/V2 frames and operation maps | versioned wire compatibility entry point | `packages/desktop-protocol/src` | Protocol package; canonical ownership not yet proven across installed clients | B | V1 remains accepted; V2 negotiation is additive; operation/result schemas are strict. | Existing repository evidence; external version matrix unresolved | `packages/desktop-protocol/src/*.test.ts`, desktop host tests | Preserve V1 wire contract |
| REST control routes and asset/resource APIs | versioned HTTP compatibility entry point | `api/routes/control.ts`, `api/routes/samples.ts`, related routes | Hono route boundary; deployment consumer ownership unresolved | B | Control bodies canonicalize before Convex calls; asset uploads require size, MIME, extension, and SHA-256 evidence. | Deployment/external consumer evidence unresolved | `api/routes/control*.test.ts`, `api/routes/samples.test.ts`, contract equivalence tests | Keep route contracts until deployment conformance |
| Convex control rows, functions, and schema | durable versioned data surface | `convex/control.ts`, `convex/schema.ts` | Convex control functions plus API gateway; deployed canonical owner unverified | C | Rows carry versioned control ledgers; Worker gateway derives authenticated identity for touched routes. | Deployment and external consumer evidence unresolved | `convex/control*.test.ts`, `api/control-contract-equivalence.test.ts` | Preserve rows/functions; delete only after conformance proof |
| Local IndexedDB project/control state | durable versioned data surface | `src/lib/local-project-db.ts` | Local project DB/control layer; canonical migration authority is being established | C | Project DB version 6 and local schema version 2 are durable. Matching V1 digest rows migrate to V2 without revision drift. | Migration evidence added in Checkpoint 1 | `src/lib/local-project-db.test.ts`, `src/lib/local-control/local-control-state.test.ts` | Canonicalize early; retain markers until proof |
| Local control snapshots and semantic digest | durable versioned data surface | `src/lib/local-control/local-control-state.ts`, projector | Local control transaction authority; canonical digest ownership not yet finalized | C | V1 digest comparison supports additive migration; V2 semantic digest is current; corrupt rows fail closed. | V1/V2 evidence present; no deletion | `src/lib/local-control/local-control-state.test.ts`, service/projector tests | Keep one digest authority |
| History and recovery ledgers | durable versioned data surface | `src/lib/local-control`, `src/lib/undo`, local DB stores | Local control/recovery layer; canonical history ownership unresolved | C | Recovery payloads, hashes, expiration, idempotency, and undo/history persistence are versioned and project/actor scoped. | Inventory only; no marker deletion | local-control service/execution and `src/lib/undo/*.test.ts` | Preserve durable ledgers |
| Desktop `registration-v1.json` | machine discovery contract | `apps/desktop/main.ts`, `packages/control-cli/src/host.ts` | Desktop registration schema plus CLI discovery; canonical replacement not established | D | Strict, private, size-bounded, path-contained registration is validated before socket connection. V1/V2 handshake fixtures cover discovery. | Existing evidence; replacement/external matrix unresolved | `packages/control-cli/src/host.test.ts`, `packages/control-cli/src/index.test.ts` | Keep registration-v1 until replacement conformance proof |
| Browser shortcuts and local control entrypoints | runtime surface; not a compatibility artifact | `src/hooks/useTimelineKeyboard.ts`, timeline/control hooks | Existing browser hook/adapters; no canonical migration in Checkpoint 1 | n/a | Keyboard cleanup uses `onCleanup`; local and cloud routes retain their existing adapters. | Inventory only | timeline/controller tests where applicable | No behavior change |
| Electron menu dispatch | IPC/runtime surface; command IDs are separately versioned in protocol | `apps/desktop/application-menu.ts`, `main.ts`, `preload.ts` | Electron main/preload boundary; ownership split not yet canonicalized | n/a | Menu command/state schemas, renderer-origin, and main-frame checks remain enforced. | Inventory only | `apps/desktop/application-menu.test.ts`, desktop renderer/menu tests | Preserve existing command contract |
| Desktop asset/resource APIs and native capability files | capability/runtime surface; not a standalone compatibility artifact | `apps/desktop/file-capabilities.ts`, renderer export/import adapters | Desktop capability manager; canonical resource owner unresolved | n/a | Capability tokens, path limits, export/import schemas, and native resource handling remain at the existing boundary. | Inventory only | `apps/desktop/file-capabilities.test.ts`, export/native capability tests | Keep capability indirection |
| Compatibility and order regression tests | test evidence surface; not a compatibility artifact | `src/lib/test/hermetic-browser-environment.ts` plus affected suites | Test-only helper; no production canonical owner | n/a | Combined local-send, desktop, and local-control runs clean up globals, storage, relevant IndexedDB, fetch, and listeners. | Implemented in Checkpoint 1 | `bun run test:control-compat` and individual affected files | Keep helper test-only |
| Docs/examples and external consumers | documentation/evidence surface; not a compatibility artifact | `README.md`, package docs/examples, deployment configuration | No verified external canonical owner | n/a | Repository documentation is inventoried; checked-in deployment/external-consumer conformance evidence is absent. | Explicitly unresolved | Repository tests only; external evidence pending | Do not claim consumer parity |

## Checkpoint 1 findings

- Combined execution reproduced an unhandled background request to
  `/api/convex-auth/token` after local-send and desktop tests ran before
  local-control state tests.
- The trigger was test code installing a partial `globalThis.window` before a
  module graph reached `src/lib/convex.ts`; the module-level browser check
  configured Convex auth, whose asynchronous token request outlived the test
  that installed the fake window.
- The production guard now requires a browser-like window with a document.
  The shared test helper installs tracked listeners and clears local/session
  storage and IndexedDB stores without changing production state.
- Existing desktop registration-v1 parsing/discovery and IndexedDB schema
  upgrade tests provide the required durable compatibility evidence; only the
  missing V1 digest-to-V2 state migration assertion was added.

## Deferred evidence

- Deployed Convex schema/function conformance for every external consumer.
- Real installed desktop/CLI version matrix and third-party MCP/REST consumer
  inventory.
- Production rollout evidence for deleting any V1 surface.
