# 30-track performance campaign acceptance report

## Outcome

The 30-track campaign is accepted on branch `perf/30-track-stress`, including the paging, Knip, recording, corrected zoom methodology, and measured raster-coalescing work.

The production workload, exact-frame precision gates, recording path, five-run distribution, five-minute soak, real-Valhalla automation override/re-enable behavior, late-offset mapped-media playback, and the published validation through `32042bb1` passed. PR #57 remains open and unmerged while the expanded telemetry change set completes final validation.

## Authoritative acceptance matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| 30-track production workload | Pass | V3 archive contains exactly 30 tracks, 30 clips, 24 mixed-rate audio assets, six instrument tracks, and 96 MIDI notes. Audio sources cover 44.1, 48, and 96 kHz, mono/stereo, and durations through 600 seconds. |
| Bounded fixture generation | Pass | V3 WAV generation streams 16,384-frame pages and enforces the 1 GiB archive budget. Fixture sample checks include page seams and later source positions. |
| Tier 1 and Tier 2 UI/playback | Pass | Browser and packaged Electron acceptance verified production import, visible timeline operations, built-in devices, transport state, rendered meter activity, increasing native callbacks, and zero rejected blocks. |
| Full DSP distribution | Pass | Five packaged 60-second runs with eight ValhallaSupermassive instances passed. Median native callback increase: 6,218. Median renderer CPU average: 5.72%. Median renderer CPU P95: 6.68%. Median peak renderer working set: approximately 889 MiB. |
| Full-load UI frame distribution | Pass | Five packaged 60-second full-DSP runs exercised timeline pan/scroll, overview/deep/pointer-anchored zoom, Sample Detail waveform zoom, ruler seek, loop, built-in Drive, instrument-track selection, and visible Valhalla Mix. Median rAF interval was 8.30 ms P50, 9.50 ms P95, and 10.20 ms P99 on the measured approximately 120 Hz display. Four runs reported zero long tasks; one reported one 59 ms long task. |
| Application main-thread proxy | Pass | The bounded rAF-to-queued-microtask proxy measured 1.90 ms P50, 8.90 ms P95, and 10.80 ms P99 median across five runs. This is an application/main-thread occupancy proxy, not direct framework render duration. Every sample family was capped at 8,192 records with explicit dropped-sample counters; all five runs dropped zero samples. |
| Native callback deadline headroom | Pass | Across five packaged full-DSP UI runs, the complete CoreAudio callback histogram reported 1.049 ms P99 and 1.366 ms median-of-run maximum against a 10.667 ms 512-frame/48 kHz deadline. Every run recorded zero inferred deadline misses. No hardware-xrun claim is made because CoreAudio does not expose that signal at this boundary. |
| VST worker processing headroom | Pass | Eight active workers produced approximately 23.9k observations per run. Processing measured 0.131 ms P99 and a 0.358 ms median-of-run maximum. Every run recorded zero worker deadline misses, watchdog misses, faults, or restarts. |
| Five-minute DSP soak | Pass | Eight VST instances remained responsive. The telemetry run recorded 28,541 callbacks and 229,671 worker observations with zero callback/worker deadline misses, watchdog misses, faults, restarts, or rejected blocks. |
| Native transport-frame drift | Pass | Authoritative native transport frames were sampled near 10 seconds, 60 seconds, and five minutes. Wall-clock comparison retained a stable approximately 3.4k-frame launch/observation offset; relative to the first checkpoint, later error changed by +64 frames at 60 seconds and -32 frames at five minutes, both within one 512-frame callback. |
| Recording under full DSP/UI load | Pass | The matched packaged run combined recording with timeline pan/scroll and timeline/Sample Detail zoom. It captured 2,806,784 frames at 48 kHz, committed exactly one recording clip, and reported zero dropped/overrun frames, callback/worker deadline misses, watchdog misses, faults, or restarts. Peak SAB writer occupancy was one. The same run recorded 8.35/9.25/16.95 ms rAF P50/P95/P99 and 15 long tasks totaling 1,733 ms; recording therefore passes correctness and realtime-audio health but exposes visible main-thread tail latency under the matched stress workload. |
| Recording finalization attribution/optimization | Pass | Phase attribution identified WAV encoding, local asset creation, and clip creation as the top three stop-time owners; waveform geometry and raster together accounted for only about 13 ms and were ruled out. Replacing per-sample PCM conversion with planar typed-array views and yielding SHA-256 work in bounded 1 MiB chunks reduced matched finalization long-task time from 4,036 ms to 3,051 ms (24.4%), WAV-encode long-task time from 1,830 ms to 1,111 ms (39.3%), count from 16 to 14, and maximum from 449 ms to 362 ms. The after run captured 2,974,720 frames with zero drops, callback/worker deadline misses, watchdog misses, faults, or restarts. |
| Corrected zoom benchmark | Pass | Timing now originates in the renderer. Each gesture records canonical viewport state change, the first subsequent visual frame, two stable frames with unchanged viewport/raster state and zero pending waveform requests, and browser-command round trip separately. Five valid runs each were collected for true 10-, 20-, and 30-clip projects produced through approved public-control deletion. Median run-level first-visual P95 scaled from 21.4 ms at P10 to approximately 25.6 ms at P20 and 33.6 ms at P30. Median settled P95 scaled from 36.9 ms to approximately 42.9 ms and 53.4 ms. No valid playback run produced a long task. |
| Zoom request-cache optimization | Pass | The bounded per-clip completed-request cache remains covered by reciprocal-zoom regression and corrected runs. P30 artifacts recorded 677 cache hits against 52 starts in a representative run, with zero pending requests at completion. Earlier CDP round-trip latency claims are superseded and are not used as visual-latency evidence. |
| Zoom visibility scaling | Pass | The corrected matrix uses projects with exactly 10, 20, or 30 active clips rather than hiding nodes after mounting. Every gesture records project active clips, mounted clips, and exact viewport intersections. The benchmark resets vertical scroll before measurement; the P10 smoke consistently measured four viewport-intersecting clips while six to eight clips remained mounted through overscan. |
| Zoom under recording | Pass | Practical corrected recording runs completed at R10, R20, and R30 with 80 renderer-timed gestures, eight VST workers, zero dropped recording frames, and zero callback/worker deadline misses, watchdog misses, faults, or restarts. First-visual P95 was 27.4–29.0 ms at R10, 26.7 ms at R20, and 35.3 ms at R30; settled P95 was 45.1–51.4 ms, 58.1 ms, and 70.4 ms respectively. The R30 run captured 2,804,224 frames. |
| Zoom structural optimization | Pass | Corrected P30 attribution ranked synchronous viewport/reactive fanout first at a median 920.0 ms per 80-gesture run, ahead of waveform raster at about 233 ms. Coalescing each clip canvas's reactive invalidations into one cancellable draw per animation frame reduced median viewport work to 693.1 ms (24.7%), raster calls from 2,255–2,268 to 1,376–1,378 (39.1%), and raster time from about 233 ms to 136 ms (41.6%). Across seven valid after runs, median run-level first-visual P95 improved from 33.6 to 30.6 ms (8.9%). Settled P95 regressed from 53.4 to 58.2 ms because the bounded draw now completes at the paint boundary; the report retains both outcomes rather than claiming a universal latency win. |
| VST reliability classification | Needs follow-up | The corrected playback campaign retained failed attempts. P30 produced five valid runs from seven attempts: one renderer/probe timeout while native playback remained healthy and one VST availability failure with five watchdog misses and five worker faults. P20 required additional retries and exposed the same native availability class, including worker shutdown with watchdog misses/faults. These are reliability failures, not discarded benchmark samples. Successful runs remained clean. |
| Exact-frame precision | Pass | 44.1, 48, and 96 kHz mono/stereo source projection to 48 kHz output, raw trim/source-offset placement, waveform source-window projection, and hold/linear automation at 10 seconds, 60 seconds, and five minutes passed with zero-frame error. Marker-based Stretch now applies `sourceBeatOffset` consistently in both directions and is covered to within one source frame at all six sample-rate/channel combinations. |
| Re-Pitch applicability | Pass | Re-Pitch timing remains supported by the browser scheduler and waveform projection. Portable/native graph projection rejects Re-Pitch explicitly, so native Re-Pitch render precision is not applicable and is not claimed. Stretch marker/source-offset timing is the supported native/browser precision contract. |
| Issue #48 visible manual override | Pass | A visible Valhalla Mix edit reached the native instance and suppressed scheduled automation in the active transport epoch. |
| Issue #48 two-parameter global re-enable | Pass | Two visible writable Valhalla edits produced `Re-enable automation (2)`. The existing global control cleared both renderer/native overrides and Mix scheduling resumed without an epoch change. |
| Issue #48 fail-closed behavior | Pass | Stale revision, stale epoch, malformed identity, mixed identity, unknown instance, and unknown parameter requests are rejected at controller/native boundaries. Native selective clearing validates the full request before changing any override. |
| Late-offset long-media paging | Pass | Packaged playback moved the unique 600-second source to timeline 540s with source offset 540s, sought through the public desktop transport, and advanced to 544.117s. Native callbacks increased from 0 to 534, rejected blocks stayed at zero, and the renderer remained responsive for the full 60-second measurement. |
| Bounded page preparation/retention | Pass | The page manager hydrates one 16,384-frame page for a 4,096-frame request at source offset 540s. Uploaded-page bookkeeping remains capped at 128 pages, decoder concurrency at two, and the native written-range hint ledger at 256 ranges. |
| Paging memory behavior | Pass | In the packaged late-offset run, renderer working set moved from 1,907,916,800 bytes to 1,874,034,688 bytes, a decrease of 33,882,112 bytes. Peak during the measured window was the starting value; CPU averaged 2.11%, with 3.02% P95 and 3.18% peak. |
| Exact-base Knip reconciliation | Pass | Exact base `9201649ca38c907b6dc947c8b5c00a102a3b4a9e` reports 193 findings. This branch reports 191. The set difference contains zero added findings and two removed findings. |
| Security review | Pass | The full branch diff was reviewed against threat model version 1.0.0 and the configured STRIDE patterns. No merge-blocking findings were identified. External VST isolation remains an availability boundary, not a malicious-code sandbox. |

## Key packaged artifacts

- Issue #48 two-parameter certification: `/tmp/daw-tier3-issue48-two-parameter-final.json`
  - Run ID: `b8fb828d-8f37-4c35-b4d7-e32c0a3cbd5c`
  - `errors: []`
  - Playback continued for approximately 9.91 seconds and added 911 native callbacks.
  - Recording captured 2,887,680 frames at 48 kHz.
- Late-offset paging: `/tmp/daw-v3-later-offset-paging.json`
  - Timeline/source offset: 540 seconds.
  - Playing observation: 544.117333 seconds.
  - Native callbacks: 0 to 534.
  - Rejected blocks: 0.
  - Renderer responsive after the 60-second control interval.
- One-parameter attachment-plan proof: `/tmp/daw-tier3-issue48-attachment-plan.json`
  - Run ID: `3c3dad38-a990-49b4-aac0-cfa3c6e47129`.
- Five full-DSP UI distributions: `/private/tmp/daw-v3-dsp-ui-formal-1.json` through `/private/tmp/daw-v3-dsp-ui-formal-5.json`.
- Matched recording/UI stress: `/private/tmp/daw-v3-dsp-ui-recording-formal-6.json`.
- Recording finalization attribution before/after: `/private/tmp/daw-v3-recording-attribution-after-hash.json` and `/private/tmp/daw-v3-recording-attribution-after-final-2.json`.
- Diagnostic zoom before/after: `/private/tmp/daw-v3-zoom-diagnostic-before-3.json` and `/private/tmp/daw-v3-zoom-after.json`.
- Zoom visibility matrix: `/private/tmp/daw-v3-zoom-visible-10-final.json`, `/private/tmp/daw-v3-zoom-visible-20-final.json`, and `/private/tmp/daw-v3-zoom-recording-final-3.json`.
- Five-minute native transport/deadline telemetry: `/private/tmp/daw-v3-transport-drift-formal.json`.

Temporary artifact paths identify the local acceptance records used for this campaign. Durable behavior is covered by committed harnesses and regression tests.

## Corrected zoom evidence

The renderer-owned probe replaces the preliminary outer-driver response and fixed-delay settle measurements. Browser-command round trip remains available only as a harness diagnostic.

- Corrected playback matrix: `/private/tmp/daw-zoom-corrected/p10-*.json`, `/private/tmp/daw-zoom-corrected/p20-*.json`, and `/private/tmp/daw-zoom-corrected/p30-*.json`.
- Raster-coalescing P30 after matrix: `/private/tmp/daw-zoom-optimized/p30-*.json`.
- Corrected recording evidence: `/private/tmp/daw-zoom-recording/r10-1.json`, `/private/tmp/daw-zoom-recording/r10-3.json`, `/private/tmp/daw-zoom-recording/r20-5.json`, and `/private/tmp/daw-zoom-recording/r30-5.json`.

Recording long-task partitioning uses the long-task entries only, rather than summing duplicate long-animation-frame attribution. R30 reported 15 long tasks totaling 1,734 ms: 104 ms during a zoom phase, 924 ms in WAV encoding, 233 ms in asset creation, and 473 ms unattributed. R20 reported 1,439 ms total: 88 ms during zoom, 907 ms in WAV encoding, and 444 ms unattributed. Recording UI did not emerge as a separate long-task owner. Finalization remains dominant.

## Issue #48 implementation boundary

External VST processors are native attachment-plan entries, not portable graph processors. Re-enable now:

1. parses canonical `vst3:<instance>:<parameter>` identities before graph lookup;
2. resolves the instance and writable parameter against the prepared native attachment plan;
3. sends numeric parameter IDs to the native attachment instance;
4. preserves the existing graph-processor path for built-in effects; and
5. rejects the entire request before clearing anything when any target is stale, malformed, mixed, or unknown.

The UI remains intentionally unchanged. Pointer release does not silently clear an override. Users edit the visible plugin card and use the existing global re-enable control. Issue #48 now states this global-only product contract explicitly; selective A-only clearing while B remains overridden is not a visible product requirement.

## Measured optimization result

The campaign made two measured runtime corrections:

- Recording status delivery now coalesces unchanged native status instead of flooding renderer IPC. Before the correction, stressed recording exhausted the bounded eight-buffer writer pool after worker-return delivery delays around one second. After the correction, the full eight-VST PCM recording run completed, persisted, and survived a true cold relaunch without dropped frames or native fatal termination.
- Long-media playback uses bounded mapped pages instead of duration-proportional eager PCM installation. The late-offset proof prepared only the requested page region at 540 seconds, completed one minute of responsive playback, and ended with lower renderer working set than it started.
- Recording finalization now avoids per-sample JavaScript PCM conversion and yields large-file hashing at bounded byte intervals. The matched stop-time tail fell by 24.4% without changing the realtime audio path.
- Reciprocal timeline zoom now retains a bounded set of completed waveform requests per mounted clip. The matched 80-gesture workload eliminated 106 repeated waveform reads and improved first-response P95 by 17.9%.

No causal performance claim is made from unlike fixtures. Distribution claims use repeated runs of the same V3 full-DSP workload; the paging result is reported as its own bounded-path acceptance case.

## Known interpretation limits

- Browser meter evidence proves rendered signal activity, not audible-output perception.
- Callback and worker quantiles use fixed, callback-safe power-of-two histograms. Reported quantiles are conservative bucket upper bounds.
- Callback deadline misses are inferred by comparing measured callback duration with the configured block deadline. They are not hardware-reported CoreAudio xruns.
- The product exposes a global re-enable control. Packaged acceptance clears both visible overrides globally; selective A-only clearing is an internal protocol capability, not a product contract.
- Generated V3 fixture archives are large local acceptance inputs and are not source code. Their SHA-256 sidecars provide local integrity checks.
- Two standalone 30-clip playback reruns were invalidated by native VST deadline/recovery failures and are not used for distribution claims. The accepted standalone before/after artifacts and the successful 30-clip recording matrix retained zero realtime failures.

## Validation status

Completed for the expanded PR #57 telemetry and precision change set:

- Focused telemetry, diagnostics, precision, and acceptance tests: 95 passed, zero failed.
- Complete Bun suite: 3,156 passed, one intentional skip, zero failed.
- Full package and root TypeScript checks: passed.
- Lint with warnings denied: passed.
- Anti-slop rule suites: 12 of 12 passed.
- Production build and portable-Wasm artifact validation: passed.
- Cloudflare Worker dry-run bundle: passed.
- Native aggregate debug CTest: 6 of 6 passed.
- Native macOS host debug-preset CTest: 6 of 6 passed.
- Audio-core standalone CTest: 1 of 1 passed after rebuilding the standalone build directory.
- Audio-core AddressSanitizer/UndefinedBehaviorSanitizer CTest: 1 of 1 passed.
- Five packaged full-DSP UI distributions: passed.
- Matched packaged recording/UI stress: passed with zero audio drops or realtime deadline failures.
- Five-minute packaged transport/callback/worker telemetry: passed.
- Cloudflare Worker dry-run bundle after the telemetry changes: passed.
- Full-branch secret-pattern scan: passed with zero matches.
- V3 local fixture SHA-256 verification: passed for both browser and native archives.
- Packaged late-offset paging: passed.
- Diff hygiene: passed.
- Exact-base Knip set comparison: passed with zero branch-added findings.
- Security review: passed across 148 changed files with no threshold-triggering findings.
