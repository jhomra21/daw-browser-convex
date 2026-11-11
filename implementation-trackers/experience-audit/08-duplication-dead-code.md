# Cross-cutting Duplication, Dead Code, and Consistency Audit

Read-only audit of the current working tree on 2026-10-14. No source, builds, tests, dev servers, or applications were modified/run. `bunx knip --no-progress --reporter json` returned exit code 1 but emitted valid JSON to `/private/tmp/knip.json`, which was triaged. The working tree already had extensive unrelated changes; this report does not attribute them.

## Summary

- **10 actionable findings**: 7 duplication/organization (C), 3 dead-code (D). No confirmed unused whole source files; Knip's file candidates mostly have test/runtime-entry uncertainty.
- **Knip:** 470 issue records total, 104 outside acceptance-reports; only a small subset are candidate dead exports. Generated acceptance evidence accounts for many file entries. Knip is not treated as proof without reference checking.
- **Largest authored files:** top 15 production source files over 1,000 lines are listed below. Generated declaration, build output, and tests are excluded from responsibility-split recommendations.
- **Markers:** 30 `console.log` matches, 0 TODO, 0 FIXME, 0 HACK in scanned TS/TSX/JS/JSX source.
- **TypeScript tokens:** 1,271 `as` occurrences and 529 `any` occurrences. Counts include generated files, type-level constructs, comments, and test code, and are not a count of unsafe casts / explicit-any violations.
- **Verification:** no typecheck or tests run per request. Recommended verification for migrations is listed per finding.

## 1. Dead code

### Confirmed unused exports

**D (dead code) — Knip candidates:** references were searched across source, tests, tools, Electron, API, and Convex. Knip surfaced these exports; they had no reference found beyond their definition in the audited source search. Remove the export (or the helper if it is otherwise private and unused) only after the intended public/package boundary is checked.

- **XC-01 (D) — Unused exports on otherwise-live helpers**
  - Evidence: `src/lib/audio-pcm-source-resolver.ts:322` (`audioPcmSourceResolverCacheLimits`); `src/lib/external-plugin-artifacts.ts:113` (`deleteLocalExternalPluginState`). Knip reports both exports unused; no source, test, tool, Electron, API, or Convex reference was found.
  - Canonical target: keep the current owning module; narrow visibility rather than moving code.
  - Migration size **S**, risk **low**.
  - Verification: `bun run typecheck`; targeted audio PCM resolver and plugin-artifact tests.
- **XC-02 (D) — Exported but apparently unconsumed performance/engine constants**
  - Evidence: `packages/audio-engine/src/audio-runtime.ts:14` (`CANONICAL_DECODE_SAMPLE_RATE`); `packages/audio-engine/src/worklet-manifest.ts:31` (`portableAudioCoreWasmManifest`); `packages/audio-engine/src/true-peak-kernel.ts:1,3,8` (three reported constants); `src/lib/sampled-instrument-region-loader.ts:42` (`DEFAULT_SAMPLED_INSTRUMENT_REMOTE_LOAD_DEADLINE_MS`, internally consumed at 159, so export alone is unused); `src/lib/timeline-viewport-geometry.ts:44` (`TIMELINE_VIEWPORT_OVERSCAN_PX`, internally consumed at 110, so export alone is unused); `src/lib/export/native-offline-pcm-spool.ts:9-10` (two reported replay constants).
  - Canonical target: keep private constants in their existing owning module; preserve only real cross-module API.
  - Migration size **S**, risk **low**.
  - Verification: `bun run typecheck`; nearest audio-engine/export/waveform tests.
- **XC-03 (D) — Unused exports in native host and application boundaries**
  - Evidence: `apps/desktop/native-vst3-coordinator.ts:106,135,152` (three Knip-reported exports); `apps/desktop/native-release-artifacts.ts:79` (`validateNativeReleaseArtifactPlan`); `apps/desktop/release.config.ts:201` (`getNativeReleaseArtifacts`); `apps/desktop/recording-start-diagnostic.ts:12` (`recordingStartDiagnosticEventSchema`); `apps/desktop/vst3-scanner.ts:54` (`assertSafeVst3Bundle`).
  - Canonical target: keep Electron/build APIs private to their entry modules unless imported externally by a script/config that Knip cannot model.
  - Migration size **S**, risk **med** due to build-time/dynamic consumers.
  - Verification: `bun run typecheck`; desktop packaging/native VST acceptance checks and relevant desktop tests.

### Not confirmed as dead

- Knip reported **no unreferenced source file confirmed removable**. `src/hooks/useLocalProjectActions.browser-test.ts`, `src/lib/desktop/native-playback-lifecycle.browser-runtime.ts`, `src/lib/recording/benchmark-sab-worker.ts`, and multiple `tools/performance/30-track/*` entries may be invoked by browser harnesses, workers, scripts, or manual acceptance flows. Do not delete based on the Knip file issue alone.
- Knip's exported `hydrateInstrumentBuffers` is used by its own module and by `Timeline.tsx` through the controller callback; it is live.
- Knip's `recordedAudioContentSchema` is used by neighboring performance acceptance code/tests; it is live.
- Many reported types are imported by tests or consumers outside Knip's graph. No test-only-used export is labeled removable here; re-run Knip with the complete intended workspace/entry configuration before deleting any type/API.

## 2. Duplicate helpers

- **XC-04 (C) — Clamp implementation is copied across domains.**
  - Evidence: `src/lib/midi-editor-grid.ts:32`, `src/lib/timeline-midi-bounds.ts:13`, `src/components/timeline/clip-fade-interaction.ts:31`, `src/components/effects/Delay.tsx:42`, `src/components/effects/Reverb.tsx:45`, `src/components/effects/synth-visualizations.ts:3`, `packages/audio-engine/src/bpm-detection.ts:23`, `packages/audio-engine/src/synth-voice.ts:110`, `packages/shared/src/synth-params.ts:112`, `packages/shared/src/granular-params.ts:28`, `packages/shared/src/sampler-params.ts:70`, `packages/shared/src/drum-rack-params.ts:49`, `packages/shared/src/automation-parameters.ts:96`, `packages/shared/src/effects-params.ts:44`, `packages/timeline-core/src/clip-fades.ts:19`.
  - Canonical target: a tiny `clamp` in a low-level shared numeric package, only for semantically identical inclusive bounds; retain named/domain-specific clamps where input normalization differs.
  - Migration size **M**, risk **med** (boundary/NaN semantics vary); **15 definitions, about 144 in-file uses** across the listed implementations.
  - Verification: `bun run typecheck`; tests for MIDI grid, timeline bounds/fades, params, DSP, Delay/Reverb.
- **XC-05 (C) — dB/linear conversion duplicated in rendering/export paths.**
  - Evidence: `packages/audio-engine/src/effects/dsp.ts:59` (`dbToGain`); `src/lib/export/process-native-offline-pcm-spool.ts:29-30`; `packages/audio-engine/src/export-fidelity.ts:44-45`; `packages/audio-engine/src/streaming-export-fidelity.ts:25-26`; `packages/audio-engine/src/streaming-true-peak-limiter.ts:25`.
  - Canonical target: `packages/audio-engine/src/effects/dsp.ts` or a small DSP math module for shared conversion; retain explicit zero-to-negative-infinity handling.
  - Call sites to migrate: 17 in-file uses of `linearFromDb` / `dbFromLinear` across the listed four modules; wider `10 ** (db / 20)` use also exists in recording, automation, and limiter code.
  - Migration size **M**, risk **med** (zero, finite-value, and naming semantics).
  - Verification: `bun run typecheck`; export fidelity, streaming fidelity, true-peak, and DSP tests.
- **XC-06 (C) — Runtime time formatting diverges by screen.**
  - Evidence: `src/components/timeline/automation-lane.tsx:37` (`formatTime`); `src/components/dashboard/samples-view.tsx:10` (`formatSampleDuration`); `src/components/timeline/TransportControls.tsx:405` inline seconds; `src/components/timeline/clip-fade-interaction.ts:176` separate “seconds” label.
  - Canonical target: do not impose one universal formatter where precision/unit/copy differ; centralize only a shared duration-display policy if UX wants identical output.
  - Migration size **S**, risk **low**.
  - Verification: `bun run typecheck`; targeted browser checks for timeline and sample list labels.
- **XC-07 (C) — `isRecord` wrappers repeat around the existing JSON guard.**
  - Evidence: `src/lib/undo/persisted-history.ts:43`, `src/lib/undo/shared-ungroup-history.ts:43` both wrap `isJsonObject`; `packages/shared/src/project-manifest-contract.ts:69`, `packages/shared/src/instrument-params.ts:112`, and `packages/shared/src/shared-timeline-operations.ts:272` define near-identical object guards.
  - Canonical target: reuse the existing `isJsonObject` for JSON data; retain specialized typed guards at protocol boundaries where their value type differs.
  - Migration size **S**, risk **low**.
  - Verification: `bun run typecheck`; undo history and shared-operation parser tests.
- **XC-08 (C) — Drag gesture ownership is split among multiple local implementations.**
  - Evidence: `src/hooks/useDrag.ts:27-28,82-109`; `src/hooks/useTimelineSidebarResize.ts:33-53`; `src/hooks/useTimelineLeftBrowserResize.ts`; `src/hooks/useClipDrag.ts`; `src/hooks/useClipResize.ts`; `src/components/timeline/browser/create-browser-device-drag.ts:179`; `src/components/timeline/create-effect-card-reorder-drag.ts:33`; `src/components/midi/MidiEditorCard.tsx:55-59`.
  - Canonical target: use `useDrag` for simple pointer capture/listener lifecycle; keep timeline clip, device-drop, and MIDI gesture models domain-specific, extracting only proven common ownership/cleanup logic.
  - Migration size **M**, risk **med** (pointer capture, cancellation, multi-pointer and gesture ownership).
  - Verification: `bun run typecheck`; pointer-gesture, clip drag/resize, sidebar resize, device drag, MIDI editor browser tests.

## 3. Parallel implementations of the same component/concept

- **XC-09 (C) — Device controls have multiple interaction primitives, but are not confirmed duplicate sliders.**
  - Evidence: `src/components/ui/knob.tsx`; `src/components/timeline/MixerVolumeSlider.tsx`; `src/components/ui/device-control.tsx`. UI search found no separate shared Slider primitive and no Toast system in `src/components/ui`.
  - Canonical target: keep rotary parameter knobs, mixer fader, and compact device controls distinct where their interaction/visual semantics differ; document/align shared keyboard, drag, and value accessibility behavior rather than merging them.
  - Migration size **S**, risk **low**.
  - Verification: `bun run typecheck`; knob and mixer interaction browser coverage.
- Dialog shell is centralized at `src/components/ui/dialog.tsx`; `src/components/ui/sheet.tsx` is a distinct modal surface with different positioning/interaction and should not be counted as a second dialog implementation. Context-menu system is centralized in `src/components/ui/context-menu.tsx`, with timeline item-model composition in `src/components/timeline/context-menu/timeline-context-menu.tsx`; these are a wrapper and a consumer, not duplicate menu systems.
- Track/effect/browser drag entry points coexist but have different semantics. Findings propose a shared low-level pointer lifecycle only, not a single generalized DnD manager.

## 4. Consistency

### Naming

- **XC-10 (C) — `trackId` is the established identity term; `laneId` should not silently substitute for it.**
  - Evidence: `packages/shared/src/automation.ts:15,47` and `packages/shared/src/sampler-automation.ts:51` use `trackId`; application surfaces consistently use `Track['id']` and `trackId`, including `src/hooks/useTimelineAudioWarp.ts:18` and `src/hooks/useTimelineMixerController.ts:35-72`. The scanned shared model has no same-entity `laneId` definition.
  - Canonical target: `trackId` for persisted/domain identity; reserve “lane” for arrangement/automation display regions and layout coordinates.
  - Migration size **S**, risk **med** if a persisted wire name is involved; no rename recommended absent a concrete conflicting field.
  - Verification: `bun run typecheck`; control/protocol serialization tests if any wire field changes.
- Filename conventions are inconsistent in `src/components/ui/`: PascalCase (`Icon.tsx`) and lowercase kebab-case (`context-menu.tsx`, `text-field.tsx`) sit alongside lowercase single-word components. Avoid broad rename; apply the repository's kebab-case guidance to new files and rename only in an isolated, import-safe cleanup.

### Large-file size/responsibility table

Top 15 production source files over 1,000 lines from the size inventory; test files are excluded. Responsibilities are inferred from module/file structure; the recommended seam is a proposal, not proof a split is immediately safe.

| File | Lines | Distinct responsibilities / existing seam |
|---|---:|---|
| `apps/desktop/audio-host.ts` | 2,853 | Audio host lifecycle, IPC/runtime commands, diagnostics; split by protocol command families behind existing host interface. |
| `src/components/Timeline.tsx` | 2,744 | Timeline composition, route/project state, action wiring, overlays; existing `timeline-workspace`, `timeline-panels`, `timeline-overlays` seams. |
| `apps/desktop/main.ts` | 2,637 | Electron startup, window lifecycle, IPC registration, menus/permissions; split into lifecycle, IPC registration, application menu modules. |
| `src/lib/desktop/native-playback-controller.ts` | 2,306 | Native transport, scheduling, parameter queues, lifecycle; existing `native-schedule-coordinator` and parameter queue boundaries. |
| `src/lib/portable-browser-playback-controller.ts` | 2,087 | Browser transport, scheduling, recording and resource lifecycle; split around schedule, recording, and session lifecycle interfaces. |
| `src/hooks/useTimelinePlayback.ts` | 1,984 | Playback state, engine selection, scheduling, transport UI; use browser/native controller seam and smaller transport state helpers. |
| `convex/tracks.ts` | 1,942 | Track reads/writes, grouping, mixer, routing; existing `trackWrites.ts`, `trackRouting.ts`, `mixerChannels.ts` modules are natural boundaries. |
| `packages/audio-engine/src/audio-stretching.ts` | 1,806 | Stretch planning, render algorithms, chunk/stream processing; split pure plan/math from render orchestration. |
| `packages/control-core/src/planner.ts` | 1,793 | Action parsing/planning, references, validation/preview; split by planner phase only if public contract remains stable. |
| `convex/clips.ts` | 1,675 | Clip queries, mutations, audio/warp logic; existing `clipWrites.ts` and validators are natural seams. |
| `src/components/timeline/create-effects-panel-audio-effects-state.ts` | 1,639 | Audio effect instance projection, state writes, synchronization; existing controller and audio-sync modules are nearby seams. |
| `src/lib/export/run-export-job.ts` | 1,600 | Export orchestration, source preparation, rendering, encoding; split stage adapters around source/render/encode contracts. |
| `packages/shared/src/shared-timeline-operations.ts` | 1,587 | Operation schemas, parsing, normalization, payload validation; split schema families while keeping one public operation contract. |
| `convex/effects.ts` | 1,499 | Effect reads/writes and validation; group by effect family or mutation/query boundary. |
| `packages/audio-engine/src/export-mixdown.ts` | 1,422 | Mixdown graph setup, offline rendering, analysis/output; split graph construction from render/write lifecycle. |

### Debug, TODO/FIXME/HACK, casts and `any`

Scanned source roots `src packages apps/desktop convex api tools`; excluded `dist`, `.vite`, and dependencies where practical. `as` and `any` are token counts, not AST-classified casts/types. AGENTS' no-cast rule should be enforced by lint/type-aware checks; many current `as` uses may be legitimate literal/narrowing or generated.

| Area | `console.log` | TODO/FIXME/HACK | `as` tokens | `any` tokens |
|---|---:|---:|---:|---:|
| `src` | 12 | 0 | 443 | 26 |
| `packages` | 0 | 0 | 208 | 44 |
| `apps/desktop` | 2 | 0 | 156 | 9 |
| `convex` | 0 | 0 | 313 | 266 |
| `api` | 0 | 0 | 91 | 173 |
| `tools` | 16 | 0 | 60 | 11 |
| **Total** | **30** | **0** | **1,271** | **529** |

Note: counts are literal token matches, not AST-classified casts/types; the `as` total includes `as const`, type assertions, and unrelated token text. Counts exclude `.vite`/`dist` but include generated `convex/_generated` and `api/worker-configuration.d.ts`; they are not lint violation totals. All 30 `console.log` occurrences are primarily evidence/report output: 16 are in `tools/performance/30-track`, 12 in `src` (11 under `src/hooks`, mostly browser-test evidence), and 2 in `apps/desktop`. No TODO/FIXME/HACK token was found in the scanned source files.

## 5. Open/obsolete tracker spot-check

- `implementation-trackers/context-menus-tracker.md:5-22` has all plan items checked off, with explicit validator/simplification/review completion. The tracker appears complete; archive/close it if the tracker convention has a completed state.
- `implementation-trackers/assertion-adoption-tracker.md` describes a multi-phase adoption plan, but current `packages/shared/src/assert.ts` exists and exports `assertNever` (source line 13). This means the initial “add helper” step is obsolete, while listed adoption candidates still require a fresh status check; update tracker phases rather than treating the full plan as unstarted.
- `implementation-trackers/duration-independent-media.md:5` says `IN PROGRESS`. Current scan found no direct contradiction sufficient to call the work done; tracker is unresolved, not marked obsolete.
- `implementation-trackers/audio-settings-dashboard-tracker.md:136` retains an unchecked “Open Audio Settings without a project…” item. This audit did not run app/E2E checks, so cannot call it done.

## Payoff order

1. **XC-05** — unify audio conversion formulas across offline/streaming export with shared math and focused DSP verification.
2. **XC-04** — reduce repeated clamp implementations after defining common finite/boundary semantics.
3. **XC-08** — consolidate pointer listener lifecycle while preserving domain-specific drag behavior.
4. **XC-03** — remove dead export surfaces once Electron/build-time consumers are excluded.
5. **XC-01** — prune clearly unneeded public exports without moving ownership.
6. **XC-07** — reuse canonical JSON object guard in undo parser helpers.
7. **XC-02** — narrow exports for constants that have no cross-module consumer.
8. **XC-06** — align duration display only where product copy and precision are intended to match.
