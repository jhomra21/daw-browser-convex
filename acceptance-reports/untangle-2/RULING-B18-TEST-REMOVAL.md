# Ruling: tests removed in untangle batch 18 (dead code)

Date: 2026-11-22. Branch `untangle-leftovers`, commit f9ee5904 `chore(audio-engine): delete two helpers with no callers and their tests`.

Two exported helpers in `packages/audio-engine` had no caller in the product: rg across src, packages, apps, convex, api, tools and native, including string references, found only their own tests. Batch 18 deletes code that nothing uses, so each helper and its only test go together:

- `packages/audio-engine/src/metering-runtime.test.ts`: "accepts only finite bounded level messages" (covered only `readTrackStereoLevels`)
- `packages/audio-engine/src/sample-rate-characterization.test.ts`: "accepts machine-readable pass and unsupported results" (covered only `isSampleRateConversionResult`)

Neither test is named as a killer by any mutation arm or gate, and no other test loses coverage. The engine gates that count these files (`gate:f-engine`, `gate:last-engine`) each lose exactly these two passing tests. Batch 14 first deleted them and the bless refused the count drop; they were restored then and are removed here through `--allow-removal`.
