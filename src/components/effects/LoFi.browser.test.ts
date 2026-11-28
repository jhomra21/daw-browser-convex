import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/lofi-e2e'

// Ways the panel could fail, written before the panel: Floor DC Fix shows (or stays) when the quantizer is not Floor; a value or quantizer change replaces a knob or chooser; Rate reads in the wrong unit; a toggle writes the wrong flag; a knob reports no manual override; the panel overflows 400 px or a value crowds a label.
test('the Lo-Fi panel shows Floor DC Fix only for Floor, writes the params its controls own and keeps its controls mounted', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./LoFi.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/lofi-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'a-quantizer-change-keeps-the-same-knobs',
    'a-value-change-keeps-the-same-knobs-and-choosers',
    'bits-write-a-whole-number',
    'dc-fix-writes-its-flag',
    'every-automatable-knob-shows-its-automation',
    'every-control-has-an-accessible-name',
    'every-enabled-control-shows-a-focus-ring',
    'floor-adds-dc-fix',
    'floor-still-fits',
    'jitter-noise-and-dry-wet-write-their-params',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-crowds-another-control',
    'no-label-or-value-is-wider-than-its-box',
    'rate-writes-hz-and-reports-a-manual-override',
    'round-has-no-dc-fix',
    'the-defaults-read-as-the-transparent-device',
    'the-dither-chooser-writes-the-dither',
    'the-panel-stays-400-px-wide-and-fits-the-device',
    'the-toggles-write-their-flags',
    'truncate-has-no-dc-fix',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
