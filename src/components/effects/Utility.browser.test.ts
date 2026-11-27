import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/utility-e2e'

// Ways the panel could fail, written before the panel: Width or Mid/Side stay on Left or Right, where the kernel ignores them; Mid/Side keeps the Width knob beside its own; Bass Mono Frequency or Audition show with Bass Mono off; Gain never reads minus infinity at its floor; a mode change replaces the Gain knob; a knob writes the wrong param or reports no manual override; the panel overflows 420 px or a value crowds a label.
test('the Utility panel shows the controls each Channel Mode, Mid/Side and Bass Mono state acts on and keeps its controls mounted', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Utility.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/utility-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'a-channel-mode-change-keeps-the-same-gain-knob-and-chooser',
    'a-value-change-keeps-the-same-knob-and-chooser',
    'audition-writes-the-flag',
    'balance-writes-its-param-and-reads-in-sides',
    'bass-mono-and-width-still-fit',
    'bass-mono-frequency-writes-its-param-and-reports-a-manual-override',
    'bass-mono-off-removes-frequency-and-audition',
    'bass-mono-writes-the-flag-and-shows-frequency-and-audition',
    'every-automatable-knob-shows-its-automation',
    'every-control-has-an-accessible-name',
    'every-enabled-control-shows-a-focus-ring',
    'gain-at-the-floor-reads-minus-infinity',
    'gain-writes-its-param-and-reports-a-manual-override',
    'left-removes-the-width-controls',
    'mid-side-off-brings-the-width-knob-back',
    'mid-side-swaps-the-width-knob-for-mid-side',
    'mid-side-writes-its-param-and-reports-a-manual-override',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-crowds-another-control',
    'no-label-or-value-is-wider-than-its-box',
    'right-removes-the-width-controls',
    'stereo-shows-width-and-no-bass-mono-controls',
    'swap-keeps-the-width-controls',
    'the-defaults-read-as-the-device-defaults',
    'the-knobs-read-the-values-they-wrote',
    'the-matrix-chooser-writes-the-matrix',
    'the-panel-stays-420-px-wide-and-fits-the-device',
    'the-toggles-write-their-flags',
    'the-width-knob-shows-its-automation',
    'width-writes-its-param',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
