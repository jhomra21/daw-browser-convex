import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/flanger-e2e'

// Ways the panel could fail, written before the panel: it overflows 300 px or 360 px; a value is clipped or crowds its label; the mode buttons do not exclude each other or hide a control Through-Zero still uses; Bass Freq shows with Safe Bass off; a knob or the waveform chooser writes the wrong param or none; a control has no name or no focus ring; an automated knob shows no dot or a manual change is not reported as an override.
test('the Flanger panel fits the 300 px device, shows only the controls it uses and writes the params its controls own', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Flanger.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/flanger-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'delay-writes-its-param-and-reports-a-manual-override',
    'depth-writes-its-param',
    'dry-wet-writes-its-param',
    'every-automatable-knob-shows-its-automation',
    'every-control-has-an-accessible-name',
    'every-control-visible-still-fits',
    'every-enabled-control-shows-a-focus-ring',
    'feedback-writes-its-param',
    'flanger-writes-the-mode-back',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-crowds-another-control',
    'no-label-or-value-is-wider-than-its-box',
    'output-writes-its-param',
    'phase-writes-its-param-and-reads-degrees',
    'rate-writes-its-param',
    'safe-bass-off-has-no-frequency-knob',
    'safe-bass-writes-the-flag-and-shows-its-frequency',
    'the-bass-frequency-writes-its-param',
    'the-defaults-read-as-the-device-defaults',
    'the-knobs-read-the-values-they-wrote',
    'the-panel-stays-360-px-wide-and-fits-the-device',
    'the-waveform-chooser-writes-the-waveform',
    'through-zero-writes-the-mode-and-excludes-flanger',
    'width-writes-its-param',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
