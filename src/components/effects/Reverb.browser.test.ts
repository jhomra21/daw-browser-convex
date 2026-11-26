import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/reverb-e2e'

test('the Reverb panel fits the 300 px device, reads every control, gates Flat and Cut on Freeze and writes the params its controls own', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Reverb.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/reverb-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'a-knob-change-writes-its-param',
    'an-automatable-knob-reports-a-manual-override',
    'every-control-has-an-accessible-name',
    'every-control-sits-inside-the-300-px-device',
    'every-enabled-control-shows-a-focus-ring',
    'every-knob-has-its-name-and-reads-its-value-in-units',
    'every-knob-shows-its-visible-label',
    'flat-and-cut-are-disabled-until-freeze-is-on',
    'flat-and-cut-write-their-params-once-frozen',
    'freeze-enables-flat-and-cut-and-marks-the-panel',
    'freeze-off-disables-flat-and-cut-again',
    'hi-cut-switches-on-at-6-khz',
    'lo-cut-switches-on-at-830-hz',
    'no-label-or-value-is-wider-than-its-box',
    'the-cut-handles-are-absent-until-the-cut-is-on',
    'the-decay-curve-is-flat-with-flat-shelves-and-falls-with-a-high-shelf-cut',
    'the-density-chooser-writes-density',
    'the-input-curve-rolls-off-below-the-lo-cut-and-above-the-hi-cut',
    'the-lo-cut-handle-moves-the-frequency',
    'the-panel-stays-720-px-wide',
    'the-sections-read-their-values',
    'the-smooth-chooser-writes-smooth',
    'the-toggles-and-choosers-read-their-state',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
