import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/autopan-e2e'

// Ways the panel could fail, written before the panel: it overflows 300 px or the panel width; a value is clipped or crowds its label; Sync keeps the free Rate knob next to the division chooser, or the division chooser stays after Sync goes off; a division writes the wrong index; Phase or Offset read in the wrong unit; a control has no name or no focus ring; an automated knob shows no dot, or a manual change is not reported as an override.
test('the AutoPan panel fits the 300 px device, shows only the controls it uses and writes the params its controls own', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./AutoPan.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/autopan-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'depth-writes-its-param',
    'every-automatable-knob-shows-its-automation',
    'every-control-has-an-accessible-name',
    'every-enabled-control-shows-a-focus-ring',
    'free-rate-has-no-division-chooser',
    'invert-writes-the-flag',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-crowds-another-control',
    'no-label-or-value-is-wider-than-its-box',
    'offset-writes-its-param',
    'phase-writes-its-param',
    'rate-writes-its-param-and-reports-a-manual-override',
    'shape-writes-its-param',
    'sync-off-brings-the-rate-knob-back',
    'sync-writes-the-flag-and-swaps-the-rate-knob-for-a-division',
    'synced-automation-shows-on-the-remaining-knobs',
    'synced-still-fits',
    'the-defaults-read-as-the-device-defaults',
    'the-division-chooser-writes-its-index',
    'the-knobs-read-the-values-they-wrote-in-degrees-and-percent',
    'the-panel-stays-300-px-wide-and-fits-the-device',
    'the-waveform-chooser-writes-the-waveform',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
