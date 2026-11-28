import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/spectral-e2e'

// Ways the panel could fail, written before the panel: a mode shows a control the engine ignores in it, or hides one it reads; Freeze or Learn is a knob instead of a toggle or does not write 0/1; the Noise Floor or the dBFS threshold is missing; the Sidechain Source shows where it has no effect (every mode but Morph, or the master); the HPSS footer text comes back; the latency label disappears; a knob writes another param; a mode overflows the 300 px device; a control has no name or no focus ring.
test('the Spectral panel shows only the controls each mode acts on and writes the params its controls own', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Spectral.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/spectral-device.png`, styled: true })
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])

  expect(Object.keys(results).sort()).toEqual([
    'attack-writes-its-param',
    'automated-knobs-show-their-automation',
    'balance-writes-its-param',
    'blur-writes-its-param',
    'dry-wet-moves-down-from-full',
    'dry-wet-writes-its-param',
    'every-control-has-an-accessible-name',
    'every-enabled-control-shows-a-focus-ring',
    'freeze-mode-fits-the-360-px-device',
    'freeze-mode-shows-exactly-its-controls',
    'freeze-releases-back-to-zero',
    'freeze-writes-its-flag-and-reads-pressed',
    'fft-size-chooser-writes-the-size',
    'gate-defaults-read-in-dbfs-and-ms',
    'gate-mode-fits-the-360-px-device',
    'gate-mode-shows-exactly-its-controls',
    'hpss-mode-fits-the-360-px-device',
    'hpss-mode-shows-exactly-its-controls',
    'learn-is-a-toggle-that-writes-the-lane-on',
    'learn-starts-off',
    'learn-toggles-back-off',
    'morph-mode-fits-the-360-px-device',
    'morph-mode-shows-exactly-its-controls',
    'morph-on-the-master-has-no-source-chooser',
    'morph-shows-its-source-chooser-on-a-track',
    'morph-writes-its-param',
    'no-knob-shows-automation-without-an-envelope',
    'no-label-or-value-crowds-another-control',
    'no-label-or-value-is-wider-than-its-box',
    'noise-floor-defaults-to-minus-30-db',
    'noise-floor-writes-its-param',
    'noise-reduce-mode-fits-the-360-px-device',
    'noise-reduce-mode-shows-exactly-its-controls',
    'overlap-chooser-writes-the-overlap',
    'reduction-writes-its-param',
    'release-writes-its-param',
    'shift-blur-mode-fits-the-360-px-device',
    'shift-blur-mode-shows-exactly-its-controls',
    'shift-writes-its-param',
    'the-defaults-read-as-the-device-defaults',
    'the-header-shows-the-latency',
    'the-panel-has-no-hpss-kernel-footer',
    'the-panel-stays-360-px-wide-and-fits-the-device',
    'the-sidechain-chooser-offers-internal-and-the-other-tracks-only',
    'the-sidechain-chooser-writes-the-chosen-track',
    'threshold-writes-its-param',
  ].sort())
}, 90_000)
