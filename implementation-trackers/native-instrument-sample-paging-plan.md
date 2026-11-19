# Native instrument sample paging implementation plan

Date: 2026-10-16  
Status: design only, not implemented or runtime-validated. Evidence describes the current working tree, including existing uncommitted work. All source references below are repository-relative.

## Decision and scope

Reuse the desktop **mapped-asset transfer protocol** for decoded instrument regions. Register each region independently of timeline clips, upload bounded pages, prepare the complete playable region, then configure the instrument and admit notes. Keep the 1 MiB frame limit unchanged.

Important correction to the initial hypothesis: desktop “mapped pages” are writes into a full-length, file-backed PCM mapping, not entries in the core's bounded paged-asset pool. Mapped assets already expose contiguous plane pointers to every instrument reader. **No core sample-reader rewrite, core ABI bump, or instrument-state wire change is needed for this design.**

Use full-region native residency for the first implementation, not predictive instrument streaming. Granular random access makes a rolling timeline window insufficient. Sampler pitch changes, simultaneous voices and loop crossfades also make full-region preparation the smallest reliable first step.

Two explicit delivery gates:

1. Advisory prefetch is not guaranteed residency. For live instrument mappings, add control-thread memory locking with checked failure, immutable publication and lifetime ownership. Do not claim an absence of OS page faults from the existing prepare acknowledgement.
2. A full 3-minute stereo 48 kHz region exceeds 64 MiB. Supporting that fixture in every instrument requires an approved native-only budget policy adjustment, or a different, larger streaming architecture. Merely replacing IPC cannot meet that acceptance criterion under today's 64 MiB limits.

Non-goals: disk-streaming arbitrarily large random-access samples, renderer decode elimination, browser budget changes, changes to event admission or granular voice stealing, new public project-control operations, and general timeline streaming redesign.

Implementation constraints: follow `AGENTS.md` and `AGENTS-solid.md` for affected UI; retain Ableton-like device loading/error behavior and the current theme. Prefer pure policy/collection functions, explicit ownership at I/O boundaries, typed objects without `as` casts, and one shared implementation of region identity/page transport rather than per-instrument copies.

## 1. Today's model, with evidence

### Live timeline: renderer to callback

| Stage | Current behavior and source evidence |
| --- | --- |
| Projection and registration | `src/lib/desktop/native-playback-controller.ts:1174-1220` selects projection assets without `pcm`, resolves prepared Stretch artifacts or snapshot asset buffers, otherwise finds a timeline clip and calls `resolveSource(clip)`. `1194-1208` is the clip dependency that cannot resolve an instrument-only sample. |
| Renderer page manager | `src/lib/desktop/native-timeline-page-manager.ts:11-20,73-106` takes source descriptors, IDs, dimensions and optional Stretch repositories. It uses 16,384-frame pages bounded again by channel-dependent protocol capacity, with two concurrent decoders (`47-49`). It is already descriptor-based, not inherently clip-based. |
| Page production | `native-timeline-page-manager.ts:260-351` deduplicates in-flight reads, validates metadata and complete coverage, copies bounded planar pages and waits for `writePage`. `430-498` merges ranges, uploads intersecting pages, then prepares each range, with one rehydration attempt after failed preparation. |
| IPC | `native-playback-controller.ts:1221-1239,1255-1262` connects create/write/prepare bridge operations to the transaction. `packages/desktop-protocol/src/native-audio-host.ts:69-72` assigns mapped create/write/prepare/release opcodes 57-60; `80-98` bounds page payloads separately from whole-PCM installs. `native/audio-host-macos/src/main.cpp:492-498,909-910` dispatches range preparation to the host. |
| Host storage | `native/audio-host-macos/src/audio-host.cpp:3425-3491` creates an unlinked temporary file, sizes it for the entire planar Float32 asset and maps it with `MAP_SHARED`. It supplies channel pointers and a 64-bit frame count to `daw_audio_core_create_mapped_asset`. This reserves full logical storage, not a fixed pool of resident audio pages. |
| Host page writes | `audio-host.cpp:3494-3547` validates dimensions and finite PCM, copies into the appropriate channel offsets and merges written ranges. A ledger overflow at 256 disjoint ranges forgets coverage hints, not PCM (`3537-3542`; limit in `native/audio-host-macos/include/daw/audio_host_macos.h:29`). Sequential full-region uploads coalesce into one covered range. |
| Preparation | `audio-host.cpp:3549-3573` checks written coverage and issues `madvise(..., MADV_WILLNEED)` for each plane. It ignores the syscall result. It does not lock memory, create a core preparation handle, install a page-fault handler, or guarantee physical residency. Arbitrary start offsets also need OS-page alignment if the advice is to be reliable. |
| Core registration/read | `native/audio-core/include/daw/audio_core.h:925-937` defines caller-owned mapped planes and their lifetime. `native/audio-core/src/audio_core.cpp:8673-8694` stores them with `slot.paged = false`. Timeline `asset_sample` directly reads those planes when no paged preparation is supplied (`3452-3470`, timeline call sites `3540-3541`). |

### Prefetch, misses, eviction and lifetime

- Scheduling prepares source-event coverage, including interpolation coverage, **before** submitting a window: `src/lib/desktop/native-schedule-coordinator.ts:800-817`. Progress events request refills (`1020-1031`). This is an event-driven rolling schedule, not callback-driven page loading.
- Renderer uploaded-page bookkeeping is capped at 128 entries and uses access-sequence eviction (`native-timeline-page-manager.ts:124-151`). This cap is neither a native RAM budget nor a 128-page maximum asset duration. Discarding an uploaded hint does not unmap or erase native PCM.
- Native coverage-ledger eviction likewise does not evict data. A prepare can fail because coverage hints were forgotten, causing bounded rehydration (`native-timeline-page-manager.ts:478-498`).
- **Current mapped callback miss behavior is not a controlled zero-fill policy.** Direct mapped reads can trigger a synchronous OS page fault. An unwritten part of the newly sized file can read as zeros, but the instrument reader has no written-coverage check or asynchronous missing-page notification. Correctness must come from preparation before publication, not from sparse-file zeros.
- Distinguish the separate core paged API: `audio_core.h:939-998,1180-1205` defines page slots and explicit preparation handles. Its read returns zero outside prepared coverage, on owner mismatch or beyond valid frames (`audio_core.cpp:3435-3449`). That is not what the desktop mapped protocol currently uses.
- The core paged pool has at most 256 slots; the Wasm configuration uses 128 slots of 16,384 frames, about 16 MiB stereo (`audio_core.h:10-19`). A 3-minute 48 kHz source needs 528 such pages, so routing instruments into this pool and pinning the entire region cannot solve this task without substantial new design.
- Manager disposal aborts shared decoding and waits for in-flight operations (`native-timeline-page-manager.ts:516-525`). A canceled individual caller detaches from shared hydration; manager disposal cancels the shared operation (`272-275`).
- Renderer session disposal invalidates ownership, drains page operations, requests stop/release and then teardown (`native-playback-controller.ts:754-775`). Do not assume every release succeeds before teardown: release is guarded.
- Host release refuses prepared/retired-plan and queued-control hazards and asks the core first (`audio-host.cpp:3576-3583`). Core release rejects active references, clears pointers and advances generation (`audio_core.cpp:8709-8732`). Reference checks include configured sampler zones, active voices, and active granular notes/grains (`894-918`, `3379-3380`).
- Mapped storage owns its FD and unmaps/closes in its destructor (`audio-host.cpp:1285-1304`); host asset collections are cleared during configuration/teardown (`2048`, `4265`). Extend this same ownership to residency locks. Never free a mapping because a renderer cache entry alone was evicted.

### Instrument bottleneck and existing core support

- `apps/desktop/audio-host.ts:283-303` serializes one whole PCM install. `packages/desktop-protocol/src/native-audio-host.ts:76-98` bounds it to 262,138 mono or 131,069 stereo frames after its 24-byte header and the 1 MiB payload bound, about 5.46/2.73 seconds at 48 kHz.
- `packages/audio-engine/src/live-native-projection.ts:284-307` gathers decoded sampler, drum-rack and granular buffers; `195-245` copies complete PCM planes and rejects assets above the install limit. `native-playback-controller.ts:1243-1254` then uses `installAsset`.
- `audio_core.cpp:1010-1021` accepts sample zones only for non-`paged` assets, including mapped assets; it validates region/loop bounds against full asset length. `996-1007` does the same for granular.
- Sampler and drum rack share native sample-state configuration: `audio-host.cpp:2290-2315`. Their reader moves forward at pitch/sample-rate-dependent increments, loops and optionally reads a second loop-crossfade position (`audio_core.cpp:3898-3974`). It already calls `asset_sample(..., nullptr, ...)`.
- Granular chooses positions across the asset with spray, reverse and pitch, then linearly reads plane pointers (`audio_core.cpp:3979-4035`). Native instrument buffers are localized regions, not necessarily full original files (`live-native-projection.ts:53-55`; export localization in `packages/audio-engine/src/portable-export-snapshot.ts:102-147`). Preserve that coordinate system.
- `audio-host.cpp:2260-2339` configures instrument states against active/prepared core ownership. This is the appropriate native readiness/residency admission boundary; do not relax the existing instrument-event admission checks.

## 2. Proposed source registration and readiness

### Register instruments without synthetic timeline clips

Choose **decoded-region-backed instrument providers** feeding the existing descriptor page manager. Do not generalize the timeline clip resolver into a universal file/URL resolver in this change.

1. During existing instrument localization, collect a `Map` of immutable region identity to the already-decoded regional `AudioBuffer`, dimensions and instrument ownership. Include generation/project identity. Preserve distinct crops of the same source; never key only by original file asset ID.
2. Reuse `createAudioPcmSourceDescriptor({ source: buffer, ... })`, as the controller already does for timeline buffers (`1197-1205`). The page manager already supports this, with coverage in `src/lib/desktop/native-timeline-page-manager.test.ts:293-319`. No second page splitter, codec, upload cache or instrument page-manager class is needed.
3. Native live projection should carry metadata/source association rather than copied whole-region `pcm`. Build the manager source list from the union of timeline/Stretch descriptors and instrument region descriptors. Resolve an instrument region first by exact regional identity, without looking for a timeline clip. Use indexed Maps rather than repeating clip/asset linear searches.
4. Keep buffer references in a renderer-local provider registry or native preparation result, not a structured-cloned IPC plan. Share the small region-source collection helper between live and native export where both genuinely consume it. Do not create a generic resolver framework.
5. For every native instrument asset: reserve memory, create mapped descriptor, upload all pages of `[0, frameCount)`, prepare complete coverage, then configure state. Only after the acknowledgement may the prepared instrument accept live notes or scheduled notes. Full regional coverage includes interpolation neighbors and both sides of loops; mapping the entire localized region avoids separate guard transfers.
6. Keep an explicit distinction between decoded-ready and native-ready. A device may show loading while native preparation runs, but must not claim playable readiness. On failure retain the previous playable instrument where transaction rollback allows it; otherwise show an actionable inline error and keep the new device unready. Do not silently fall back to browser audio or play delayed accumulated notes after readiness.
7. Carry abort/generation ownership through upload and configuration. Replacement, project switch, Stop during startup, host loss and late transaction acknowledgement must not publish stale region sources. Reuse existing session cancellation and rollback instead of adding timers or polling.
8. Once configured, instrument data is immutable. Deduplicate identical regional content/identity, but do not rewrite mapped bytes while a callback can read them. Track shared ownership across instruments and any timeline references; one consumer's removal must not release another's mapping.

### Live residency, admission and misses

Full upload guarantees **logical coverage**, not physical residency. For this plan's stronger live guarantee:

- In native host instrument configuration, resolve all referenced mapped assets and validate full written coverage before any state is accepted. Collect unique handles; validate the complete candidate batch before changing state.
- On the control thread, lock the OS-page-aligned mapped ranges for those instrument assets with `mlock`, checking return values. Full localized assets are simplest. A successful lock faults in and retains those pages; do not run lock/touch/advice work inside the callback. Account page-rounded lock bytes and shared ownership.
- Reserve against a session-level native resident-byte limit before locking. Failed lock, budget exhaustion, incomplete upload or invalid state fails preparation with bounded, actionable diagnostics. Never downgrade a failed lock into “ready”. Roll back newly acquired locks/reservations if any subsequent configure step fails.
- Preserve locks while published/prepared/retired instrument plans, release-tail voices or grains may access them. Release on proven retirement/asset release/teardown, not immediately on parameter replacement or Stop. Use host-owned RAII cleanup and idempotent ownership accounting. The initial implementation may conservatively retain a successful instrument lock until safe asset release/session teardown, bounded by the session budget; it must not pretend to reclaim that memory on track removal.
- Existing mapped create/write/prepare wire messages remain sufficient. Do not change generic timeline preparation into mandatory locking. Apply live instrument locking at instrument-state admission; the offline host (`offline:render`, identified in `audio-host.cpp:3600-3602`) can validate coverage without requiring realtime residency.
- **Expected live callback behavior: no software page miss and no sample-buffer OS paging after successful readiness.** The callback performs existing pointer reads, not IPC, file I/O, allocation, mutex acquisition or decoding. OS/kernel scheduling still prevents an absolute general-purpose-OS deadline guarantee.
- A mapped OS fault cannot be caught and converted to silence by these readers. Therefore “return zero and ask the renderer” is not an implementable fallback for this chosen mapping design. If deterministic locking is unavailable on a target machine, fail loading before publication. Expose recovery outside the callback, preserving unrelated playback when possible.
- If a future bounded software cache is implemented, a missing read must return bounded silence for the affected voice/grain and publish a preallocated diagnostic/request for non-RT handling, never block. Strict export must reject incomplete output, not silently certify zero-filled audio. That alternative needs instrument preparation handles and new core readers and is explicitly deferred.

## 3. Memory feasibility and product gates

All calculations use decoded Float32 PCM at the **source** sample rate, not WAV file size, 16-bit encoding size, or output device rate.

| Full stereo 48 kHz region | Frames | One decoded/mapped copy | Renderer + resident native, minimum |
| --- | ---: | ---: | ---: |
| 8 seconds | 384,000 | 3,072,000 B = 2.93 MiB | 5.86 MiB |
| 180 seconds | 8,640,000 | 69,120,000 B = 65.92 MiB | 131.84 MiB |

Add bounded IPC/page staging, OS-page alignment and overlapping old/new regions during replacement. A native export alongside live playback can retain a third full copy, about 197.75 MiB for one such region, before staging/other instruments.

Current policy evidence:

- Granular defaults to 64 MiB, configurable up to 256 MiB (`packages/shared/src/granular-params.ts:44,72`). Live preflight counts two retained copies (`src/lib/sampler-buffer-sync.ts:293-295,343-364`), so even a raw region below 64 MiB can exceed its retained-working-set admission. Export separately counts two retained copies in aggregate accounting, with raw bytes checked against the instrument setting (`run-export-job.ts:841-861`).
- Sampler defaults to 256 MiB (`packages/shared/src/sampler-params.ts:87`); the shared sampled-instrument aggregate defaults to 256 MiB (`sampler-buffer-sync.ts:21`, `src/lib/sampled-instrument-session.ts:28-38`). Sampler live reservations currently count one region copy, not native residency (`sampler-buffer-sync.ts:292-296`).
- Drum rack declares 64 MiB (`packages/audio-engine/src/drum-rack-runtime.ts:55`), enforced across unique pad regions before decode (`src/lib/drum-rack-buffer-sync.ts:226-240`) and again during export (`src/lib/export/run-export-job.ts:784-811`).
- Current live and portable-export projections add whole-plane copies (`live-native-projection.ts:209-215,227-233`; `portable-export-snapshot.ts:159-175`). The new native path should avoid those full projection copies, but still retains decoded renderer PCM plus native mapping. Paging the IPC alone is not renderer memory streaming.

**Feasibility conclusion:** full-region residency works within admitted memory, regardless of sequential versus random reads, but it cannot satisfy arbitrary multi-minute sources under fixed 64 MiB limits. At 48 kHz stereo, 64 MiB holds about 174.76 seconds of one copy or 87.38 seconds when two copies share that cap. A 3-minute stereo 44.1 kHz sample is smaller (60.56 MiB), but choosing it to conceal the 48 kHz failure is not acceptance.

**Approved decision (2026-10-17, user: "do what Ableton does; if we must raise it then raise it"; evidence `acceptance-reports/ableton-sample-memory-research-2026-10-17.md`):**

- Ableton loads Simpler/Sampler samples into RAM up to 1024 MB per multisample and streams from disk beyond that; no per-Set aggregate cap is documented. Desktop native therefore uses a **1 GiB per-device decoded-region ceiling** for sampler, granular and drum rack (granular/drum rack value is app policy; Ableton does not document those).
- The combined desktop budget is **derived from system memory** (a conservative fraction of `os.totalmem()`, computed once in one native policy helper), not a fixed 256 MiB. It counts renderer decoded PCM and native resident/locked bytes separately, plus replacement and export overlap. Effective admission is the lesser of the device ceiling and remaining aggregate.
- On lock or admission failure: **fail before ready with an actionable device-pane error** (user-approved). No silent streaming, no glitching playback.
- Browser/portable limits and serialized `maxDecodedBytes` defaults stay unchanged.
- Disk streaming above 1 GiB (Ableton's fallback) is a later, separate project.

The original proposal below is superseded where it conflicts with this decision.

**Original recommended native-only policy:**

- Separate decoded-region limits from native resident-byte accounting; use one runtime policy calculation for live loading and export. Count renderer buffers once by buffer identity, native mappings once by asset identity, and bounded page staging separately. Keep pinned/leased usage non-evictable.
- For native granular use a 256 MiB retained-working-set allowance, respecting any explicit larger supported user setting only within existing normalization; do not rewrite persisted/browser defaults. For native drum rack permit up to 128 MiB decoded unique regions and charge the native copy separately. Sampler keeps its 256 MiB decoded default with an additional native-copy reservation.
- Retain the shared 256 MiB sampled-instrument session aggregate as a real combined admission bound rather than allowing every device its maximum simultaneously. This admits one 3-minute stereo region plus its native copy; it does not guarantee three distinct such devices fit simultaneously. Live/export sharing and overlap must be included or fail before mutation.
- Keep browser/portable policy and serialized project parameters unchanged. A desktop-only runtime policy belongs at sampled-instrument preparation boundaries, not duplicated constants in each device component.
- Decide whether live resources may be released/paused to make room for export, or whether export reports insufficient memory while live playback holds leases. Default recommendation: preserve live playback, fail export preflight clearly, allow retry after explicit release. Do not silently evict audible samples.

If product requires the existing 64 MiB caps unchanged, the 3-minute 48 kHz stereo drum-rack success criterion is blocked. The alternative is source-backed renderer decoding plus bounded native streaming and controlled software misses, a separate project rather than an unacknowledged extension of this plan.

## 4. Offline export

Today's native export compiles a portable snapshot with native capability targeting (`src/lib/export/native-offline-render-plan.ts:247-262`), but instrument assets still become full PCM (`portable-export-snapshot.ts:340-355`). PCM chunking explicitly refuses oversized instrument-owned assets (`packages/audio-engine/src/native-pcm-chunking.ts:115-134`).

`native-offline-render-plan.ts:77-148` splits PCM versus mapped assets, deriving mapped ranges only from timeline sample-source events. Instrument notes do not create these events. `run-export-job.ts:1194-1224` then resolves mapped providers only through clips. Both are necessary changes; simply clearing instrument `pcm` would produce an unresolved or empty-range asset.

Implementation:

1. Preserve portable snapshot behavior by default. Add a native-only instrument metadata mode or equivalent native adapter before snapshot PCM creation, retaining stable regional identities and graph references without allocating whole copied planes. Native live/export use the same regional descriptor association; portable export continues receiving its existing transferable PCM.
2. In native plan assembly, union instrument-owned `[0, frameCount)` ranges with existing timeline coverage by asset identity. Deduplicate and merge; include assets referenced only by instrument state even if there is no audio clip/event. Preserve zone, loop and localized offset semantics. Do not send instruments through timeline PCM chunking or change its protective rejection for unexpected legacy inputs.
3. In `run-export-job.ts`, register descriptors from the exact hydrated export `fx` regional buffers before falling back to clip resolvers or prepared Stretch artifacts. The registry remains local and leased for the export; the IPC plan stays structured-cloneable metadata.
4. Reuse existing offline page requests and validation: `apps/desktop/audio-host.ts:1000-1057` creates mappings, requests pages no larger than 16,384 frames/payload capacity, waits for each ACK, and prepares ranges. It configures the graph and instruments only afterward (`1066-1070`).
5. Offline requires complete coverage, not realtime `mlock`. All required regional data must be acknowledged before render starts. Failed page read, coverage validation, identity mismatch or cancellation must fail/cancel export before completion; release providers, budget leases, child resources and partial spools through existing cleanup.
6. Account simultaneous live+export copies and existing export buffer leases. Do not detach live buffers, retain stale registry generations, or eagerly serialize an entire region into the offline job message.

## 5. Portable/browser compatibility

Browser playback and export behavior remain unchanged. The browser backend posts `register-asset` with planar PCM (`packages/audio-engine/src/backends/wasm-audio-worklet-backend.ts:478`); the v2 worklet validates and copies those planes into Wasm memory (`public/audio-worklets/daw-portable-audio-core-host-v2.js:1730-1752`). Its distinct paged API remains available for its existing consumers, not newly instrument-enabled here.

Preserve default `compilePortableExportSnapshot` PCM materialization, localization and transferables. Native-only switches must be explicit at native call sites, not inferred from region size. Preserve browser budgets, sample voices, granular RNG/output and the shared core artifact. With no core source/ABI change, a new Wasm binary should not be necessary for this feature.

Remove the **native whole-message duration** rejection only when the mapped route is ready: both projection rejection (`live-native-projection.ts:236-244`) and predecode `nativeInstrumentSampleDiagnostic` use (`src/lib/native-instrument-sample-diagnostic.ts:1-13`, `sampler-buffer-sync.ts:79-84,256-263`). Audit remaining consumers before deleting the helper/native-only option. Keep real memory, missing-source, unsupported-channel and residency errors in the current device panes; do not remove unrelated import diagnostics. Recent diagnostic implementation is documented in `acceptance-reports/daw-experience-import-diagnostics-2026-10-16.md:44-51`.

## 6. Implementation phases and proof

Estimates are changed production/test lines, excluding generated WAVs and evidence. They are planning ranges, not promises. Native residency/lifetime work makes the earlier 150-350-line transport-only estimate inadequate. Write isolation failure cases/test fixtures before changing isolated behavior; prefer native integration and browser/package journeys over adding a new unit-test framework. Each phase must keep the default shipping path working until the live/export integration is complete.

### Phase 1: decoded-region provider seam, no behavior switch

- **Files:** `packages/audio-engine/src/live-native-projection.ts`, `packages/audio-engine/src/portable-export-snapshot.ts`, a small shared instrument-region source collector only if needed by both; `src/lib/desktop/native-timeline-page-manager.ts` only if its existing descriptor interface proves insufficient.
- **Work:** expose exact localized region sources without copying full PCM in the opt-in native metadata route; preserve existing defaults. Cover repeated crops, inconsistent dimensions and absent timeline clips.
- **Size/risk:** 90-160 production + 100-180 test lines; medium, primarily identity/localization.
- **Existing proof files:** extend `src/lib/desktop/native-timeline-page-manager.test.ts` eager-buffer/no-URL, concurrent hydration and disposal cases (`293`, `321`, `357`, `437`, `548`); `packages/audio-engine/src/live-native-projection.test.ts` and `portable-export-snapshot.test.ts` prove native metadata versus unchanged portable PCM. These are seam tests, not proof of audible native playback.
- **Exit:** an instrument-only region yields valid bounded pages and stable references, with no unconditional portable change.

### Phase 2: native instrument coverage and resident lifetime

- **Files:** `native/audio-host-macos/src/audio-host.cpp`, `native/audio-host-macos/include/daw/audio_host_macos.h` if private limits/status require it; `native/audio-host-macos/src/main.cpp` and `apps/desktop/audio-host.ts` only for actionable bounded error propagation, if existing errors are insufficient. No core reader/API edits.
- **Work:** add checked control-thread locking for instrument-owned mappings, full-coverage validation, unique byte admission and rollback, write rejection for published/resident data, and RAII release. Validate all candidate assets before configure. Keep generic timeline advisory preparation and offline no-lock coverage behavior intact.
- **Size/risk:** 160-280 production + 180-300 native integration test lines; high, OS lock limits and ownership across graph retirement.
- **Existing proof files:** extend `native/audio-host-macos/tests/audio_host_test.cpp` beside `TestMappedAssetSurvivesGraphPublication` (`1137`), bounded ledger (`1193`), admission (`1694`) and voice stealing (`1728`). Feed page-written assets over the old frame ceiling into all three instrument states, process actual output, compare against equivalent contiguous-reference PCM. Exercise loop/crossfade seams, granular late/random/reverse positions and finite stereo output.
- Extend `native/audio-host-macos/tests/audio_host_transaction_test.cpp` for real framed create/write/prepare/configure ordering, missing-range rejection, malformed page rejection and corrected retry. Use deterministic test-only syscall failure injection to prove lock failure and partial-lock rollback; no shipping test hook.
- Cover release while configured/voiced/retired, safe post-retirement release, duplicate owner removal, replacement, teardown and canceled preparation. Run `native/audio-host-macos/tests/realtime_callback_guard.test.ts`; demonstrate no new callback syscall/allocation/lock. Check lock-byte accounting, not RSS alone.
- **Exit:** a fully supplied mapped region configures/renders correctly, incomplete or un-lockable live assets never become ready, and cleanup returns owned lock bytes to zero.

### Phase 3: native live integration, budget policy and diagnostic replacement

- **Files:** `src/lib/desktop/native-playback-controller.ts`, `packages/audio-engine/src/live-native-projection.ts`, `src/lib/sampler-buffer-sync.ts`, `src/lib/drum-rack-buffer-sync.ts`, `src/lib/sampled-instrument-session.ts`, `src/lib/sampled-instrument-region-budget.ts` as needed for real native reservations; native diagnostic helper and its callers, including `src/components/Timeline.tsx`, only where obsolete wiring must be removed. Add one native runtime budget-policy helper rather than scattering constants.
- **Work:** after budget-policy approval, register instrument sources, map/page/prepare full regions before instrument configure and transaction commit, gate native readiness, remove single-install duration rejection, account renderer+native ownership and retain bounded errors. Use native-only policy values; no persisted/browser default change.
- **Size/risk:** 180-300 production + 180-300 test/journey lines; high, readiness, replacement and cancellation.
- **Existing proof files:** `src/lib/desktop/native-playback-controller.test.ts`, `src/lib/instrument-buffer-sync.test.ts`, `src/lib/sampled-instrument-region-budget.test.ts`, `packages/audio-engine/src/live-native-projection.test.ts`. Replace existing eight-second rejection expectations with successful mapped routing; preserve genuine over-budget failure expectations. Assert zero instrument `installAsset` calls and every payload at most 1 MiB.
- Extend real Chromium `src/lib/desktop/native-playback-lifecycle.browser.test.ts` and its existing runtime fixture for instrument-only sample loading, readiness, notes, replace/cancel/late ACK, Stop/Play and project-switch cleanup. This fixture uses a bridge harness, so it proves renderer lifecycle, not native audio. Pair it with Phase 2 native audio evidence.
- Re-run `src/lib/desktop/native-schedule-coordinator.test.ts` and existing live/scheduled admission and granular stealing regressions. Do not loosen admission to make loading pass.
- **Exit:** eight-second stereo sources work for all three instruments without timeline clips, browser behavior remains unchanged, and three-minute behavior matches approved native budgets rather than the IPC cap.

### Phase 4: native export instrument pages

- **Files:** `src/lib/export/native-offline-render-plan.ts`, `src/lib/export/run-export-job.ts`, `packages/audio-engine/src/portable-export-snapshot.ts`, shared region-source/policy helper from earlier phases. Only adjust `apps/desktop/audio-host.ts` if a demonstrated offline boundary needs it.
- **Work:** emit mapped instrument metadata/full-region ranges, register hydrated export providers without clips, retain leases until completion and avoid instrument PCM chunking. Validate complete pages before instrument configuration.
- **Size/risk:** 130-230 production + 160-260 test lines; medium-high, structured-clone boundaries, region identities and export/live memory overlap.
- **Existing proof files:** extend `src/lib/export/native-offline-render-plan.test.ts` mapped-source tests (`598`, `638`), `src/lib/export/run-export-job.test.ts` instrument-only local preload (`665`) and cancel (`344`), and `apps/desktop/audio-host.test.ts` bounded offline pages (`615`) and provider cancellation (`569`). Assert nonempty full instrument ranges, no whole-region PCM in plans, and no timeline-clip requirement.
- Extend `native/audio-host-macos/tests/audio_host_transaction_test.cpp`/`audio_host_test.cpp` for actual child-host/native offline output across all instrument kinds with page-delivered sources. Verify tail rendering, custom ranges, exact frame counts and deterministic sample comparisons; include provider failure and canceled export with no successful terminal.
- **Exit:** instrument-only MIDI projects export actual expected PCM from long samples; default portable export retains its existing PCM contract.

### Phase 5: packaged acceptance and regression gate

- **Files:** extend the acceptance infrastructure under `tools/acceptance/` with a focused native-instrument paging journey and WAV analyzer, reusing existing harness patterns; save report/artifacts under `acceptance-reports/native-instrument-sample-paging-<date>/`. Production changes only for proven defects. `tools/acceptance/README.md:10-20,25-40` documents disposable profiles, UI actions and ground-truth live PCM evidence.
- **Size/risk:** 250-450 harness/analysis lines plus evidence; medium. Packaging and app launch happen only in this later implementation phase with authorization, not during this planning task.
- **Required matrix:** granular, sampler, drum rack × 8-second and full 180-second stereo **48 kHz** sources × native live and native export = 12 success cells. Run instruments separately so the fixture does not accidentally require three concurrent 132 MiB working sets. Use approved native policy; do not trim or downsample the three-minute fixture to pass.
- Generate deterministic distinguishable left/right signals and sparse late-region markers; record source SHA-256, frames, sample rate, channels, crop and policy values. Load sources directly into devices without an audio timeline clip. Play live MIDI and scheduled notes.
- Sampler: one-shot progression, pitched playback, late loop and crossfade across page boundaries. Drum rack: full one-shot including the late marker, retrigger/choke behavior. Granular: fixed-seed position sweeps, maximum spray, reverse and freeze near beginning/middle/end; late positions must be audible, not merely “loaded”.
- Capture real post-master live PCM using existing acceptance infrastructure, not offline output presented as live proof. Export through the product dialog, complete Save, decode the output and verify channel content, frame count, finite/nonzero expected regions and late markers. Compare deterministic native reference renders with documented tolerance/alignment; no arbitrary nonzero-audio-only pass.
- Keep inline loading/error screenshots, transaction/page logs, maximum payload size, callback/xrun diagnostics, resident/locked-byte peaks, export WAVs and hashes, cleanup counters and a machine-readable cell-by-cell result. Repeat replace/remove, save/reopen, cancel midway, Stop/Play and live+export memory-pressure cases. Include deliberately oversized/lock-failure cases that recover without corrupting unrelated playback.
- **Exit:** all 12 cells pass, no sample-length IPC rejection, no missing late audio, no partial-success export, no leaked locks/leases. A 64 MiB policy failure must be reported as blocked acceptance, never recorded as successful paging.

### Commands for the implementation pass

From `/Users/juan/Documents/daw-browser-convex`, run focused test files listed per phase first, then:

```sh
bun run typecheck
bun run build
bun test src/lib/desktop/native-timeline-page-manager.test.ts src/lib/desktop/native-playback-controller.test.ts src/lib/desktop/native-schedule-coordinator.test.ts src/lib/instrument-buffer-sync.test.ts src/lib/sampled-instrument-region-budget.test.ts
bun test src/lib/export/native-offline-render-plan.test.ts src/lib/export/run-export-job.test.ts apps/desktop/audio-host.test.ts
bun test packages/audio-engine/src/live-native-projection.test.ts packages/audio-engine/src/portable-export-snapshot.test.ts packages/audio-engine/src/native-pcm-chunking.test.ts
bun test src/lib/desktop/native-playback-lifecycle.browser.test.ts --timeout 120000
bun test native/audio-host-macos/tests/realtime_callback_guard.test.ts
sh native/audio-core/scripts/test-native.sh
cmake --build native/build/audio-host-macos-debug -j 4
ctest --test-dir native/build/audio-host-macos-debug --output-on-failure --timeout 900
```

Confirm the existing native build directory/toolchain before using it. The core script runs its generation check, build and CTest (`native/audio-core/scripts/test-native.sh:9-12`). Run targeted Oxlint and `git diff --check` on changed files. Browser fixtures may start their own test infrastructure; do not independently start a dev server. Preserve unrelated working-tree changes and report environmental or pre-existing failures accurately.

## 7. Risks and open product decisions

1. **Budget approval, required:** approve the recommended native-only limits/accounting so 180-second 48 kHz stereo succeeds in granular and drum rack. Keeping 64 MiB unchanged is incompatible with the requested full-region fixture. This is not resolved by a protocol change.
2. **Residency tradeoff, required:** approve fail-before-ready when OS locking fails. `mlock` limits and practical lockable memory must be tested on supported macOS configurations without privilege changes. If this fails materially on target machines, stop at this gate and redesign explicitly; advisory prefetch cannot be relabeled as a guarantee.
3. **Export overlap UX:** recommended policy preserves existing live resources and gives an actionable export memory error instead of silently stopping playback. Decide if an explicit “release live samples and retry” action is desired later; no new UI action is required for the initial implementation.
4. **Lifetime and updates:** configured sampler zones retain asset references even without voices; granular grains/release tails and retired graphs can outlive the visible device. Conservative session-duration locks are correct but may increase replacement pressure. Safe incremental reclamation needs native retirement proof, not optimistic renderer cache eviction.
5. **Mapping mutation and sharing:** full-region immutable publication must not race existing timeline uploads. Shared regional assets need consistent source identity and ownership; otherwise use distinct region IDs. Avoid making repeated identical writes to callback-visible memory.
6. **Performance:** eager full-region native loading increases initial preparation latency and temporary disk-backed storage. Bound decoder concurrency and transfer staging, retain cancellation, and show honest loading. Several minutes is supported within memory policy, not an unlimited-duration promise.
7. **Compatibility:** keep portable defaults, the 1 MiB payload bound, core ABI and event-admission/voice-stealing behavior unchanged. Native errors must remain useful after removing the obsolete duration diagnostic.

## Planning verification

Read-only source tracing completed; only this plan document is written by this task. No source implementation, tests/builds, packaging, app launch, dev server, commits or subagents were run. Test cases above are proposed work, not claimed passing results.

## Phase 1 implementation

Implemented the decoded-region provider seam without switching native call sites or changing default projection/export behavior.

- `packages/audio-engine/src/live-native-projection.ts`: added the explicit `instrumentRegionMode: 'metadata'` opt-in. In this mode sampled-instrument assets keep their existing metadata/asset IDs but omit copied planar PCM. The successful projection also exposes `instrumentRegionSources`, an array of `{ sourceAssetKey, buffer }` references using the already-localized region identity. Sampler zones, drum-rack pads and granular regions share one indexed collection; repeated matching identities deduplicate and dimension conflicts reject the projection. Default mode retains its previous PCM materialization and size validation.
- `packages/audio-engine/src/portable-export-snapshot.ts`: added the same opt-in and source association after the existing instrument localization. Default portable compilation still materializes transferable PCM. Metadata mode emits metadata-only assets and exact region buffer references.
- `src/lib/desktop/native-timeline-page-manager.ts`: no production change was needed; its existing descriptor shape accepts these eager AudioBuffers. `src/lib/desktop/native-timeline-page-manager.test.ts` now proves full-region paging is capped at 16,384 frames and within the mapped payload limit.
- `packages/audio-engine/src/live-native-projection.test.ts` and `portable-export-snapshot.test.ts`: cover instrument-only sources without timeline clips, metadata-only output versus unchanged portable PCM, stable repeated-region references, and inconsistent dimensions for a shared identity.

**Phase 3 consumer shape:** pass `instrumentRegionMode: 'metadata'` at the native projection/snapshot call site, register each `instrumentRegionSources` entry as a `NativeTimelineSource` with `sourceAssetKey`, session asset ID, buffer dimensions, and a `createAudioPcmSourceDescriptor({ source: buffer, ... })` descriptor. The projected/snapshot asset metadata supplies the matching frame count, sample rate, and channel count. Then use the existing `NativeTimelinePageManager.ensureRanges` with full-region `[0, frameCount)` coverage. This phase deliberately does not alter call sites or native readiness.

**Validation:** focused tests passed (44 tests); `bun test packages/audio-engine` passed (680 tests); `bun test src/lib/desktop/native-timeline-page-manager.test.ts` passed (14 tests); `bun run typecheck` passed; targeted Oxlint passed (0 warnings/errors); `git diff --check` passed. No build, app launch, packaging, native test, or behavior-switch validation was run, as those are outside Phase 1.

## Phase 2 implementation

Implemented native mapped-instrument coverage and resident lifetime. Preserved the core, generic timeline advisory prepare, offline no-lock path, unrelated admission/filtered-processing/granular-stealing changes, and Phase 1 work.

### Lock and admission model

- `native/audio-host-macos/src/audio-host.cpp:46,1351`: calculate the native resident allowance once per host from `hw.memsize / 8`, failing closed if physical memory cannot be read. Here this is 2,415,919,104 bytes (2.25 GiB). Each device also has a 1 GiB unique decoded-region ceiling. This is the native-copy backstop: Phase 3 must still charge renderer decoded PCM separately and coordinate combined session/export/replacement overlap using the approved shared policy.
- `audio-host.cpp:2317`: validate the entire candidate batch on a disposable, non-rendering validation core using the existing authoritative core state/zone validators. Remap handles rather than assuming generations or asset-slot order match. Every mapped candidate must have complete coalesced written coverage of `[0, frameCount)` before changing target states or locking memory.
- `audio-host.cpp:2477`: admit unique OS-page-rounded bytes, including existing retained locks, before checked control-thread `mlock` on full mappings. Shared owners do not double-charge. Lock failure unlocks the failed range and rolls back all newly acquired locks, preserving existing locks. A subsequent prepared-bank configure failure cancels that bank before unlocking. The legacy active-core failure path conservatively retains candidate owners/locks because its API cannot undo a partially applied batch.
- `audio-host.cpp:1313,1466,3783`: mapped-storage RAII unlocks before unmapping/closing. Successful locks remain until safe asset release or teardown, including cancelled prepares and replacement overlap. Per-node published/prepared host ownership additionally prevents release of configured granular data before its first note, which the current core alone does not protect. Existing queued-control, prepared/retired-plan, voice/grain, and core release checks remain intact.
- `audio-host.cpp:3699`: reject writes to resident or configured instrument mappings, including offline configured data. Generic timeline preparation is unchanged. The realtime callback is unchanged and gains no allocation, syscall, or lock.

### Phase 3 error and diagnostics surface

- `native/audio-host-macos/include/daw/audio_host_macos.h:542`: control-thread queries `instrumentLockedBytes()`, `instrumentResidentBudgetBytes()`, and `instrumentPreparationError()` expose owned locks, native allowance, and configuration failure. Lock-byte queries are host APIs, not new serialized diagnostic fields.
- `native/audio-host-macos/src/main.cpp:111,1081`: failed instrument-state ACKs retain the existing two big-endian integers and append at most 256 UTF-8 error bytes. Successful ACKs and other requests keep their existing shape. Causes include **“memory locking unavailable”**, **“sample memory budget exceeded”**, and incomplete upload with a retry instruction.
- `apps/desktop/audio-host.ts:969,2081`: bounded ACK error decoding preserves native text in live `NativeAudioHostCommandError.message` and offline errors. Phase 3 should display that rejection in the device pane and keep the device unready. No opcode, core ABI, or instrument-state wire change was added.

### Native integration proof

- `native/audio-host-macos/tests/audio_host_test.cpp:1276`: missing range, nonfinite malformed page, corrected retry, invalid second candidate, injected first-/second-lock failure and full rollback, deduplicated retry, cancellation plus release, native budget exhaustion, sparse >1 GiB device rejection, offline no-lock success with lock failure armed, and zero-byte cleanup.
- `audio_host_test.cpp:1361`: two configured granular nodes share one lock; removing one owner cannot release the other. Removing both permits release. Teardown of still-resident prepared data returns owned bytes to zero.
- `audio_host_test.cpp:1404`: sampler, drum rack, and three seeded granular position/reverse cases render page-written **300,000-frame stereo assets**, beyond both legacy host and IPC ceilings. Every output sample matches a direct-core contiguous-vector PCM reference exactly. Sampler/drum crossfade loops cross a 16,384-frame page seam; granular covers late/random-spray and forward/reverse/mixed directions. Output is finite and audible. Configured/voiced/retired release rejection, replacement reuse and final post-retirement release also pass.
- `native/audio-host-macos/tests/audio_host_transaction_test.cpp:279`: real child-host framed create/write/prepare/configure ordering, premature prepare/configure rejection with actionable text, malformed page rejection, corrected upload/retry, and post-configuration write rejection.
- `native/audio-host-macos/CMakeLists.txt:44`: a private test translation unit defines `DAW_AUDIO_HOST_TEST_MEMORY_LOCK`, following the existing private-core fault-injection pattern. Production runtime/host do not define it. `nm` confirmed no host/core test injection symbols in the shipping host executable.

### Observed macOS limits

`hw.memsize = 19,327,352,832` bytes (18 GiB); `vm.user_wire_limit = 14,688,788,152` bytes; `RLIMIT_MEMLOCK` soft/hard = `9,223,372,036,854,775,807` (shell: unlimited); OS page size = 16,384 bytes. After checking memory headroom, an isolated anonymous **1 GiB actual `mlock` succeeded** (`0`, errno `0`); immediate `munlock` returned `0` and the mapping was closed. No privileges or limits changed. This is single-machine feasibility evidence, not a supported-machine guarantee.

### Validation

- Confirmed the existing native build directory before building.
- `cmake --build native/build/audio-host-macos-debug -j 4`: passed.
- `ctest --test-dir native/build/audio-host-macos-debug --output-on-failure --timeout 900`: passed, 8/8 (final run 85.33 seconds). Focused final residency/render tests also passed after the last teardown assertion.
- `sh native/audio-core/scripts/test-native.sh`: passed generation check, build and 1/1 core CTest. Phase 2 edited no `native/audio-core/**` files.
- `bun test native/audio-host-macos/tests/realtime_callback_guard.test.ts apps/desktop/audio-host.test.ts`: passed, 75 tests, 0 failures.
- `bun run typecheck`: passed all package, app and API checks.
- Targeted Oxlint on `apps/desktop/audio-host.ts`: passed, 0 warnings/errors. `git diff --check`: passed.
- Reviewed ownership, rollback, scope, and duplication. Authoritative state validation remains in the core rather than being copied into host predicates; locks and accounting remain mapped-asset-owned. No app launch, packaging, dev server, commit, or subagent was used.

## Phase 2 review fixes

Applied Sol r1's residency review fixes without changing the existing admission,
filtered-process, granular-stealing, or concurrent Phase 1 work.

### Correctness and compatibility

- `native/audio-core/include/daw/audio_core_native.h:15` and
  `native/audio-core/src/audio_core.cpp:5896`: added three native-only,
  allocation-free `ValidateInstrumentState` overloads. They check the exact
  instrument kind in the selected prepared/published graph and reuse
  `valid_synth_state`, `valid_sampler_state`, `valid_sample_zone`, and
  `valid_granular_state`. They do not modify configuration or runtime ownership.
  The small addition is behind `DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS`;
  `audio_core.h`, the portable/Wasm ABI, and portable setters are unchanged.
- `native/audio-host-macos/src/audio-host.cpp:2316`: validate the complete batch
  directly against the target core before locking or configuring. Removed the
  disposable core, graph reconstruction, asset-handle remapping, and now-unused
  published graph byte copy. A synth record targeting a granular node now fails
  before replacing its sample owners. Sampler and drum-rack record kinds must
  also match exactly, despite sharing a configure setter.
- `native/audio-host-macos/tests/audio_host_test.cpp:1409`: the existing shared
  granular residency fixture rejects mismatched synth records and preserves
  locked bytes/release rejection, including after removing the other owner.
  Clearing the actual remaining granular state still permits release.
- `native/audio-host-macos/src/audio-host.cpp:4441`: removed Teardown's
  zero-core early return, so asset/owner cleanup still runs after Retire destroys
  the last core. `audio_host_test.cpp:1433` configures a resident mapping,
  publishes, retires, then tears down and asserts zero locked bytes.
- `audio-host.cpp:2489`: the prepared-bank fallback comment now states that
  current setters cannot exhaust capacity after successful validation.
  The separate active-core comment explains the absence of a cancel API and
  conservative retention, not a reachable capacity failure.
- `native/audio-host-macos/src/main.cpp:118`: documented co-shipped packaged
  host/renderer ACK compatibility. Development has an explicit
  `DAW_AUDIO_HOST_PATH` override (`apps/desktop/main.ts:2481`;
  `apps/desktop/audio-host.ts:1152`), which can select an old executable.
  This development-only mixed-build caveat is reported here; no negotiation
  was invented. Packaged startup uses verified bundled artifacts instead
  (`apps/desktop/main.ts:2462`).

### Validation cost, before and after

`native/audio-host-macos/tests/audio_host_test.cpp:1446` retains a repeatable
opt-in benchmark:

```sh
DAW_PHASE2_VALIDATION_BENCHMARK=1 native/build/audio-host-macos-debug/audio-host-macos/daw-audio-host-macos-test
```

Measured the Debug build with maximum host record count (64), maximum zones per
record (32, 2,048 total), 63 sampler nodes plus master, maximum 8,192-frame
stereo blocks, one shared fully uploaded 300,000-frame stereo asset, and 20
configure calls including the first call. The 64th record repeats a node.
Offline mode isolates validation/configuration from upload and `mlock`.
Memory uses `malloc_zone_statistics` and `MACH_TASK_BASIC_INFO` immediately
before and after validation; the table gives the largest simultaneous observed
increase, not a continuously sampled allocator/kernel peak or a bound on OS
locking latency. These are worst observed configure times for this
maximum-record/zone workload, not a universal realtime deadline.

| Measurement | Disposable validation core | Native validation overloads |
| --- | ---: | ---: |
| Mean configure latency | 4.303 ms | 0.984 ms |
| Worst observed configure latency | 21.467 ms | 1.132 ms |
| Peak simultaneous validation C++ heap allocations | 193,710,688 B | 8,096 B |
| Validation-boundary heap bytes added | 191,981,984 B | 8,048 B |
| Validation-boundary resident bytes added | 192,397,312 B | 32,768 B |

For the transient peak row, a separate temporary executable interposed C++
`new`/`new[]` (throwing and nothrow) and `delete` during the exact validation
interval, tracking simultaneous live allocations by pointer and `malloc_size`.
All 20 calls measured 193,710,688 B before versus 8,096 B after. This captures
temporary graph-preparation storage that boundary snapshots miss. It does not
claim an exact OS physical-memory peak. The probe used preallocated thread-local
bookkeeping and did not modify shipping code. Source and logs remain at
`/tmp/phase2-allocation-peak.cpp`, `/tmp/phase2-instrumented-test.cpp`,
`/tmp/phase2-instrumented-baseline-host.cpp`, and
`/tmp/phase2-peak-{before,after}.log`; run
`DAW_PHASE2_VALIDATION_BENCHMARK=1 /tmp/phase2-peak-before` or
`/tmp/phase2-peak-after` to repeat. Latencies in the table are from the
non-interposed benchmark, not allocator-instrumented timings.

The core config only controls processing capacities; `Core` embeds large fixed
arrays (`native/audio-core/src/audio_core.cpp:595`). Lowering capacities would
not remove that allocation. The new native validators allocate no core or
auxiliary DSP storage; the remaining measured heap bytes are bounded host
candidate/ownership bookkeeping. Existing resident-byte admission, checked
locking, shared accounting, and partial-lock rollback remain intact. The
measurement hook is compiled only into the private test translation unit;
`nm` found no measurement hook in the shipping host executable.

### Validation results

- `cmake --build native/build/audio-host-macos-debug -j 4`: passed.
- `ctest --test-dir native/build/audio-host-macos-debug --output-on-failure --timeout 900`:
  passed, 8/8, 93.78 seconds, including ownership, retirement, rollback,
  resident audio rendering, framed ACK errors, and callback guards.
- `sh native/audio-core/scripts/test-native.sh`: passed generation check,
  build, and 1/1 CTest (82.51 seconds).
- `sh native/audio-core/scripts/build-wasm.sh` and
  `bun test native/audio-core/tests/wasm_artifact.test.ts`: passed, 15 tests.
  Regenerated production Wasm is byte-identical to the pre-fix working-tree
  binary, SHA-256
  `7ea395679142a1a96d3e6057643e4a682995d8695156517027954f1cba4bf364`.
  Only the generated manifest source hash changes for this fix.
- The current working tree contains **195**, not 194, parity fixtures
  (180 rendered, 15 rejected). Built a temporary pre-fix native reference by
  omitting only the new native validation block, preserving all older core
  changes. All 195 before/after exit codes and output byte buffers match
  exactly. Existing native/Wasm tolerance-based parity checks also pass.
- `bun test native/audio-host-macos/tests/realtime_callback_guard.test.ts apps/desktop/audio-host.test.ts`:
  passed, 75 tests, 0 failures.
- `bun run typecheck`: **blocked**, twice, by errors in the concurrently edited,
  explicitly excluded `packages/audio-engine/src/live-native-projection.test.ts`
  and `portable-export-snapshot.test.ts`. Final errors include playback-mode
  typing, optional/readonly expectation typing, missing granular buffer fields,
  and instrument-state union narrowing. No excluded files were edited.
  The package-check failure prevents the command's subsequent root/API checks.
- `git diff --check`: passed.

Reviewed the focused implementation for ownership, rollback, duplicate
validation, unused state, and scope. No callback changes, TS casts, new unit-test
framework, subagents, commits, packaging, application launch, or dev server.

## Phase 1 review fixes

- Metadata-mode instrument regions now validate registered frame count, sample
  rate, and channel count before changing asset/source registries. Asset-ID
  indices are tracked in a `Map`, avoiding repeated scans during insert/replace.
- Extended the existing live and portable snapshot tests for sampler, drum rack,
  and granular localized regions, explicit region identities, distinct PCM,
  shared-region deduplication, dimension conflicts, localized loop bounds, and
  unchanged default PCM/transferable behavior.
- Validation passed: focused projection/snapshot tests (33), audio-engine
  package tests (683), native timeline page-manager tests (14), repository
  typecheck, targeted Oxlint, and `git diff --check`.

## Phase 2 review fixes r2

- Chose **(a), existing rollback**, not duplicated runtime admission.
  `native/audio-host-macos/src/audio-host.cpp:2489` cancels the entire prepared
  bank before unlocking only newly acquired mappings. Rollback (`:2641`) clears
  prepared handles/owners without changing published owners; core cancellation
  (`native/audio-core/src/audio_core.cpp:7147`) releases prepared slots, not
  active slots/configuration. Earlier locks and accounting stay unchanged.
  Cancellation intentionally discards the entire unpublished revision.
- `audio-host.cpp:2439` reports capacity failure with an actionable “let audio
  transitions finish, then prepare and retry” error. Corrected the false claim
  that validation excludes capacity failure. Active-core setters
  (`audio_core.cpp:7501,7523,7559`) update existing runtime directly and return OK
  without calling `refresh_prepared_node`, so this capacity error is unreachable.
- `native/audio-host-macos/tests/audio_host_test.cpp:1446` adds one regression:
  fill eight unfinished replacement blends; configure node 2 with a newly locked
  asset before node 1 fails; verify cancellation, unchanged locked bytes, both
  original owners surviving, and candidate release (no partial ownership).
  Active-core configuration succeeds at saturation. After four rendered blocks
  finish the blends, reprepare/configure/publish succeeds; teardown unlocks all.
- Removed the unread `prepared_graph_payload` member, assignment and all clears
  from `audio-host.cpp`; preparation uses the payload directly (`:2216`).
  Reviewed scope, ownership and unused state. No core files or
  `packages/audio-engine/**` were edited in this round.

Validation:

- `cmake --build native/build/audio-host-macos-debug -j 4`: passed.
- `ctest --test-dir native/build/audio-host-macos-debug --output-on-failure --timeout 900`:
  **8/8 passed**, 82.36 seconds.
- `bun test native/audio-host-macos/tests/realtime_callback_guard.test.ts apps/desktop/audio-host.test.ts`:
  **75 passed**, 0 failed.
- `git diff --check`: passed.
- Core-only scripts, Wasm rebuild/artifact tests and byte-identical parity
  comparison were not rerun because this round changes no core files/fixtures.
  Full host CTest includes the existing core suite (passed).
- Two development runs failed on regression setup (missing transport preparation,
  then the recreated asset's advanced handle generation). Both were corrected;
  the focused executable and final full suite pass.

## Phase 3 implementation

Implemented native live region paging, native-only memory admission, and
decoded-versus-native readiness. Phase 4 export routing is unchanged.
The starting dirty tree was preserved, including accepted Phase 1/2 work.

### Runtime policy and accounting

- `src/lib/desktop/native-instrument-budget-policy.ts:5-13` is the single
  TypeScript runtime policy helper: **1,073,741,824 decoded bytes per device**,
  and **floor(total physical memory / 8)** combined bytes. On the Phase 2
  18 GiB machine this is **2,415,919,104 bytes (2.25 GiB)**. It matches the
  existing host's `hw.memsize / 8` and 1 GiB admission backstop; an existing-file
  regression checks both native constants against the runtime calculation.
- `apps/desktop/main.ts:2310` passes `os.totalmem()` through the sandboxed
  renderer's startup arguments; `apps/desktop/preload.ts:353` computes and exposes
  the policy once. No renderer Node integration or new mutation IPC is added.
  Missing system-memory policy fails closed, not back to a fixed desktop cap.
- `src/lib/sampled-instrument-session.ts:31-55` shares the aggregate between
  decoded caches, native live preparation, and existing export scopes.
  `src/components/Timeline.tsx:269-271,712-713` explicitly selects native policy
  and connects native preparation status. Browser/default serialized budgets
  remain unchanged.
- `src/lib/desktop/native-playback-controller.ts:1194-1223` validates unique
  decoded region bytes per instrument, leases renderer PCM once per physical
  AudioBuffer, separately pins each native mapping's **16 KiB-rounded** bytes
  (the supported Apple Silicon host), and reserves **2 MiB** for bounded
  two-decoder page staging until full preparation completes.
- `src/lib/sampled-instrument-region-budget.ts:50,260-270,443` adds an explicit
  native-only physical-registration protection flag to leases. A native owner
  prevents eviction of another cache registration for the same physical PCM.
  Old/new buffers, retained mappings, and existing export leases remain charged
  independently; no audible owner is evicted to admit a replacement. Default
  portable lease eviction behavior is unchanged.
- `src/lib/sampler-buffer-sync.ts:110,343,486,563` and
  `src/lib/drum-rack-buffer-sync.ts:66,248` apply the native 1 GiB decoded ceiling.
  Native sampler preparation eagerly resolves even on-demand zones before
  publication. Native granular loading does not allocate a second browser
  worklet copy or accidentally apply its portable 64 MiB admission.

### Registration, readiness, and lifetime

- `src/lib/desktop/native-playback-controller.ts:1169,1193,1279` explicitly selects
  metadata projection and resolves exact localized instrument-region providers
  before snapshot/clip fallbacks, using indexed source and session asset Maps.
  Instruments need no timeline audio clip and use the existing descriptor/page
  transport, not another splitter or copied whole-region PCM.
- `native-playback-controller.ts:1356-1381` creates mappings, uploads and prepares
  **[0, frameCount)**, then publishes the transaction's graph and configures
  instruments. Configuration ACK includes Phase 2 coverage/locking admission.
  Commit and session/schedule startup precede native-ready status. Failed
  preparation/configuration never admits notes.
- `src/lib/desktop/native-timeline-page-manager.ts:20,127,487-509` protects fully
  prepared immutable instrument mappings independently of the 128-page hint
  cache. Shared later timeline coverage cannot rewrite a resident instrument;
  lost prepared coverage fails with a reload instruction instead.
- `native-playback-controller.ts:345-352,719,786-813,1425,1509-1547,1688` retains
  leases through native ownership, cancellation, late ACKs, and host retirement.
  Rollback after successful configuration additionally tears down retained
  Phase 2 locks. Failed teardown keeps its accounting until successful teardown
  or host loss. Stop/Play reuses a valid prepared session; replacement and project
  switch drain page operations and retire old resources. Both project identity
  and generation guard asynchronous ownership.
- `native-playback-controller.ts:2396,2435` discards sampled notes pressed during
  preparation instead of playing an accumulated burst after loading.
  Synth admission behavior and core event/voice-stealing limits are unchanged.

### Diagnostic removal and audited consumers

- Deleted `src/lib/native-instrument-sample-diagnostic.ts`, whose only production
  consumer was `src/lib/sampler-buffer-sync.ts` (sampler and granular).
  Drum rack had no direct diagnostic-helper caller. Removed the whole-install
  duration rejection in `packages/audio-engine/src/live-native-projection.ts`.
  Source search confirms no remaining runtime helper import or desktop-duration
  message. Historical acceptance reports are intentionally retained.
- Kept `nativeAudio` wiring because it now selects real native admission and
  readiness, rather than deleting a still-needed boundary.
  `sampler-buffer-sync.ts:605,672-690` overlays loading/error/native-ready status
  on existing sampler and granular pane surfaces, preserving native ACK text.
  `src/components/timeline/create-effects-panel-state.ts:166-168,621`,
  `EffectsPanel.tsx:289`, and `src/components/effects/DrumRack.tsx:278` add the
  corresponding subscribed inline drum-rack status. Empty racks do not claim
  to be loading. Genuine memory, missing-source, invalid-channel and residency
  failures remain errors; native aggregate errors include a retry instruction.
- Stale decode failures cannot overwrite replacement status. Reapplying
  unchanged region identities preserves native status instead of leaving
  parameter edits permanently loading.

### Tests and validation

- Focused plan command (page manager, controller, schedule coordinator, buffer
  sync, budget): **184 passed**, including **14/14 budget tests** and host-policy
  alignment. All instrument kinds route eight-second
  stereo sources with **zero instrument installs** and sub-1-MiB page payloads.
  Tests also cover complete 180-second 48 kHz granular routing, native granular/
  drum loading above 64 MiB, unchanged portable caps, sparse >1 GiB rejection,
  aggregate pressure, late instrument-state ACK cancellation, and immutable
  region/cache ownership.
- `bun test packages/audio-engine`: **683 passed**.
  Projection/snapshot/chunking plus playback-hook compatibility:
  **148 passed, 2 existing skips** (full engine tests also cover these packages).
- Export-plan/export-job/desktop-host/callback-guard command: **112 passed**.
  No export production file, host native file, core ABI, admission policy,
  granular stealing implementation, Wasm binary, or persisted default changed.
- `bun test src/lib/desktop`: **235 passed**, including Chromium.
  Explicit `bun test src/lib/desktop/native-playback-lifecycle.browser.test.ts
  --timeout 120000`: **2 passed**, 387 assertions. The added journey covers all
  three instrument-only sources, loading/no delayed notes, ready/live notes,
  replacement, held-page cancellation, late Commit, Stop/Play and project switch.
  Evidence: `acceptance-reports/native-running-seek-b339e36c-607f-4469-a162-6c7d3d17fd2c/paging-*.json`.
  This is renderer lifecycle proof with an emulated bridge, not audible native
  output; Phase 2 supplies native rendering evidence.
- `bun run typecheck`, `bun run build`, targeted Oxlint (24 changed TS/TSX files),
  and `git diff --check`: passed. Standalone preload bundling also passed.
- `sh native/audio-core/scripts/test-native.sh`: generation/build passed and
  **1/1 CTest passed** (77.01 s), including admission and stealing regressions.
  Host rebuild/CTest was not rerun because Phase 3 changes no native files.
- During development, initial fixture identity/order expectations, abort
  rejection compatibility, and two missing fixture instance IDs failed checks;
  corrected before final passing validation. Existing build/dependency warnings
  were not treated as test failures or fixed outside this scope.

### Remaining Phase 4/5 gaps

- Phase 4 still needs explicit native export metadata routing, instrument-only
  full-region export ranges/providers, offline page failure/cancellation tests,
  and native export allocation accounting using this same policy/aggregate.
  Existing portable and native export behavior was deliberately preserved.
- Phase 5 still needs authorized packaging/app launch and the full 12-cell
  native live/export matrix with real post-master PCM, late markers, saved WAVs,
  screenshots, locked-byte/xrun peaks, and supported-machine lock-failure proof.
  Chromium bridge traces do not substitute for those acceptance artifacts.
- Reviewed scope, ownership, simpler alternatives, dead code, duplication, and
  Solid status subscriptions. No subagents, commit, packaging, application
  launch, independent dev server, stash, reset, or process-wide kill was used.

## Phase 3 review fixes

- `src/lib/sampler-buffer-sync.ts:649-710`: sampler and granular Retry now clear
  native error status and return the pane to loading before retrying decode.
  Successful decode invokes the retry callback, which rebuilds native playback
  and only reaches ready after native preparation/configuration succeeds.
  The callback is wired through `src/components/Timeline.tsx:2438-2447`,
  `src/components/timeline/EffectsPanel.tsx:1113-1137`, and the effects-panel
  controller/state. Drum Rack has no Retry path or control.
- `src/lib/desktop/native-playback-controller.ts:1434-1441`: cancellation after
  Commit releases the attempt scope only when native teardown acknowledges
  success; failed or unresolved teardown retains accounting. Regression:
  `native-playback-controller.test.ts:899-928` holds Commit and checks budget
  accounting returns to zero after one teardown.
- `native-playback-controller.ts:335,854,1531-1536`: preparation error status
  checks the originating attempt identity and project ID/generation again after
  cleanup. Regression `native-playback-controller.test.ts:930-957` changes the
  project while teardown is held and confirms the old error is not published.
- `src/lib/instrument-buffer-sync.test.ts:949-977` verifies sampler pane status
  through failure, Retry, native preparation, and ready. No Drum Rack Retry test
  applies because that UI has no retry action.
- Validation passed: `bun run typecheck`; `bun test src/lib/desktop` (237);
  `bun test src/lib/instrument-buffer-sync.test.ts
  src/lib/sampled-instrument-region-budget.test.ts` (41);
  `bun test src/lib/desktop/native-playback-lifecycle.browser.test.ts
  --timeout 120000` (2); `bun test packages/audio-engine` (683);
  targeted Oxlint on 9 changed source files (0 warnings/errors); and
  `git diff --check`.

## Phase 3 review fixes r2

- `src/lib/desktop/native-playback-controller.ts:336,826,857,1536,1570,1681,1740` adds a preparation-request invalidation token. Cancellation and replacement advance it before asynchronous cleanup, and the failure path rechecks it after teardown. The regression at `native-playback-controller.test.ts:990-1028` queues a same-project replacement while teardown is held and verifies the old error is not published.
- `src/lib/sampler-buffer-sync.ts:665-748` captures project, version, and instrument identity for sampler and granular Retry, revalidates them after decode, and passes the originating identity to the rebuild callback. Forced granular Retry decodes again instead of resolving from the prior cache. `src/components/Timeline.tsx:2439-2449` refuses rebuild when the originating project is no longer mounted and passes that project identity into the rebuild intent. `instrument-buffer-sync.test.ts:979-1018` holds Retry during a same-track replacement and project switch and verifies no callback rebuild occurs.
- The sampler Retry handshake is exercised in `src/lib/desktop/native-playback-controller.test.ts:815-844`: after a preparation failure, Retry runs a fresh native preparation, verifies its ACK precedes Commit, and checks ready is published only after the committed start.
- `src/lib/drum-rack-buffer-sync.ts:374-407` adds a decode-and-prepare retry using the same guarded callback. `src/components/timeline/create-effects-panel-state.ts:628-640` connects it, and `src/components/effects/DrumRack.tsx:279-296` shows a themed Retry action only for native errors. Regression coverage is in `instrument-buffer-sync.test.ts:1021-1055` and `create-effects-panel-device-collapse.test.ts:67-96`.

Validation passed:

- `bun run typecheck`
- `bun test src/lib/desktop`: **239 passed**
- `bun test src/lib/instrument-buffer-sync.test.ts src/lib/sampled-instrument-region-budget.test.ts`: **43 passed**
- `bun test src/lib/desktop/native-playback-lifecycle.browser.test.ts --timeout 120000`: **2 passed**
- `bun test packages/audio-engine`: **683 passed**
- `bun test src/components/timeline/create-effects-panel-device-collapse.test.ts`: **6 passed**
- Oxlint on 12 changed source/test files: **0 warnings, 0 errors**
- `git diff --check`

## Phase 3 review fixes r3

- `src/lib/desktop/native-playback-controller.test.ts:816-907` now runs the
  sampler Retry via `retryZone` and its injected native rebuild callback. It
  independently holds native preparation and Commit, verifies the sampler pane
  stays loading at both barriers, and observes ready only after successful
  Commit.
- `src/lib/instrument-buffer-sync.test.ts:949-977,1011-1084` starts granular
  retries from an uncached failed decode, separately tests a same-project
  replacement device and a project switch, and awaits the returned retry
  promise instead of relying on `Bun.sleep(0)`. `src/lib/sampler-buffer-sync.ts:710-739`
  returns that retry promise so completion is deterministic; no new hook was
  added.
- Mutation checks: temporarily removed granular Retry identity revalidation,
  and the project-switch regression failed because the stale callback rebuilt.
  Temporarily published native ready before Commit, and the sampler Retry
  regression failed at its held-Commit assertion. Both guards were restored.
- `src/components/effects/DrumRack.tsx:279-297` now uses the same clickable
  status-label structure and error presentation as Sampler and Granular rather
  than an underlined Retry label. The existing device-collapse test now checks
  this markup.

Validation passed:

- `bun run typecheck`
- `bun test src/lib/desktop`: **239 passed**
- `bun test src/lib/instrument-buffer-sync.test.ts src/lib/sampled-instrument-region-budget.test.ts`: **44 passed**
- `bun test src/components/timeline/create-effects-panel-device-collapse.test.ts`: **6 passed**
- Oxlint on 5 changed source/test files: **0 warnings, 0 errors**
- `git diff --check`

## Phase 4 implementation

Implemented native export instrument paging. Preserved the starting dirty tree,
including accepted Phases 1–3 and their review fixes.

### Snapshot, ranges, providers and transport

- `src/lib/export/native-offline-render-plan.ts:82-126,269-288,309-340` explicitly
  compiles native export with instrument metadata, indexes timeline coverage by
  asset ID, unions complete instrument `[0, frameCount)` coverage, and merges
  overlapping/shared ranges. Instrument-only assets survive without a clip or
  source event. Instrument assets bypass timeline PCM chunking; its protective
  oversized-instrument rejection remains unchanged.
- `native-offline-render-plan.ts:227,284` hands exact localized regional
  AudioBuffer references to a renderer-local registration callback. Buffers never
  enter the structured-cloneable render plan. Default portable compilation and
  transferable PCM contracts are unchanged; no audio-engine production file or
  portable binary was edited.
- `src/lib/export/run-export-job.ts:1019,1161,1226-1288` registers descriptors
  from those exact hydrated export buffers before indexed timeline fallbacks,
  using the existing `NativeTimelinePageManager`. `:1299-1317` checks requested
  identity/dimensions and returned session identity. `:912-944,1093-1116` drains
  sibling preparation/decode work before scope cleanup, including failures and
  cancellation. `:1467-1468` releases scope ownership and regional registrations
  after page-manager disposal and spool/output cleanup.
- `apps/desktop/audio-host.ts:1002-1077` reuses existing mapping/page/ACK/prepare
  ordering: each page is at most 16,384 frames and payload capacity; graph and
  instrument configuration follow successful complete preparation. No second
  page splitter, native protocol, core reader or residency path was introduced.
  Offline coverage remains mandatory and needs no memory lock.

### Export accounting and actionable errors

- `src/lib/export/run-export-job.ts:723,800-889` uses the Phase 3 shared native
  **1 GiB per-device decoded** ceiling, not portable granular/drum defaults.
  Existing export scopes come from the same sampled-instrument session aggregate
  (**floor(system physical memory / 8)**), including simultaneous live scopes.
- Physical renderer PCM is leased once per AudioBuffer; repeated regions share
  that charge. Each unique export regional identity separately charges a
  **16 KiB-rounded child-host mapping**. Live mappings remain independent.
  **2 MiB bounded staging** is conservatively held through scope release.
  Existing and newly decoded native buffers receive physical-protection leases;
  native mappings/staging are scope-pinned. No audible owner is evicted.
- `src/lib/export/timeline-export-service.ts:207-219` changes native snapshot
  leases to one physical renderer copy with protection, retaining the portable
  granular worklet mirror accounting on portable exports. This avoids charging
  an imaginary native worklet copy in addition to the real offline mapping.
- Admission fails before creating an output target with:
  **“Not enough sample memory for native export while live samples are retained.
  Shorten sample regions or explicitly release live instruments, then retry.
  Live playback was preserved.”** Missing scope accounting fails closed with a
  desktop-audio restart/retry instruction. Device ceiling errors retain the
  decoded-byte limit.
- `apps/desktop/audio-host.ts:970-980` preserves native failed-ACK text. A legacy
  instrument rejection without text now says **“Native export could not prepare
  instrument samples. Reload the instrument samples and retry; no export was
  completed.”** Other failed ACKs identify the failed export stage. The existing
  export error result carries these messages to inline dialog errors.

### Proof and validation

- `src/lib/export/native-offline-render-plan.test.ts:599-655`: all three
  instrument kinds, eight-second stereo regions without timeline clips, shared
  regions and timeline/instrument overlap, nonempty complete ranges, custom
  range plus tail frame count, structured cloning, zero whole-instrument PCM in
  plans, and unchanged default portable PCM/transferables.
- `src/lib/export/run-export-job.test.ts:665,815-881,1077-1125`: exact local
  hydrated-region providers without clips, failure/cancel with zero saved output
  and zero retained export bytes, plus exact-cap live/export overlap and
  one-byte-insufficient admission preserving live leases.
- `apps/desktop/audio-host.test.ts:636-744` extends bounded-page ordering to
  instrument configuration and verifies page-read failure, identity mismatch,
  short coverage, and actionable native errors produce no PCM output.
  The existing held-provider cancellation regression also passes.
- `native/audio-host-macos/tests/audio_host_transaction_test.cpp:325-503`
  runs real child-host offline exports for sampler, drum rack and granular.
  Page-delivered 200,000-frame stereo sources produce exactly **16,003 output
  frames**, with every sample equal to an independent contiguous core reference.
  Rebasing is exercised by scheduled offsets 97/12,097 and the TS custom-range
  plan test. Sampler/drum release tails and granular's existing immediate final
  note grain-clear behavior match exactly. Partial provider failure and
  cancellation close the child without OfflineStart or a successful terminal.
- `native/audio-host-macos/tests/audio_host_test.cpp:1568,2759` repeats the
  existing 300,000-frame deterministic mapped-versus-contiguous render and
  ownership proof for all three instrument kinds in explicit offline mode,
  with zero locked bytes.
- `bun run typecheck`, then `bun run build`: **passed**.
- Required combined command
  `bun test src/lib/export apps/desktop/audio-host.test.ts packages/audio-engine src/lib/desktop`:
  **1,096 passed** on one run. Two later full runs reported **1,095 passed,
  1 timeout** in unchanged
  `packages/audio-engine/src/prepared-stretch-store.test.ts:190`
  (“rejects invalid ranges and append shapes before storage changes”, 5 s).
  The storage file passes alone; final split verification passes:
  `bun test packages/audio-engine`: **683 passed**;
  `bun test src/lib/export apps/desktop/audio-host.test.ts src/lib/desktop`:
  **413 passed**, including Chromium lifecycle tests. No unrelated storage
  implementation or test was changed to hide the combined-process timeout.
- `cmake --build native/build/audio-host-macos-debug -j 4`: **passed**.
  `ctest --test-dir native/build/audio-host-macos-debug --output-on-failure --timeout 900`:
  **8/8 passed**, 87.39 seconds, including the core suite and callback guard.
  Core-only script was not rerun because Phase 4 touches no core files.
- Targeted Oxlint on all seven changed TS source/test files: **0 warnings,
  0 errors**. `git diff --check`: **passed**.
  Development failures (C++ fixture typing/decoder assumptions, child stdout
  draining, granular tail expectation, global AudioBuffer fixture interference,
  and readonly buffer-map typing) were corrected before final checks.
- Reviewed ownership, scope, duplicate logic and simpler alternatives. Retained
  one identity/page transport and existing cleanup rather than adding an export
  instrument manager. No subagents, commits, packaging, application launch, dev
  server, stash, reset, process-wide kill or core changes.

### Remaining Phase 5 gaps

Packaged product-dialog Save acceptance and the complete 12-cell matrix remain:
all three devices × 8/180-second stereo 48 kHz sources × live/export, with real
post-master captures, late markers, saved WAVs/hashes, inline screenshots,
maximum payload/locked-byte/xrun measurements, supported-machine lock failures,
replace/remove/reopen, cancellation and real live/export memory pressure.
Child-host deterministic PCM is implementation proof, not packaged acceptance
or evidence of live captured output. The combined-process storage timeout above
also remains reported for broader test-harness investigation.
