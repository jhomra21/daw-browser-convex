import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/spectrum-e2e'

test('the Spectrum device paints delivered frames, follows its view, and shows nothing while bypassed', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Spectrum.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/spectrum-device.png` })
  expect(Object.keys(results).sort()).toEqual([
    'a-bypassed-device-shows-nothing',
    'frames-fed-to-the-device-paint-spectrogram-columns',
    'hovering-the-curve-shows-frequency-note-and-level',
    'leaving-the-curve-hides-the-readout',
    'max-is-off-by-default',
    'pressing-max-turns-max-hold-on',
    're-enabling-the-device-resumes-the-spectrogram',
    'the-block-and-channel-choosers-show-the-defaults',
    'the-choosers-follow-the-device-params',
    'the-device-defaults-to-the-curve-and-the-spectrogram',
    'the-spectrogram-view-shows-only-the-spectrogram',
    'the-spectrum-view-shows-only-the-curve',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
