# Automation Implementation Tracker

> Created: 2026-06-30
> Branch: `automations`
> Scope: add Ableton-style arrangement automation for browser DAW projects.

## Purpose

Add first-class automation envelopes for track and master parameters, with local-first persistence, shared Convex collaboration, live Web Audio scheduling, offline export parity, and undo/redo support.

## Reference Material

Saved Ableton references:

- `/private/tmp/ableton-ui-reference/automations/ableton-live12-automation-envelopes-manual.png`
- `/private/tmp/ableton-ui-reference/automations/ableton-live12-clip-envelopes-manual.png`
- `/private/tmp/ableton-ui-reference/automations/ableton-automation-modulation-help.png`
- `/private/tmp/ableton-ui-reference/automations/ableton-live12-automation-arm-button.png`
- `/private/tmp/ableton-ui-reference/automations/ableton-live12-clip-envelope-editor.png`

Local reference codebases:

- `/Users/juan/Documents/monorepo-new`: keyframe API/render/layers and interpolation UX.
- `/Users/juan/Documents/dialkit`: pointer interaction state, cleanup, and meaningful commit patterns.

## V1 Scope

- Arrangement automation only.
- Track and master automation envelopes.
- Breakpoint editing with `linear` and `hold` interpolation.
- SVG automation overlay inside current fixed-height timeline lanes.
- Track/master volume, EQ bands, and effect params backed by native `AudioParam`s.
- Local project persistence and shared Convex persistence.
- Undo/redo.
- Offline export parity.

## Deferred

- Clip envelopes.
- Automation recording and Automation Arm.
- Ableton's Back-to-Arrangement override behavior.
- Compressor worklet parameter automation unless the worklet is converted to real `AudioParam` descriptors first.
- Curved/freehand automation.

## Important Design Corrections

- Use plain string `parameterId`s with runtime validation. Avoid brittle template-literal unions because dynamic EQ band ids make strict compile-time unions impractical.
- Keep cloud writes on the existing durable shared operation path. Effects already use `publishDurableSharedTimelineOperation`.
- Do not publish during every pointer move. Preview immediately in draft state, then commit once on pointerup or through debounced keyboard edits.
- Add a parallel local automation persistence module instead of extending `LocalEffectKind`.
- Do not resolve EQ nodes by array index. Disabled bands alter node ordering, so EQ nodes need a `bandId -> BiquadFilterNode` map.
- Do not cache stale `AudioParam` handles in persisted UI state. Resolve params from live/master/offline graph owners when scheduling.
- Offline export must load and apply automation explicitly. It does not inherit live runtime scheduling.
- Undo/redo must update persisted history validation, not just local UI state.

## Shared Types

Add `packages/shared/src/automation.ts`.

```ts
export type AutomationInterpolation = 'linear' | 'hold'

export type AutomationTargetKind = 'track' | 'master'

export type AutomationPoint = {
  id: string
  timeSec: number
  value: number
  interpolation: AutomationInterpolation
}

export type AutomationTarget =
  | { kind: 'track'; trackId: string }
  | { kind: 'master' }

export type AutomationEnvelope = {
  id: string
  projectId: string
  target: AutomationTarget
  targetKey: string
  parameterId: string
  enabled: boolean
  points: AutomationPoint[]
  updatedAt: number
}

export function automationTargetKey(target: AutomationTarget, parameterId: string): string {
  if (target.kind === 'master') return `master:${parameterId}`
  return `track:${target.trackId}:${parameterId}`
}
```

Normalize points with deterministic ordering, clamped values, and duplicate-time handling.

## Parameter Registry

Add `packages/shared/src/automation-parameters.ts`.

```ts
export type AutomationParameterDescriptor = {
  id: string
  label: string
  targetKinds: AutomationTargetKind[]
  min: number
  max: number
  defaultValue: number
  scale: 'linear' | 'log'
  unit?: 'db' | 'hz' | 'percent' | 'seconds'
}

export function createEqBandParameterId(
  bandId: string,
  property: 'frequencyHz' | 'gainDb' | 'q',
): string {
  return `eq.${bandId}.${property}`
}

export function parseEqBandParameterId(parameterId: string) {
  const parts = parameterId.split('.')
  if (parts.length !== 3 || parts[0] !== 'eq') return null
  const property = parts[2]
  if (property !== 'frequencyHz' && property !== 'gainDb' && property !== 'q') return null
  return { bandId: parts[1], property }
}
```

Required helpers:

- `getAutomationParameterDescriptor(parameterId)`
- `normalizeAutomationPoints(points, descriptor)`
- `valueAtAutomationTime(points, timeSec, fallbackValue)`
- `isAutomationParameterSupportedForTarget(parameterId, targetKind)`

V1 should only expose descriptors that resolve to native `AudioParam` bindings.

## Convex Persistence

Add `automationEnvelopes` to `convex/schema.ts`.

```ts
automationEnvelopes: defineTable({
  projectId: v.string(),
  targetKind: v.union(v.literal('track'), v.literal('master')),
  trackId: v.optional(v.id('tracks')),
  targetKey: v.string(),
  parameterId: v.string(),
  enabled: v.boolean(),
  points: v.array(v.object({
    id: v.string(),
    timeSec: v.number(),
    value: v.number(),
    interpolation: v.union(v.literal('linear'), v.literal('hold')),
  })),
  updatedAt: v.number(),
})
  .index('by_project', ['projectId'])
  .index('by_project_target_key', ['projectId', 'targetKey'])
```

Add `convex/automation.ts` with:

- `listByProject`
- `serverSetEnvelope`
- `serverDeleteEnvelope`

`serverSetEnvelope` must authenticate, validate project/track access, normalize track ids, runtime-validate the parameter id, normalize points, and upsert by `projectId + targetKey`.

Update `convex/timeline.ts` `fullView` to include automation envelopes.

## Shared Timeline Operations

Extend `packages/shared/src/shared-timeline-operations.ts`.

```ts
| {
    kind: 'automation.setEnvelope'
    payload: {
      targetKind: 'track' | 'master'
      trackId?: string
      parameterId: string
      enabled: boolean
      points: AutomationPoint[]
      updatedAt: number
    }
  }
| {
    kind: 'automation.deleteEnvelope'
    payload: {
      targetKind: 'track' | 'master'
      trackId?: string
      parameterId: string
    }
  }
```

Set `durableQueue: true`.

Targets:

- Track automation targets `trackId`.
- Master automation has no track target, but still needs project write validation in the executor.

Update:

- `api/timeline-operation-executor.ts`
- `src/lib/shared-timeline-operations-api.ts`
- shared operation parser and descriptor tests.

## Local Persistence

Add `src/lib/local-automation.ts`, mirroring `src/lib/local-effects.ts`.

Required API:

- `loadLocalAutomationEnvelopes(projectId)`
- `setLocalAutomationEnvelope(projectId, envelope)`
- `deleteLocalAutomationEnvelope(projectId, targetKey)`
- `replaceLocalAutomationEnvelopes(projectId, envelopes)`

Use `targetKey` as the stable lookup key for local projects. Do not depend on Convex ids.

## Persisted Automation State

Add `src/components/timeline/create-persisted-automation-state.ts`, modeled after `create-persisted-effect-state.ts`.

Behavior:

- Hydrate from local or remote envelopes.
- Keep pointer interaction in draft state.
- Preview draft changes in the engine immediately.
- Commit one operation on pointerup.
- Debounce keyboard/numeric edits.
- Reconcile remote updates unless the envelope is actively dirty.
- Use durable shared operations for shared projects and local writes for local projects.

## Audio Engine Scheduling

Add `packages/audio-engine/src/automation.ts`.

```ts
export type AutomationAudioBinding = {
  param: AudioParam
  valueToAudioValue: (value: number) => number
}

export type AutomationScheduleWindow = {
  playheadSec: number
  startLimitSec: number
  endLimitSec: number
}
```

Scheduling helper:

```ts
export function scheduleAutomationEnvelope(
  bindings: AutomationAudioBinding[],
  envelope: AutomationEnvelope,
  window: AutomationScheduleWindow,
  timelineToCtxTime: (timeSec: number) => number,
  fallbackValue: number,
) {
  const startValue = valueAtAutomationTime(envelope.points, window.startLimitSec, fallbackValue)

  for (const binding of bindings) {
    const param = binding.param
    const startCtx = timelineToCtxTime(window.startLimitSec)
    param.cancelScheduledValues(startCtx)
    param.setValueAtTime(binding.valueToAudioValue(startValue), startCtx)

    for (const point of envelope.points) {
      if (point.timeSec < window.startLimitSec || point.timeSec > window.endLimitSec) continue
      const ctxTime = timelineToCtxTime(point.timeSec)
      const value = binding.valueToAudioValue(point.value)
      if (point.interpolation === 'hold') param.setValueAtTime(value, ctxTime)
      else param.linearRampToValueAtTime(value, ctxTime)
    }
  }
}
```

Extend `AudioEngine` with:

- `setAutomationEnvelopes(envelopes)`
- `scheduleAutomationFromPlayhead(playheadSec, opts)`
- `applyAutomationAtTimelineSec(timeSec)`
- `cancelAutomationSchedules()`

Wire scheduling into `src/hooks/useTimelinePlayback.ts` at play, seek, loop wrap, horizon refresh, pause, and stop.

## Runtime Parameter Resolution

Add graph-owned resolvers.

In `packages/audio-engine/src/live-mixer-runtime.ts`:

```ts
resolveTrackAutomationBindings(trackId: string, parameterId: string): AutomationAudioBinding[]
```

In `packages/audio-engine/src/master-fx-runtime.ts`:

```ts
resolveMasterAutomationBindings(parameterId: string): AutomationAudioBinding[]
```

EQ implementation requirement:

- Store EQ nodes in a `Map<string, BiquadFilterNode>` keyed by `band.id`.
- Resolve `eq.${bandId}.frequencyHz`, `eq.${bandId}.gainDb`, and `eq.${bandId}.q` through this map.
- Do not infer the band from array order.

Supported V1 bindings:

- Track volume.
- Master volume.
- EQ frequency, gain, and Q for enabled bands.
- Effect params backed by native `AudioParam`s.

Unsupported descriptors should be hidden from the V1 picker.

## Offline Export

Update:

- `src/lib/export/run-export-job.ts`
- `packages/audio-engine/src/export-mixdown.ts`
- `packages/audio-engine/src/mixer/apply-offline-routing.ts`

Export must load automation envelopes alongside effects and schedule automation on the `OfflineAudioContext` after graph creation and before render start.

Do not reuse live runtime state.

## Timeline UI

Use SVG overlays, not canvas.

Likely files:

- `src/components/timeline/timeline-workspace.tsx`
- `src/components/timeline/TrackLane.tsx`
- `src/components/timeline/automation-lane.tsx`
- `src/components/timeline/automation-parameter-picker.tsx`

Behavior:

- Global automation mode persisted with `useProjectPersistedState`.
- Selected parameter per target persisted per project.
- Red automation line with breakpoint handles.
- Larger invisible hitboxes around points.
- Click segment to add point.
- Drag point updates draft and previews engine changes.
- Pointerup commits one persisted change and one undo entry.
- Delete/Backspace removes selected point.
- If an envelope has no points after deletion, delete it.

Follow `monorepo-new` keyframe transaction patterns and `dialkit` pointer interaction cleanup patterns.

## Undo / Redo

Extend:

- `src/lib/undo/types.ts`
- `src/lib/undo/builders.ts`
- `src/lib/undo/exec.ts`
- `src/lib/undo/persisted-history.ts`

History entry:

```ts
export type AutomationEnvelopeHistoryEntry = {
  kind: 'automation-envelope-change'
  projectId: string
  before: AutomationEnvelope | null
  after: AutomationEnvelope | null
}
```

Rules:

- One entry per gesture.
- Never record pointermove.
- Undo applies `before`.
- Redo applies `after`.
- `null` means delete envelope.
- Use the same persistence adapter as normal automation commits.
- Bump persisted history validation/version.

## Implementation Order

- [x] Add shared automation types, registry, normalization, and tests.
- [x] Add Convex schema, queries, and server mutations.
- [x] Add shared timeline operation parser, builders, and executor handling.
- [x] Add local automation persistence.
- [x] Add persisted automation state adapter.
- [x] Add audio engine scheduler and live parameter resolvers.
- [x] Add offline export automation scheduling.
- [x] Add timeline SVG UI and parameter picker.
- [x] Add undo/redo integration.
- [x] Run final validation.

## Validation

Before shipping implementation:

```bash
bun test
bun run typecheck
bun run build
```

Run `bun run knip` if new exported modules are added.
