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
| `@daw-browser/control` V1/V2 snapshots, requests, approvals, commits, history, recoveries | versioned package compatibility entry point | `packages/control/src/{actions,primitives,recovery,serialization,snapshots,versions}.ts` with root barrel | Focused contract modules; root barrel remains the compatibility entry point | B | V1 remains parseable; V2 snapshot and local control capability remain current. Canonical aliases point to the existing V2 high-fidelity capability/snapshot/query representations. Package tests cover canonical JSON, planner, snapshots, and recovery payloads. | Checkpoint 2 complete; no deletion or durable rewrite | `packages/control/src/index.test.ts`, local-control service/execution tests | Keep V1/V2 exports and durable markers; canonicalize through identity-preserving aliases |
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

## Checkpoint 2 — Modular contract ownership

- The oversized control barrel was split into focused internal owners for
  primitives/IDs, versioned limits and capabilities, actions and envelopes,
  snapshots, recovery payloads, and canonical serialization/digests.
- `packages/control/src/index.ts` remains the public compatibility barrel, and
  `packages/control/src/recovery-track-order.ts` remains an independent
  package export.
- Canonical aliases are additive and identity-preserving:
  `canonicalControlApiVersion`, `canonicalControlLimits`,
  `canonicalControlCapabilitiesSchema`, `canonicalControlCapabilitiesQuerySchema`,
  `canonicalControlCapabilities`, `canonicalLocalControlCapabilities`,
  `canonicalControlSnapshotQuerySchema`, and
  `canonicalProjectSnapshotSchema`, plus the corresponding canonical snapshot
  query parser and inferred types.
- No V1/V2 export was removed, no durable V1 data was rewritten, and no
  operation catalog or control-core extraction was started.
- Evidence: package typecheck plus focused index/planner tests; canonical
  request serialization and SHA-256 digest fixtures remain unchanged.

## Checkpoint 3 — Control semantic core extraction

- Extracted pure semantic behavior into `@daw-browser/control-core`:
  planner, projection, MIDI resolution, timeline range deletion, track
  deletion, and recovery track ordering. Planner recovery limits remain
  contract-owned in `@daw-browser/control`.
- `@daw-browser/control-core` depends on `@daw-browser/control`,
  `@daw-browser/shared`, and `@daw-browser/timeline-core`; `@daw-browser/control`
  does not depend on core. Contract schemas, serialization, digests, durable
  recovery readers, and version constants remain in `@daw-browser/control`.
- Migrated local-control and Convex planner, projection, MIDI, deletion, and
  recovery consumers to `@daw-browser/control-core`. The repository has no
  remaining semantic consumer import from `@daw-browser/control`.
- Semantic root exports were intentionally removed from `@daw-browser/control`.
  Re-exporting them would create the prohibited `control -> control-core ->
  control` cycle. This is category A source-only generation/migration work, not
  proof of external compatibility safety; all repository consumers were
  migrated, while external-consumer evidence remains unresolved.
- The former `@daw-browser/control/recovery-track-order` subpath was removed;
  the canonical semantic subpath is now
  `@daw-browser/control-core/recovery-track-order`.
- Split the former mixed test ownership: contract/schema/serialization tests
  remain in `packages/control/src/index.test.ts`, while semantic MIDI,
  projection, and policy tests are in
  `packages/control-core/src/semantic.test.ts`; planner tests remain in
  `packages/control-core/src/planner.test.ts`. Fixtures and expected outputs
  remain unchanged.
- Evidence: focused control/core tests passed with contract tests independent
  from core; package checks passed and the application TypeScript graph passed.

## Checkpoint 4 — Canonical operation catalog

- Added the authoritative keyed catalog in `packages/control/src/operations.ts`
  for project discovery and the canonical control read, preview, approval,
  commit, history, and recovery operations.
- Project discovery is strict and bounded: `project.list` accepts only `{}` and
  returns readonly accessible `{ projectId, name? }` entries; `project.current`
  returns an explicit `present` or `absent` result and is desktop-only.
- Catalog descriptors are keyed by the same operation IDs as
  `ControlOperationMap`, with strict input/output schemas, effect,
  idempotency, target, and approval metadata. Canonical capabilities and
  snapshots use the existing V2 aliases; mutation, history, and recovery
  contracts retain their established V1 schemas.
- Added schema-validated operation lookup/support helpers and a cast-free,
  exhaustive-switch dispatch foundation. Dispatch validates target support,
  input, and output while keeping trusted principal/target metadata in
  `ControlRequestContext`; no extension provenance or handler implementation
  was added.
- Evidence: `packages/control/src/operations.test.ts` covers exact IDs,
  metadata truthfulness, strict/bounded discovery, input/output validation,
  unsupported targets, unknown IDs, and complete keyed handler correlation.
  Existing V1/V2 exports, serialization, durable formats, and adapters remain
  unchanged. External deployment and consumer evidence remains unresolved.

## Checkpoint 5 — Provider handlers and conformance

- Added `createLocalControlHandlers` in
  `src/lib/local-control/local-control-handlers.ts`. It binds one local
  project identity, exposes only that project's discovery metadata, rejects
  cross-project requests before invoking the existing local service, and
  delegates capabilities, V2 snapshots, preview, approval, commit, history,
  and recoveries without duplicating semantic or durable behavior.
- Added `createCloudControlHandlers` in `api/control-handler.ts`. It receives
  a trusted Convex gateway, lists only `projects.listMineDetailed`, delegates
  control reads and writes to the generated Convex control functions, and
  intentionally omits desktop-only `project.current`.
- Refined `ControlOperationHandlers` with target-specific keyed handler sets
  (`ControlOperationIdsForTarget`) while retaining runtime catalog target
  rejection and cast-free exhaustive dispatch. Missing runtime handlers fail
  explicitly.
- Added reusable test-only conformance coverage in
  `src/lib/control-conformance.ts`, exercised by both local fake-IndexedDB
  fixtures and the direct Convex test gateway. Coverage includes capabilities,
  discovery, V2 snapshot fidelity, preview non-mutation, approval issuance and
  required approval, commit, idempotent replay and conflict, revision
  conflict, history, recoveries, strict schema validation, unsupported target,
  and provider-specific missing-project authorization behavior.
- No REST, SDK, CLI, MCP, desktop protocol, or extension adapter migration was
  performed. Existing routes and durable authorities remain owners.

## Checkpoint 6 — App-local extension kernel

- Added the framework-neutral `src/lib/extensions/` kernel with validated
  static command/shortcut declarations, staged atomic activation, private
  provider state, immutable snapshots, bounded diagnostics, abort signals, and
  deterministic reverse cleanup.
- Runtime command binding is limited to declarations. Activation failures,
  duplicate IDs, missing bindings, shortcut conflicts, stale generations, and
  cleanup failures are isolated without publishing partial registries.
- Stable contribution IDs support explicit first-level command replacement only
  when the target opts into a matching contract. Replacement deactivation
  restores the prior provider automatically; nested/cyclic replacement is
  rejected.
- Focused evidence is in `src/lib/extensions/extension-kernel.test.ts`.
- Deferred surfaces: browser toggle composition, UI/menu projection,
  persistence, project control facade, external packages, capabilities/grants,
  manifests/discovery, and agent APIs.

## Checkpoint 7 — Browser toggle extension composition

- Composed the built-in `builtin.view.toggle-browser` definition through the
  app-local extension kernel. It declares the stable `view.toggle-browser`
  command and `Mod+Alt+B` shortcut with the existing non-editable-target
  behavior.
- The extension receives only the narrow `views.browser.toggle()` facade.
  Browser state, persistence, rendering, and the left-browser controller
  remain application-owned.
- Timeline creates one extension host per mounted composition and disposes it
  on unmount. Shortcut activation has a deterministic synchronous fallback
  while kernel activation settles; activation failure does not leave a
  rejected promise or a dead browser shortcut.
- `useTimelineKeyboard` routes only the existing browser-toggle branch through
  extension shortcut resolution. All other keyboard branches and their
  editable-target, exact-chord, `preventDefault`, and `stopPropagation`
  behavior remain unchanged.
- Existing desktop application-menu browser entries still select specific
  browser tabs rather than toggle the browser and were intentionally left
  unchanged. Native menu projection for extension-owned commands remains
  deferred to Checkpoint 12.
- Explicitly out of scope: SDK/client work, menu projection schema work,
  persistence/preferences, project-control extensions, external extension
  APIs, menu contribution IPC, and agent command APIs.

## Checkpoint 8 — Transport-neutral control client

- Added `ControlInvoker` beside the canonical operation types. It exposes only
  the target and typed `invoke(operationId, input)` boundary; handler request
  context remains private to the direct invoker binding.
- Added `createDirectControlInvoker`, which binds target-specific handlers and
  trusted context once and delegates exclusively to canonical
  `dispatchControlOperation`. Input, output, and target validation therefore
  remain owned by the catalog dispatch.
- Added the transport-neutral `CanonicalControlClient` facade and
  `createCanonicalControlClient` to `@daw-browser/control-sdk`. Its grouped
  `projects` and `control` methods are typed from canonical operation inputs
  and outputs, invoke exactly once, and perform no retry or transport work.
  Cloud clients omit desktop-only `projects.current` both at the type and
  runtime boundaries.
- Preserved the legacy HTTP `ControlClient`, `createControlClient`, V1/V2
  methods, transport/error types, and route behavior unchanged for
  compatibility. `CanonicalControlClient` naming is an additive
  compatibility-safe split until the legacy REST entry point can be migrated.
- Evidence: control operation and SDK tests cover exact catalog-to-client
  mapping, direct dispatch validation, typed method invocation, unchanged
  synchronous/asynchronous errors, cloud target boundaries, and all existing
  HTTP SDK compatibility behavior.
- Deferred: HTTP route unification, desktop routing, CLI/MCP, JSONL, menus,
  project-action extensions, and broad final simplification review.

## Checkpoint 9 — HTTP control execution unification

- Added canonical V1 compatibility projections for capabilities and snapshots
  in `@daw-browser/control`. The projections preserve the existing V1
  envelopes and narrow legacy MIDI snapshot shape while taking canonical V2
  provider output as their input.
- REST control capabilities, V1/V2 snapshots, preview, approval, commit,
  history, and recoveries now create one authenticated cloud `ControlInvoker`
  per request. The invoker binds the bearer-derived principal and delegates
  through `createCloudControlHandlers` and the operation catalog before
  reaching Convex.
- Route parsing, path/query compatibility handling, OAuth scope checks,
  HTTP error/status translation, no-store headers, and asset/resource routes
  remain at the HTTP boundary. Asset deletion maps through canonical
  `control.commit`; upload, content, folder, and resource endpoints remain
  direct because they are not represented by the canonical control operation
  catalog.
- V1 routes project canonical V2 capabilities/snapshots only after canonical
  dispatch; V2 routes return the canonical V2 result. No project.current
  cloud endpoint or speculative public operation endpoint was added.
- Evidence: focused route, handler, contract-equivalence, operation catalog,
  and control package tests pass; the route suite asserts each canonical
  control endpoint uses exactly one expected Convex provider reference.
- Deferred: legacy HTTP SDK transport adapter migration, desktop routing,
  host operations, menus, JSONL, CLI/MCP migration, extension actions, and
  broad final simplification review.

## Checkpoint 10 — Canonical desktop control routing

- Desktop control protocol descriptors now retain explicit V1 compatibility
  adapters while deriving represented operation schemas and metadata from the
  canonical catalog. V1 capability/snapshot results continue to project from
  canonical V2 values; V2 result fidelity and negotiation remain unchanged.
- Trusted renderer control requests now bind the actor identity in the
  authority-owning main/preload path and execute through one desktop
  `ControlInvoker` backed by `createLocalControlHandlers`. The renderer wire
  `actorSubject` is no longer used as the trusted principal source.
- External desktop socket requests continue to use the existing protocol
  framing, discovery, negotiation, queue, deadlines, cancellation, approval,
  commit, history, recovery, error, and mount-selection behavior. They reach
  the same trusted renderer/invoker path exactly once.
- `project.current` remains canonical and local-handler available but is not
  added to legacy desktop socket or renderer operation frames because additive
  exposure is not required for this compatibility checkpoint.
- Host status, transport, diagnostics, VST, import, export, and native audio
  operations remain explicit host-runtime paths and were not migrated.
- Evidence: desktop protocol schema/projection tests, desktop operation and
  request-queue tests, attached controller tests, local handler conformance,
  and CLI host negotiation tests pass. Remaining full-build/typecheck and
  lint evidence is recorded with the implementation run.

## Checkpoint 11 — Host/runtime operation inventory and catalog

- Inventory confirmed that host status, VST discovery/parameters,
  import/export, transport, and diagnostics are desktop-runtime operations,
  not project-control operations.
- Added the keyed `desktopHostOperationCatalog`,
  `desktopHostOperationSchemaV1`, `desktopHostOperationIds`,
  `isDesktopHostOperation`, and `getDesktopHostOperationDescriptor` exports to
  `@daw-browser/desktop-protocol`. Descriptors own the already versioned
  request/result schemas and classify safe reads, writes, and runtime
  operations.
- Desktop capability advertisement now derives its host-runtime portion from
  that catalog while preserving native-media gating and the existing control
  operation list. No Electron paths, lifecycle internals, capability tokens,
  or renderer details entered the project control catalog.
- No separate runtime invoker was added: current desktop, CLI, and MCP
  consumers remain protocol-owned and do not share a second real invoker
  boundary. This avoids speculative duplication while giving upcoming
  transports one keyed host metadata source.
- Evidence: desktop operation inventory tests and the complete desktop
  protocol schema test file pass; V1/V2 framing, cancellation, deadlines,
  native capability security, and control compatibility remain unchanged.

## Checkpoint 12 — Built-in management and bounded menu projection

- Added `createBuiltinExtensionManager` over the existing extension kernel.
  It accepts only statically imported trusted definitions and provides
  deterministic enable, disable, reload, immutable snapshots, bounded
  diagnostics, and disposal. No extension discovery, package loading, or
  preference persistence was introduced.
- Added the approved bounded native-menu projection:
  `DesktopApplicationMenuExtensionContribution` declarations are limited to
  16 stable first-level View-menu slots with validated IDs, titles, ordering,
  enabled state, and optional checked state. Native menus are not regenerated.
- Extension menu clicks are represented by a validated extension command
  message and return through the timeline extension host/kernel. The existing
  browser tab commands remain direct native commands; the browser-toggle
  extension is available through the kernel path without adding a duplicate
  native toggle entry.
- Renderer/main-frame, same-origin, schema validation, and reset behavior
  remain enforced at the existing IPC boundary.
- Existing app preference infrastructure was reviewed. It is broad,
  browser-local UI preference storage and no extension enablement preference
  was added; persistence remains deferred rather than redesigning settings.
- Evidence: extension kernel, timeline extension host, and native menu tests
  pass; all workspace package checks and the root application typecheck pass.

## Checkpoint 13 — Sequential JSONL JSON-RPC adapter

- Added the stream/stdio-neutral `createJsonlRpcAdapter` and
  `processJsonlLines` exports in `@daw-browser/control-sdk`. The adapter
  discovers methods from the canonical control catalog and target support,
  validates inputs and outputs through canonical schemas, and invokes one
  canonical invoker per request.
- Processing is strictly sequential: each line is queued behind the prior
  line, preserving ordering and applying backpressure. Lines are bounded to
  64 KiB, JSON depth to 12, and request IDs/methods to bounded validated
  values.
- Malformed JSON, invalid requests, batches, unknown methods, unsupported
  targets, invalid params, and invoker failures return structured JSON-RPC
  errors without secrets or exception details. Notifications execute without
  responses. A line-local failure does not poison subsequent lines. No eval,
  package loading, or retry layer was added.
- The adapter deliberately has no standalone process entrypoint yet:
  existing CLI/MCP authentication and desktop registration lifecycles remain
  owners until their thin-adapter migration checkpoint. The core is directly
  consumable by a future stdio or socket entrypoint without coupling it to
  either transport.
- Evidence: JSONL malformed/unknown/unsupported/invalid/recovery,
  sequential-order, discovery, notification/batch, and size-limit tests pass;
  the SDK typecheck passes.

## Checkpoint 14 — CLI and MCP thin adapters

- Added `createCanonicalControlMethodsFromLegacy` in
  `@daw-browser/control-sdk` as the single compatibility projection from the
  existing authenticated REST client to canonical control methods. V1
  capabilities/snapshots remain projected only where legacy callers require
  them.
- CLI cloud commands now route represented V2/control operations through that
  canonical method facade while retaining all command names, target parsing,
  credential loading, redacted output, desktop negotiation, host errors, and
  REST compatibility. Host commands continue to use the existing registration
  and socket adapter.
- MCP cloud service composition now wraps the same canonical method facade,
  projecting V1 results at the MCP compatibility boundary. Existing MCP tool
  names, target routing, authorization, annotations, error redaction, host
  tools, and lifecycle behavior remain unchanged.
- No legacy REST routes, desktop adapters, schemas, operation lists, retries,
  or approval logic were deleted or duplicated. The control service facade
  owns only compatibility projection; transport and auth remain in their
  existing layers. Project discovery is additive, with current-project
  discovery limited to the desktop host.
- Evidence: CLI, MCP, SDK compatibility/equivalence suites pass, along with
  all workspace package checks.

## Checkpoint 15 — Capability-scoped extension project actions

- Added `createProjectActionFacade` in `src/lib/extensions/project-actions.ts`.
  It accepts a canonical client, an explicit action-kind grant, explicit
  preview/approval/commit grants, and an abort/generation lifecycle. It
  validates every request, denies ungranted kinds and operations, checks
  lifecycle freshness before and after each call, and exposes only the three
  narrow project-action methods.
- The facade has no raw store/service access, no arbitrary invoker exposure,
  no secret access, and no external package API. It delegates to the existing
  canonical client exactly once per operation.
- A focused trusted/test fixture proves project rename preview, approval, and
  idempotent commit request boundaries. Tests also cover ungranted actions,
  abort handling, and lifecycle/error propagation. No production mutation was
  migrated: the existing local control service remains the durable mutation
  authority and no existing extension command was suitable for migration
  without expanding UI or introducing ambient project authority.

## Checkpoint 16 — Conformance and compatibility decisions

- Added `src/lib/control-platform-conformance.test.ts`, which asserts exact
  catalog-to-canonical-client and catalog-to-desktop mappings, schema identity
  ownership, target support truthfulness, CLI alias coverage, and JSONL
  discovery behavior.
- Added the repeatable `bun run test:control-platform` suite covering the
  conformance assertions plus catalog, SDK/JSONL, CLI, MCP, HTTP equivalence,
  desktop protocol, and host-operation tests.
- Compatibility inventory decisions remain evidence-backed:
  category A generated/source-only surfaces remain preserved unless their
  repository consumers are proven absent; categories B compatibility entry
  points remain retained; category C durable V1/V2 rows/markers remain
  retained; category D `registration-v1.json` remains retained. No external
  installed-client, deployment, REST consumer, or third-party MCP parity was
  claimed.
- No source-only category A deletion was justified by this checkpoint. V1/V2
  projections, legacy REST/desktop routes, CLI commands, MCP tools, and
  registration discovery remain additive compatibility surfaces.
- Conformance evidence covers canonical error normalization, target
  discovery, strict validation, idempotent/revision/approval/recovery behavior
  through the existing equivalence and control suites; no durable semantics
  were rewritten.

## Checkpoint 17 — Documentation and implementation-completion architecture audit

- Updated `README.md` and added `docs/control-platform.md` with the control,
  control-core, SDK, handler/invoker/client, canonical catalog, target and
  transport ownership, extension trust/lifecycle/replacement/menu/action
  boundaries, JSONL behavior, compatibility policy, and explicit deferred
  features.
- Documentation states the actual current shape: JSONL has a stream-neutral
  core but no process entrypoint; host runtime operations use a separate
  desktop-protocol catalog; V1/V2 and registration-v1 compatibility remains
  retained.
- Focused architecture assertions are in
  `src/lib/control-platform-conformance.test.ts`; they verify catalog
  ownership, canonical client/desktop mappings, target support, CLI aliases,
  and JSONL discovery. Existing package dependency checks continue to enforce
  the control/control-core boundary.
- No broad code review, code-simplifier pass, or unrelated cleanup was
  performed. Only checkpoint-local documentation and architecture evidence
  were added.

## Checkpoint 18 — Hardening completion

- Isolated extension subscriber failures and rejected failing initial
  subscribers without publishing partial state. Replacement snapshots retain
  the target contribution ID and title while provider behavior changes.
- Removed post-dispatch lifecycle rechecks from project-action approval and
  commit calls; the authoritative control operation owns the result after
  dispatch.
- Added JSON-RPC notifications, request-ID-preserving responses, bounded
  canonical domain-error data, sanitized unknown failures, and sequential
  output behavior.
- Added authenticated cloud project listing, host project discovery through
  `host.status`, CLI `project list`/`project current`, MCP discovery tools, and
  the authenticated desktop-host `rpc --target host` adapter. Cloud
  `project.current` remains intentionally unavailable.
- Corrected the duplicate desktop operation branch and retained V1/V2
  compatibility by projecting legacy host snapshots into the canonical client
  shape.
- Persistence and production extension-backed mutation remain deferred:
  existing preference infrastructure does not own extension enablement, and no
  suitable production mutation command was identified without expanding
  ambient authority.
- Evidence: control package typechecks, desktop protocol typecheck, focused
  changed tests, `bun run test:control-platform`, and changed-file oxlint all
  pass. No external deployment or installed-consumer parity is claimed.
