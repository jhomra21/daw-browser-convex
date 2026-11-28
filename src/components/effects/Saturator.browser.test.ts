import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/saturator-e2e'

// Ways the panel could fail, written before the panel: a curve keeps another curve's knobs (Threshold on Soft, Depth on Bass); Color's knobs show with Color off; the curve display is a copy that ignores Drive, the curve knobs or Post Clip; a value change replaces the graph or a knob; the HQ latency does not follow Post Clip; a knob writes the wrong param or reports no manual override; the panel overflows its width or a value crowds a label.
test('the Saturator panel shows only the controls of its curve and Color state and draws the real curve without remounting', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Saturator.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/saturator-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'a-curve-change-keeps-the-graph-and-the-drive-knob',
    'bass-adds-only-its-threshold',
    'clip-flattens-at-full-scale',
    'color-knobs-write-their-params-and-report-overrides',
    'color-off-removes-its-knobs',
    'color-on-writes-the-flag-and-shows-its-four-knobs',
    'depth-and-period-write-their-params-and-move-the-curve',
    'drive-redraws-the-curve-without-remounting',
    'drive-writes-its-param-and-reports-a-manual-override',
    'every-automatable-knob-shows-its-automation',
    'every-control-has-an-accessible-name',
    'every-enabled-control-shows-a-focus-ring',
    'fold-folds-the-curve-back-at-this-drive',
    'fold-has-no-curve-specific-control',
    'hi-quality-writes-the-flag',
    'medium-hard-analog-and-sine-have-no-curve-specific-control',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-crowds-another-control',
    'no-label-or-value-is-wider-than-its-box',
    'post-clip-writes-its-mode-and-latency-shows-on-hq',
    'soft-shows-only-drive-output-and-dry-wet',
    'the-defaults-read-as-the-device-defaults',
    'the-knob-reads-the-value-it-wrote',
    'the-panel-stays-460-px-wide-and-fits-the-device',
    'the-soft-curve-is-odd-rises-and-saturates',
    'threshold-writes-its-param-and-moves-the-curve',
    'warp-adds-only-depth-and-period',
    'warp-with-color-fits-the-device-and-crowds-nothing',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
