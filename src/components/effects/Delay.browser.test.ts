import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/delay-e2e'

test('the Delay panel fits the 300 px device, reads every control and writes the params its controls own', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Delay.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/delay-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'a-time-knob-writes-its-time-and-reports-a-manual-override',
    'an-automatable-knob-reports-a-manual-override',
    'each-channel-writes-its-own-division',
    'every-automatable-knob-shows-its-automation',
    'every-control-has-an-accessible-name',
    'every-control-sits-inside-the-300-px-device',
    'every-enabled-control-shows-a-focus-ring',
    'filter-on-writes-the-flag-and-undims-the-handle',
    'freeze-and-ping-pong-write-their-params',
    'link-disables-the-right-channel',
    'link-off-enables-the-right-channel',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-is-wider-than-its-box',
    'sync-mode-has-no-time-knob',
    'the-curve-peaks-at-the-filter-frequency-and-falls-either-side',
    'the-defaults-read-as-the-device-defaults',
    'the-feel-choosers-write-their-channel',
    'the-filter-handle-is-dimmed-until-the-filter-is-on',
    'the-filter-reads-its-frequency-and-width',
    'the-handle-moves-the-frequency-and-reports-a-manual-override',
    'the-handle-moves-the-width',
    'the-knobs-read-their-values-in-units',
    'the-offset-is-off-in-time-mode',
    'the-offset-knob-writes-the-offset-percent',
    'the-panel-stays-640-px-wide',
    'the-smoothing-buttons-write-the-mode-and-exclude-each-other',
    'the-strips-follow-the-filter',
    'time-mode-shows-the-time-knobs',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
