# Ruling: test removed in untangle batch 1 (dead code)

Date: 2026-11-20. Branch `untangle-dead-code` (PR #66), commit 5e3a875b `refactor: delete runAudioHostDiagnostic`.

`runAudioHostDiagnostic` in `apps/desktop/audio-host.ts` had no caller in the product (rg across src, packages, apps, convex, api, tools and native found only its own test). Batch 1 deletes code that nothing uses, so the function and its only test go together:

- `apps/desktop/audio-host.test.ts`: "reports an unavailable CoreAudio host without launching a device"

The test exercised only the deleted function. No mutation arm names it as a killer, and no other test loses coverage. The two FAST-CERT gates that run the file (`gate:rc1-i6-desktop`, `gate:rc1-g-panel-audiohost`) each lose exactly this one passing test.
