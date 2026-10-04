# 30-track performance campaign acceptance report

## Outcome

The 30-track campaign is accepted on branch `perf/30-track-stress`, including the paging, Knip, recording, corrected zoom methodology, and measured raster-coalescing work.

The production workload, exact-frame precision gates, recording path, five-run distribution, five-minute soak, real-Valhalla automation override/re-enable behavior, late-offset mapped-media playback, and published validation remain green. Final packaged controls now include a stable-generation P30 zoom run with complete native CPU attribution, and the V0/V1/V4/V8/V8A/V8Z reliability matrices all completed at their requested clean-attempt counts. PR #57 was verified open and unmerged.

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
| Native process CPU controls | Pass | Final packaged idle, playback, and P30 controls each retained 60/60 one-second samples and eight workers; playback/P30 each used one host PID, while idle reported eight audio-host PIDs. P30 (`/private/tmp/daw-wake-cert-p30-final.json`) measured audio-host CPU 30.67% average / 33.08% P95 / 34.07% peak; aggregate worker CPU 6.95% / 8.02% / 8.09%. Per-worker averages were 0.85–0.97%, P95 1.00–1.01%, and peaks 1.01–2.00%. Renderer CPU was 7.20% average / 11.99% P95 / 13.34% peak. Native CPU is sourced from runner-owned `ps` CPU-time deltas, not renderer proxies. |
| Five-minute DSP soak | Pass | Eight VST instances remained responsive. The telemetry run recorded 28,541 callbacks and 229,671 worker observations with zero callback/worker deadline misses, watchdog misses, faults, restarts, or rejected blocks. |
| Native transport-frame drift | Pass | Authoritative native transport frames were sampled near 10 seconds, 60 seconds, and five minutes. Wall-clock comparison retained a stable approximately 3.4k-frame launch/observation offset; relative to the first checkpoint, later error changed by +64 frames at 60 seconds and -32 frames at five minutes, both within one 512-frame callback. |
| Recording under full DSP/UI load | Pass | The matched packaged run combined recording with timeline pan/scroll and timeline/Sample Detail zoom. It captured 2,812,416 frames at 48 kHz, committed exactly one recording clip, and reported zero dropped/overrun frames, callback/worker deadline misses, watchdog misses, faults, or restarts. Peak SAB writer occupancy was one. The same run recorded 8.35/9.25/16.95 ms rAF P50/P95/P99 and 15 long tasks totaling 1,733 ms; recording therefore passes correctness and realtime-audio health but exposes visible main-thread tail latency under the matched stress workload. |
| Recording finalization attribution/optimization | Pass | Phase attribution identified WAV encoding, local asset creation, and clip creation as the top three stop-time owners; waveform geometry and raster together accounted for only about 13 ms and were ruled out. Replacing per-sample PCM conversion with planar typed-array views and yielding SHA-256 work in bounded 1 MiB chunks reduced matched finalization long-task time from 4,036 ms to 3,051 ms (24.4%), WAV-encode long-task time from 1,830 ms to 1,111 ms (39.3%), count from 16 to 14, and maximum from 449 ms to 362 ms. The after run captured 2,974,720 frames with zero drops, callback/worker deadline misses, watchdog misses, faults, or restarts. |
| Corrected zoom benchmark | Pass | Timing now originates in the renderer. Each gesture records canonical viewport state change, the first subsequent visual frame, two stable frames with unchanged viewport/raster state and zero pending waveform requests, and browser-command round trip separately. Exactly five accepted runs each were retained for true 10-, 20-, and 30-clip projects produced through approved public-control deletion. Median run-level first-visual P95 was 21.405 ms at P10, 25.635 ms at P20, and 30.645 ms at P30. Median settled P95 was 36.940 ms, 43.705 ms, and 58.000 ms respectively. No valid playback run produced a long task. |
| Zoom request-cache optimization | Pass | The bounded per-clip completed-request cache remains covered by reciprocal-zoom regression and corrected runs. The accepted P30 artifacts record 677 cache hits against 52 starts in the representative attribution run, with zero pending requests at completion. Earlier CDP round-trip latency claims are superseded and are not used as visual-latency evidence. |
| Zoom visibility scaling | Pass | The corrected matrix uses projects with exactly 10, 20, or 30 active clips rather than hiding nodes after mounting. Every gesture records project active clips, mounted clips, and exact viewport intersections. The benchmark resets vertical scroll before measurement; the P10 smoke consistently measured four viewport-intersecting clips while six to eight clips remained mounted through overscan. |
| Zoom under recording | Pass | Practical corrected recording runs completed at R10, R20, and R30 with 80 renderer-timed gestures, eight VST workers, zero dropped recording frames, and zero callback/worker deadline misses, watchdog misses, faults, or restarts. First-visual P95 was 27.4–29.0 ms at R10, 26.7 ms at R20, and 35.3 ms at R30; settled P95 was 45.1–51.4 ms, 58.1 ms, and 70.4 ms respectively. The R30 run captured 2,804,224 frames. |
| Zoom structural optimization | Pass | Corrected P30 attribution ranked synchronous viewport/reactive fanout first at a median 693.1 ms per 80-gesture run, ahead of waveform raster at about 135.7 ms. Coalescing each clip canvas's reactive invalidations into one cancellable draw per animation frame reduced median viewport work to 693.1 ms, raster calls from 2,255–2,268 to 1,376–1,378, and raster time to about 136 ms. Across the retained optimized runs, median run-level first-visual P95 was 30.645 ms. Settled P95 was 58.000 ms because the bounded draw now completes at the paint boundary; the report retains both outcomes rather than claiming a universal latency win. |
| VST reliability classification | Pass | Realtime submissions use a nonblocking wake pipe as a notification hint while shared transport remains authoritative, eliminating the permanent 1 ms worker poll. Teardown-dropped slots are released rather than reported as plugin faults. Neither change extends the watchdog deadline or weakens fail-closed behavior. Final packaged certification recorded V0 3/3, V1 3/3, V4 3/3, V8 20/20, V8A 3/3, and V8Z 10/10 clean attempts. Earlier failed attempts remain retained separately; no failed attempt was counted as an accepted success. |
| Exact-frame precision | Pass | 44.1, 48, and 96 kHz mono/stereo source projection to 48 kHz output, raw trim/source-offset placement, waveform source-window projection, and hold/linear automation at 10 seconds, 60 seconds, and five minutes passed with zero-frame error. Marker-based Stretch now applies `sourceBeatOffset` consistently in both directions and is covered to within one source frame at all six sample-rate/channel combinations. |
| Re-Pitch applicability | Pass | Re-Pitch timing remains supported by the browser scheduler and waveform projection. Portable/native graph projection rejects Re-Pitch explicitly, so native Re-Pitch render precision is not applicable and is not claimed. Stretch marker/source-offset timing is the supported native/browser precision contract. |
| Issue #48 visible manual override | Pass | A visible Valhalla Mix edit reached the native instance and suppressed scheduled automation in the active transport epoch. |
| Issue #48 two-parameter global re-enable | Pass | Two visible writable Valhalla edits produced `Re-enable automation (2)`. The existing global control cleared both renderer/native overrides and Mix scheduling resumed without an epoch change. |
| Issue #48 fail-closed behavior | Pass | Stale revision, stale epoch, malformed identity, mixed identity, unknown instance, and unknown parameter requests are rejected at controller/native boundaries. Native selective clearing validates the full request before changing any override. |
| Late-offset long-media paging | Pass | Packaged playback moved the unique 600-second source to timeline 540s with source offset 540s, sought through the public desktop transport, and advanced to 544.117s. Native callbacks increased from 0 to 534, rejected blocks stayed at zero, and the renderer remained responsive for the full 60-second measurement. |
| Bounded page preparation/retention | Pass | The page manager hydrates one 16,384-frame page for a 4,096-frame request at source offset 540s. Uploaded-page bookkeeping remains capped at 128 pages, decoder concurrency at two, and the native written-range hint ledger at 256 ranges. |
| Paging memory behavior | Pass | In the packaged late-offset run, renderer working set moved from 1,907,916,800 bytes to 1,874,034,688 bytes, a decrease of 33,882,112 bytes. Peak during the measured window was the starting value; CPU averaged 2.11%, with 3.02% P95 and 3.18% peak. |
| Exact-base Knip reconciliation | Pass | Exact base `9201649ca38c907b6dc947c8b5c00a102a3b4a9e` reports 193 findings. This branch reports 191. The set difference contains zero added findings and two removed findings. |
| Security review | Pass | A targeted STRIDE review covered the changed wake-pipe, native host lifecycle, renderer-to-host teardown, and process telemetry paths against threat model version 1.0.0. The changed-line credential-pattern scan found no matches; no full dependency CVE scan was run. External VST isolation remains an availability boundary, not a malicious-code sandbox. |

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

The unattributed recording tail remains classified as browser/runtime scheduling outside the explicit finalization phases. The retained long-task entries have no script source, function name, rendering duration, or style/layout duration that would support assigning them to another product subsystem. No additional optimization was made from that evidence. Moving WAV finalization to a worker remains optional future work rather than an acceptance blocker because the measured optimization already reduced finalization tail time while recording correctness and realtime health remained clean.

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

- Complete Bun suite: 3,162 passed, one intentional skip, zero failed (3,163 tests across 412 files).
- Full package and root TypeScript checks: passed.
- Lint with warnings denied: passed.
- Anti-slop rule suites: 12 of 12 passed.
- Production build and portable-Wasm artifact validation: passed.
- Cloudflare Worker dry-run bundle: passed in the prior retained validation and freshly rerun after final package build.
- Native aggregate debug CTest: 6 of 6 passed.
- Native macOS host debug-preset CTest: 6 of 6 passed.
- Audio-core standalone CTest: 1 of 1 passed after rebuilding the standalone build directory.
- Audio-core AddressSanitizer/UndefinedBehaviorSanitizer CTest: 1 of 1 passed in the sanitized build.
- Five packaged full-DSP UI distributions: passed.
- Matched packaged recording/UI stress: passed with zero audio drops or realtime deadline failures.
- Five-minute packaged transport/callback/worker telemetry: passed.
- Cloudflare Worker dry-run bundle after the telemetry changes: passed.
- Fixture SHA-256 sidecars: verified for both V3 archives.
- V3 local fixture SHA-256 verification: passed for both browser and native archives.
- Packaged late-offset paging: passed.
- Diff hygiene: passed.
- Raw Knip returned nonzero on inherited findings; an exact-base set comparison against `9201649ca38c907b6dc947c8b5c00a102a3b4a9e` found zero added findings (193 baseline / 191 current; two baseline findings removed).
- Security: manual STRIDE review recorded zero findings; a source diff scan checked 581 staged source additions for credential patterns and found zero matches. A full dependency CVE scan was not run.
- Final packaged VST reliability evidence: V0, V1, V4, V8, V8A, and V8Z all met requested complete counts; failed early batch attempts retained separately.
- Final packaged P10/P20/P30 zoom regressions: 80/80 settled gestures each. Recording-plus-zoom: 80/80, zero dropped frames, zero realtime failures.
- Zoom coalescing follow-up: a microtask candidate did not materially improve median P30 settled latency over cancellable animation-frame coalescing and encountered a renderer/probe-loss attempt, so the measured animation-frame implementation was retained.

## Source and external-status identifiers

- Prior pushed evidence SHA: `bf7677582dff7704fe8dc39f1f40ea509a093f69`.
- Native CPU follow-up implementation SHA: `eb2027eff70f10e71b29325c72086ead1ddc89ed`.
- Generation-aware sampler follow-up SHA: `1d303d62c83ce57366dd48f8b85cb77e8b39e2b9`.
- Cloudflare supplied evidence commit: `c9ce7097` — `COMPLETED/SUCCESS`; user-supplied, not independently verified. Cloudflare MCP tools were unauthenticated.
- Native CPU follow-up artifacts: `/private/tmp/daw-followup-idle-final-3.json`, `/private/tmp/daw-followup-playback-final.json`, and `/private/tmp/daw-followup-p30-final-2.json`.
- Generation-aware P30 retries: `/private/tmp/daw-followup-p30-generation-1.json`, `/private/tmp/daw-followup-p30-generation-2.json`, and `/private/tmp/daw-followup-p30-generation-3.json`; these retained the earlier lifecycle failures. Repaired controls are retained at `/private/tmp/daw-wake-final-p30-certified-2.json` and `/private/tmp/daw-wake-final-p30-grace.json`; the interaction control completed, while CPU attribution remained blocked after concrete audio-host replacement evidence.
- The retained compatible pre-fix V8 artifacts contain worker processing histograms but no trustworthy OS process CPU samples, so they cannot provide a CPU baseline for the 7.21% idle aggregate.

## Final zoom scorecard

The expanded machine-readable scorecard is `acceptance-reports/30-track-zoom-scorecard-2026-10-01.json`. It retains exactly five accepted packaged runs per playback profile, with failed attempts retained outside the accepted set. Each accepted run has 80 renderer-timed gestures, eight configured VST processors, zero callback/worker deadline misses, zero worker watchdog misses, zero worker faults, and zero rejected blocks.

| Profile | Accepted runs | Gestures | First visual P95 | Settled P95 | Renderer CPU P50/P95 | Long tasks | Realtime faults |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P10 | 5 | 400 | 21.405 ms | 36.940 ms | 5.920% / 10.812% | 0 | 0 |
| P20 | 5 | 400 | 25.635 ms | 43.705 ms | 6.234% / 11.738% | 0 | 0 |
| P30 | 5 | 400 | 30.645 ms | 58.000 ms | 6.836% / 12.590% | 0 | 0 |
| 30+ recording | 1 | 80 | 35.3 ms (retained recording evidence) | 70.4 ms (retained recording evidence) | n/a | 15 / 1,734 ms | 0 |

The accepted recording artifact `/private/tmp/daw-zoom-recording/r30-5.json` captured 2,804,224 frames at 48 kHz with zero dropped frames, eight active workers, zero deadline/watchdog/fault failures, and zero rejected blocks. Media paging/decode and waveform cache bytes are explicitly zero/not measured in the scorecard because those fields are absent from the zoom-profile boundary; late-offset paging remains covered by `/private/tmp/daw-v3-later-offset-paging.json`.

## CPU controls and settle attribution

The new packaged controls measured 60 seconds each with native host, VST-worker, and renderer process telemetry. Idle initialized eight workers but produced no audio callbacks, as expected; renderer CPU averaged 0.376% (P95 1.547%, peak 3.167%), while the eight-worker aggregate CPU averaged 7.21% (P95 7.84%, peak 7.84%). Playback averaged 0.700% renderer CPU (P95 1.279%, peak 2.043%), with 6,037 callbacks, 49,600 worker observations, and zero realtime failures; aggregate worker CPU was 9.49% average / 11.71% P95 / 11.73% peak. The original P30 zoom control averaged 6.591% renderer CPU (P95 12.179%, peak 13.162%), with 3,731 rAF samples, 3,732 application-work samples, 1 long task of 65 ms, and zero dropped probe samples, but its native sampler lost an owned process after 16 interval samples. The generation-aware retry retained explicit process generations but the renderer probe disappeared during rehosting. The wake-pipe change does not rely on that blocked CPU sampler result.

The event-driven wake implementation was measured with final packaged 60-second idle and eight-worker playback controls after rebuilding the unsigned desktop package. The earlier before controls measured aggregate worker CPU at 7.21% average / 7.84% P95 / 7.84% peak in idle and 9.49% / 11.71% / 11.73% in playback; the older controls did not retain usable native process samples. The final after-idle artifact `/private/tmp/daw-wake-cert-idle-final.json` retained 60/60 samples and eight worker identities, but the harness observed eight audio-host PIDs in this control. The reported 18.73% / 21.02% / 21.04% host distribution sums those observed host CPU deltas and must not be read as one stable host’s CPU. Aggregate worker CPU was 1.32% / 3.00% / 3.93%, and renderer CPU was 1.16% / 2.12% / 2.33%. The final after-playback artifact `/private/tmp/daw-wake-cert-playback-final.json` retained 60/60 samples for one audio-host process and eight workers: audio-host CPU was 21.93% / 25.97% / 27.00%, aggregate worker CPU 6.80% / 8.02% / 8.12%, and renderer CPU 5.05% / 6.03% / 6.52%. Playback recorded 6,318 callbacks and 51,819 worker observations; callback processing P50/P95/P99/max were 1.049/1.049/1.049/2.559 ms, worker P50/P95/P99/max were 0.066/0.066/0.131/0.305 ms, with zero callback/worker deadline misses, watchdog misses, faults, restarts, or rejected blocks. The earlier wake-package runs at 59/60 are retained as historical evidence; the full 60/60 reruns are authoritative here.

The disposable causal benchmark `/tmp/daw-native-wake-benchmark` ran eight idle worker processes for exactly 60 seconds per case. Polling at 1/2/4/8 ms produced 3,365,248 / 1,699,776 / 841,208 / 399,920 slot scans and aggregate CPU of 0.0840% / 0.0389% / 0.0184% / 0.0087%, respectively. The event-driven control case produced zero scans and 0.0001% aggregate CPU. This establishes the expected inverse polling-period cost and provides benchmark-only causal evidence; it is not substituted for the product P30 acceptance control.

The wake notification is a nonblocking realtime wake hint implemented as a one-byte pipe write: shared transport slots and the submission queue remain authoritative, and `EAGAIN`/`EWOULDBLOCK` means a wake is already pending and is harmless. The callback path uses preallocated slot/queue storage and performs no allocation, mutex acquisition, waiting, or blocking for pipe capacity. The notification still invokes the kernel through `write(2)`, so this is not claimed as a formally hard-realtime or lock-free userspace operation. It empirically remained well within the measured callback budget. The worker polls the shared slots as the source of truth and drains any pending wake bytes. The native transport layout also rounds every slot stride to the cache-line alignment required by `SharedSlotControl`.

The final packaged P30 artifact `/private/tmp/daw-wake-cert-p30-final.json` completed all 80 zoom gestures with 60/60 process samples, one audio-host PID and eight workers; there were zero identity losses, callback or worker deadline misses, watchdog misses, faults, restarts, or rejected blocks. CPU averages/P95/peaks were: aggregate workers 6.95% / 8.02% / 8.09%; audio host 30.67% / 33.08% / 34.07%; renderer 7.20% / 11.99% / 13.34%. Per-worker CPU average/P95/peak (in worker order) was 0.93/1.00/1.03%, 0.90/1.00/1.01%, 0.88/1.00/1.03%, 0.97/1.00/1.03%, 0.90/1.00/1.03%, 0.93/1.01/2.00%, 0.92/1.00/1.03%, and 0.90/1.00/1.03%. Callback processing P50/P95/P99/max was 1.049/1.049/1.049/1.367 ms; worker processing was 0.066/0.066/0.131/0.535 ms. This harness does not expose VST dispatch-latency quantiles, so no dispatch-latency figure is claimed. The 10.667 ms callback period leaves 9.300 ms versus the measured maximum callback time; this is duration headroom, not a dispatch-latency guarantee. The fresh final-package P30 run's first-visual and settled zoom P95 were 29.43 ms and 52.42 ms.

The exact packaged reliability controls were rerun after rebuilding the desktop package. The first batch was retained with its one V8 realtime-gate failure and two V8Z renderer-probe timeouts; complete retry batches then passed V8 20/20 and V8Z 10/10. The accepted complete matrix is V0 3/3, V1 3/3, V4 3/3, V8 20/20, V8A 3/3, V8Z 10/10. P10, P20, and P30 final zoom regressions each completed 80/80 settled gestures with zero dropped probe samples and zero rejected blocks. Final R30 recording-plus-zoom completed 80/80 gestures, captured 2,812,416 frames at 48 kHz, and recorded zero dropped frames, one maximum writer occupancy, zero deadline/watchdog/fault/restart failures, and zero rejected blocks.

The P30 benchmark-only settle attribution artifact is `/private/tmp/daw-zoom-attribution-p30-final.json`. Its segment distributions are recorded in the scorecard for input-to-viewport state, viewport-to-request quiescence, quiescence-to-raster callback start, raster execution, raster-complete-to-presented frame, and first-presented-to-two-stable-frames. Raster-related attribution is applicable to 44/80 gestures because only those gestures produced a matching post-quiescence raster-start/raster-complete mark pair; the remaining settled gestures reached presentation/stability without a complete raster mark pair and are not treated as raster samples. The dominant tail is request quiescence/stability wait at the paint boundary; the retained cancellable rAF strategy remains in place. Context-switch and wakeup counters were not collected.

## Final validation and external status

Final local validation: full Bun suite (3,162 pass, one intentional skip), typecheck, lint, 12 anti-slop suites, production/Wasm build, rebuilt unsigned macOS desktop package, debug CTest 6/6, worker-debug CTest 2/2, ASan 1/1, UBSan 1/1, fixture hashes, and diff hygiene passed. After the final package rebuild, 60-second idle/playback/P30 process controls and R30 recording-plus-zoom passed; P30/P10/P20 each completed 80/80 settled gestures and R30 captured 2,812,416 frames without drops. Raw Knip returned nonzero due inherited findings, but exact-base set comparison found zero added findings. Wrangler dry-run passed after the final build; a full dependency CVE scan was not run. Added-diff credential-pattern scan and manual STRIDE review were completed. PR #57 is open, not draft, and unmerged. The GitHub Workers Builds check for head `469cdef72d392d39cf0ce9a8ac51f8f43fcc8e37` completed successfully, as independently verified by the user.
