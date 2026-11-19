import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/spectrum-e2e'

test('the spectrum view scrolls frames into a bounded log-frequency spectrogram and draws the live curve', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./SpectrumView.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/spectrum-view.png` })
  expect(Object.keys(results).sort()).toEqual([
    'a-1khz-tone-lands-on-its-log-frequency-row-at-the-newest-column',
    'a-new-tone-scrolls-in-on-the-right-while-the-old-one-stays-left',
    'a-null-frame-clears-the-history',
    'a-screenshot-scene-was-rendered',
    'both-views-render-a-curve-and-a-spectrogram-canvas',
    'the-curve-draws-the-latest-frame',
    'the-ring-is-full-so-the-oldest-column-shows-the-tone-too',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
