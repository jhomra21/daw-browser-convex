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

## Runtime regression fix

- [x] Local waveform source descriptors now use subscriber-aware bounded caching for local assets; non-verified files retain an asset-scoped session identity instead of generating a new identity for every resolution, while verified stretch sources retain content-hash identities.
- [x] Waveform view-model source reuse includes the stretch verification mode, so enabling Stretch cannot reuse a non-verified descriptor.
- [x] Clip media-cache teardown clears the bounded local descriptor cache so file-backed descriptors do not outlive the active media generation.
- [x] The arrangement playhead is omitted when it is outside the logical viewport, preventing distant playhead coordinates from expanding the physical timeline surface during deep zoom.
- [x] Focused resolver, viewport, waveform, and timeline tests pass; browser runtime acceptance remains pending.

## Final audit hardening

- [x] Arrangement PCM cache and dedupe keys include the canonical asset key, preventing cross-project reuse when source identities and ranges match.
- [x] Long multi-tile PCM requests submit work incrementally within scheduler capacity instead of saturating their own two-active and 64-queued budget.
- [x] Partial final source tiles size envelope columns from the clipped frame count, preserving sample placement at end-of-file.
- [x] Audio source descriptor and pending-resolution caches are resolver-instance scoped; clip media teardown clears only the active resolver.
- [x] Waveform view models preserve prior PCM only after the newly resolved source identity matches, preventing stale media after source replacement.
- [x] Automation viewport boundaries retain active hold interpolation, and MIDI notes are culled before deep-slice projection.
- [x] Focused audit regressions pass, and an independent final review reported no remaining P0/P1/P2 finding.

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

## Latest exact-head evidence

- Final source head: `d9b0400d0cb4643ea359054fee75f2288dfc72e8`.
- Cloudflare build `be0a27a1-3ee5-490b-a90c-19d61a95dabe` succeeded.
- Version-only preview: `5d26eb00-b537-4e3c-be50-818435776f88`; no production traffic was routed.
- Exact-head arm64 Electron packaging succeeded with the accepted SDK at `/Users/juan/Documents/vst3sdk-3.8.0`, including the VST3 scanner, VST3 worker, native audio host, and packaged application.
- Exact-head static gates pass: focused tests, package/root/API typechecks, lint with zero warnings, anti-slop, production build, portable Wasm validation, and `git diff --check`.
- Full suite result: 2,903 passed, one intentional Electron-only skip, and one unrelated five-second timeout in the 129th protected-recovery fixture. Its complete file passed immediately afterward with 14 passed and zero failed; the timed test completed in 4.216 seconds.
- Actual Safari 26.3 is installed. The `AllowRemoteAutomation` preference is absent, so WebDriver automation is not proven enabled and no simulated Safari result is claimed.
- Fresh browser and packaged-Electron automation could create clean local projects and confirmed the 200,336 px bounded runway. Automated bundled-audio drag/import then stopped responding before a representative playback fixture or valid telemetry campaign could complete. This is unresolved acceptance evidence, not a readiness pass.
- Browser playback stress, four LOD screenshots, objective destination PCM telemetry, actual-Safari bounce/recenter, and packaged Electron native playback stress remain required. The branch is not declared ready.

## Recursion fix and runtime acceptance

- Recursion-fix source head: `04bd307caac9f71aaa8ac9766ebac378abc963f4`.
- `useClipWaveformViewModel` no longer subscribes its waveform-loading effect to the
  `segments` value that the same effect writes. Browser-condition regression tests
  cover initial rendering and repeated zoom updates.
- Exact-head static validation passed: focused browser-condition tests, typecheck,
  lint with zero warnings, anti-slop, production build, `git diff --check`, and an
  independent review. The full suite passed 2,905 tests with one intentional
  Electron-only skip and zero failures.
- Cloudflare build `42ccfc11-4516-415a-9dab-d4aa54093990` succeeded. Version-only
  preview `5528f401-ac04-436f-981d-58b874794518` was used without routing production
  traffic.
- Factory in-app browser acceptance used eight tracks, one six-minute WAV, and
  sixteen short WAV clips. Playback advanced beyond 141 seconds through twelve
  extreme zoom cycles with no captured JavaScript errors.
- Browser runtime measurements after settlement:
  - rAF median approximately 8.3 ms, p95 approximately 8.9 ms, and p99
    approximately 9.3 ms.
  - Five observed long tasks at or above 100 ms; telemetry maximum approximately
    166 ms.
  - Heap started near 50.6 MiB, peaked near 295.8 MiB, and settled near
    139–151 MiB while playback continued.
  - Physical runway remained 200,336 px. Maximum observed canvas backing area was
    163,904 pixels.
- Browser screenshot evidence is stored in
  `acceptance-reports/deep-zoom-04bd307/`. The cached-peaks and PCM-envelope
  transitions are visually distinct. The raw-PCM and sample-points captures are
  visually indistinguishable, so this tracker does not claim four independently
  proven visual LOD states.
- The exact-source arm64 Electron package was rebuilt with the existing local
  Convex build configuration and accepted VST3 SDK. The first package attempt
  omitted `VITE_CONVEX_URL`, causing a startup `ZodError`; that artifact was
  discarded and the configured rebuild mounted correctly at `daw://app/`.
- Packaged Electron acceptance created a fresh local project and imported a
  six-minute WAV plus a short WAV through the public desktop adapter. The native
  audio-host process launched, transport advanced from 360 seconds to beyond
  432 seconds during twelve deep-zoom cycles, no JavaScript error was captured,
  the physical runway stayed at 200,336 px, and renderer heap was approximately
  85 MiB after stress. Renderer rAF median was approximately 8.3 ms, p95 9.3 ms,
  and p99 9.4 ms; the single 15.8-second first-sample gap includes pre-observation
  attachment time and is not classified as an in-campaign frame interval.
- Packaged process RSS during continuing playback was approximately 183 MiB for
  Electron main, 180 MiB for the renderer, and 14 MiB for the native host.
- The public diagnostic snapshot continued to report the audio device as
  `uninitialized` with no sample rate even while native transport and the
  playhead advanced. Objective device/output PCM evidence is therefore not
  proven.
- Actual Safari 26.3 remains installed but Remote Automation is not enabled. Per
  the selected acceptance path, no Chromium result is labeled as Safari.
- Remaining readiness blockers are objective native output/device initialization,
  independently proven raw-PCM versus sample-point visual evidence, and actual
  Safari bounce/recenter acceptance. The branch remains not ready and PR #54
  must remain open and unmerged.

## Final security follow-up

- This security follow-up is the final branch commit recorded by Git history.
- The branch security scan found one cross-project cache-isolation issue:
  unverified local descriptor identities included only the local asset key.
- Unverified local identities now include the required project ID, while verified
  Stretch content-hash identities remain unchanged. Equal local asset keys in
  different projects are covered by a focused regression and no longer produce
  equal scheduler identities.
- The resolver and scheduler focused validation passed 29 tests, application
  typecheck passed, changed-file lint reported zero warnings, and
  `git diff --check` passed.
- The follow-up STRIDE scan analyzed 46 changed production files and reported no
  remaining vulnerability with confidence at or above 0.8.
