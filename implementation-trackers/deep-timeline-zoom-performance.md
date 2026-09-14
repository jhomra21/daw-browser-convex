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
  `acceptance-reports/deep-zoom-04bd307/`. The raw-PCM capture was verified with
  zero canvas point-arc calls and 1,726 line calls. The sample-points capture was
  verified with 432 point-arc calls and 918 line calls. The two captures are now
  visually distinct and independently prove the raw-line and point LODs.
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
- Exact-head native diagnostics report artifact verification `verified`, ABI 4,
  active graph revision 1, one installed asset, advancing callback/render epochs,
  and zero rejected blocks. A bounded native meter capture reported stereo RMS
  between approximately 0.122 and 0.126 over sounding content.
- An isolated ten-cycle Electron zoom reproduction kept the same native-host PID,
  advanced playback beyond 22 seconds, retained the 200,336 px runway, and ended
  with 2,153 callbacks and zero rejected blocks. Earlier PID changes were caused
  by overlapping timed-out automation evaluations and are not reproduced by the
  bounded campaign.
- Actual Safari 26.3 remains installed but Remote Automation is not enabled. Per
  the selected acceptance path, no Chromium result is labeled as Safari.
- Actual Safari bounce/recenter acceptance remains unavailable: Safari 26.3 is
  installed, the `AllowRemoteAutomation` preference is absent, SafariDriver
  diagnostics do not complete, no repository-supported WebKit harness exists,
  and the available desktop-control driver is not installed. No Chromium result
  is labeled as Safari.
- Browser and packaged Electron runtime gates are green. Safari remains an
  explicitly unproven platform limitation, so the branch is not declared fully
  ready under the original all-platform acceptance contract. PR #54 must remain
  open and unmerged.

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

## Waveform fallback correction (`8ee079c`)

- Corrected two distinct causes behind the long-audio hatch report. Same-source pan/zoom now preserves only overlapping ready segments while bounded replacement work is pending. Long local waveform generation now requests a byte-verified source identity, allowing peak chunks evicted from the 64-entry memory cache to persist and reload safely.
- Added behavioral coverage for pending pan/zoom replacements, source changes, rejection, cancellation, atomic replacement, verified/session cache separation, forged hash rejection, long non-persistable cache exhaustion, and persisted six-minute cold reopen.
- Final static gates passed: focused regressions 23/23, package/root/API typechecks, lint with zero warnings, anti-slop, production build, portable Wasm validation, Workers dry-run, desktop check/package, security scan with zero findings, and `git diff --check`.
- Full suite reached 2,908 passed, one intentional Electron-only skip, and one unrelated five-second timeout in the 129th protected-recovery fixture. Its complete file passed immediately afterward, 14/14, with the timed fixture completing in 3.993 seconds.
- Exact-head Cloudflare build `d8d91a66-1a7a-43f9-87e9-637e6dc939dd` succeeded and uploaded version `9e0207b2-1631-4251-8072-8adad386bb08` without routing production traffic.
- Exact-head arm64 Electron packaging succeeded with `/Users/juan/Documents/vst3sdk-3.8.0`.
- Packaged Electron fresh import produced one persisted peak asset and 540 peak chunks. A full app restart restored the clip from those persisted peaks. Forced canvas redraw recorded 988 waveform strokes, confirming actual waveform geometry rather than the diagonal fallback. Playback advanced to 1.365 seconds without renderer errors.
- Evidence: `acceptance-reports/deep-zoom-8ee079c/electron-waveform-confirmed.png` and `acceptance-reports/deep-zoom-8ee079c/electron-true-cold-reopen.png`.
- The exact-head browser preview loaded and accepted a local six-minute import, but desktop-sized visual/zoom stress could not be completed in the available isolated browser session because it remained constrained to a narrow viewport. Safari remains UNPROVEN. These browser-specific gaps are reported separately and are not represented as passes.

## Visual fidelity qualification (supersedes prior READY)

- Current status: **DEEP TIMELINE ZOOM — VISUAL FIDELITY QUALIFICATION IN PROGRESS**.
- The prior READY determination and any PR wording based on it are superseded. PR #54 must remain open and unmerged.
- Frozen accepted scope: deep-zoom geometry, sidebar behavior, persistence, bounded scheduling/cache behavior, browser audio, and native audio. This phase changes waveform visual authority only where measurements require it.
- Acceptance requires the visible waveform to derive from source data, canonical clip-time projection, and the current viewport at native device-pixel density. A retained bitmap enlarged with CSS is not acceptable as primary visual truth.
- Visible detail must transition continuously from envelope to exact PCM line to smoothly emerging sample points during an uninterrupted zoom gesture, without blank frames, LOD snapping, delayed settle-to-sharpen, or timing drift.
- Safari automation is waived for this phase. Merge, rebase, force-push, and production deployment remain prohibited.

### Exact local reference matrix

| Reference | Exact files inspected | Evidence | Decision |
| --- | --- | --- | --- |
| `/Users/juan/Documents/monorepo-new` | `apps/web/src/components/engine/timeline/timeline.ts`; `apps/web/src/components/engine/timeline/render/audio.ts`; `apps/web/src/components/engine/timeline/render/clip.ts`; `apps/web/src/components/engine/timeline/utils.ts` | Uses centralized domain view state, frame-oriented timeline canvas rendering, native-DPR backing dimensions, visible-range clipping, source-window waveform caching, pixel-density-driven peak requests, and one active plus latest pending asynchronous update. | **Adapt.** Preserve this project's canonical clip timing and bounded source LOD/cache contracts, but move visible waveform rasterization toward current-frame/current-DPR projection. Adopt visible-window overscan and latest-pending coalescing only if Phase 1 traces show request churn. Do not assume its shared-canvas shape is correct here without profiling. |
| `/Users/juan/Documents/dialkit` | `src/solid/components/Timeline/DialTimeline.tsx`; `src/store/DialStore.ts`; `src/store/TimelineStore.ts` | Keeps transient pointer/zoom state cheap and local, snapshots gesture anchors in plain variables, preserves the anchor during updates, cleans listeners explicitly, and separates transient interaction state from persisted state. | **Adapt selectively.** Retain this project's stronger wheel rAF coalescing and preview/commit separation. Keep transient zoom out of expensive waveform acquisition identity and preserve deterministic gesture cleanup. |
| `/Users/juan/Documents/solid-primitives` | `packages/raf/src/index.ts`; `packages/resize-observer/src/index.ts`; `packages/media/src/index.ts` | Demonstrates one owned animation-frame lifecycle, direct ResizeObserver ownership, explicit reactive dependencies, DPR/media-query re-arming, coalescing, and deterministic cleanup. | **Adapt without dependency.** Reuse existing local timeline-level scheduler and DPR patterns. Do not add a package or clip-local self-rescheduling loop. |
| `/Users/juan/Documents/opencode` | Repository located; no waveform/timeline renderer evidence was identified in the focused Phase 0 audit. | Its declared relevance is Solid persistence, preferences, and product architecture, not current-view waveform rasterization. | **Reject for renderer design.** Revisit only if this phase changes persisted preferences or cross-session view state, which is currently out of scope. |
| `/Users/juan/Documents/daw-effect-research` | Top-level clone inspected; only `.DS_Store` and empty directory shells were present. | No implementation source exists locally to audit for DSP or waveform rendering. | **Unavailable.** Do not claim evidence from this reference. Continue with canonical project timing/DSP tests and the populated references unless the clone is restored. |

### Current implementation facts to prove or replace

- Superseded: `ClipComponent.tsx` previously enlarged retained waveform output with a CSS `scaleX` transform during live zoom; the current implementation draws the current slice directly.
- Superseded: `useClipWaveformViewModel.ts` previously retained raster geometry at an earlier pixels-per-second value; the current implementation retains source data only and projects through the current layout/map.
- Superseded: `waveform-canvas.ts` previously capped CSS raster width at 4,096 and applied a DPR double penalty; it now preserves logical CSS width and budgets only the horizontal backing density.
- Superseded: sample points previously switched through a boolean `showPoints` threshold; the current implementation uses continuous opacity/radius mixing while preserving the exact PCM line.

### Required evidence before renderer selection

- [x] Phase 1 focused coverage records current-view projection, selected LOD, samples/pixel, and pixels/sample while zooming; retained raster scale and CSS transform are no longer render inputs.
- [x] The renderer now uses the current visible clip slice and native-DPR backing dimensions. At 4,096 x 47 CSS px, DPR 3 produces exactly 12,288 x 141 backing px; over-budget widths preserve CSS width and reduce only horizontal backing density.
- [x] The prior DPR double-penalty was rejected: the backing-width budget is `floor(2,000,000 / backingHeightPx)`, with backing height `ceil(cssHeightPx * dpr)`, covered at DPR 1, 1.5, 2, and 3.
- [x] Focused browser-condition churn coverage exercises forward/reverse zoom and asserts source reuse plus non-empty overlapping retained coverage. The measured focused path remained bounded; no active/latest coalescer was added.
- [x] Per-visible-clip canvases remain the frame authority. No shared canvas, OffscreenCanvas, WebGL, dependency, RAF, timer, or polling loop was introduced.
- [x] Canonical trim, Re-Pitch, Stretch, BPM mismatch, source beat offset, marker warp, and silence projection remain covered by the existing canonical timing fixtures and current-layout projection path.

### Current-view waveform architecture

- [x] Acquisition identity is data-only: PCM line and point presentation share the same `pcm-line` request key.
- [x] Retained data is limited to the current ready generation and one previous ready generation; source identity or timing changes clear both generations.
- [x] Arrangement and Sample Detail project retained source data through the current `getAudioWaveformLayout` and `getAudioClipTimeMap` result on every view change.
- [x] Envelope, exact PCM line, and sample points use a monotonic smooth visual mix. The exact line remains present while point opacity and radius emerge across the 4–6 pixels/sample band.
- [ ] Runtime browser/Electron visual qualification, screenshot comparison, and packaged playback qualification are not claimed complete by this implementation change.

### Current-view renderer implementation and interim runtime evidence

- [x] Removed retained raster geometry and CSS `scaleX` from arrangement waveform authority; retained state now contains bounded source representations and projects through the current canonical layout/time map on each view change.
- [x] Removed point presentation from PCM acquisition identity and added continuous envelope/line and line/point visual weights.
- [x] Corrected backing-store DPR budgeting: a 4,096 × 47 CSS-pixel canvas at DPR 3 now uses 12,288 × 141 backing pixels (1,732,608 total, within the 2,000,000-pixel budget). Logical current-view width is no longer capped to 4,096 CSS pixels.
- [x] Retained results are bounded to the current plan plus one relevant refinement and one previous ready generation. Async refinement publication advances the render revision; current projected peak layers preserve fade timing.
- [x] Focused validation passed 46 tests with 1,452 assertions. The complete suite passed 2,935 tests, one intentional Electron-only skip, zero failures, and 373,887 assertions. Package/root/API typechecks, lint with zero warnings, anti-slop, production build, and `git diff --check` pass.
- [x] Exact local-browser visual probe on a real bundled audio clip observed `transform: none`, 3,360 point arcs, and 2,820 line strokes. Measured cadence was p50 8.3 ms, p95 9.6 ms, p99 10.2 ms, max 10.3 ms, with zero intervals at or above 50 ms.
- [x] Exact arm64 Electron packaging succeeded with `VITE_CONVEX_URL=https://polite-peccary-245.convex.cloud` and `/Users/juan/Documents/vst3sdk-3.8.0`. The accepted local fixture reopened with 21 tracks and reached 18 simultaneously visible canvases after resizing to the maximum available 1,290 px outer window height. During active playback, a 20-cycle synthetic trackpad zoom campaign measured p50 8.3 ms, p95 10.2 ms, p99 10.4 ms, max 18.6 ms, zero intervals at or above 50 ms, 1,202 waveform strokes, no canvas CSS transforms, a 200,000 px runway, and approximately 97.4 MB renderer heap.
- [ ] Final 20-simultaneously-visible audio-canvas browser and Electron campaign remains unproven. The isolated browser fixture reached 20 tracks but the UI-only bundled-sample insertion path did not populate all tracks reliably; the packaged fixture exposed at most 18 canvases at the maximum available 1,290 px outer window height. These results are not mislabeled as the required all-20-visible pass.
- [ ] Slowed uninterrupted zoom recording remains unavailable because the attached browser driver rejected recording context creation. Static screenshots are preserved under `acceptance-reports/visual-fidelity-*.png`; no recording pass is claimed.
- Current status remains **DEEP TIMELINE ZOOM — VISUAL FIDELITY QUALIFICATION IN PROGRESS**. PR #54 must remain open and unmerged.
