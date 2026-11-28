import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/chorus-e2e'

// Ways the panel could fail, written before the panel: it overflows 300 px or 360 px; a value is clipped or crowds its label;
// Vibrato keeps Feedback or Dry/Wet although the kernel ignores them; Bass Freq shows with Safe Bass off; a knob or chooser
// writes the wrong param or none; a mode button does not exclude the others; a control has no name or no focus ring;
// an automated knob shows no dot, or a manual change is not reported as an override.
test('the Chorus panel fits the 300 px device, shows only the controls its mode uses and writes the params its controls own', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Chorus.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/chorus-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'the-bass-frequency-writes-its-param',
    'chorus-brings-feedback-and-dry-wet-back',
    'safe-bass-off-has-no-frequency-knob',
    'safe-bass-writes-the-flag-and-shows-its-frequency',
    'delay-writes-its-param-and-reports-a-manual-override',
    'depth-writes-its-param',
    'dry-wet-writes-its-param',
    'every-automatable-knob-shows-its-automation',
    'every-control-has-an-accessible-name',
    'every-control-visible-still-fits',
    'every-enabled-control-shows-a-focus-ring',
    'feedback-writes-its-param',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-crowds-another-control',
    'no-label-or-value-is-wider-than-its-box',
    'output-writes-its-param',
    'phase-writes-its-param-and-reads-degrees',
    'rate-writes-its-param',
    'the-defaults-read-as-the-device-defaults',
    'the-knobs-read-the-values-they-wrote',
    'the-panel-stays-360-px-wide-and-fits-the-device',
    'the-waveform-chooser-writes-the-waveform',
    'vibrato-still-fits',
    'vibrato-writes-the-mode-and-hides-feedback-and-dry-wet',
    'vintage-writes-the-mode-and-keeps-the-other-controls',
    'width-writes-its-param',
  ].sort())
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
