# Model-independent control platform: what changed

**Merged:** 2026-08-26  
**Pull request:** #47, `feat/model-independent-control-platform`  
**Merge commit:** `b4bf014d5d9e95e82cff64df8c78a44ae46ae138`  
**Runtime-certified ancestor:** `37e400e42bcde874926d45e952a91ceb5080c94d`  
**Final reviewed PR head:** `3cff4bf5af63a8eb8fd6823babd0c119d1bb3d67`

PR #47 is not a small feature addition. It changes how this repository exposes project state, how desktop-native capabilities are owned, how external tools and agents interact with the DAW, and how native VST3 hosting is packaged, trusted, recovered, and tested.

The branch touched 926 files and merged 132 commits. This article is the durable behavior/architecture-level record of that change. The exact schemas and public APIs remain source-authoritative, but the sections below enumerate the important product, protocol, integration, runtime, safety, testing, and documentation changes that landed with the merge.

For current operating documentation, also read:

- [Control platform architecture](../control-platform.md)
- [Agent control operating manual](../agent-control.md)
- [Native VST3 architecture](../native-vst3.md)
- [Packaged runtime acceptance report](../../acceptance-reports/control-platform-runtime-2026-08-20.md)
- [Completed implementation tracker](../../implementation-trackers/model-independent-control-platform.md)

## The short version

Before this merge, the repository had several ways to manipulate DAW state, but there was no single model-independent semantic control platform that worked consistently across cloud and local desktop authorities. Desktop/native functionality also did not yet have the complete authenticated public adapter, native VST3 lifecycle, packaged recovery, and agent-discoverability surface that exists now.

After this merge:

- project control is defined by one canonical operation catalog;
- cloud and desktop implementations conform to the same semantic contracts;
- agents and external programs can use SDK, CLI, MCP, JSONL, REST, and authenticated desktop adapters without reaching into app internals;
- preview, approval, keyed idempotency, revision checks, history, and recoveries are first-class behavior;
- the Electron app owns a typed and authenticated desktop runtime boundary;
- macOS native audio and VST3 hosting are packaged product capabilities rather than loose internal experiments;
- VST3 discovery, trust, scanning, attachment, parameters, editor workers, state persistence, worker recovery, automation override, export, and restart behavior are defined and tested;
- renderer lifecycle and native transaction ownership fail closed across navigation, reload, crash, and ambiguous event sequences;
- cloud asset upload now validates real audio metadata from uploaded bytes and participates in the control/resource model;
- repository linting, anti-slop enforcement, compatibility tests, conformance tests, acceptance evidence, and agent skills were expanded to make these boundaries durable.

## 1. One canonical project-control architecture

The central architectural change is the split between contracts, pure semantics, target authorities, and adapters.

```text
UI / Extension / Agent / CLI / MCP
              |
        ControlClient
              |
        ControlInvoker
        /      |      \
      HTTP   Desktop   Direct
        \      |      /
         ControlHandler
              |
          control-core
              |
     canonical project state
```

The major ownership rules are now:

- `@daw-browser/control` owns versioned schemas, operation IDs, request envelopes, snapshots, serialization/digests, approval/recovery contracts, limits, capabilities, and compatibility aliases.
- `@daw-browser/control-core` owns pure planning and projection behavior, MIDI resolution, destructive transforms, and recovery ordering. It does not own transport or persistence.
- provider handlers bind the canonical semantics to a trusted authority: local desktop project state or authenticated cloud/Convex state.
- `ControlInvoker` validates target support and operation input/output at one catalog boundary.
- SDK, CLI, MCP, REST, JSONL, Electron, and extensions are adapters. They do not get to invent a second mutation language.

This separation is important because future UI, agent, extension, and automation work can target the same semantic layer instead of separately reproducing DAW mutation logic.

## 2. Canonical operation catalog

The project-control catalog now has nine operations:

| Operation | Targets | Purpose | Idempotency |
| --- | --- | --- | --- |
| `project.list` | cloud, desktop | discover accessible projects | safe |
| `project.current` | desktop | identify the currently mounted local project | safe |
| `control.capabilities` | cloud, desktop | discover supported actions and limits | safe |
| `control.snapshot` | cloud, desktop | read canonical project state and revision | safe |
| `control.preview` | cloud, desktop | validate and project a mutation without committing | safe |
| `control.requestApproval` | cloud, desktop | obtain bounded approval for a destructive request | none |
| `control.commit` | cloud, desktop | apply the exact previewed request | keyed |
| `control.history` | cloud, desktop | inspect committed control history | safe |
| `control.recoveries` | cloud, desktop | inspect active recovery records | safe |

`project.current` is deliberately desktop-only. It describes a mounted local project and is not a cloud concept.

Capabilities and snapshots use the canonical V2 representation for new integrations. Existing V1 compatibility surfaces remain available. Mutation, approval, history, and recovery request envelopes retain their established V1 contracts so the migration is additive instead of destructive.

## 3. Capability-first control replaces guessed behavior

A client is no longer supposed to infer what it can do from UI labels, package names, or prior knowledge.

The expected workflow is now:

1. discover the project;
2. request V2 capabilities;
3. request a V2 snapshot and revision;
4. construct schema-valid V1 actions from returned IDs and capabilities;
5. preview the exact request;
6. request approval if preview says approval is required;
7. commit the exact request with a stable idempotency key;
8. fetch a fresh snapshot and optionally history/recoveries.

On `revision-conflict`, the stale request must be discarded and rebuilt from a fresh snapshot. The platform does not encourage blind retries against stale IDs or revisions.

## 4. Complete project-action inventory

Cloud project control currently advertises these 39 semantic action kinds.

### Project and track actions

```text
project.rename
project.settings.set
track.create
track.rename
track.mix.set
track.routing.set
track.reorder
track.group.set
track.delete
track.collapsed.set
track.color.set
track.color.cascade
track.ungroup
```

### Clip and timeline actions

```text
clip.midi.create
clip.audio.create
clip.source.set
clip.midi.set
clip.fades.set
clip.audioWarp.set
clip.color.set
clip.move
clip.timing.set
clip.rename
clip.delete
timeline.range.delete
```

### Mixer and built-in processor actions

```text
master.volume.set
effect.upsert
effect.remove
effect.reorder
instrument.set
instrument.remove
arpeggiator.set
arpeggiator.remove
```

### Automation, routing, resources, and recovery

```text
automation.set
automation.delete
sidechain.set
sidechain.remove
asset.delete
recovery.restore
```

Local desktop project control adds one currently local-only semantic action when advertised by capabilities:

```text
external-plugin.parameters.set
```

That VST3 parameter action is intentionally not available on cloud projects and must never be assumed merely because a desktop host exists.

## 5. Preview, approval, idempotency, revisions, history, and recovery

The control platform makes mutation lifecycle behavior explicit.

### Preview

`control.preview` resolves references, validates action ordering and limits, projects the expected change, returns warnings/change summaries, and determines whether approval is required. Preview is non-mutating.

### Approval

Destructive operations use `control.requestApproval`. Approval is tied to the exact request digest/action selection and expires after the bounded approval lifetime. A token for one request cannot authorize a different request.

### Keyed commits

Every commit uses a stable idempotency key. Replaying the same semantic request with the same key is safe and does not create another mutation. Reusing the key for a different request is an idempotency conflict rather than a silent second operation.

### Revision conflicts

Snapshots carry revision state. Commits can require an expected revision. A stale revision fails explicitly instead of applying against unexpectedly changed project state.

### History

Successful canonical commits are recorded in bounded chronological history. An idempotent replay does not create duplicate history.

### Recoveries

Destructive operations can produce persisted recovery records. Current recovery-capable destructive kinds include:

```text
clip.delete
effect.remove
instrument.remove
arpeggiator.remove
automation.delete
sidechain.remove
asset.delete
track.delete
track.ungroup
timeline.range.delete
```

Recoveries expire after seven days and are restored through the canonical `recovery.restore` action.

Local recovery was extended to preserve native external-processor state references, shared opaque VST state artifacts, routing, grouping, and other affected project state without leaking implementation details into the public request format.

## 6. Public TypeScript SDK

`@daw-browser/control-sdk` is now the programmatic integration layer rather than requiring consumers to import CLI internals.

Important public surfaces include:

- `createCanonicalControlClient` for transport-neutral project discovery and canonical control;
- `createJsonlRpcAdapter` for bounded sequential JSON-RPC over JSONL;
- retained REST compatibility client behavior;
- `@daw-browser/control-sdk/desktop` with `connectDesktopControl(options?)` for authenticated packaged-desktop discovery and connection.

The desktop connection returns a typed invoker plus `close()`. It does not expose raw project stores, registration secrets, socket implementation details, or unrestricted Electron/native IPC.

## 7. CLI: `daw-control`

The CLI now exposes the canonical project workflow across cloud and attached desktop targets.

Project/control commands include:

```text
auth login --base-url <origin>
auth status
auth logout
capabilities [--target <cloud|host>]
capabilities-v2 [--target <cloud|host>]
project list [--target <cloud|host>]
project current --target host
snapshot <project-id> [--target <cloud|host>]
snapshot-v2 <project-id> [--target <cloud|host>]
preview --request <file|-> [--target <cloud|host>]
approval --request <file|-> [--target <cloud|host>]
commit --request <file|-> [--target <cloud|host>]
history <project-id> [--cursor <cursor>] [--limit <number>] [--target <cloud|host>]
recoveries <project-id> [--cursor <cursor>] [--limit <number>] [--target <cloud|host>]
rpc --target host
```

Host runtime commands remain intentionally separate:

```text
host status
host transport-status
host play
host pause
host stop
host seek <seconds>
host diagnostics
host import (--path <absolute-path>|--picker)
host export --request <file|->
host export-status
host export-cancel <job-id>
```

`rpc --target host` is canonical **project-control JSONL** over the authenticated desktop connection. It is not a generic escape hatch into host runtime/native commands.

The JSONL process path was hardened for malformed input, oversized lines, split UTF-8, notifications, sequential request ordering, and stdin flow behavior.

## 8. MCP support and agent discoverability

`@daw-browser/control-mcp` now exposes a model-friendly tool surface without adding convenience mutation APIs that bypass the canonical contracts.

Preferred V2 read tools:

```text
control_capabilities_v2
control_snapshot_v2
```

Compatibility reads:

```text
control_capabilities
control_snapshot
```

Project workflow tools:

```text
project_list
project_current
control_preview
control_request_approval
control_commit
control_history
control_recoveries
```

Desktop runtime tools:

```text
host_status
host_transport_status
host_play
host_pause
host_stop
host_seek
host_diagnostics
host_import_audio
host_export_run
host_export_status
host_export_cancel
host_vst_instances
host_vst_parameters
```

The MCP server instructions and schema descriptions now teach agents how to discover a project, prefer V2 reads, construct persisted references, preview, approve, commit, and recover without protocol-specific prompting.

Packaged acceptance included protocol-naive autonomous model runs. Two models independently discovered the mounted project, used the canonical V2 snapshot, built a persisted track reference, previewed, committed, and verified the resulting revision without being given DAW protocol instructions.

## 9. Cloud REST/OAuth control boundary

The Worker now exposes retained versioned control routes backed by the canonical handler/invoker semantics.

Core routes include:

```text
GET  /api/control/v1/capabilities
GET  /api/control/v2/capabilities
GET  /api/control/v1/projects
GET  /api/control/v1/projects/:projectId/snapshot
GET  /api/control/v2/projects/:projectId/snapshot
POST /api/control/v1/projects/:projectId/preview
POST /api/control/v1/projects/:projectId/approvals
POST /api/control/v1/projects/:projectId/commit
GET  /api/control/v1/projects/:projectId/history
GET  /api/control/v1/projects/:projectId/recoveries
```

OAuth control scopes distinguish reads from writes. Project access and role checks remain enforced at the Worker/Convex boundary. A bearer token is not permission to address arbitrary projects.

## 10. Cloud asset/resource control

Project assets remain resource APIs rather than pretending every storage operation is a project action.

The control resource family now includes:

```text
POST   /api/control/v1/projects/:projectId/assets
GET    /api/control/v1/projects/:projectId/assets/:assetId/content
DELETE /api/control/v1/projects/:projectId/assets/:assetId
POST   /api/control/v1/projects/:projectId/asset-folders
PATCH  /api/control/v1/projects/:projectId/asset-folders/:folderId
DELETE /api/control/v1/projects/:projectId/asset-folders/:folderId
PATCH  /api/control/v1/projects/:projectId/assets/:assetId/folder
```

Important upload behavior now includes:

- required bounded `Content-Length`;
- project write authorization;
- stable `Idempotency-Key`;
- lowercase `x-content-sha256` verification against actual bytes;
- supported audio MIME and extension matching;
- maximum upload size enforcement;
- audio metadata inspection from actual file bytes;
- duration metadata fast path with bounded MediaBunny duration fallback;
- sample rate/channel count persistence;
- begin-upload / R2 upload / finalize-upload coordination;
- typed user-media validation errors rather than mapping every parser/runtime failure to a client error.

The MediaBunny dependency was upgraded from the older branch baseline to `1.55.1`, including migration to the current quality API where encoding bitrate is specified while preserving existing target bitrate semantics.

Project deletion and resource cleanup were also tightened so both the asset-namespace prefix and project-owned backup/export prefix are queued through exact, fail-closed R2 prefix validation rather than leaving orphaned objects or authorizing overly broad prefixes.

## 11. Desktop protocol and authenticated host

Electron is now a real public authority boundary, not simply the browser app wrapped in a desktop window.

The desktop protocol owns:

- strict versioned request/reply framing;
- typed operation maps;
- registration discovery;
- authenticated local socket negotiation;
- request correlation;
- chunking/size limits;
- generation/lifecycle handling;
- host runtime status;
- native audio bridge contracts;
- application menu protocol;
- file capability boundaries;
- VST instance/parameter read schemas.

`registration-v1.json` remains a compatibility/discovery contract. Packaged acceptance verified private registration/socket permissions and adversarial cases including missing registration, malformed content, dead sockets, unsafe permissions, stopped hosts, and restart discovery.

The public SDK and CLI use the protocol client instead of manually reading socket internals.

## 12. Desktop runtime operation catalog

Desktop runtime operations are deliberately separate from semantic project control:

```text
host.status
host.vst.instances
host.vst.parameters
host.import.audio
host.export.run
host.export.status
host.export.cancel
transport.status
transport.play
transport.pause
transport.stop
transport.seek
diagnostics.snapshot
```

This split prevents a transport command such as Play from masquerading as a durable project mutation and prevents project-control adapters from becoming generic native RPC tunnels.

## 13. Local desktop import, playback, export, and media hydration

The packaged desktop host gained validated public runtime flows for:

- transport status/play/pause/stop/seek;
- local audio import through picker or absolute bounded media path;
- mounted-project media persistence;
- cold-restart media hydration;
- native/portable export dispatch;
- export status and cancellation;
- safe output path capabilities;
- host diagnostics.

Several packaged bugs were found and fixed while proving those boundaries, including canonical `/tmp` versus `/private/tmp` path handling, renderer reply serialization of optional errors, stale transport-stop responses, file metadata/context-bridge incompatibility, duplicate export request IDs, missing-media hydration after restart, output capability path canonicalization, native PCM queue overflow, and Bun stdin chunk loss in JSONL mode.

## 14. Native VST3 hosting is now a first-class desktop capability

The merge introduces the complete macOS packaged VST3 path.

### Discovery

Standard VST3 directories are initialized automatically:

```text
/Library/Audio/Plug-Ins/VST3
~/Library/Audio/Plug-Ins/VST3
```

Catalog entries are revalidated rather than treated as permanent launch permission.

### Trust and scanning

First native execution is consent/trust-gated. The scanner/launch path validates canonical bundle placement, executable existence, quarantine state, strict code signing, arm64 compatibility, protocol-compatible scanner output, and bundle/executable fingerprints.

Trusted stale catalog entries self-heal by revalidation/rescan when possible. A changed bundle is not launched simply because an older record was once trusted.

### Process model

The desktop/native architecture separates:

- Electron main/preload authority;
- native audio host;
- VST scanner;
- realtime playback workers;
- editor workers/windows;
- bounded control/shared-memory transport.

Playback and editor lifecycles are separate so opening a native editor does not make the Electron renderer the owner of foreign plugin UI or DSP execution.

### Attachment and graph publication

VST attachments are resolved from trusted catalog identity, preflighted against packaged artifact/protocol/ABI/class/bus/parameter/state expectations, and committed through the native transaction/graph publication path.

The final packaged campaign also uncovered and fixed a real TypeScript/native protocol mismatch: the TypeScript attachment serializer emitted the extended parameter-ID payload while the native decoder previously required the payload to stop after initial values. The decoder now accepts and bounds the current extension rather than rejecting valid packaged attachments.

### Parameters

Public reads:

```text
host.vst.instances
host.vst.parameters
```

Public semantic write, only when local capabilities advertise it:

```text
external-plugin.parameters.set
```

The platform intentionally does not expose public arbitrary plugin insertion/removal, scanner control, worker process control, or arbitrary native editor manipulation.

### State and persistence

Opaque VST state is bounded and hash-validated. Stateful attachments persist/capture supported state for rebuilds, editor lifecycle, export, and cold restart. Stateless plugins are recreated from defaults plus persisted parameters.

Shared local state artifacts are reference-aware: deleting one processor does not destroy an artifact still referenced by another processor, and recovery can reuse an existing identical immutable artifact while failing closed on same-ID/different-content corruption.

### Worker loss and native host recovery

Worker/native-host loss no longer leaves the mounted graph permanently dead. The supervisor supports bounded canonical rebuild behavior, stale generation rejection, process cleanup, and restart limits while preserving trust/preflight requirements.

### Editor lifecycle

Editor-capable plugins can open, close, focus, and resize worker-local native editor windows. Parameter/editor events return through typed notifications. Editor state capture and teardown are generation-safe.

### Automation override

Manual VST parameter edits now override scheduled automation at both renderer and native layers. Native override reservation uses one authoritative insertion path, handles tombstones correctly, preserves existing overrides, and rolls back only newly-added overrides if queueing fails.

Explicit automation re-enable clears the selected override. The certified product flow currently requires stopped transport before re-enable succeeds.

### Export

Native export resolves and preflights attachments again rather than trusting the live graph. The export lifecycle was fixed so completed renders are not held hostage by synchronous plugin teardown and offline workers do not initialize unused AppKit editor state.

Current Native Phase A export remains intentionally limited: projects containing automation are rejected. A VST project without automation was independently exported successfully in packaged acceptance.

## 15. Real packaged VST3 acceptance

ValhallaSupermassive 5.0.0 arm64 was used as the real installed plugin acceptance target.

Verified behavior included:

- standard-directory discovery;
- trust-gated scan;
- readiness and insertion;
- 19 real parameters;
- native editor launch;
- Mix parameter edit from 0.50 to 0.51 with independent public MCP verification;
- playback;
- deliberate playback-worker termination and bounded replacement/recovery;
- cold restart with plugin/parameter state preserved;
- stale-catalog corruption followed by automatic self-heal;
- repeated one-second stereo 48 kHz PCM WAV exports of 192,044 bytes;
- manual automation override and explicit re-enable;
- renderer reload/crash recovery while native state remained usable.

The final browser acceptance also covered non-VST project editing, routing, import, playback/seek, built-in EQ/Synth, reload/cold-session media hydration, settings, shortcuts, and a one-second nonzero export.

## 16. Renderer lifecycle and transaction ownership hardening

Electron renderer lifetime is now treated as a security/correctness boundary.

The renderer lifecycle owner tracks committed document generations and full main-frame navigation attempts instead of using a simple reload flag. Important behaviors include:

- same-document and subframe navigations do not invalidate ownership;
- a full outgoing navigation invalidates privileged requests and active manual native transactions;
- a committed new document activates a fresh generation;
- failed/cancelled navigation can restore the still-live prior document only when the outcome is unambiguous;
- renderer crash invalidates ownership and cannot be undone by late navigation events;
- stale generations cannot commit old native transactions;
- overlapping same-URL navigations fail closed because Electron does not provide a reliable navigation ID for correlation;
- retired ambiguous navigation identities are quarantined so delayed outcomes cannot be mistaken for a later redirect/commit;
- quarantine state is bounded; overflow becomes an allocation-free fail-closed state until renderer crash recovery;
- the public/test-only shortcut for activating a document outside the real commit boundary was removed.

This work prevents dead renderers or ambiguous navigation events from retaining privileged native transaction ownership.

## 17. Local/cloud semantic parity and conformance

The branch added reusable conformance coverage so local IndexedDB authority and cloud/Convex authority are tested against the same project-control expectations.

Conformance includes:

- discovery;
- capabilities;
- canonical snapshots;
- preview non-mutation;
- approval requirements;
- commit behavior;
- idempotent replay/conflict;
- revision conflicts;
- history;
- recoveries;
- schema rejection;
- target restrictions;
- project authorization differences.

Cloud track-delete/ungroup recovery was corrected to preserve survivor group/output routing instead of reconstructing partial state by hand. Local destructive recovery gained VST-aware behavior through an explicit planner capability rather than falsifying the planner snapshot.

## 18. Built-in extension kernel

The branch introduced a trusted app-local extension kernel for statically imported built-ins.

It provides:

- validated command/shortcut declarations;
- atomic staged activation;
- generation-safe cleanup;
- bounded diagnostics;
- abort signals;
- stable contribution IDs;
- controlled command replacement;
- narrow application facades;
- project-action grants that still route through preview/approval/commit.

The existing browser toggle shortcut was composed through the kernel while preserving application-owned state and keyboard behavior.

External extension packages, arbitrary package/DSP loading, and a public arbitrary operation endpoint remain explicitly out of scope.

## 19. Security and trust-boundary changes

The control/native work tightened several security-sensitive boundaries:

- control actions are schema-validated through a single catalog;
- project access stays behind local authority or authenticated Worker/Convex authority;
- OAuth read/write scopes are explicit;
- approval tokens are exact-request bound and expiring;
- desktop registration/socket discovery is private and validated;
- renderer privileged requests are generation-bound;
- output/import paths use capability checks and canonicalization;
- R2 deletion prefixes are exact/fail-closed;
- uploaded audio is byte-validated instead of trusting caller metadata;
- native frames, shared memory, state size, parameter counts, worker limits, deadlines, and artifact manifests are bounded;
- VST catalog identity is revalidated at launch;
- plugin fingerprints/signatures/quarantine/architecture are checked at the native boundary;
- worker crashes are contained/recovered instead of making stale state authoritative.

One trust statement is especially important: VST3 worker processes are primarily crash/availability isolation. Third-party plugins are native code running with the desktop user's authority; this merge does **not** claim malicious plugins are safely sandboxed. Users should install and run only trusted plugins.

## 20. Tooling, linting, tests, and review gates

This branch substantially expanded repository quality enforcement.

Important gates now include:

```text
bun run lint
bun run test:anti-slop
bun run typecheck
bun test
bun run test:control-platform
bun run test:control-compat
bun run build
native CTest
Electron package/release artifact verification
```

Anti-slop rules are wired into Oxlint and the RuleTester suites run under Node where required. Root `bun test` was restored to zero failures rather than accepting a red repository gate.

The final certified state reported:

- 2,433 Bun tests passed;
- 1 intentional skip;
- 0 Bun test failures;
- 161 control-platform tests passed;
- 40 control-compatibility tests passed;
- 12 anti-slop RuleTester suites passed;
- repository Oxlint: 0 warnings, 0 errors;
- TypeScript checks passed;
- native CTest: 6/6 passed at the runtime-certified ancestor;
- production build passed;
- final Electron packaging and native artifact checks passed during runtime certification;
- final correctness, structural, simplification, defensive, and security review passes found no merge blocker.

## 21. Agent-facing repository documentation and shared skills

The repository now contains current agent operating documentation instead of relying on hidden implementation knowledge.

New/current docs:

- `docs/control-platform.md`
- `docs/agent-control.md`
- `docs/native-vst3.md`

Repo-scoped Factory skills were added for discovery by future coding agents:

```text
.factory/skills/daw-project-control/SKILL.md
.factory/skills/daw-desktop-runtime/SKILL.md
.factory/skills/daw-vst3/SKILL.md
```

Those skills explicitly separate semantic project mutations, desktop runtime operations, and VST-specific trust/acceptance behavior.

`AGENTS.md` was updated so agents are directed to the public control boundaries rather than the old Workers AI/agent-route assumptions. Local Factory settings, captures, threat models, and credentials remain ignored; only intentional repo skill manifests are unignored.

## 22. Documentation and historical cleanup

The README was rewritten to describe the repository as a browser + cloud + Electron/native DAW rather than a browser-only product.

The model-independent-control implementation tracker is now marked completed/historical and points to current operating docs.

Temporary branch-local advisor plans 001–010 were removed after the work they described was implemented and certified.

The stale checked-in `security-findings.json` that identified itself as an August 17 working-tree scan was removed so it cannot be mistaken for exact-head certification evidence. The meaningful VST native-code trust boundary is now documented in the current native VST3 reference.

Old AI/agent route assumptions were removed from current guidance. The supported automation story after this merge is the explicit model-independent control platform, not hidden application-specific agent mutations.

## 23. Compatibility that was deliberately preserved

This was a large architecture change, but compatibility was intentionally additive.

Preserved compatibility surfaces include:

- V1 and V2 control contracts;
- V1/V2 snapshot/capability projections;
- retained REST routes;
- CLI commands;
- MCP compatibility tools;
- desktop V1/V2 framing where applicable;
- `registration-v1.json` discovery;
- durable local control/history/recovery markers where migration evidence required them.

A large change is not permission to delete an older surface without deployed/external consumer evidence.

## 24. Current limitations and intentionally deferred scope

The merge does not claim these are solved:

- native VST3 loading in browser or cloud targets;
- public arbitrary VST insertion/removal/editor/process control;
- malicious-plugin sandboxing;
- cloud JSONL process transport;
- public arbitrary operation RPC;
- external extension package loading;
- arbitrary DSP/package loading;
- portable/cloud opaque VST state transport;
- a packaged extension activation/deactivation/reload product surface;
- Native Phase A export for projects containing automation.

Observed current product behavior also requires transport to be stopped before the automation-reenable flow succeeds.

The packaged exact-overlap same-URL Electron event sequence cannot be deterministically forced/proven via CDP, so the executable lifecycle state-machine tests are the authority for that specific ambiguous-event case.

## 25. What integrators and contributors should do differently now

If you are adding an agent, extension, CLI command, MCP tool, REST adapter, or external integration after this merge:

- do not create a new mutation language;
- start with `control.capabilities` and `control.snapshot`;
- prefer canonical V2 reads for new consumers;
- use the existing V1 mutation envelopes;
- construct persisted references from the latest snapshot;
- preview before commit;
- request approval only when preview requires it;
- reuse idempotency keys only for the identical request;
- rebuild after revision conflict;
- keep runtime transport/import/export/VST reads separate from semantic project actions;
- use `external-plugin.parameters.set` only when local capabilities advertise it;
- use the SDK/desktop protocol client instead of reading registration/socket internals;
- preserve native trust/preflight/state bounds;
- never directly mutate Convex, IndexedDB, plugin state artifacts, or raw native frames when a public boundary exists.

## 26. Certification trail

The runtime-certified ancestor was `37e400e42bcde874926d45e952a91ceb5080c94d`. Two following commits changed only documentation, shared Factory skill manifests, ignore/tracker hygiene, acceptance reporting, and stale review artifacts. The final reviewed PR head was `3cff4bf5af63a8eb8fd6823babd0c119d1bb3d67`.

Cloudflare successfully built/deployed the exact final PR head before merge. PR #47 was then merged into `master` with merge commit `b4bf014d5d9e95e82cff64df8c78a44ae46ae138`.

For the detailed runtime matrix, individual bugs discovered during packaged testing, and temporary evidence locations, use the [packaged runtime acceptance report](../../acceptance-reports/control-platform-runtime-2026-08-20.md). For historical checkpoint-by-checkpoint implementation context, use the [completed tracker](../../implementation-trackers/model-independent-control-platform.md).
