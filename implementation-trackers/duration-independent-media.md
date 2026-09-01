# Duration-Independent Media Tracker

## Status

IN PROGRESS

Branch: `fix/native-asset-capacity` (name retained for PR continuity)
Base: `master`

## Product invariant

Audio duration is never an application-level admission limit.

Imports, project assets, recordings, playback sources, and exports may be as long as the underlying filesystem/storage and media format permit. Memory use must remain bounded independently of duration. Disk use may grow with media. A media operation may fail for real resource or format failures, but not because a DAW-owned frame/byte counter translates into "too many seconds."

This means there must be no correctness dependency on:

- complete-file `arrayBuffer()` reads
- complete-asset `AudioBuffer` decoding
- complete planar PCM copies
- one-control-frame PCM installation
- application-defined total recording byte ceilings
- complete rendered-output `AudioBuffer` materialization

Short media may still use eager caches as an optimization. Eager materialization must never be required for correctness.

## Grounded current-state findings

- Local project media is already copied to project-owned files (project directory or OPFS), so durable bytes are not inherently RAM-backed.
- Local asset hashing already streams `File.stream()` rather than requiring a complete `ArrayBuffer`.
- Audio import reads metadata lazily with MediaBunny and can create ordinary clips without complete-file Web Audio decoding.
- Ordinary portable/native snapshots are metadata-only; bounded legacy instrument and prepared Stretch paths may still carry planar PCM.
- Native live playback hydrates bounded MediaBunny pages into one sparse mapped asset per ordinary source before scheduling.
- Recording capture already uses bounded reusable blocks and writes them sequentially to OPFS.
- Recording duration independence is not yet closed; the remaining writer, finalization, and post-recording hydration paths still require audit and runtime acceptance.
- Recording WAV finalization already reads/writes blocks incrementally.
- Native offline rendering consumes scheduled ordinary-source ranges through bounded mapped pages, emits bounded PCM chunks, and spools output to disk-backed streaming DSP and encoding.
- MediaBunny is already a project dependency and provides lazy `BlobSource` reading plus incremental `AudioSampleSink` decoding.

## Architecture

### Durable source

The project-owned media file is the source of truth. Timeline clips retain semantic asset identity and persisted metadata. Runtime decoded PCM is a cache, never the authoritative asset.

### Metadata

Use MediaBunny over `BlobSource(File)` to read the primary audio track, sample rate, channel count, and duration without complete-file reads or complete decoding.

### Decoded pages

Represent decoded audio as bounded time/frame pages. Decode only the requested/sequentially prefetched ranges. Cache pages under an explicit memory budget and evict by access policy. The cache budget is independent of source duration.

### Browser playback

Feed bounded decoded pages into the portable audio runtime. The audio callback/worklet consumes prepared pages/ring data and never performs filesystem or decoder work.

### Desktop native playback

Do not transfer an entire asset over control IPC. Use a desktop-owned, path-safe media cache keyed by project/asset identity. Canonical decoded channel data is file-backed and range-addressable. Native playback must use prepared ranges without blocking filesystem/decoder work in the realtime callback. A mapped/file-backed representation may provide the audio core stable planar pointers while allowing the OS to page media instead of allocating duration-sized RAM.

### Recording

Capture remains block-based and sequential. There is no default total byte/frame ceiling. Storage writes continue until the user stops or the filesystem/quota/write boundary reports a real failure. Finalization and project promotion remain streaming.

### Export

Both source consumption and rendered output are block-streamed. Native `offlinePcmChunk` output is written to the encoder/output sink as it arrives rather than collected into one `AudioBuffer`. Export duration therefore does not determine peak RAM.

## Implementation phases

### Phase 0 — invariant and hard-limit audit

- [x] Establish duration-independent product invariant.
- [x] Record current whole-file/whole-PCM boundaries.
- [x] Add regression helpers/tests that express duration independence without giant allocations.

### Phase 1 — metadata and import admission

- [x] Add MediaBunny-backed audio metadata reader using lazy `BlobSource` input.
- [x] Stop requiring whole-file Web Audio decode before a local audio file can be persisted and represented as a clip.
- [x] Preserve optional eager `AudioBuffer` cache for short/active media only as an optimization.
- [x] Ensure invalid/unsupported audio still fails explicitly.

### Phase 2 — recording duration independence

- [ ] Remove the default 4 GiB recording-session cap.
- [ ] Keep explicit injectable limits only for bounded unit-test/failure simulation.
- [ ] Ensure native and portable recording writers remain bounded by queued block count, not total captured duration.
- [ ] Avoid complete-file decode after recording finalization.

### Phase 3 — decoded page source

- [ ] Introduce one bounded decoded-page abstraction shared by import hydration/playback/export consumers.
- [x] Decode requested ranges with MediaBunny `AudioSampleSink`.
- [x] Close decoded samples promptly and keep a fixed memory budget.
- [x] Preserve sample-rate/channel metadata and deterministic frame addressing.

### Phase 4 — timeline/runtime migration

- [x] Make source asset identity + metadata sufficient for a playable audio clip; `AudioBuffer` becomes optional cache only.
- [ ] Migrate clip hydration away from whole-asset decode.
- [ ] Ensure seeking, duplicated clips, offsets, fades, and loops request the correct source ranges.
- [ ] Generate waveform/peak data incrementally without requiring complete decoded PCM.

### Phase 5 — desktop native file-backed assets

- [x] Replace whole-PCM `assetInstall` with a duration-independent file/range boundary.
- [x] Main/native host owns cache paths; renderer never supplies arbitrary filesystem paths.
- [x] Keep IPC messages bounded and sequential.
- [x] Keep realtime callback free of blocking I/O/decoding.
- [x] Preserve asset lifetime/release/transaction semantics.
- [x] Remove native duration-derived `maximumAssetFrames` admission checks for mapped ordinary assets; bounded legacy instrument installs remain intentionally capped.

### Phase 6 — streaming export

- [x] Consume ordinary source audio in bounded pages for native export.
- [ ] Consume source audio in bounded pages for portable export.
- [x] Stream native offline PCM chunks directly into encoding/output.
- [x] Remove monolithic rendered-PCM `AudioBuffer` requirement and duration-derived output-memory rejection.
- [x] Keep cancellation and partial-file cleanup deterministic.

### Phase 7 — instrument/warp compatibility

- [ ] Audit sampler, drum rack, granular, and stretch preparation for whole-asset assumptions.
- [ ] Use duration-independent source/page access where an instrument can legitimately reference long media.
- [ ] Keep any intentionally bounded instrument-local buffers explicit and unrelated to project-asset duration.

### Phase 8 — acceptance

- [ ] Confirm a multi-minute imported source persists without complete-file decoding in the packaged app.
- [ ] Seek near beginning/middle/end and play through the packaged native path.
- [ ] Native VST processing works on the long source.
- [ ] Record for a duration logically beyond the old 4 GiB policy without an application ceiling (synthetic storage test plus practical runtime soak).
- [ ] Export a long range with bounded process memory.
- [ ] Corrected Valhalla automation acceptance from PR #51 still passes.
- [x] `bun run lint`
- [x] `bun run typecheck`
- [x] `bun run test`
- [x] native CTest/runtime checks on macOS
- [ ] packaged Electron acceptance on macOS

Current live boundary evidence: MediaBunny page decoding, metadata-only ordinary
snapshots, bounded concurrent mapped-page hydration, bounded native written-range
ledgering, renderer page LRU bookkeeping, and hydration-before-schedule are
covered by focused tests. Native offline planning now emits metadata-only mapped
ordinary-source descriptors, hydrates only their scheduled source ranges through
bounded pages before graph publication, and retains `native-pcm-chunking` only
for eagerly prepared Stretch/instrument PCM. A fresh unsigned packaged Electron
launch also reached the local project workspace through the public `daw://app/`
path; long-media/VST/recording/export acceptance remains open below.

## Non-goals / real limits

"Any duration" does not mean infinite physical resources. The following remain valid failures when they come from the environment rather than a DAW-owned duration ceiling:

- disk full / browser storage quota exhausted
- filesystem permission revoked
- unsupported or corrupt media format/codec
- OS/process address-space or mapping failure
- user cancellation
- source removed or cloud media unavailable

Those failures must be explicit and recoverable; none should be reported as a generic maximum-duration error.
