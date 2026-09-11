# Deep Timeline Zoom Performance — Wave B/C

## Baseline and scope

- Exact implementation base: `91188e0be185b60b624c08034f4fa9440de873ad`.
- Target branch: `feat/deep-timeline-zoom-performance`.
- Frozen rule: PR #52 and `fix/native-asset-capacity` are frozen; this branch must not modify or merge them.
- Reference branch heads (read-only through `git show`/`git diff`):
  - `c034f1c4733ac20508e893f05417bbedfcd6177f`
  - `a139c3da011329f1229e6a25d05a0d6272c06da1`
  - `ac0cc5ab71ce9a60c4a09ab8dece8378d069e47d`

## Evidence and current constraints

- At the exact base before Wave A, `src/lib/timeline-view.ts` defined `MAX_PIXELS_PER_SECOND = 800`.
- At that base, `src/hooks/useTimelineViewport.ts` independently used `width / 800` as the minimum visible duration. This is the duplicate boundary removed in Wave A.
- Historical commit `6f43b3f6c59063d5e474fc544f095307b86e127f` introduced the 800 px/sec cap and the width/800 calculation as part of the initial timeline zoom/arrangement overview. Its commit and diff contain no documented browser or DSP rationale for that boundary.
- Current viewport behavior derives scroll/time from a duration-sized timeline surface and clamps against `durationSec * pixelsPerSecond`; Wave A adds duration-independent logical geometry and a bounded physical runway/recentering contract but does not migrate UI consumers.
- Current DOM layout uses duration-scaled surfaces in `src/components/timeline/timeline-workspace.tsx:397,406`, `src/components/timeline/TimelineRuler.tsx:31,275`, and `src/components/timeline/GridOverlay.tsx:48`; clip DOM widths are duration-scaled in `src/components/timeline/ClipComponent.tsx:400`.
- Current canvas consumers size and draw per component canvas (`src/components/timeline/ClipComponent.tsx:197-201`) and current waveform requests derive draw columns and source windows from the full-duration clip/layout (`src/lib/audio-waveform-layout.ts:87-126`, `src/hooks/useClipWaveformViewModel.ts:75-88`). This is the current DOM/canvas/request limitation surface. Wave A keeps current Arrangement, Sample Detail, and Drum Rack consumers unchanged; migration remains integration work.
- Frozen-source baseline:
  - `MAX_PIXELS_PER_SECOND` is 800 px/sec.
  - Timeline, ruler, grid, clips, and waveform canvases derive physical geometry from duration multiplied by pixels/sec.
  - A six-minute source therefore reaches 288,000 px at the old maximum; a two-hour project reaches 5,760,000 px.

## Intended resource budgets

- `MAX_PIXELS_PER_SECOND`: one fixed source of truth at `480_000` px/sec.
- Arrangement PCM scheduler: at most 2 active decodes, at most 64 queued jobs, 16,384-frame stable tiles, 32 MiB completed cache, and 8 MiB maximum cache entry.
- Cache must be bounded by both bytes and entry count; oversized, null, and failed results are not cached.
- No whole-file decode, unbounded allocation, timer/rAF loop, or independent retry loop.

## Wave A acceptance checklist

- [x] Tracker created before source edits.
- [x] Pure logical viewport geometry contracts and focused tests added; ordinary zoom behavior preserved; no UI consumer migration.
- [x] Shared waveform LOD selector uses the specified 400-columns/sec, samples-per-pixel, and 5-pixels-per-sample boundaries with exact threshold tests.
- [x] Bounded channel-aware PCM envelope and raw sample-window primitives preserve frame windows, channel separation, gaps-as-silence, metadata validation, and bounded allocations.
- [x] Framework-independent arrangement PCM scheduler covers concurrency, FIFO priority, dedupe, cancellation, stale identity, queue/cache bounds, retryability, and aggregate diagnostics.
- [x] Shared waveform LOD selection and render primitives now drive Arrangement and Sample Detail; Sample Detail keeps cached peaks while bounded visible-range PCM work progresses through envelope, raw line, and points.
- [x] Persisted peaks use format version 3 with channel-aware signed min/max planes, IndexedDB schema recreation, and unchanged 400/100/25 levels with two-second streaming chunks.
- [x] Drum Rack consumes the explicit channel-aware peak shape without reintroducing collapsed-channel rendering.
- [x] Narrow tests, waveforms check, relevant TypeScript checks, supported lint, and `git diff --check` pass.
- [x] Final review confirms no casts, duplicate APIs, whole-file decode, unbounded allocation, timers, or rAF.
- [ ] Runtime baseline remains explicitly pending; Wave A does not claim full feature readiness.
- [ ] Runtime benchmarks, browser acceptance, and full marker/warp interaction acceptance remain pending after waveform convergence.

## Wave B/C implementation facts

- [x] Arrangement viewport consumers now use a logical visible origin, fixed-pixel overscan, and a bounded 200,000 px physical runway; arrangement surface, ruler, grid, overlays, and footer no longer size from project duration.
- [x] Pointer projection, playhead scrubbing, selection, clip drag/resize/import placement, jump-to-clip navigation, ruler loop editing, automation, clip shells, collapsed overviews, playhead, loop, range, recording preview, and grid/ruler phase use viewport-relative coordinates.
- [x] Horizontal clip culling uses the overscan range and preserves selected clips; clip canvas windows are limited to the visible intersection and request exact source windows.
- [x] Arrangement waveform requests preserve source identity, cancellation, generation checks, cached peaks during PCM loading, and use the shared cached-peak/PCM LOD selector plus the bounded channel-aware PCM scheduler.
- [x] Deep ruler intervals include 10/5/2/1 ms and 500 us candidates, selected by pixel spacing; musical grid selection remains unchanged.
- [x] Focused geometry, ruler, selection, waveform LOD, PCM scheduler, and renderer tests pass; package/application typechecks and changed-path lint pass.
- [ ] Runtime benchmarks, browser acceptance, Safari bounce behavior, and full interaction acceptance remain pending.

## Deep-zoom audit follow-up

- [x] Clip rendering now mounts only real viewport intersections; selected clips no longer become offscreen phantom shells, resize handles are boundary-aware, fade edits use absolute clip-local time through sliced overlays, and range overlays use the rendered slice origin.
- [x] Waveform source resolution is bounded and deduplicated for stable source fields; prior overlapping waveform segments remain visible while adjacent work loads; PCM requests retain aligned tile dedupe and stale cancellation.
- [x] PCM scheduler keeps two active decodes and 64 queued jobs, assigns visible-center priority, evicts queued overscan work for visible requests, and exposes capacity/eviction diagnostics instead of silently starving visible work.
- [x] Sample Detail overview uses the canonical source resolver and peak ensure/read path, including generation on cache miss and identity validation.
- [x] Peak persistence now rejects malformed metadata/chunks, propagates durable write failures, removes incomplete assets before regeneration, and publishes metadata only after all chunks store successfully.
- [x] Sample Detail viewport clamps reactively when the same clip's duration or sample rate changes while preserving the valid anchor.
- [x] A read-only `@daw-browser/waveforms/diagnostics` accessor exposes aggregate scheduler counters without asset or project identifiers.
- [x] Added focused deep-zoom interaction, scheduler saturation, persistence-integrity, and viewport-clamp coverage.
- [ ] Runtime browser acceptance and six-minute canvas measurements remain pending; no runtime work is claimed by this follow-up.

## Final deep-zoom audit

- [x] Range, loop, return-range, and collapsed-clip overlays intersect the actual viewport before projection; extreme-zoom detectors cover 480,000 px/sec and bounded widths.
- [x] PCM envelope decoding honors requested columns for exact ranges and multi-tile assembly; exact impulse alignment and canvas-sized output are covered.
- [x] Shared descriptor resolution uses subscriber-aware pending work with an internal abort controller; individual cancellation no longer poisons remaining subscribers, and final cancellation permits immediate replacement.
- [x] Sample Detail raw PCM segments render with segment-local width and offset; trim, trailing silence, and marker-warp segment coverage remains in waveform layout tests.
- [x] MIDI bar-line indices are bounded to the visible clip slice and use the same slice origin/duration as notes.
- [x] Sample Detail overview captures CSS width and project BPM synchronously inside the reactive effect before asynchronous source work.
- [ ] Runtime browser acceptance, six-minute canvas measurements, and full-suite fixture-backed acceptance remain pending.

## Exact-commit release evidence

- Feature commit: `9f701ff69cd77955e8e4048100079f05a62db6d8`.
- Cloudflare build `85958d22-2c53-42e0-98fb-26fc051e86e8` succeeded.
- Version-only preview: `18712a70-9495-441e-a677-325029086139`; no production traffic was routed.
- Empty-project extreme-zoom smoke test on the exact preview:
  - Physical scroll runway: 200,336 px.
  - Visible timeline workspace: 552 px.
  - Largest DOM width: 200,336 px, independent of project duration.
  - JavaScript heap after the zoom stress: 41,754,017 bytes.
- Full static release gates passed: package/root/API typechecks, lint with zero warnings, anti-slop, production build, portable Wasm validation, Workers dry-run, and `git diff --check`.
- Focused deep-zoom suites passed, including 43 waveform package tests, 133 affected timeline tests, and all final audit detectors.
- The final isolated full suite passed: 2,896 passed, one intentional Electron-only skip, zero failed, 2,897 tests across 364 files, and 372,463 assertions.
- Desktop TypeScript checks pass. Packaging is blocked in this disposable worktree because no `VST3_SDK_PATH` is configured and no VST3 SDK is vendored.
- Full audio-project browser stress, four LOD screenshots, Safari bounce behavior, and packaged Electron playback acceptance remain outstanding. This tracker does not claim those runtime checks.
