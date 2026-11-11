# AE-08 plan review

Review of `implementation-trackers/ae-08-live-graph-edits-plan.md`, 2026-10-15. Read-only source inspection plus web research. No builds, tests, app launches, process signals, or subagents. Line anchors refer to the current working tree.

Labels used below: **[Doc]** is stated in an official or primary source. **[Code]** is verified in this repository. **[Inference]** is reasoning or an estimate and needs measurement.

---

## 1. Research

### Q1. Adding a VST during playback

#### What the DAWs actually do

- **Ableton Live.** I found no official Ableton document that says how plug-in instantiation interacts with running audio, or which thread loads a plug-in. Ableton documents delay compensation, "Reduced Latency When Monitoring", and the Live 12 per-track "Keep Latency" option. It does not document an insertion-time guarantee.
  - [Doc] Live delays other tracks to compensate device and plug-in latency: [Delay Compensation FAQ](https://help.ableton.com/hc/en-us/articles/209072409-Delay-Compensation-FAQ), [How Latency Works](https://help.ableton.com/hc/en-us/articles/360010545559-How-Latency-Works).
  - [Doc] Monitored tracks can bypass compensation: [Reduced Latency When Monitoring FAQ](https://help.ableton.com/hc/en-us/articles/209072249-Reduced-Latency-When-Monitoring-FAQ).
  - [Doc, secondary] Live 12 replaced that option with a per-track "Keep Latency" toggle (release-note quote in [r/ableton](https://www.reddit.com/r/ableton/comments/17v33yh/keep_monitoring_latency_finally/)).
  - [Inference] Live hosts plug-ins in-process. Loading happens off the audio thread, and the device is not audible until the plug-in is ready. Light plug-ins look instant because they load in tens of milliseconds. Heavy instruments visibly take time. Community reports describe short glitches when global latency changes. **"Ableton does it instantly" is a perception of fast loading, not a documented guarantee.** Do not cite it as a contract.
- **Bitwig.** [Doc] Bitwig has five hosting modes: Within Bitwig, Together, By Manufacturer, By Plug-in, and Individually. In-process mode uses the least memory but lets a plug-in crash the engine. Sandboxed modes trade memory for isolation ([Plug-in Handling and Options](https://www.bitwig.com/userguide/latest/vst_plug-in_handling_and_options/), [2.5 release notes](https://downloads.bitwig.com/stable/2.5/Release-Notes-2.5.html)). Bitwig does not document insert-time audio behavior or any warm-process pool.
- **Reaper.** [Doc, blog] Plug-ins can run "as separate process" or "as dedicated process" ([reaper.blog](https://reaper.blog/2012/02/run-plugin-as-dedicated-process/)). Bridged plug-ins add IPC cost. I found no official statement about insert latency while playing.
- **VST3 itself.** [Doc] Steinberg's `IAudioProcessor::getLatencySamples` reference says that if latency changes, the plug-in must call `restartComponent(kLatencyChanged)`, and "this could lead to audio playback interruption because the host has to recompute its internal mixer delay compensation" ([IAudioProcessor](https://steinbergmedia.github.io/vst3_doc/vstinterfaces/classSteinberg_1_1Vst_1_1IAudioProcessor.html), [Processing FAQ](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Processing.html)). The SDK authors do not expect hosts to make latency changes artifact-free.

#### Our startup path, from the code

[Code] The steps when a VST is attached today:

1. **Preflight in a separate process.** `apps/desktop/vst3-preflight.ts:96-133` spawns the worker with `--preflight`. That process loads the module, creates and initializes the component and controller, enumerates every parameter, calls `setupProcessing`, probes `getState`, and on editor-mode runs creates a view (`native/plugin-host/src/vst3-worker.cpp:560-761`). Then it exits.
2. **Playback worker spawn.** `posix_spawn` (`native/plugin-host/src/worker-runtime.cpp:219-264`) then **loads and instantiates the plug-in a second time**, applies bus arrangements, calls `setupProcessing`, applies state, and calls `setActive(true)` and `setProcessing(true)` (`vst3-worker.cpp:763-870`).
3. **Startup is serial across attachments.** `StartNativeVstWorkers` loops over every attachment (`audio-host.cpp:1562-1647`).

Every insert therefore pays module load and instantiation twice.

#### Latency per step

No repository artifact times these steps. The 30-track report measures processing time, not startup (`acceptance-reports/30-track-performance-2026-09-23.md:20,166`). All figures below are [Inference] for Apple Silicon and must be measured in phase 1.

| Step | Light effect (e.g. Valhalla) | Heavy instrument (sample-based) | Where |
|---|---|---|---|
| Process spawn + dyld of worker | 5–20 ms | 5–20 ms | `worker-runtime.cpp:237` |
| Module load (`dlopen` of bundle) | 5–50 ms | 50–500 ms | `vst3-worker.cpp` before 566 |
| Component/controller init + parameter enumeration | 5–50 ms | 50–1000 ms | `vst3-worker.cpp:567-646` |
| `setState` | <5 ms | 100 ms – several s (sample loading) | `vst3-worker.cpp:850` |
| `setupProcessing` + `setActive` + `setProcessing` | 1–20 ms | 10–200 ms | `vst3-worker.cpp:813,854,858` |
| **Duplicate preflight (all of the above, again)** | +15–120 ms | +100 ms – s | `vst3-preflight.ts` |

#### Options

| Option | Saves | Memory | Complexity | Verdict |
|---|---|---|---|---|
| A. Pre-warmed idle worker processes | Spawn and dyld only, about 5–20 ms | about 5–15 MB RSS per idle worker [Inference] | Medium. The pool must re-verify, has an ownership lifecycle, and must not pre-load untrusted code. | **Low value.** It saves the cheapest step. |
| B. Device appears immediately as passthrough or silent placeholder, joins when ready (the plan's phase 6) | Perceived latency: the UI updates in the same frame and audio never stops | None | Already in the plan | **Required** |
| C. Reuse the preflight result: cache the manifest by (bundle fingerprint, binary fingerprint, class ID, sample rate, transport), or turn the preflight process into the playback worker | One full load and instantiation, roughly 50% of time to ready | None, or one process | Low to medium. The trust gates already run before both. | **Recommended** |
| D. Park deleted workers for undo: keep a removed instance alive but detached for a bounded time or count | Undo of a delete rejoins with exact state in one publish | One plug-in instance per parked entry. Bound by count, e.g. 4, and by age. | Medium. It reuses the staged/retired ownership. | **Recommended.** Undo is in AE-08 scope. |
| E. Start new instances in parallel (one startup per new instance, which the plan already intends) | Bursts of N inserts take max(t) instead of sum(t) | None | Low | Recommended |

**Recommendation.** Do B, C, and E as part of phase 6, and D as a bounded add-on to phase 6. Skip A. The honest equivalent of "instant" is this: the device appears in the same UI frame, audio continues, and the plug-in joins with a short fade. Time to audible is then about one load (C) instead of two. Undo of a delete becomes truly instant (D).

### Q2. Latency compensation changes during playback

#### What the DAWs do

- [Doc] VST3: hosts may interrupt playback when latency changes (see the link above).
- [Doc] Logic compensates plug-in latency on track and aux channels, and its Low Latency Mode bypasses latent plug-ins while monitoring ([Work with plug-in latencies](https://support.apple.com/guide/logicpro/work-with-plug-in-latencies-lgcpe11997ba/mac), [Manage input monitoring latency](https://support.apple.com/en-us/105040)). No document describes the transition while playing.
- [Doc] Ableton: Delay Compensation, Reduced Latency When Monitoring, and Keep Latency, as linked above. No document describes the transition.
- Pro Tools, Bitwig, and Reaper: I found no official documentation of the runtime transition. Avid's user forum discusses ADC range and inserting during playback (for example [DUC "Increase Delay Compensation Range?"](https://duc.avid.com/home/forum/pro-tools-software/pro-tools/401519-increase-delay-compensation-range)). That is not authoritative.
- **Conclusion.** [Inference] No surveyed DAW documents an artifact-free change of global latency while playing. Steinberg says interruption is expected. In practice hosts do one of three things: (1) a short dropout or re-sync of the whole mix, (2) a timing jump (repeat or skip), or (3) avoid moving global latency by bounding it (Pro Tools' fixed ADC range) or by bypassing compensation on monitored paths.

#### Why the plan's policy fails the user's requirement

The plan uses a dynamic total latency with two read heads on one history and a 256-sample crossfade (plan:32-36). The plan describes the result as a "brief timing smear/comb coloration". That holds only when the change L is small.

When a plug-in with latency L is inserted on one track, the graph's maximum path latency grows by L. **Every unaffected path** then moves its read head from delay d to d+L. Over the crossfade, the listener hears samples from time t−d blended with samples from t−d−L. After the fade, **the last L frames of every unaffected track play again**. Removing the plug-in skips L frames instead.

- At L = 2048 frames (43 ms at 48 kHz), that is an audible stutter or flam on the whole mix.
- At L = 48,000 frames (1 s), it is a one-second repeat.

This contradicts the decision that unaffected audio keeps playing with no gap, voice reset, or tail reset. It also shifts the audible playhead against the UI, meters, and record alignment by L.

#### Alternatives

| Approach | Audibility | CPU | Memory | Complexity |
|---|---|---|---|---|
| Plan: two read heads, linear, 256 samples | Repeat or skip of L on **all** unaffected paths. Comb during the fade. | 2 reads per tap during the fade | One history per tap at the ceiling | High (burst chaining, descriptor banks) |
| Longer or adaptive crossfade | Still repeats or skips L. A longer fade only smears it. | Same | Same | Same |
| Equal-power vs linear | Linear (equal-gain) is right for correlated signals (small L, or same content at aligned time). Equal-power is right for uncorrelated signals (large L). Neither removes the repeat or skip. | Same | Same | Low |
| Fractional-delay ramp (varispeed) | No repeat, but a pitch glide. Moving 2048 frames over 1 s is about 4.3% ≈ 0.73 semitone, audible on tonal material. Absorbing large L takes seconds of detune. | Interpolated read per sample | Same | Medium |
| **Fixed latency budget B** (constant total output latency) | **Unaffected paths are bit-identical.** Only the edited path changes, by a micro-fade at its content seam. The master timing never moves. | Normal: one read per tap | One history per tap of B frames | **Lower.** No global transition, no burst chaining. |
| Compensate only the affected paths (with a dynamic total) | Not possible when the maximum path latency changes, because every other path must move | — | — | — |
| Hybrid: B plus monitoring bypass (Ableton-style Keep Latency off on monitored inputs) | Keeps live-input monitoring low latency | Normal | Same | Low. The record path already separates input accounting (plan:175). |

**How the fixed budget works.** Each path's compensation is `B − path_latency(tap)`. Inserting an effect with latency L on track X reduces only X's compensation by L. The read head switch on X must be scheduled at the **write-frame seam**, where the node output changes from old-chain to new-chain content. It must not be scheduled at the publish frame. Then the duplicated L input frames are skipped exactly once, and the edited track gets one short declick (a fade-out and fade-in of about 3–5 ms, scaled by sample rate). Where both signals exist at once, use a true linear crossfade instead. Examples are a VST joining from a warmed worker (dry and wet both available) and a bypass toggle.

**Choosing B.** Today the graph rejects any edge with `pdc_delay_frames > 8192` (`audio_core.cpp:1280-1288`). So every graph the product currently admits fits a compensation of 8192 frames or less. Pick `B = max(8192 frames, current max path latency rounded up to a block)`, fixed at device configure.

- Its only user-visible cost is that Play and Stop respond up to B/sr later: 171 ms at 48 kHz, 85 ms at 96 kHz.
- The scheduler can pre-roll to hide that for timeline playback, because it already schedules ahead.
- Monitored inputs bypass compensation.
- Raising B (a new plug-in with latency beyond B) is the single case where global timing must move. Treat it as a one-time micro-fade on the master, and log it. Alternatively, set the default B high enough that it never happens for plug-ins the product admits (see section 2, finding F1).

**Crossfade details.** Make the length time-based, not 256 samples. 256 samples is 5.3 ms at 48 kHz but 2.7 ms at 96 kHz. Use about 5 ms for seam declicks and about 10 ms for true crossfades. Use linear gain for aligned or correlated content. Equal-power is needed only for uncorrelated content, which the fixed budget never creates on unaffected paths.

**Recommendation.** Replace the plan's latency policy with **fixed budget B, seam-scheduled per-path transitions on the edited path only, time-based declick or crossfade, and a monitoring bypass**. Among the options considered, it is the only one that keeps unaffected audio unchanged. It is also cheaper than the plan's approach: no global multi-tap transitions, no burst descriptor chaining, and bounded memory (see the math below).

---

## 2. Findings

| ID | Sev | Plan section | Issue | Evidence | Suggested change |
|---|---|---|---|---|---|
| F1 | P0 | Latency policy (38–40), Phase 4, Open investigation 1 | The capacity premise is wrong. The plan treats the worker manifest's 10,000,000-frame latency as "currently admitted", so the history ceiling must cover it, and calls infeasibility a release blocker. The graph already rejects compensation above 8192 frames, so no 10M-latency graph is admitted today. At the 10M ceiling the math is infeasible: 80 MB per history, 5–15 GB in total (see the memory table). The gate as written can never pass. | `audio_core.cpp:1280-1288` (`PDC_DELAY_EXCEEDS_RING_CAPACITY`); `worker-supervisor.cpp:95` and `vst3-worker.cpp:702` (10M) | Define one product latency ceiling (B in section 1). Lower the manifest bound to match, or make the graph reject the plug-in as a genuine failure with an accurate message. Either way it is consistent with plan line 11 ("genuine failures"). Delete the "release-blocking capacity" language. |
| F2 | P0 | Latency policy (32–36), Phase 4 | Two read heads under a dynamic total latency repeat or skip L frames on **every unaffected track** whenever the maximum latency changes. That violates "unaffected audio keeps playing with no gap". The plan's "brief timing smear" claim is false for any L above a few ms. It also shifts the playhead, meter, and record alignment. | Section 1, Q2 analysis; `graph_edge_sample` (`audio_core.cpp:3590-3610`) shows compensation is per edge, so every sibling edge changes when the maximum changes | Adopt the fixed latency budget with seam-scheduled per-path transitions (section 1). |
| F3 | P0 | Phase 6, Phase 4 (173), Open investigation 2 | Two paths missing from the plan stop or restart the whole host. **Any** `restartComponent` (any flag, including routine `kParamValuesChanged` on preset load) becomes `kRestart`, and the host calls `Stop(); Start();`. A changed latency report sets `native_graph_revision_required`, which calls `Stop()`. The plan cites only the mute path (907–934). The worker also never re-reads latency after `kLatencyChanged`: `RefreshLifecycleMetadata` refreshes only the tail. | `vst3-worker.cpp:176-181,1145-1156`; `worker-main.cpp:293-295`; `audio-host.cpp:3204-3208,3225-3243` | In phase 6: decode `restartComponent` flags. Handle `kLatencyChanged` by re-reading latency in the worker and feeding the phase-4 prepare/publish path. Handle parameter/title flags as metadata refresh. Never Stop/Start the host. This also answers open investigation 2. |
| F4 | P1 | Phase 4 (169), Latency policy | The PDC ring stores **post-gain** samples, and its length equals the current delay (`% delay`). A shared per-tap history therefore cannot serve edges with different gains or delays. | `audio_core.cpp:3599-3609,4526-4529` | The history stores pre-gain tap output in a fixed power-of-two ring with an absolute write index. Apply gain at read. |
| F5 | P1 | Phase 3 and 4 transition timing | The plan switches read heads "at publication". With latency-changing inserts, the switch must happen at the content seam: write frame t0, read at t0 + d_new. Switching at publish reads old-chain content at the new delay and skips or duplicates audio on the edited path. | Section 1 derivation | Transition descriptors carry an absolute seam frame. The analyzer checks the seam frame, not only the publish frame. |
| F6 | P1 | Contract (7), Phase 3 | "Cut immediately" implemented as a hard cut clicks on every delete of a sounding object, which is an audible artifact the analyzer would flag. | Plan:7,34 | A fixed fade-out of about 3–5 ms on the deleted contribution only, then disconnect. Document it as "immediate" and keep the analyzer exclusion window equal to the fade. |
| F7 | P1 | Phase 6 | Every insert loads and instantiates the plug-in twice (preflight, then playback worker), which roughly doubles time to audible. The plan's file list omits `vst3-preflight.ts`. | `vst3-preflight.ts:96-133`; `vst3-worker.cpp:560-761,763-870` | Cache the preflight manifest by fingerprint, class, and setup, or reuse the preflight process. Run trust gates before both, unchanged. |
| F8 | P1 | Phase 2 and 5 | `PublishGraphRevision` waits 1 s, then **waits without a timeout** (`publish_wait.wait`) if the callback consumed the request. If the device halts (sleep, unplug), the native command loop hangs. The failure list does not include this. | `audio-host.cpp:2330-2348` | Add a failure mode and guard: a bounded wait plus status reconciliation, with device-halt detection. |
| F9 | P1 | Phase 5 | Prepare is refused while `retired_core != 0` or any control is queued. `InstallAsset` is refused while a prepared or retired core exists. Edits therefore serialize behind retirement epochs, and asset staging cannot overlap prepare. The plan touches `HasQueuedControl`, but not these two gates. | `audio-host.cpp:2071-2073,3255` | List both gates in phase 5's files and functions. Allow staged assets bound to the prepared revision, and auto-retire before the next prepare. |
| F10 | P1 | Phase 3 RT safety | The same-core publish runs in the callback and can `memset` every history array (`kIncompatible`) or assign large structs (`SpectralHistory` holds about 12 arrays of 4096 floats × 32 slots). `merge_prepared_instrument_runtime` copies whole `InstrumentNodeState` objects in the callback. The plan says "no mass zeroing at publish" but does not list these call sites. | `audio_core.cpp:6038-6094,6014-6036` | Name these as phase 3 removal targets. The publish operation is a pointer or index swap only, and resets happen off-thread on spare slots. |
| F11 | P1 | Phase 6 fixtures, Phase 9 | No certified plug-in exercises a runtime latency change. Valhalla is the only certified VST, and the plan's open investigation 2 acknowledges the gap without proposing a fix. | `docs/native-vst3.md:180-201` | Add an acceptance-only, locally signed test VST3 built from the SDK samples with a switchable latency parameter. Gate it to the disposable acceptance profile and trusted root. |
| F12 | P2 | Latency policy (34) | The 256-sample crossfade is sample-rate dependent. | — | Time-based: about 5 ms declick, about 10 ms crossfade. |
| F13 | P2 | Phase 4 over-engineering | Burst chaining ("retain the currently audible weighted taps as the next transition's source"), bounded transition banks, and storage migration with immutable pages are unnecessary under a fixed B with preallocated histories. | Plan:34,164-165 | Cut. Serialize a same-path transition behind the in-flight fade (at most 10 ms, completion-driven). Allocate histories once at device configure for the maximum node and tap counts. |
| F14 | P2 | Phase 8 (283) | The coordinator allows one prepare/publish in flight. Under undo bursts with retire-before-prepare (F9), throughput is bounded by render epochs. That is fine, but the plan has no latency budget for edit-to-audible time. | — | Add a measured edit-to-publish P95 target (for example under 2 render periods plus prepare time) to phase 9's thresholds. |
| F15 | P2 | Phase 9 | `--matrix full --repetitions 100` on packaged hardware with real-time capture can take days. There is no time budget or stopping rule. | Plan:307-316 | Use 100 repetitions for deterministic built-in cases and 20 for VST and recording rows, plus a scheduled long soak. Record the wall time. |
| F16 | P2 | Phase 1 baseline | The baseline logs edit-caused respawns but not the restart and latency `Stop()` paths from F3. | — | Log `ProcessNativeVstControl` restart and latency transitions with their cause. |
| F17 | P3 | Anchors | Spot-checked anchors are accurate: `audio_core.cpp:1280`, 1410, 3590, 4527, 5472-5486, 5761-5949, 6014-6094; `worker-supervisor.cpp:95`; `audio-host.cpp:2060-2169`, 2172-2275, 2278-2406, 4219-4254, 1562, 907-934; `audio-host.ts:2499-2514,2693`; `Timeline.tsx:749,761,1451`; `native-playback-controller.ts:298,615,2012`. | — | None. |
| F18 | P3 | Phase 7 | The recording-target lock is renderer work with standalone value. Today a destructive edit during recording already settles or cancels the take. It can land before phase 3. | `Timeline.tsx:1451` | Allow phase 7's lock and UI to ship as soon as phase 2 lands. Packaged native certification still waits for 5 and 6, as the plan says. |

### Phase 4 memory feasibility

A stereo float history uses 8 bytes per frame. The byte count depends on frames, so sample rate matters only when the ceiling is expressed in seconds. Distinct taps come from `kMaximumGraphNodes = 64` with at most 3 taps per node (pre-FX, pre-fader, post) = **192 worst case**. Realistic maximums are about 64–128 (`audio_core.cpp:25-26`).

| Ceiling | Frames | Per history | ×64 taps | ×192 taps | Feasible? |
|---|---|---|---|---|---|
| Plan: manifest bound | 10,000,000 | 80 MB | 5.1 GB | 15.4 GB | No |
| Plan: checked path sum (64 VSTs × 10M) | 640,000,000 | 5.12 GB | 328 GB | 983 GB | No |
| Current cap, B = 8192 (171 ms at 48k, 85 ms at 96k) | 8,192 | 64 KiB | 4 MiB | 12 MiB | Yes. The existing `graph_delay_lines` is already 16 MiB (`audio_core.cpp:517`). |
| B = 65,536 (1.37 s at 48k, 0.68 s at 96k) | 65,536 | 512 KiB | 32 MiB | 96 MiB | Yes |
| 1.0 s at 44.1k | 44,100 | 345 KiB | 22 MiB | 66 MiB | Yes |
| 1.0 s at 48k | 48,000 | 375 KiB | 24 MiB | 72 MiB | Yes |
| 1.0 s at 96k | 96,000 | 750 KiB | 48 MiB | 144 MiB | Yes, but heavy |

**Bound to use.** Express the ceiling in frames, not seconds, so memory does not double at 96 kHz. Default B = 8192 to preserve exactly what is admitted today. Add one explicit constant for a product maximum, recommended 65,536 frames (96 MiB worst case, preallocated and prefaulted at configure). Make the manifest validator (`worker-supervisor.cpp:95`, `vst3-worker.cpp:702`) and the graph validator agree on it.

### Verification practicality

- The plan is E2E-first and packaged, with real output capture. The native C++ harness extensions are justified because Chromium cannot observe callback ownership. That fits the user's rules.
- The new `native-live-graph.browser.test.ts` (phase 2) exercises the real bridge adapter with delayed replies. It is an integration E2E, not a unit test. Acceptable.
- The analyzer's defect-injection requirement is good. Add seam-frame checks (F5) and a deletion fade window (F6).
- The fixed-budget design makes unrelated-track checks **bit-exact nulls**, not a "localized alignment" against a two-read-head reference. That is simpler and stronger.

### Effort

The plan's phase sums come to 60–94 engineer-days. With F1, F2, and F13 applied, phase 4 drops from XL (10–15) to about M/L (5–8). Phase 6 gains about 3–5 days for F3, F7, and parking. That nets 58–88 days.

Phases 3, 5, and 6 carry high discovery risk: shared ownership across core, host, and renderer. Plan for **about 80–110 engineer-days** realistically. Calendar time is longer, because packaged runs cannot overlap other acceptance runs.

---

## 3. Suggested edits to the plan

1. **Latency policy (lines 30–40):** replace "two read heads … 256 samples" with: "Fixed output latency budget B, fixed at device configure (default 8192 frames, product maximum `kMaximumGraphLatencyFrames` = 65,536). Compensation per tap = B − path latency. A latency-changing edit transitions only the edited path, at its write-frame seam, with a time-based declick (about 5 ms) or a linear crossfade (about 10 ms) where both signals exist. Unaffected paths are unchanged. Raising B beyond its current value is the only global timing move; log it and apply a master micro-fade." Delete "brief timing smear" and the burst-chaining sentences.
2. **Capacity paragraph (lines 38–40) and open investigation 1:** replace the 10M and path-sum framing with the memory table above. State that 8192-frame compensation is what is admitted today. Unify the manifest validator (`worker-supervisor.cpp:95`, `vst3-worker.cpp:702`) and the graph validator on `kMaximumGraphLatencyFrames`. A plug-in above it is a genuine failure with an accurate message. Remove "release-blocking capacity-design problem".
3. **Phase 4 files:** add "history stores pre-gain tap output in a fixed power-of-two ring with an absolute write index; gain is applied at read" (F4). Add "transition descriptors carry an absolute seam frame" (F5). Delete the storage-migration and transition-bank bullets (F13). Allocate all histories once at configure for 64 nodes × 3 taps.
4. **Contract (line 7) and phase 3:** define "cut immediately" as a fixed fade-out of about 3–5 ms of the deleted contribution, then disconnect (F6).
5. **Phase 6, failure modes and files:** add "`restartComponent` from any flag stops and restarts the whole host (`audio-host.cpp:3225-3243`); a latency report stops the host (`3204-3208,3236-3239`)". Add the worker change "re-read `getLatencySamples` on `kLatencyChanged` and emit `kLatency`" (`vst3-worker.cpp:176-181`, `worker-main.cpp:293-295`) (F3).
6. **Phase 6:** add `apps/desktop/vst3-preflight.ts` and a manifest cache keyed by fingerprint, class, and setup to skip the second load (F7). Add bounded parking of deleted workers for instant undo (Q1 option D). Start new instances in parallel.
7. **Phase 2 and 5, failure modes:** add "publish wait without a timeout hangs on device halt" (`audio-host.cpp:2345`) (F8). Add "prepare and asset install are refused while a retired or prepared core exists" (`2071-2073`, `3255`) (F9).
8. **Phase 3 files:** name the callback-side `memset` and struct resets in `daw_audio_core_publish` (`audio_core.cpp:6050-6089`) and `merge_prepared_instrument_runtime` (`6014-6036`) as removal targets (F10).
9. **Phase 6 and 9 fixtures:** add an acceptance-only test VST3 with switchable latency, signed and gated to the disposable profile (F11).
10. **Phase 7:** allow the lock and UI to land after phase 2 (F18).
11. **Phase 9:** set the repetition counts per row class and a wall-time budget (F15). Add an edit-to-publish P95 threshold (F14).
12. **Phase 1:** log the restart and latency `Stop()` causes from `ProcessNativeVstControl` in the baseline (F16). Add per-step VST startup timing (spawn, module load, init, state, activate) for both preflight and playback to replace the Q1 estimates with measurements.
13. **Effort table:** phase 4 becomes 5–8 days and phase 6 becomes 13–20 days. Add a total line of "about 80–110 engineer-days including discovery".

---

## 4. Go/no-go for phase 1

**GO for phase 1, with edit 12 applied.** Phase 1 is instrumentation and an owned packaged harness. It changes no edit behavior and does not depend on the latency design.

**NO-GO for phase 3 until edits 1–3 are applied to the plan.** Phase 3 moves the PDC rings into stable tap slots, so it must target the fixed-budget, pre-gain history layout. Otherwise phase 4 would rework it. F3 should be scheduled no later than phase 6, and it can be fixed earlier on its own: it is a standing whole-host restart triggered by ordinary plug-in behavior.
