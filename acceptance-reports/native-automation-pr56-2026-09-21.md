# PR 56 Native Automation Packaged Acceptance

## Artifact

- Commit: `30abc810f71536363efc17c17650fd72b6d93de3`
- Branch: `chore/repository-cleanup`
- OS: macOS arm64
- Packaged app: fresh unsigned Electron package
- Profile and project: isolated disposable local state
- Real plugin: ValhallaSupermassive 5.0.0, arm64, 19 parameters

## Result

Issue #48 remains open. Native automated mixdown passed packaged acceptance,
but live-running re-enable did not produce certifying runtime evidence.

### Offline export

| Acceptance item | Classification | Evidence |
| --- | --- | --- |
| Track volume affects rendered PCM | PASS — packaged runtime | Enabled and disabled automation renders differ across the full custom range. |
| Master volume affects rendered PCM | PASS — packaged runtime | Mixed automated render includes enabled master volume automation. |
| Built-in hold and linear automation | PASS — packaged runtime | Utility gain used hold and linear points in the mixed render. |
| VST3 hold and linear automation | PASS — packaged runtime | Valhalla Mix parameter 48 used hold and linear points. |
| Mixed built-in and VST automation | PASS — packaged runtime | One project rendered Utility, mixer, master, and Valhalla automation together. |
| Disabled envelopes are ignored | PASS — packaged runtime | Disabling all four envelopes produced the fixed comparison render. |
| Custom range rebases to frame zero | PASS — packaged runtime | A 2–7 second range produced exactly 240,000 stereo frames at 48 kHz. |
| Pre-range value applies at range start | PASS — packaged runtime | Every envelope included a value before the two-second range start. |
| Dense automation capacity behavior | PASS — source/test | Native schedule and offline-plan tests cover partitioning and explicit overflow failure. |
| Normal automation no longer triggers the old rejection | PASS — packaged runtime | Export completed successfully. |

The automated and fixed renders were both five-second stereo 48 kHz 32-bit
float WAV files with 479,998 nonzero samples. They differed in 479,998 of
480,000 samples. Difference RMS was `0.097734`; difference peak was
`0.394735`. Every one-second region contained changed samples.

### Live re-enable

| Acceptance item | Classification | Evidence |
| --- | --- | --- |
| Start native playback with VST automation scheduled | FAIL | Transport reported playing, but the fresh profile's audio engine remained uninitialized. |
| Manual edit proves native override wins | FAIL | No active native feedback baseline was available. |
| Re-enable while transport remains running | PASS — source/test | Coordinator regression accepts re-enable without replacing the active schedule. |
| Native host accepts clear-override command | PASS — source/test | Protocol/native tests cover accepted bounded commands. |
| Automated value resumes from current playhead | FAIL | Valhalla Mix feedback remained at its default value. |
| Other overrides remain active | PASS — source/test | Override bookkeeping tests cover targeted clearing. |
| Stale/unknown targets fail closed | PASS — source/test | Existing protocol and native tests cover stale and unknown targets. |

The live result is incomplete runtime evidence, not a product pass. Documentation
must continue to distinguish source/test support from packaged certification.
