# Ableton Effect Reordering Tracker

> Created: 2026-06-26
> Branch: `ableton-effect-reordering`
> Scope: make the effects panel order drive live playback, master bus playback, collaboration, local projects, and offline export.

## Purpose

Implement Ableton-style left-to-right audio effect ordering. Dragging an effect card in the panel must change the visible order and the audio processing order. The existing effect row `index` field is the canonical source of truth.

## Goals

- Preserve the current one-instance-per-effect-kind model: `eq`, `saturator`, `delay`, `reverb`.
- Use persisted row `index` as the single source of truth for order.
- Support local projects and shared Convex projects.
- Support track effects and master bus effects.
- Keep live playback and offline export consistent.
- Keep the UI implementation local, Solid-friendly, and dependency-free.

## Non-Goals

- Do not add multi-instance effects.
- Do not add a separate order table or parallel order state.
- Do not persist order changes during pointer movement.
- Do not redesign the audio effect chain internals.
- Do not add a drag-and-drop dependency.

## Current State

- Effect rows already have an `index` field.
- New Convex effect rows currently use `index: existing.length`.
- Local effect writes already accept an optional `index`.
- `create-effects-panel-audio-effects-state.ts` already derives `orderedEffects()` by sorting rows.
- `connectFxChain` already builds effect stages and connects them in sequence.
- The audio runtime still uses the hardcoded order `eq`, `saturator`, `delay`, `reverb`.

## Architecture Summary

```txt
Effect row index
  -> EffectsPanel orderedEffects()
  -> drag reorder rewrites indexes
  -> local/Convex persistence
  -> shared operation replay
  -> useEffectsPanelAudioSync derives order
  -> AudioEngine setTrackFxOrder / setMasterFxOrder
  -> connectFxChain reorders existing stages
  -> live playback and offline export match UI order
```

## Phase 1: Shared Effect Order Helpers

### Work

- Add or reuse `AUDIO_EFFECT_ORDER` in `packages/shared/src/effects-params.ts`.
- Add `AudioEffectKind` if it is not already exported there.
- Add `isAudioEffectKind(value: unknown): value is AudioEffectKind`.
- Add `normalizeAudioEffectOrder(order, enabled)`.

### Acceptance

- Unknown effect names are ignored by normalization and rejected by parsers.
- Duplicate effect names are collapsed.
- Missing enabled effects are appended in default order.
- Disabled or absent effects are omitted.

## Phase 2: Shared Timeline Operations

### Work

- Add `effects.reorderAudioChain` for track effects.
- Add `effects.reorderMasterAudioChain` for master effects.
- Validate `order` with `isAudioEffectKind`.
- Keep track and master operation shapes separate to match existing conventions.

### Acceptance

- Shared operation parsing accepts valid orders.
- Shared operation parsing rejects unknown effect names.
- Track reorder operations require `trackId`.
- Master reorder operations do not rely on optional `trackId`.

## Phase 3: Convex Reorder Mutations

### Work

- Add `reorderAudioEffects` to `convex/effects.ts`.
- Add `serverReorderAudioEffects` for durable operation execution.
- For track targets, enforce track write access.
- For master targets, enforce master bus write access.
- Query current effect rows for the target.
- Reindex rows by requested order.
- Preserve relative order for rows omitted from the request.

### Acceptance

- Reordering rewrites all changed indexes in one mutation.
- Missing effect rows are skipped.
- Existing rows omitted from the request remain after requested rows.
- Unauthorized users cannot reorder target effects.

## Phase 4: Timeline Operation Executor

### Work

- Route `effects.reorderAudioChain` to `serverReorderAudioEffects` with `targetType: 'track'`.
- Route `effects.reorderMasterAudioChain` to `serverReorderAudioEffects` with `targetType: 'master'`.

### Acceptance

- Shared track reorder operations reach Convex.
- Shared master reorder operations reach Convex.
- Existing effect operations continue to work.

## Phase 5: Local Effects Reorder

### Work

- Add `reorderLocalAudioEffects(projectId, targetId, order)` in `src/lib/local-effects.ts`.
- Use existing `listLocalEffects` and `setLocalEffect` APIs.
- Respect the local master prefix convention: `master-eq`, `master-saturator`, `master-delay`, `master-reverb`.
- Avoid typecasts by using explicit mapping helpers where practical.

### Acceptance

- Local track effect reorder rewrites indexes.
- Local master effect reorder rewrites indexes.
- Existing params are preserved.
- Missing rows are skipped.

## Phase 6: Audio Engine Type Plumbing

### Work

- Add `order?: AudioEffectKind[]` to `MixerTrackFx`.
- Add `order?: AudioEffectKind[]` to resolved master FX state.
- Thread master order through `resolveMixerGraph`.

### Acceptance

- Track and master order can be passed through mixer routing types.
- Existing callers compile without order.

## Phase 7: Reorder Existing `connectFxChain` Stages

### Work

- Add `order?: AudioEffectKind[]` to `connectFxChain` config.
- Keep existing effect node and stage construction.
- Store built stages in `Map<AudioEffectKind, FxStage>`.
- Assemble final `stages` using `config.order ?? AUDIO_EFFECT_ORDER`.
- Append any built stages omitted by `config.order` in default order.
- Keep the existing connection loop unchanged.

### Acceptance

- Default order remains `eq`, `saturator`, `delay`, `reverb`.
- Custom order changes the connection order.
- Missing stages are skipped.
- Existing node reuse and cleanup behavior stays intact.

## Phase 8: Live Mixer Runtime

### Work

- Add `trackFxOrders = new Map<string, AudioEffectKind[]>()`.
- Pass `trackFxOrders.get(trackId)` into `connectFxChain` from `rebuildTrackRouting`.
- Add `setTrackFxOrder(trackId, order)`.
- No-op when the order is unchanged.
- Rebuild routing when order changes and the track nodes exist.
- Clear track order in dispose and runtime clear paths.

### Acceptance

- Track FX order changes affect live playback routing.
- Setting the same order twice does not rebuild routing.
- Disposed tracks do not retain stale order.

## Phase 9: Master FX Runtime

### Work

- Add `masterFxOrder`.
- Pass `masterFxOrder` into `connectFxChain`.
- Add `setOrder(ctx, masterGain, destination, order)`.
- No-op when order is unchanged.
- Rebuild master routing when order changes.

### Acceptance

- Master FX order changes affect live master routing.
- Setting the same master order twice does not rebuild routing.
- Closing the master runtime clears order state.

## Phase 10: AudioEngine Facade

### Work

- Add `setTrackFxOrder(trackId, order)` to `AudioEngine`.
- Add `setMasterFxOrder(order)` to `AudioEngine`.

### Acceptance

- UI sync code can update track and master effect orders through the public engine facade.

## Phase 11: Offline Export

### Work

- Thread `order` through offline mixer routing.
- Pass `fx.order` into offline FX chain building.
- Pass master `order` into master offline FX chain building.
- Forward order to `connectFxChain`.

### Acceptance

- Exported audio uses the same effect order as live playback.
- Existing exports without order retain default behavior.

## Phase 12: Effects Panel State

### Work

- Add `reorder(effect, targetIndex)` to `createEffectsPanelAudioDevice`.
- Use `orderedEffects()` to compute current order.
- Commit local reorders with `reorderLocalAudioEffects`.
- Commit shared track reorders with `effects.reorderAudioChain`.
- Commit shared master reorders with `effects.reorderMasterAudioChain`.
- Respect `canWriteCurrentTargetEffects`.

### Acceptance

- Read-only targets cannot reorder effects.
- Local projects reorder without Convex.
- Shared projects publish durable operations.
- The operation payload contains the full requested order.

## Phase 13: Audio Sync Hook

### Work

- Derive audio effect order from synced rows in `useEffectsPanelAudioSync`.
- Push order to `audioEngine.setTrackFxOrder(trackId, order)`.
- Push master order to `audioEngine.setMasterFxOrder(order)`.
- Keep order derived from rows, not UI component state.
- Avoid `any` and avoid typecasts where possible.

### Acceptance

- Active and non-active track orders reach the audio engine.
- Master order reaches the audio engine.
- Order sync runs alongside existing param sync.

## Phase 14: Drag UI

### Work

- Create `src/components/timeline/create-effect-card-reorder-drag.ts`.
- Use pointer capture, matching `DraggableDeviceGraph`.
- Snapshot card bounds on pointer down.
- Compute target index from pointer X position on pointer up.
- Commit once on pointer up.
- Clear state on cancel.
- Wire the helper into effect card rendering in `EffectsPanel.tsx`.

### Acceptance

- Dragging an effect card left or right reorders cards.
- Reorder persists for local and shared projects.
- Read-only targets do not start drag reorder.
- No new drag dependency is introduced.

## Phase 15: Tests

### Work

- Test `normalizeAudioEffectOrder`.
- Test shared operation parser acceptance and rejection.
- Test `connectFxChain` default and custom ordering.
- Add local reorder tests if a suitable local effect test harness exists.
- Add Convex reorder tests if a suitable mutation test harness exists.

### Acceptance

- Default order remains backward compatible.
- Invalid shared operations are rejected.
- Custom chain order is observable in tests.
- Persistence helpers preserve params while changing indexes.

## Phase 16: Simplification Pass

### Work

- Review changed code for duplicated order normalization.
- Remove redundant guards that are already enforced by parsers or helpers.
- Keep helper APIs consumer-shaped.
- Keep JSX shallow and local to the effect panel.

### Acceptance

- No duplicate order derivation logic remains where a shared helper can be used.
- No dead exports or generic abstractions are introduced.
- The implementation remains focused on effect reorder only.

## Phase 17: Validation

### Work

- Run `git diff --check`.
- Run `bun run typecheck`.
- Run targeted tests for changed modules.
- Run `bun test`.
- Run `bun run knip`.
- Run `bun run build`.

### Acceptance

- All validators pass.
- Any expected build warnings are identified as pre-existing.

## Progress

- [ ] Phase 1: Shared effect order helpers
- [ ] Phase 2: Shared timeline operations
- [ ] Phase 3: Convex reorder mutations
- [ ] Phase 4: Timeline operation executor
- [ ] Phase 5: Local effects reorder
- [ ] Phase 6: Audio engine type plumbing
- [ ] Phase 7: Reorder existing `connectFxChain` stages
- [ ] Phase 8: Live mixer runtime
- [ ] Phase 9: Master FX runtime
- [ ] Phase 10: AudioEngine facade
- [ ] Phase 11: Offline export
- [ ] Phase 12: Effects panel state
- [ ] Phase 13: Audio sync hook
- [ ] Phase 14: Drag UI
- [ ] Phase 15: Tests
- [ ] Phase 16: Simplification pass
- [ ] Phase 17: Validation
