# Post-Merge Improvements Tracker

## Purpose

This tracker captures the non-blocking review notes from the final `local-first-refactor` PR pass and turns them into a concrete implementation plan for the next branch after PR #9 merges into `master`.

It exists to:

- preserve every follow-up that was intentionally not treated as a merge blocker
- ground each improvement in current repo files and external/current documentation
- avoid re-discovering the same cleanup work after merge
- give the next branch a phase-by-phase implementation and validation sequence
- keep the work focused on maintainability, protocol clarity, bundle size, and local-first durability without changing the just-merged behavior by accident

This tracker should be updated during the follow-up branch with implementation notes, rejected candidates, browser/runtime evidence, PR review findings, and final validation artifacts.

---

## Branch

- Source branch that produced these follow-ups: `local-first-refactor`
- Base after merge: `origin/master`
- Next branch name suggestion: `post-local-first-cleanup`
- PR that generated the final review notes: `#9 Complete local-first project workflows`
- Last reviewed head before this tracker was created: `fd1a4e1 fix: refresh local timeline after cloud restore`

---

## Current Merge Readiness Context

These follow-ups are **not** merge blockers for PR #9.

Already completed before this tracker:

- `bun run typecheck` passed
- `git diff --check` passed
- `bun run knip` passed
- `bun run build` passed with existing large-chunk warnings
- Cloudflare Workers build check passed
- PR merge state returned `CLEAN`
- Blocking restore bug fixed in `fd1a4e1`

The next branch should start from merged `master`, not from the still-open PR branch, unless the PR is intentionally not merged yet.

---

## Review Notes To Carry Forward

### Functional / correctness

- [x] Validate and simplify the defensive track-routing fallback in `src/lib/undo/exec.ts`.
  - Not a current bug.
  - Goal: remove unreachable fallback only if proven by `buildHistoryRefIndex`, `resolveTrackId`, and current `deps.getTracks()` semantics.

### Maintainability / architecture

- [x] Move pure cross-runtime contracts from `src/lib` into `shared/`.
- [x] Consolidate the shared timeline operation protocol into one registry/source of truth.
- [x] Continue extracting `src/components/Timeline.tsx` into smaller orchestration units.
- [x] Deduplicate asset ID helper semantics between `createLocalAssetId` and `createAudioAssetKey`.
- [x] Deduplicate initial/default track construction between `createLocalProject` and local timeline repository track creation.
- [x] Deduplicate local entity row wrapper helpers used by timeline/cache modules.

### Performance / bundle size

- [x] Investigate Vite large chunk warnings and split heavy Solid components/routes where it improves startup cost.

---

## Research Notes

## Cleanup-2 Progress Log

- [x] Created `cleanup-2` from fast-forwarded `master` after PR #9 merge.
- [x] Added shared contract files for timeline operations, project manifests, R2 delete keys, audio source rules, clip timing, track routing, effect params, agent commands, command targets, and local IDs.
- [x] Replaced the corresponding `src/lib` contract implementations with compatibility re-export wrappers so existing frontend imports continue to work while API/Convex can depend on `shared/`.
- [x] Updated API/Convex pure contract imports away from `src/lib` where the dependency is now shared-runtime safe.
- [x] Kept remaining `api/agent-actions.ts` imports from `src/lib/clip-create`, `src/lib/audio-source`, and `src/types/timeline` for now because those are mixed runtime/application helpers rather than pure contract-only modules.
- [x] Deduplicated `createAudioAssetKey` by aliasing it to `createLocalAssetId`.
- [x] Added `buildTimelineTrackRow` and reused it for both local project initialization and local timeline track creation.
- [x] Added `createLocalProjectEntityRow` and reused it in local timeline repository/cache writers.
- [x] Proved the undo routing fallback was redundant: `resolveTrackId` uses the current track-derived history index, so the resolved ID should be present in the same track list. Replaced the fallback with an explicit `requireResolved`.
- [x] Validation after this cleanup slice: `bun run typecheck`, `git diff --check`, `bun run knip`, and `bun run build` passed.
- [x] Build still reports the existing large client `Timeline` chunk warning and stale `baseline-browser-mapping` warning; no new blocking build failure.
- [x] Extracted the recording/transport bridge from `src/components/Timeline.tsx` into `src/hooks/useTimelineRecordingTransport.ts` so pause/stop/record behavior has a focused owner.
- [x] Validation after the `Timeline.tsx` extraction: `bun run typecheck`, `git diff --check`, `bun run knip`, and `bun run build` passed.
- [x] Consolidated shared timeline operation metadata into a descriptor registry in `shared/shared-timeline-operations.ts`; parsing, target extraction, operation kinds, and durable queue metadata now share one source.
- [x] Updated the shared outbox to accept only descriptor-marked durable timeline operation kinds; recording lock/unlock remain non-durable.
- [x] Investigated additional bundle splitting. Existing lazy panels already split `AgentChat`, `SharedChat`, `EffectsPanel`, `ExportDialog`, `MidiEditorCard`, `GridOverlay`, and `RecordingPreview`.
- [x] Tried splitting always-visible timeline chrome/workspace/track/menu components, then rejected and reverted it after review because it caused blank `Suspense` fallbacks and extra startup chunk requests for above-the-fold UI.
- [x] Added a focused Vite manual chunk for `src/lib/audio-engine*`, creating a reusable `audio-engine` chunk while keeping always-visible Solid UI eager.
- [x] Bundle evidence: before the final bundle pass, `Timeline` was ~560.27 kB minified / 158.37 kB gzip; after the audio-engine chunk it is ~519.81 kB / 147.72 kB gzip plus `audio-engine` ~41.57 kB / 11.41 kB gzip. The >500 kB warning remains, but the remaining size is core timeline startup code, so it is documented rather than hidden by raising the warning limit.
- [x] Final review agents checked reuse, quality, and efficiency; their core lazy-loading findings were addressed by reverting always-visible UI lazy splits.

---

### Current codebase evidence

#### Cross-runtime imports from `src/lib`

Current API/Convex code imports pure contracts from frontend-oriented paths:

- `api/routes/timeline-operations.ts` imports `../../src/lib/shared-timeline-operations`
- `api/timeline-operation-executor.ts` imports `../src/lib/shared-timeline-operations`
- `api/routes/cloud-backups.ts` imports `../../src/lib/project-manifest-contract` and `../../src/lib/r2-delete-keys`
- `api/agent-actions.ts` imports from:
  - `../src/lib/agent-commands`
  - `../src/lib/clip-create`
  - `../src/lib/audio-source`
  - `../src/lib/audio-source-rules`
  - `../src/lib/effects/params`
  - `../src/lib/agent-command-targets`
  - `../src/types/timeline`
- `convex/clips.ts` imports `../src/lib/clip-timing` and `../src/lib/audio-source-rules`
- `convex/effects.ts` imports `../src/lib/effects/params`
- `convex/trackRouting.ts` imports `../src/lib/track-routing-core`
- `convex/cloudBackups.ts` imports `../src/lib/project-manifest-contract`
- `convex/r2Deletes.ts` and `convex/exports.ts` import `../src/lib/r2-delete-keys`

The preferred pattern already exists:

```ts
import type { ProjectRole } from "../shared/project-role"
```

#### Shared timeline operation protocol drift risk

`src/lib/shared-timeline-operations.ts` currently owns several related concerns in one long file:

- `SharedTimelineOperation` union
- `SharedTimelineOperationKind`
- `readSharedTimelineOperationTargets`
- `sharedTimelineOperationKinds`
- `isSharedTimelineOperationKind`
- manual payload readers such as `readSharedTimelineClipCreatePayload`, `readEqParams`, `readReverbParams`
- `parseSharedTimelineOperation`
- `sharedTimelineOperationSchema`

The operation execution path then uses the protocol from:

- `api/routes/timeline-operations.ts`
- `api/timeline-operation-executor.ts`
- `src/lib/shared-outbox.ts`
- `src/lib/shared-timeline-operations-api.ts`

The risk is future drift: adding a new operation requires editing the union, kind list, parser, target reader, outbox behavior, and executor.

#### Timeline orchestration size

`src/components/Timeline.tsx` is currently about 975 lines. It wires many controller hooks and still owns central orchestration, including data, projection, persistence, mixer, clip actions, recording, drag/drop, keyboard, playback, chrome, dialogs, and resolved render state.

Related already-extracted hooks/components include:

- `src/hooks/useTimelineData.ts`
- `src/hooks/useTimelineProjectionState.ts`
- `src/hooks/useTimelinePersistenceController.ts`
- `src/hooks/useTimelineMixerController.ts`
- `src/hooks/useTimelineClipActions.ts`
- `src/hooks/useTimelineClipImport.ts`
- `src/hooks/useTimelineDragDrop.ts`
- `src/hooks/useTimelineHistory.ts`
- `src/components/timeline/timeline-workspace.tsx`
- `src/components/timeline/timeline-chrome.tsx`
- `src/components/timeline/timeline-panels.tsx`

The follow-up should continue extracting around real ownership boundaries, not introduce a generic app shell.

#### Duplication candidates

- `src/lib/local-ids.ts`
  - `createLocalAssetId()` returns `asset:${crypto.randomUUID()}`
- `src/lib/audio-source.ts`
  - `createAudioAssetKey()` also returns `asset:${crypto.randomUUID()}`
- `src/lib/local-project-db.ts`
  - `createLocalProject()` constructs the first default track inline
- `src/lib/timeline-repository/local-timeline-repository.ts`
  - `createTrack()` constructs timeline track rows with the same defaults
- `src/lib/remote-timeline-cache.ts`
  - local `toEntityRow()` duplicates the entity wrapper shape used by the local repository
- `src/lib/timeline-repository/local-timeline-repository.ts`
  - local `toEntityRow()` does the same shape with a default timestamp

#### Defensive fallback candidate

`src/lib/undo/exec.ts` currently does:

```ts
const trackId = requireResolved(resolveTrackId(index, entry.data.trackRef), 'Track not found for track-routing history entry')
const track = deps.getTracks().find((entryValue) => entryValue.id === trackId)
const routing = resolveTrackRoutingSnapshot(index, pickDirectionalValue(direction, entry.data.from, entry.data.to))
const normalizedRouting = track ? normalizeTrackRouting(track, routing, deps.getTracks()) : routing
```

The fallback to raw `routing` may be redundant because `trackId` was resolved from the same track set. The next branch should prove or reject that before changing it.

### Documentation / external research

- SolidJS `createEffect` docs: effects automatically track reactive reads made inside the effect. This supports using explicit accessors as reload triggers where needed, but also means accidental reads can widen dependencies.
  - https://docs.solidjs.com/reference/basic-reactivity/create-effect
- SolidJS `lazy` docs: `lazy(() => import(...))` supports component-level code splitting and integrates with `Suspense`.
  - https://docs.solidjs.com/reference/component-apis/lazy
- Zod docs: discriminated unions and schema composition can model protocol variants more directly than ad hoc parser branches when the payload is schema-friendly.
  - https://zod.dev/api
- Hono docs surfaced `Zod OpenAPI` and validator error-handling examples. Relevant if the follow-up adds route-local validation wrappers or wants typed route docs around the timeline operation endpoint.
  - https://hono.dev/examples/zod-openapi
  - https://hono.dev/examples/validator-error-handling
- Cloudflare Workers docs: Workers Static Assets and the Cloudflare Vite plugin support serving Vite output and assets through the Worker assets binding. Bundle work should preserve current Cloudflare Vite plugin behavior rather than replace deployment shape.
  - https://developers.cloudflare.com/workers/static-assets/
  - https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/
- MDN OPFS docs: OPFS is origin-private browser storage, useful for local-first asset durability but not user-visible filesystem organization.
  - https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- Vite/Rollup docs should be consulted during the bundle phase for `build.rollupOptions.output.manualChunks`, but route/component-level splitting should be tried before manual chunk policy.
  - https://vite.dev/config/build-options
  - https://rollupjs.org/configuration-options/#output-manualchunks

### Patterns from `/Users/juan/Documents/monorepo-new`

Use these as inspiration, not as code to copy blindly.

#### Shared package contracts

Files:

- `/Users/juan/Documents/monorepo-new/packages/shared/src/schemas.ts`
- `/Users/juan/Documents/monorepo-new/packages/shared/src/types.ts`
- `/Users/juan/Documents/monorepo-new/packages/shared/src/index.ts`

Pattern:

- central Zod schemas define cross-boundary payloads
- inferred TS types are consumed by API/web callers
- discriminated unions model file/media references and generation modes

Adaptation:

- move only pure DAW contracts to this repo's `shared/`
- avoid importing browser-only helpers, Convex-generated types, or UI types into `shared/`
- keep runtime adapters in their current layers

#### IndexedDB/project DB organization

Files:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/db/global-db.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/db/project-db.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/db/migrations.ts`

Pattern:

- global DB for project/directory metadata
- per-project DB for project content
- named migration functions
- coalesced writers for entity and world-state persistence

Adaptation:

- this repo already uses the same broad global/per-project DB shape
- the improvement is not to redesign persistence, but to reuse helper factories and make migrations/default builders easier to reason about
- do not add broad polling or hidden write loops; existing project guidance forbids unnecessary timers

#### Timeline decomposition

Files:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/timeline/timeline.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/timeline/render/*.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/timeline.tsx`

Pattern:

- timeline math/state lives behind `createTimeline()`
- rendering responsibilities are split by track/ruler/background/clip/playhead/marquee modules

Adaptation:

- this repo already has strong hooks and timeline subcomponents
- the next useful extraction is a small orchestration model around `Timeline.tsx`, not a wholesale engine port

#### Media asset identity

Files:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/db/schemas.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/ecs/assets.ts`
- `/Users/juan/Documents/monorepo-new/packages/shared/src/schemas.ts`

Pattern:

- discriminated asset schemas by media kind
- storage references are separated from runtime resolver behavior

Adaptation:

- preserve this repo's local/R2/Convex asset mapping
- consider a shared `AssetRef`/`AudioAssetId` contract only if it reduces actual cross-boundary duplication

---

## Implementation Phases

## Phase 0 — Branch Baseline And Safety

### Goal

Start from merged `master`, verify the baseline, and avoid mixing cleanup with unrelated feature work.

### Checklist

- [x] Merge PR #9 into `master`.
- [x] Create follow-up branch from updated `master` (`cleanup-2`).
- [x] Run baseline validators:
  - [x] `bun run typecheck`
  - [x] `git diff --check`
  - [x] `bun run knip`
  - [x] `bun run build`
- [x] Record any existing warnings before changing code.
- [x] Confirm no local-first behavior changes are planned for Phase 1 unless explicitly listed.

### Validation evidence

- [x] Baseline command output captured in tracker or PR notes.

---

## Phase 1 — Move Pure Cross-Runtime Contracts To `shared/`

### Goal

Make API, Convex, and frontend depend on a neutral contract layer instead of importing pure contracts from `src/lib`.

### Files to audit

Likely pure contract candidates:

- `src/lib/shared-timeline-operations.ts`
- `src/lib/audio-source-rules.ts`
- `src/lib/effects/params.ts`
- `src/lib/track-routing-core.ts`
- `src/lib/clip-timing.ts`
- `src/lib/project-manifest-contract.ts`
- `src/lib/r2-delete-keys.ts`
- `src/lib/agent-commands.ts`
- `src/lib/agent-command-targets.ts`

Likely files to update:

- `api/routes/timeline-operations.ts`
- `api/timeline-operation-executor.ts`
- `api/routes/cloud-backups.ts`
- `api/agent-actions.ts`
- `api/indexing.ts`
- `api/clip-targets.ts`
- `api/r2-delete-queue.ts`
- `convex/clips.ts`
- `convex/effects.ts`
- `convex/sampleRows.ts`
- `convex/trackRouting.ts`
- `convex/cloudBackups.ts`
- `convex/r2Deletes.ts`
- `convex/exports.ts`
- frontend callers currently importing moved files from `~/lib/*`

### Proposed shape

Move only pure contracts:

```ts
// Before: api/routes/timeline-operations.ts
import { sharedTimelineOperationSchema } from "../../src/lib/shared-timeline-operations"

// After
import { sharedTimelineOperationSchema } from "../../shared/shared-timeline-operations"
```

Keep browser/API adapters where they belong:

```ts
// Stays frontend-only: src/lib/shared-timeline-operations-api.ts
export const publishSharedTimelineOperation = async (
  projectId: string,
  operation: SharedTimelineOperation,
): Promise<unknown> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/timeline/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(operation),
  })
  // ...
}
```

### Rules

- [x] Do not move functions that touch `window`, `File`, `AudioBuffer`, `fetch`, Solid, Convex client instances, or UI types.
- [x] Do not move generated Convex types into `shared/`.
- [x] If a contract currently imports browser/runtime types, split the portable shape from the runtime adapter.
- [x] Prefer one file per domain contract over a single giant `shared/index.ts`.
- [x] Keep import paths boring and direct; avoid large re-export barrels unless they already serve multiple real consumers.

### Risks

- Moving too much can couple `shared/` to frontend runtime APIs.
- Moving too little leaves API/Convex imports from `src/lib` and fails the goal.
- `project-manifest-contract.ts` may need small shared row types to avoid importing local DB implementation details.

### Validation

- [x] `bun run typecheck`
- [x] `git diff --check`
- [x] `bun run knip`
- [x] `bun run build`
- [x] Grep check: API/Convex should not import pure contracts from `../src/lib/*` unless the remaining import is intentionally runtime-specific and documented.

---

## Phase 2 — Consolidate Shared Timeline Operation Protocol

### Goal

Reduce operation protocol drift by making each operation's kind, schema/parser, target extraction, queue behavior, and execution mapping visible from one source of truth.

### Current problem

Adding one operation currently requires touching multiple protocol surfaces:

- union type
- manual payload parsing
- kind array
- kind set
- target reader switch
- API executor switch
- outbox queueability behavior
- frontend operation builder if it needs stable IDs

### Proposed shape

Create a shared registry for protocol metadata and keep execution in the API layer.

Example direction:

```ts
// shared/shared-timeline-operations.ts
const trackIdPayload = z.object({ trackId: z.string() })

export const sharedTimelineOperationDescriptors = {
  "tracks.lock": {
    schema: z.object({ kind: z.literal("tracks.lock"), payload: trackIdPayload }),
    targets: (payload: { trackId: string }) => ({ trackIds: new Set([payload.trackId]), clipIds: new Set<string>() }),
    durableQueue: false,
  },
  "tracks.setVolume": {
    schema: z.object({
      kind: z.literal("tracks.setVolume"),
      payload: z.object({ trackId: z.string(), volume: z.number() }),
    }),
    targets: (payload: { trackId: string }) => ({ trackIds: new Set([payload.trackId]), clipIds: new Set<string>() }),
    durableQueue: true,
  },
} as const
```

Then derive:

```ts
export const sharedTimelineOperationKinds = Object.keys(sharedTimelineOperationDescriptors)
export const isSharedTimelineOperationKind = (value: unknown): value is SharedTimelineOperationKind =>
  typeof value === "string" && value in sharedTimelineOperationDescriptors
```

The exact implementation may need a small helper to preserve TypeScript inference. If a fully-derived discriminated union becomes too complex, keep the existing union type but still use one descriptor map for kind/target/queue metadata.

### Scope

- [x] Move the protocol to `shared/` first if Phase 1 has not done so.
- [x] Define operation descriptors.
- [x] Derive `isSharedTimelineOperationKind` from descriptors.
- [x] Route `readSharedTimelineOperationTargets` through descriptor metadata.
- [x] Keep `api/timeline-operation-executor.ts` as the executor owner, but align its switch with descriptor kinds.
- [x] Keep recording lock/unlock intentionally non-durable unless product requirements change.

### Files likely touched

- `shared/shared-timeline-operations.ts`
- `src/lib/shared-timeline-operations-api.ts`
- `src/lib/shared-outbox.ts`
- `api/routes/timeline-operations.ts`
- `api/timeline-operation-executor.ts`
- operation callers in:
  - `src/lib/timeline-clip-write-adapter.ts`
  - `src/hooks/useTrackRecording.ts`
  - clip import/history/mixer/effects paths

### Validation

- [x] `bun run typecheck`
- [x] `git diff --check`
- [x] `bun run knip`
- [x] `bun run build`
- [ ] Runtime smoke: queue and flush at least one durable track operation and one clip operation through `/api/projects/:projectId/timeline/operations`.
  - Not run in this CLI-only pass because it needs a live authenticated/shared project session.

---

## Phase 3 — Continue Extracting `Timeline.tsx`

### Goal

Reduce `Timeline.tsx` from a near-1k-line orchestration component into smaller consumer-shaped units while preserving current behavior.

### Do not do

- Do not rewrite the timeline engine.
- Do not introduce a generic event bus.
- Do not split static JSX just to split files.
- Do not make all hooks generic; shape them around the real `Timeline.tsx` consumer.

### Candidate extractions

#### 1. Project/menu model

Move the project menu/chrome object assembly near the existing menu types.

Potential files:

- new `src/hooks/useTimelineProjectMenuModel.ts`
- existing `src/components/timeline/transport-types.ts`
- existing `src/components/timeline/projects-menu.tsx`

#### 2. Recording transport bridge

Extract the bridge that maps recording state into transport pause/stop/record actions.

Potential file:

- new `src/hooks/useTimelineRecordingTransport.ts`

Status:

- [x] Implemented `src/hooks/useTimelineRecordingTransport.ts`.
- [x] `Timeline.tsx` now delegates recording-aware pause, stop, and record toggle handlers to this hook.

#### 3. Timeline command handlers

Group add-track, keyboard, delete-track confirmation, and high-level command handlers that currently live inline in `Timeline.tsx`.

Potential file:

- new `src/hooks/useTimelineCommandHandlers.ts`

#### 4. Render model update effect

Move the `resolvedTracks()` to `renderTracks` effect into a tiny hook if it reduces state readers in `Timeline.tsx`.

Potential file:

- new `src/hooks/useTimelineRenderTracks.ts`

Example:

```ts
export const useTimelineRenderTracks = (tracks: Accessor<Track[]>) => {
  const [renderTracks, setRenderTracks] = createSignal<Track[]>([])

  createEffect(() => {
    setRenderTracks(tracks())
  })

  return renderTracks
}
```

Only use this if it makes the callsite simpler; avoid adding a hook for one trivial local signal if the extraction creates more tracing.

### Monorepo inspiration

`monorepo-new` separates timeline math/render responsibilities into focused modules under `components/engine/timeline/`. Adapt that direction by continuing focused module boundaries here:

- ruler math belongs near `TimelineRuler`
- workspace layout belongs near `timeline-workspace`
- project menu shape belongs near `projects-menu`
- audio/transport orchestration belongs near playback/recording hooks

### Validation

- [x] `bun run typecheck`
- [x] `git diff --check`
- [x] `bun run build`
- [ ] Browser smoke:
  - [ ] open local project
  - [ ] add track
  - [ ] import or create clip
  - [ ] play/pause/stop
  - [ ] record-arm state still reconciles
  - [ ] project menu still shows local/cloud/share actions correctly

---

## Phase 4 — Deduplicate IDs, Defaults, And Entity Row Helpers

### Goal

Remove small but real duplicate semantics so future local/cloud behavior changes update one helper instead of several callsites.

### 4.1 Asset ID helper

Current duplication:

```ts
// src/lib/local-ids.ts
export const createLocalAssetId = () => createLocalId("asset")

// src/lib/audio-source.ts
export function createAudioAssetKey() {
  return `asset:${crypto.randomUUID()}`
}
```

Preferred shape if semantics are confirmed identical:

```ts
// src/lib/audio-source.ts
import { createLocalAssetId } from "~/lib/local-ids"

export const createAudioAssetKey = createLocalAssetId
```

Open question:

- Is an `assetKey` always a local asset ID, or can it later represent a stable cloud/source key?
- If semantics differ, rename one helper to make the distinction explicit instead of aliasing.

### 4.2 Default track row builder

Current duplicate defaults:

- `src/lib/local-project-db.ts` creates initial `Track 1`
- `src/lib/timeline-repository/local-timeline-repository.ts` creates new tracks with similar defaults

Proposed helper:

```ts
// src/lib/timeline-repository/track-row-builder.ts
export const buildTimelineTrackRow = (input: {
  id: string
  index: number
  timestamp: number
  name?: string
  historyRef?: string
  volume?: number
  muted?: boolean
  soloed?: boolean
  kind?: TimelineTrackRow["kind"]
  channelRole?: TimelineTrackRow["channelRole"]
  outputTargetId?: string
  sends?: TimelineTrackRow["sends"]
}): TimelineTrackRow => ({
  id: input.id,
  historyRef: input.historyRef ?? input.id,
  name: input.name?.trim() || `Track ${input.index + 1}`,
  index: input.index,
  volume: input.volume ?? 0.8,
  muted: input.muted ?? false,
  soloed: input.soloed ?? false,
  kind: input.kind ?? "audio",
  channelRole: input.channelRole ?? "track",
  outputTargetId: input.outputTargetId,
  sends: input.sends ?? [],
  createdAt: input.timestamp,
  updatedAt: input.timestamp,
})
```

Use it from both:

- `createLocalProject()`
- `createLocalTimelineRepository().createTrack()`

### 4.3 Entity row helper

Current duplicate shape:

```ts
const toEntityRow = (kind: string, id: string, value: unknown, updatedAt: number): LocalProjectEntityRow => ({
  kind,
  id,
  value,
  updatedAt,
})
```

Proposed owner:

- `src/lib/local-project-db.ts` exports `createLocalProjectEntityRow`

Example:

```ts
export const createLocalProjectEntityRow = (
  kind: string,
  id: string,
  value: unknown,
  updatedAt = Date.now(),
): LocalProjectEntityRow => ({ kind, id, value, updatedAt })
```

Use from:

- `src/lib/remote-timeline-cache.ts`
- `src/lib/timeline-repository/local-timeline-repository.ts`
- any future local entity cache writers

### Validation

- [x] `bun run typecheck`
- [x] `git diff --check`
- [x] `bun run knip`
- [x] `bun run build`
- [ ] Browser smoke for local project creation and new track creation
  - Not run in this CLI-only pass.

---

## Phase 5 — Validate And Simplify Undo Routing Fallback

### Goal

Remove only proven-redundant defensive code in `src/lib/undo/exec.ts`.

### Candidate

Current code:

```ts
const track = deps.getTracks().find((entryValue) => entryValue.id === trackId)
const normalizedRouting = track ? normalizeTrackRouting(track, routing, deps.getTracks()) : routing
```

Potential simplified code:

```ts
const track = requireResolved(
  deps.getTracks().find((entryValue) => entryValue.id === trackId),
  "Track not found for track-routing history entry",
)
const normalizedRouting = normalizeTrackRouting(track, routing, deps.getTracks())
```

### Proof required before changing

- [x] Read `src/lib/undo/refs.ts`.
- [x] Confirm `resolveTrackId(index, entry.data.trackRef)` can only return a track ID currently present in `deps.getTracks()`.
- [x] Check whether any history replay path can mutate tracks between `buildRefIndex(deps)` and the `.find()`.
- [x] Check local/shared history replay for deleted/recreated track refs.
- [x] If the fallback is reachable for legacy persisted history, keep it and document why.

### Validation

- [x] `bun run typecheck`
- [x] `git diff --check`
- [ ] Browser smoke:
  - [ ] create track routing change
  - [ ] undo routing
  - [ ] redo routing
  - [ ] delete/recreate history scenario if easy to reproduce

---

## Phase 6 — Bundle Splitting / Large Chunk Follow-Up

### Goal

Reduce avoidable startup bundle weight without changing timeline behavior.

### Current signal

`bun run build` passes, but Vite reports chunks over 500 kB, including the timeline bundle.

Current Vite config already uses TanStack Router auto code splitting:

```ts
tanstackRouter({
  target: "solid",
  autoCodeSplitting: true,
})
```

So the next step should target heavy timeline-only panels/components rather than route splitting alone.

### Candidate components to inspect

- `src/components/timeline/EffectsPanel.tsx`
- `src/components/timeline/ExportDialog.tsx`
- `src/components/AgentChat.tsx` or related agent UI if included in timeline route
- MIDI/editor/export/media panels that are not needed for first paint

### Solid lazy example

```tsx
import { Suspense, lazy } from "solid-js"

const EffectsPanel = lazy(() => import("./timeline/EffectsPanel"))

<Suspense fallback={null}>
  <EffectsPanel {...props} />
</Suspense>
```

### Rules

- [x] Prefer component-level `lazy()` for rarely-opened heavy panels before manual chunk config.
- [x] Keep always-visible transport/workspace/ruler code eager.
- [x] Do not add manual chunks that split shared Solid primitives into awkward duplicate bundles.
- [x] Confirm Cloudflare Vite plugin asset handling still works after splitting.

### Validation

- [x] `bun run build`
- [x] Compare emitted chunks before/after.
- [ ] Browser smoke:
  - [ ] open app
  - [ ] open effects panel
  - [ ] open export dialog
  - [ ] open agent/chat UI if split
  - [ ] reload while panel state is open if that state persists

---

## Phase 7 — Optional Asset/Media Contract Hardening

### Goal

Only if Phase 1 exposes contract friction, consider strengthening asset/media references using a discriminated shape inspired by `monorepo-new`.

### Candidate shape

```ts
export type ProjectAssetRef =
  | { kind: "local"; projectId: string; assetId: string }
  | { kind: "cloud"; projectId: string; assetId: string; cloudKey: string }
  | { kind: "url"; url: string; assetId?: string }
```

### Use only if it solves a real problem

This is not automatically required. Use it if moving contracts to `shared/` reveals repeated ad hoc `{ sampleUrl, sourceAssetKey, cloudKey }` checks across API, Convex, and UI.

### Validation

- [ ] Contract tests or targeted type checks around manifest parsing
- [ ] Backup restore smoke
- [ ] Offline download smoke
- [ ] Shared uploaded audio publish smoke

---

## Phase 8 — Workspace Package Boundary Plan

### Goal

Turn the useful `audio-engine` chunk split into a cleaner long-term module architecture without creating packages for their own sake.

The model to copy is the simple package boundary from `/Users/juan/Documents/monorepo-new`, not a full app-directory migration:

- root `package.json` declares workspace packages
- packages own stable contracts and package manifests
- app/API code imports package names instead of relative cross-root paths
- packages stay small enough that their public surface is obvious

### Source evidence checked

From `/Users/juan/Documents/monorepo-new`:

```json
{
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "check": "bun --filter '*' check"
  }
}
```

```json
{
  "name": "@monorepo/shared",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

Consumers import by package name:

```ts
import { FREE_CREDITS_QUOTA, type UserData } from "@monorepo/shared"
import { transcriptionOutput } from "@monorepo/shared"
```

Current web/docs evidence checked on 2026-06-04:

- Bun workspaces docs: workspaces split one repo into multiple packages that can depend on each other and share installation state.
- Bun `--filter` docs: package scripts can be run for selected workspaces, matching `monorepo-new`'s `bun --filter '*' check` pattern.
- Solid `lazy` docs: lazy components load on demand and integrate with `Suspense`; use this for optional UI, not always-visible timeline chrome.
- Vite/Rollup `manualChunks`: useful for stable runtime chunks like `audio-engine`, but should not be used to hide unresolved architecture or split shared Solid primitives awkwardly.
- Diffusion check: `/Users/juan/Documents/monorepo-new/apps/web/vite.config.ts` has no `manualChunks` and no package-based bundle splitting. It uses workspaces for app/shared boundaries, keeps the media engine inside the web app, and relies on route/app structure plus targeted dynamic imports for optional dependencies like `mediabunny` output formats.

### Current repo baseline

Already completed in this branch:

```json
{
  "workspaces": ["shared"],
  "dependencies": {
    "@daw-browser/shared": "workspace:*"
  }
}
```

```json
{
  "name": "@daw-browser/shared",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

```ts
import { sharedTimelineOperationSchema } from "@daw-browser/shared/shared-timeline-operations"
import { normalizeSynthParams } from "@daw-browser/shared/effects-params"
```

### Package principles

- [x] Prefer `packages/*` for new packages; keep the existing root app in place for now.
- [x] Do not move app code into `apps/*` during this cleanup branch.
- [x] Package only cohesive code with a stable boundary and narrow consumers.
- [x] Keep app adapters in `src/` when they own Solid, TanStack, Convex client, auth, browser session state, or route behavior.
- [x] Keep singleton ownership app-side unless the package truly owns the singleton lifecycle.
- [x] Match Diffusion's shared package root export for cross-runtime contracts.
- [x] Avoid package-based manual chunking; use router/lazy/dynamic-import boundaries instead.
- [x] Run `bun run typecheck`, `bun run knip`, `git diff --check`, and `bun run build` after each package extraction.

Implementation evidence:

- `@daw-browser/shared` now lives under `packages/shared/src`.
- `@daw-browser/waveforms` owns waveform extraction/storage/render/windowing.
- `@daw-browser/timeline-core` owns timeline types, track indexing, clip placement, and track routing adapters.
- `@daw-browser/audio-engine` owns audio engine, scheduling, synth voice, mixer graph, DSP/effects, and mixdown export.
- `src/lib/audio-engine-singleton.ts` stayed app-side as the singleton lifecycle owner.
- `@daw-browser/local-projects` is intentionally deferred because local project code still crosses IndexedDB, local assets, outbox, timeline repository, undo/history, cloud restore, archives, and UI hooks.

### Phase 8A — Normalize workspace layout

This is the small architecture cleanup to do before more package extraction.

Recommended final shape:

```txt
package.json
packages/
  shared/
    package.json
    src/
      shared-timeline-operations.ts
      effects-params.ts
      project-manifest-contract.ts
      ...
```

Root `package.json` target:

```json
{
  "workspaces": ["packages/*"],
  "dependencies": {
    "@daw-browser/shared": "workspace:*"
  },
  "scripts": {
    "typecheck": "bun x tsc --noEmit -p tsconfig.json && bun x tsc --noEmit -p api/tsconfig.json"
  }
}
```

`packages/shared/package.json` target:

```json
{
  "name": "@daw-browser/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "^4.3.6"
  }
}
```

`tsconfig.json` target:

```json
{
  "compilerOptions": {
    "paths": {
      "~/*": ["./src/*"],
      "@/*": ["./src/*"],
      "@daw-browser/shared/*": ["./packages/shared/src/*"]
    }
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "packages/shared/src/**/*.ts",
    "convex/**/*.ts",
    "vite.config.ts"
  ]
}
```

Files to change:

- `package.json`
- `bun.lock`
- `tsconfig.json`
- `api/tsconfig.json`
- move `shared/*.ts` -> `packages/shared/src/*.ts`
- move `shared/package.json` -> `packages/shared/package.json`

Validation:

- [x] `bun install`
- [x] `bun run typecheck`
- [x] `bun run knip`
- [x] `git diff --check`
- [x] `bun run build`

### Phase 8B — Extract `@daw-browser/waveforms` first

This is the best first true package after `shared`.

Why first:

- `src/lib/audio-peaks/*` is cohesive.
- Internal imports only depend on other `audio-peaks` files.
- Consumers are narrow:
  - `src/components/timeline/ClipComponent.tsx`
  - `src/lib/clip-source-client.ts`
  - `src/lib/default-sample-cache.ts`
  - `src/hooks/useClipBuffers.ts`
- It has a clear browser capability boundary: `AudioBuffer`, `OfflineAudioContext`, `indexedDB`, and `CanvasRenderingContext2D`.

Files to move:

```txt
src/lib/audio-peaks/asset-store.ts
src/lib/audio-peaks/extract-peaks.ts
src/lib/audio-peaks/peak-db.ts
src/lib/audio-peaks/render-waveform.ts
src/lib/audio-peaks/resample-peak-pairs.ts
src/lib/audio-peaks/select-waveform-window.ts
src/lib/audio-peaks/types.ts
```

New package:

```txt
packages/waveforms/
  package.json
  src/
    asset-store.ts
    extract-peaks.ts
    peak-db.ts
    render-waveform.ts
    resample-peak-pairs.ts
    select-waveform-window.ts
    types.ts
```

`packages/waveforms/package.json` example:

```json
{
  "name": "@daw-browser/waveforms",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    "./asset-store": "./src/asset-store.ts",
    "./render-waveform": "./src/render-waveform.ts",
    "./select-waveform-window": "./src/select-waveform-window.ts",
    "./types": "./src/types.ts"
  }
}
```

Import rewrite examples:

```ts
// before
import { drawWaveformPeaks } from "~/lib/audio-peaks/render-waveform"
import { getWaveformSlice } from "~/lib/audio-peaks/select-waveform-window"

// after
import { drawWaveformPeaks } from "@daw-browser/waveforms/render-waveform"
import { getWaveformSlice } from "@daw-browser/waveforms/select-waveform-window"
```

Internal import rewrite example:

```ts
// before
import type { PeakAssetRecord } from "~/lib/audio-peaks/types"

// after
import type { PeakAssetRecord } from "./types"
```

Root `package.json` addition:

```json
{
  "dependencies": {
    "@daw-browser/waveforms": "workspace:*"
  }
}
```

`tsconfig.json` addition:

```json
{
  "compilerOptions": {
    "paths": {
      "@daw-browser/waveforms/*": ["./packages/waveforms/src/*"]
    }
  },
  "include": [
    "packages/waveforms/src/**/*.ts"
  ]
}
```

Risks to check:

- [x] Package typecheck has DOM types available for `AudioBuffer`, `indexedDB`, and canvas.
- [x] `clearWaveformAssetCache()` remains called on clip-buffer cleanup.
- [x] No duplicate IndexedDB cache is introduced by mixed old/new imports.
- [ ] Waveform rendering still works after local project reload.
  - Not run in this CLI-only pass.

Validation:

- [x] `bun run typecheck`
- [x] `bun run knip`
- [x] `git diff --check`
- [x] `bun run build`
- [ ] Browser smoke: import audio, confirm waveform appears, reload, confirm cached waveform appears.
  - Not run in this CLI-only pass.

### Phase 8C — Extract narrow `@daw-browser/timeline-core`

Do this before `audio-engine` because `audio-engine.ts` currently imports `~/types/timeline`, mixer types, and routing helpers. Stabilizing core timeline types reduces package coupling later.

Good candidates:

```txt
src/types/timeline.ts
src/lib/timeline-track-index.ts
src/lib/clip-placement.ts
src/lib/clip-timing.ts wrapper/contract
src/lib/track-routing.ts wrapper around shared routing rules
shared/track-routing-core.ts
shared/clip-timing.ts
shared/shared-timeline-operations.ts
```

Do **not** include in this package:

- `src/lib/clip-create.ts` yet; it imports Convex args, upload helpers, outbox, local repositories, undo refs, and audio buffers.
- `src/lib/undo/*` yet; it depends on persistence/history behavior.
- `src/lib/timeline-audio-import.ts`; it owns browser file/import/local asset side effects.
- `src/lib/timeline-repository/*` until local project persistence is cleaner.

Package shape:

```txt
packages/timeline-core/
  package.json
  src/
    types.ts
    track-index.ts
    clip-placement.ts
    track-routing.ts
```

Type cleanup needed first:

```ts
// current src/types/timeline.ts
import type { AudioSourceKind } from "~/lib/audio-source"

// target
import type { AudioSourceKind } from "@daw-browser/shared/audio-source-rules"
```

Import rewrite example:

```ts
// before
import type { Track, Clip } from "~/types/timeline"
import { createTimelineTrackIndex } from "~/lib/timeline-track-index"

// after
import type { Track, Clip } from "@daw-browser/timeline-core/types"
import { createTimelineTrackIndex } from "@daw-browser/timeline-core/track-index"
```

Risks to check:

- [x] Do not move browser-only `AudioBuffer` handling unless the package tsconfig includes DOM libs.
- [x] Do not move Convex/client mutation builders.
- [x] Do not move Solid/UI constants like timeline layout unless there is a second non-UI consumer.
- [x] Keep shared operation schemas in `@daw-browser/shared` unless `timeline-core` clearly becomes their only owner.

Validation:

- [x] `bun run typecheck`
- [x] `bun run knip`
- [x] `git diff --check`
- [x] `bun run build`
- [ ] Runtime smoke: clip drag, clip resize, routing changes, undo/redo clip movement.
  - Not run in this CLI-only pass.

### Phase 8D — Extract `@daw-browser/audio-engine`

Do this after `timeline-core`, not before.

Current boundary evidence:

```ts
// src/lib/audio-engine.ts
import { getPlayableAudioWindow, getScheduledMidiEvents } from "~/lib/audio-scheduling"
import { normalizeSynthParams, serializeEqParams, serializeReverbParams } from "~/lib/effects/params"
import { applyLiveMixerGraph } from "~/lib/mixer/apply-live-routing"
import { resolveMixerGraph } from "~/lib/mixer/resolve-routing"
import type { Track, Clip } from "~/types/timeline"
```

```ts
// src/lib/export-mixdown.ts
import { Output, BufferTarget, WavOutputFormat, AudioBufferSource } from "mediabunny"
import { createOfflineMixerNodes } from "~/lib/mixer/apply-offline-routing"
import { createTimelineTrackIndex } from "~/lib/timeline-track-index"
```

Files to move:

```txt
src/lib/audio-engine.ts
src/lib/audio-scheduling.ts
src/lib/synth-voice.ts
src/lib/export-mixdown.ts
src/lib/effects/chain.ts
src/lib/effects/dsp.ts
src/lib/mixer/apply-live-routing.ts
src/lib/mixer/apply-offline-routing.ts
src/lib/mixer/channels.ts
src/lib/mixer/resolve-routing.ts
src/lib/mixer/types.ts
```

Keep app-side:

```txt
src/lib/audio-engine-singleton.ts
src/hooks/useTimelinePlayback.ts
src/hooks/useTimelineAudioLifecycle.ts
src/hooks/useTimelineMixerController.ts
```

Reason: singleton lifecycle and Solid hooks are app orchestration, not package logic.

Package shape:

```txt
packages/audio-engine/
  package.json
  src/
    audio-engine.ts
    audio-scheduling.ts
    export-mixdown.ts
    synth-voice.ts
    effects/
    mixer/
```

Package dependencies:

```json
{
  "name": "@daw-browser/audio-engine",
  "dependencies": {
    "@daw-browser/shared": "workspace:*",
    "@daw-browser/timeline-core": "workspace:*",
    "mediabunny": "^1.35.1"
  }
}
```

Import rewrite examples:

```ts
// before
import { AudioEngine } from "~/lib/audio-engine"
import { renderMixdown } from "~/lib/export-mixdown"

// after
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import { renderMixdown } from "@daw-browser/audio-engine/export-mixdown"
```

Vite chunking decision after Diffusion comparison:

```ts
// No package-based manualChunks.
// Let TanStack Router route splitting and explicit lazy/dynamic imports decide runtime chunks.
```

Risks to check:

- [ ] AudioWorklet/meter processor asset loading still works.
  - Not run in this CLI-only pass.
- [x] Export dialog still lazy-loads and can import `renderMixdown`.
- [x] `AudioEngine` package does not import Solid hooks/components.
- [x] `audio-engine-singleton.ts` remains the only app singleton owner.
- [x] Package extraction is not coupled to package-based manual chunks.
  - Initial package build emitted `audio-engine-DskRh0ul.js` at ~106.51 kB / 27.82 kB gzip.
  - Review found export-only mixdown/MediaBunny code was grouped into the live audio-engine chunk. The follow-up split keeps live engine code in `audio-engine-C2ZcBoDN.js` at ~44.70 kB / 12.47 kB gzip and isolates MediaBunny in `audio-export-DNsZVLRs.js` at ~61.84 kB / 15.48 kB gzip. `ExportDialog` remains lazy at ~6.52 kB / 2.67 kB gzip.
  - Verified `Timeline` has no static `from "./audio-export..."` import; it only lists the lazy export chunk in Vite preload metadata for the export dialog.
  - Final Diffusion-alignment pass removed package-based `manualChunks`; build/runtime chunking should come from TanStack route splitting and explicit dynamic imports, not from every workspace package. After shared-root import cleanup and deferring mixdown loading until export start, final build emits `Timeline-BAm2A8lz.js` at ~485.80 kB / 138.85 kB gzip, lazy `ExportDialog-D85mthzn.js` at ~7.04 kB / 2.81 kB gzip, and pay-as-used `export-mixdown-Dja8trCx.js` at ~64.93 kB / 16.75 kB gzip.

Review hardening:

- [x] API no longer imports app-side `../src/lib/clip-create` or `../src/lib/audio-source`.
  - Added API-safe shared helpers in `@daw-browser/shared/clip-create-payload` and `@daw-browser/shared/audio-source-metadata`.
  - Narrowed `api/tsconfig.json` so API typechecking no longer pulls `packages/audio-engine`, `packages/waveforms`, or `src/lib`.
  - Verified with `bun x tsc --noEmit --listFilesOnly -p api/tsconfig.json | grep -E 'packages/(audio-engine|waveforms)|/src/lib/' || true`.
- [x] `@daw-browser/shared` matches Diffusion's single root export (`"." -> "./src/index.ts"`) instead of wildcard or granular subpath exports.
- [ ] `timeline-core` has no browser runtime state.
  - Follow-up remains: split persisted/core clip types from app-side hydrated clips so `AudioBuffer` leaves `packages/timeline-core/src/types.ts`.
- [ ] `packages/audio-engine/src/audio-engine.ts` is internally decomposed.
  - Follow-up remains: split context lifecycle, transport scheduling, metering/analyser, buffer/decode, graph/effects, and MIDI/synth responsibilities.
- [x] App-side shared re-export shims are removed or converted into a deliberate facade.
  - Direct consumers now import `@daw-browser/shared/...`; pure compatibility wrappers were deleted.

Validation:

- [x] `bun run typecheck`
- [x] `bun run knip`
- [x] `git diff --check`
- [x] `bun run build`
- [ ] Browser smoke: play/pause/stop, synth MIDI playback, effects chain, export WAV.
  - Not run in this CLI-only pass.

### Phase 8E — Defer `@daw-browser/local-projects`

This is a good eventual package, but it should not be next.

Current coupling evidence:

```ts
// src/lib/local-project-db.ts
import { deleteDB, openDB } from "idb"
import { createLocalProjectId, createLocalTrackId } from "~/lib/local-ids"
import { notifyLocalProjectChanged } from "~/lib/local-project-changes"
import { buildTimelineTrackRow } from "~/lib/timeline-repository/track-row-builder"
```

Local-project code crosses many boundaries:

- IndexedDB and File System Access API
- local assets
- cloud backup/restore
- local timeline repository
- shared outbox
- undo/history persistence
- remote timeline cache
- project archive import/export
- UI hooks and project picker consumers

Defer until these are cleaner:

- [x] `timeline-core` exists and owns timeline row/type contracts.
- [x] `audio-engine` no longer imports local-project code.
- [x] Shared outbox/publication contracts are stable.
- [ ] Project archive import/export has a narrow adapter API.
  - Still deferred; `@daw-browser/local-projects` should wait.

Possible later package shape:

```txt
packages/local-projects/
  src/
    db.ts
    assets.ts
    archive.ts
    history.ts
    pending-writes.ts
    outbox.ts
```

Keep app-side:

```txt
src/hooks/useLocalProjectActions.ts
src/hooks/useProjectSamples.ts
src/components/LocalProjectPicker.tsx
```

Validation when attempted:

- [ ] `bun run typecheck`
- [ ] `bun run knip`
- [ ] `git diff --check`
- [ ] `bun run build`
- [ ] Browser smoke: create local project, import audio, reload, export archive, import archive, restore backup, flush shared outbox.

### Suggested package extraction commit sequence

1. `refactor: normalize workspace package layout`
   - Move `shared` to `packages/shared/src`
   - Keep `@daw-browser/shared/*` imports stable

2. `refactor: extract waveform utilities package`
   - Move `audio-peaks/*` to `packages/waveforms`
   - Rewrite only waveform imports

3. `refactor: extract narrow timeline core package`
   - Move timeline types/index/placement/routing adapters only
   - Leave persistence, undo, and creation flows in `src/lib`

4. `refactor: extract audio engine package`
   - Move audio engine, mixer, effects DSP, scheduling, synth, export mixdown
   - Keep singleton/hooks app-side

5. `refactor: evaluate local project package boundary`
   - Only after the earlier package boundaries are stable

### Phase 8 completion criteria

- [x] Workspace packages live under `packages/*` or there is a documented reason for a root-level package.
- [x] Package-name imports replace cross-root relative imports.
- [x] `@daw-browser/waveforms` has no app imports.
- [x] `@daw-browser/timeline-core` has no persistence/UI imports.
- [x] `@daw-browser/audio-engine` has no Solid imports and no app singleton ownership.
- [x] `@daw-browser/local-projects` is either deferred with rationale or extracted only after coupling is reduced.
- [x] Validators pass after each extraction.
- [ ] Browser smoke covers every package with browser runtime APIs.
  - Not run in this CLI-only pass.

---

## Full Validation Plan For The Follow-Up Branch

Run fast checks after each phase:

- `bun run typecheck`
- `git diff --check`

Run milestone checks before each commit or PR review:

- `bun run typecheck`
- `git diff --check`
- `bun run knip`
- `bun run build`

Runtime smoke checklist before opening PR:

- [ ] signed-out local project picker opens
- [ ] create local project
- [ ] add audio track
- [ ] add MIDI/instrument track
- [ ] import audio
- [ ] playback works
- [ ] undo/redo clip create/move/delete
- [ ] local project reload restores timeline
- [ ] backup-mode project still backs up
- [ ] restore cloud backup reloads timeline snapshot
- [ ] shared project owner can manage sharing
- [ ] non-owner cannot manage sharing
- [ ] shared durable outbox still flushes after simulated failure/reconnect
- [ ] export dialog still opens if lazily split
- [ ] effects panel still opens and commits history if lazily split

---

## Suggested Commit Sequence

1. `refactor: move shared contracts out of frontend lib`
   - Move pure contract files to `shared/`
   - Update API/Convex/frontend imports
   - No intended behavior change

2. `refactor: centralize shared timeline operations`
   - Add operation descriptor registry
   - Derive kind/target helpers
   - Keep executor behavior unchanged

3. `refactor: shrink timeline orchestration surface`
   - Extract one or two focused `Timeline.tsx` orchestration helpers
   - Avoid broad rewrite

4. `refactor: dedupe local timeline helpers`
   - Asset ID helper
   - Default track builder
   - Entity row helper

5. `refactor: remove proven undo fallback`
   - Only if Phase 5 proof passes
   - Otherwise commit nothing for this candidate and record the keep decision

6. `perf: split heavy timeline panels`
   - Lazy-load selected heavy panels
   - Compare build output

---

## Out Of Scope

- Reworking local-first backup/share product behavior
- New cloud sync semantics
- Owner transfer
- Full Convex Auth migration
- Replacing Hono routes with tRPC
- Porting `monorepo-new` engine/ECS architecture
- Introducing a runtime feature flag for already-merged local-first behavior

---

## Completion Criteria

This tracker can be closed when:

- [x] API and Convex no longer import pure contracts from `src/lib`
- [x] shared timeline operations have one primary registry/source of truth
- [x] `Timeline.tsx` has at least one meaningful orchestration extraction and remains easier to read top-to-bottom
- [x] duplicate asset ID/default track/entity row helpers are resolved or explicitly kept with rationale
- [x] undo routing fallback is removed or explicitly kept with proof
- [x] bundle warnings are improved or documented with before/after output and a decision
- [x] validators pass
- [ ] browser smoke passes
  - Not run in this CLI-only pass; requires an interactive browser session against a live app.
- [x] PR review confirms no new merge blockers
