# Native Electron offline mixdown export

## Confirmed gap

Browser mixdown and stems are substantially implemented, including built-in
effects, automation, routing, tails, normalization, MediaBunny encoding,
progress, cancellation, local/cloud destinations, and export metadata.

Electron export intentionally fails closed with
`NATIVE_EXPORT_UNAVAILABLE_MESSAGE` because no device-independent native
offline PCM renderer exists. Removing that guard would violate the native-only
desktop audio contract and still would not render VSTs.

## Initial scope

Implement native Electron **main mixdown** export with built-in processors and
VST3 effects/instruments. Reuse the existing renderer-owned export dialog,
queue, fidelity processing, encoding, output targets, progress, cancellation,
and metadata.

Keep native stems disabled until main-mixdown parity is proven.

## Architecture

1. Define a versioned native export render-plan contract containing:
   - sample rate, channels, frame range, tempo/time signature/loop context;
   - serialized native graph and processor/instrument state;
   - installed planar PCM assets;
   - source, MIDI, automation, and VST parameter events;
   - VST attachment plan;
   - explicit finite tail/render-end ownership.
2. Add a device-independent native render session:
   - no output-device requirement;
   - process deterministic fixed-size blocks through the existing audio core;
   - coordinate VST workers synchronously using complete VST3 process context;
   - stream bounded planar PCM chunks and progress;
   - stop only on completion, cancellation, or error.
3. Add a constrained desktop bridge:
   - prepare/start/cancel/teardown operations;
   - strict payload validation and current trusted-window checks;
   - bounded PCM chunk delivery without exposing Electron primitives.
4. Refactor export rendering behind an explicit strategy:
   - browser strategy uses current OfflineAudioContext/portable worker;
   - desktop strategy uses native PCM streaming;
   - both feed the current fidelity, normalization, limiter, MediaBunny
     encoding, output-target, cloud upload, and metadata pipeline.
5. Enable only main mixdown in Electron initially. Clearly disable stem modes
   in the desktop dialog with accurate explanatory copy.
6. Preserve snapshot semantics: queued export renders the captured state, not
   later timeline edits.

## Fidelity requirements

- Built-in instruments/effects and mixed built-in/VST order match live audio.
- Groups, sends, returns, sidechains, master processing, master gain, clip
  fades, warp/stretch, MIDI expression, automation, loop/custom ranges, and
  finite tails match browser/live semantics.
- VST3 receives tempo, musical position, time signature, cycle bounds,
  continuous/sample time, playing state, and discontinuity.
- Export does not require or disturb the live output device/session.
- Active playback and open VST editors survive export lifecycle unchanged.

## Validation

- Contract/parser and render-plan tests.
- Native deterministic PCM fixtures for built-ins, routing, automation,
  sidechains, tails, cancellation, and sample-rate/channel variants.
- Real VST fixture covering instrument/effect processing and sparse tails.
- Browser export regression suite remains unchanged.
- Packaged Electron mixdown for WAV plus one compressed MediaBunny format.
- Verify progress, cancellation, destination writes, cloud upload, metadata,
  live playback continuity, and VST editor continuity.
- Full typecheck, lint, tests, native CTest/build, web build, and desktop package.

## Deferred follow-ups

- Native all-track and selected-track stems.
- Stem dashboard metadata/history.
- Local history reopening through retained file handles.
- General `.dawproject` interchange compatibility and compressed ZIP import.
