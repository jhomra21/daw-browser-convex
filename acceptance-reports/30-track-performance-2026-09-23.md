# 30-track performance campaign acceptance report

## Outcome

The 30-track campaign is accepted on branch `perf/30-track-stress`, including the paging, Knip, and report change set completed after commit `ae1052f1`.

The production workload, exact-frame precision gates, recording path, five-run distribution, five-minute soak, real-Valhalla automation override/re-enable behavior, late-offset mapped-media playback, and final repository-wide validation all passed. Review-PR creation is the remaining release step after this report update.

## Authoritative acceptance matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| 30-track production workload | Pass | V3 archive contains exactly 30 tracks, 30 clips, 24 mixed-rate audio assets, six instrument tracks, and 96 MIDI notes. Audio sources cover 44.1, 48, and 96 kHz, mono/stereo, and durations through 600 seconds. |
| Bounded fixture generation | Pass | V3 WAV generation streams 16,384-frame pages and enforces the 1 GiB archive budget. Fixture sample checks include page seams and later source positions. |
| Tier 1 and Tier 2 UI/playback | Pass | Browser and packaged Electron acceptance verified production import, visible timeline operations, built-in devices, transport state, rendered meter activity, increasing native callbacks, and zero rejected blocks. |
| Full DSP distribution | Pass | Five packaged 60-second runs with eight ValhallaSupermassive instances passed. Median native callback increase: 6,218. Median renderer CPU average: 5.72%. Median renderer CPU P95: 6.68%. Median peak renderer working set: approximately 889 MiB. |
| Five-minute DSP soak | Pass | Eight VST instances and 16 worker processes remained responsive. Native callbacks increased by 28,720, rejected blocks stayed at zero, renderer CPU averaged 4.95% with 5.82% P95 and 6.91% peak, and working set showed no upward trend. |
| Recording under full DSP load | Pass | Full PCM recording with eight VST instances remained responsive, stopped explicitly, finalized without dropped/overrun frames or native fatal error, and retained the recording after a true cold Electron relaunch. |
| Exact-frame precision | Pass | 44.1, 48, and 96 kHz mono/stereo source projection to 48 kHz output, raw trim/source-offset placement, and hold/linear automation at 10 seconds, 60 seconds, and five minutes all passed with zero-frame error. |
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

Temporary artifact paths identify the local acceptance records used for this campaign. Durable behavior is covered by committed harnesses and regression tests.

## Issue #48 implementation boundary

External VST processors are native attachment-plan entries, not portable graph processors. Re-enable now:

1. parses canonical `vst3:<instance>:<parameter>` identities before graph lookup;
2. resolves the instance and writable parameter against the prepared native attachment plan;
3. sends numeric parameter IDs to the native attachment instance;
4. preserves the existing graph-processor path for built-in effects; and
5. rejects the entire request before clearing anything when any target is stale, malformed, mixed, or unknown.

The UI remains intentionally unchanged. Pointer release does not silently clear an override. Users edit the visible plugin card and use the existing global re-enable control.

## Measured optimization result

The campaign made two measured runtime corrections:

- Recording status delivery now coalesces unchanged native status instead of flooding renderer IPC. Before the correction, stressed recording exhausted the bounded eight-buffer writer pool after worker-return delivery delays around one second. After the correction, the full eight-VST PCM recording run completed, persisted, and survived a true cold relaunch without dropped frames or native fatal termination.
- Long-media playback uses bounded mapped pages instead of duration-proportional eager PCM installation. The late-offset proof prepared only the requested page region at 540 seconds, completed one minute of responsive playback, and ended with lower renderer working set than it started.

No causal performance claim is made from unlike fixtures. Distribution claims use repeated runs of the same V3 full-DSP workload; the paging result is reported as its own bounded-path acceptance case.

## Known interpretation limits

- Browser meter evidence proves rendered signal activity, not audible-output perception.
- Zero rejected native blocks and increasing callbacks prove clean scheduling/processing at the exposed boundary, not uninstrumented per-callback execution-time quantiles.
- The product exposes a global re-enable control. Packaged acceptance clears both visible overrides globally; selective A-only clearing is covered at controller/native boundaries rather than through a new UI.
- Generated V3 fixture archives are large local acceptance inputs and are not source code. Their SHA-256 sidecars provide local integrity checks.

## Validation status

Completed for the paging/Knip/report change set:

- Focused performance, paging, recording diagnostics, and acceptance tests: 52 passed, zero failed.
- Complete Bun suite: 3,154 passed, one intentional skip, zero failed.
- Full package and root TypeScript checks: passed.
- Lint with warnings denied: passed.
- Anti-slop rule suites: 12 of 12 passed.
- Production build and portable-Wasm artifact validation: passed.
- Cloudflare Worker dry-run bundle: passed.
- Native aggregate debug CTest: 6 of 6 passed.
- Native macOS host debug-preset CTest: 6 of 6 passed.
- Audio-core standalone CTest: 1 of 1 passed after rebuilding the standalone build directory.
- Audio-core AddressSanitizer/UndefinedBehaviorSanitizer CTest: 1 of 1 passed.
- Full-branch secret-pattern scan: passed with zero matches.
- V3 local fixture SHA-256 verification: passed for both browser and native archives.
- Packaged late-offset paging: passed.
- Diff hygiene: passed.
- Exact-base Knip set comparison: passed with zero branch-added findings.
- Security review: passed with no threshold-triggering findings.
