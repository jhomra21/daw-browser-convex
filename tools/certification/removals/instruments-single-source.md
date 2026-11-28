# Ruling: remove tests for retired OfflineAudioContext export code

Date: 2026-11-28. Branch `instruments-single-source`.

The portable export worker and native export plan are the production export paths. A repository search found no production callers of `renderMixdown`; only its tests called it. The owner approved deleting the entire `OfflineAudioContext` export path, including the legacy-comparison browser test.

Removed tests, all for code deleted in this change:

- `packages/audio-engine/src/export-mixdown.test.ts`: “is explicitly rejected by offline export”
- `packages/audio-engine/src/export-mixdown.test.ts`: “does not fabricate a synth for instrument tracks without a persisted device”
- `packages/audio-engine/src/portable-export-legacy-comparison.browser.test.ts`: “the portable export worker matches the legacy OfflineAudioContext render”
- `packages/audio-engine/src/mixer/apply-offline-routing.test.ts`: the four offline compressor failure-contract tests

The two export-mixdown tests were recorded as passing in the pinned baseline for `export-mixdown.test.ts` (21 pass). The comparison file was recorded as 1 pass. Export stem planning tests remain because the portable export job still uses `export-stem-plan.ts`.

No FAST-CERT run was performed, so this ruling records intent only. Its paired revert/live rebase must run with `tools/certification/removals/instruments-single-source.json` before FAST-CERT accepts the deletion.
