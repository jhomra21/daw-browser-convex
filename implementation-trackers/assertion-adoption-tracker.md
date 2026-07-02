# Assertion Adoption Tracker

## Goal

Introduce a small, consistent assertion layer and use it where the code is expressing internal invariants. Assertions should make impossible states explicit, improve TypeScript narrowing, remove non-null assertions, and separate programmer errors from expected runtime or user-facing failures.

## Reference

`/Users/juan/Documents/monorepo-new/apps/web/src/utils/common.ts` uses:

```ts
export function assert(condition: any, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || `Assertion failed: ${String(condition)}`);
  }
}
```

It is used for provider hook invariants, canvas/rendering invariants, engine state assumptions, post-operation existence checks, and internal data-model invariants.

## Assertion Rule

Use `assert` only for:

> This should be impossible if our code and data model are correct.

Do not use assertions for:

- auth failures
- permissions
- request validation
- network errors
- missing optional query data
- browser feature support
- user input validation
- expected no-op guards
- parser/normalizer rejection

## Phase 1: Add assertion helpers

Create `packages/shared/src/assert.ts`:

```ts
export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertDefined<T>(
  value: T | null | undefined,
  message = "Expected value to be defined",
): NonNullable<T> {
  assert(value !== null && value !== undefined, message);
  return value;
}

export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${String(value)}`);
}
```

Export it from `packages/shared/src/index.ts`.

## Phase 2: P0 replacements

### Frontend provider and DOM invariants

- `src/main.tsx`
  - Remove `document.getElementById('root')!`.
  - Use `assert(rootElement, 'Root element with id "root" not found in index.html')`.
- `src/context/export.tsx`
  - Replace `if (!context) throw new Error('ExportProvider is missing')`.
- `src/components/ui/sidebar.tsx`
  - Replace provider hook throw with `assert(context, "useSidebar must be used within a Sidebar.")`.
- `src/components/ui/menubar.tsx`
  - Replace menubar context checks:
    - `assert(context, "MenubarContent must be used within Menubar.")`
    - `assert(value !== undefined, "MenubarContent must be used within MenubarMenu.")`

### Audio engine runtime invariants

- `packages/audio-engine/src/live-mixer-runtime.ts`
  - In `ensureTrackNodes`, after `options.ensureAudio()`, assert `ctx`.
- `packages/audio-engine/src/audio-engine.ts`
  - In `createImpulseResponse`, assert `this.audioCtx` via a local `ctx`.

### Non-null assertions

- `src/hooks/useClipDrag.ts`
  - Replace `draggingIds!` with an asserted local:
    ```ts
    const activeDraggingIds = draggingIds
    assert(activeDraggingIds, 'Missing drag ids while completing clip drag')
    ```
- `api/indexing.ts`
  - Prefer narrowed locals over assertions for optional filter values.
- `src/lib/track-recording-session.ts`
  - Remove definite assignment assertions for stop promise handlers.
  - Assert resolver/rejecter exist before returning them.

## Phase 3: P1 internal operation invariants

### Clip creation

- `src/lib/clip-create.ts`
  - Convert post-create checks:
    - `assert(createdClipId, 'Failed to create clip')`
    - `assert(clipIds.length === input.items.length, 'Failed to create clips')`
    - `assert(clipId, 'Failed to create clips')`

### Undo and history

- `src/lib/undo/exec.ts`
  - Update local `requireResolved` to use `assertDefined`, or replace it with the shared helper.
  - Convert recreated clip/track id checks.
- `src/lib/undo/track-entry-executors.ts`
  - Convert recreated `trackId`, `clipId`, `newTrackId`, and `newId` checks.
- `src/lib/undo/history-persistence.ts`
  - Convert internal history persistence postconditions:
    - created track result must be a string
    - required clip ref must exist
    - local update/delete result must be applied
    - normalized audio warp must exist when the history entry says it exists
    - shared operation result must be applied

### Timeline model and automation

- `src/hooks/useProjectedTimelineModel.ts`
  - Assert projected server mixer data invariants:
    - `track.volume !== undefined`
    - `track.sends !== undefined`
    - `send?.targetId`
    - `Number.isFinite(amount)`
- `src/hooks/useTimelineAutomationController.ts`
  - Assert `uid` before shared automation persistence.
- `src/lib/clip-drag-commit.ts`
  - Assert `input.userId` for cloud clip duplication.

## Phase 4: Audio graph invariants

### Live routing

- `packages/audio-engine/src/mixer/apply-live-routing.ts`
  - Replace unsafe `Map.get(...)!` access with assertions.
  - Assert output target nodes exist.
  - Assert send target nodes exist instead of silently continuing.

### Offline routing

- `packages/audio-engine/src/mixer/apply-offline-routing.ts`
  - Assert source track nodes exist.
  - Assert send target nodes exist.

### Export mixdown

- `packages/audio-engine/src/export-mixdown.ts`
  - Assert graph/internal mismatches only:
    - missing prepared export track
    - missing offline track input
    - missing stream writer
  - Do not assert missing clips, missing buffers, or skipped out-of-range clips.

## Phase 5: Backend and Convex internal invariants

### Convex mixer channels

- `convex/mixerChannels.ts`
  - Convert internal mixer-channel cardinality/state checks:
    - `channel`
    - `channel.channelRole !== undefined`
    - `channel.sends !== undefined`
    - `rows.length === 1`
    - no duplicate channel per track id

These are strong candidates because schema and track creation expect one mixer channel per track.

## Phase 6: Optional P2 conversions

Only do these after P0 and P1 are clean.

### Canvas 2D contexts

These currently silently return. Converting them changes behavior, so treat as optional:

- `src/components/timeline/ClipComponent.tsx`
- `src/components/timeline/SampleDetailWaveform.tsx`
- `src/components/effects/Eq.tsx`
- `src/components/effects/DrumRack.tsx`

Example:

```ts
const ctx = canvas.getContext("2d")
assert(ctx, "Clip waveform canvas 2D context unavailable")
```

### Shared outbox durable operations

- `src/lib/shared-outbox.ts`
  - Assert durable operation kind in internal enqueue/publish paths.

### Shared clip payload builder

- `packages/shared/src/clip-create-payload.ts`
  - Convert only if the function is treated as an internal builder, not an untrusted parser.

## Do not convert

Keep explicit user/API errors in:

- `api/routes/**`
- `api/convex-auth.ts`
- `api/project-r2-stream.ts`
- `convex/projectAccess.ts`
- `convex/trackWrites.ts`
- `convex/automation.ts`
- `convex/tracks.ts`
- `convex/shareInvites.ts`
- `convex/projects.ts`

Keep parser/normalizer behavior in:

- `packages/shared/src/shared-timeline-operations.ts`
- `packages/shared/src/effects-params.ts`
- `packages/shared/src/drum-rack-params.ts`
- `packages/shared/src/instrument-params.ts`
- `packages/shared/src/audio-warp.ts`
- `src/lib/sample-drag-data.ts`
- `src/lib/cloud-backup.ts`
- `src/lib/project-archive.ts`

Keep expected runtime guards such as:

```ts
if (!projectId) return
if (!canvas) return
if (!response.ok) throw ...
if (!clip.buffer) continue
if (!ctx) return false
```

when absence is expected during app lifecycle, user gesture requirements, browser support, async loading, or normal skipping.

## Implementation order

1. Add `packages/shared/src/assert.ts`.
2. Export assertions from `packages/shared/src/index.ts`.
3. Convert P0 files.
4. Run `bun run typecheck`.
5. Convert P1 frontend, undo, and history candidates.
6. Run `bun run typecheck`.
7. Convert audio graph candidates.
8. Run `bun run typecheck && bun test`.
9. Convert Convex mixer-channel candidates.
10. Run full validation:
    ```bash
    bun run typecheck
    bun test
    bun run build
    ```

## Review checklist

- No non-null assertions remain in audited candidate locations.
- Assertions are not used for user input, auth, network, or browser feature errors.
- `assert(value)` is not used when `0`, `""`, or `false` are valid.
- Use explicit predicates for those cases:
  ```ts
  assert(value !== undefined)
  assert(value !== null)
  assert(typeof value === "string")
  assert(Number.isFinite(value))
  ```
- Error messages remain as specific as existing messages.
- Parser, normalizer, and API validation paths do not gain broad behavior changes.
