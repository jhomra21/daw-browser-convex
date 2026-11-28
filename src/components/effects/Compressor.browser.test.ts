import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/compressor-e2e'

test('the Compressor panel keeps every button label whole in 700 px and shows the Makeup that Auto Makeup applies', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./Compressor.browser-runtime.tsx', import.meta.url), { screenshot: `${artifacts}/compressor-device.png`, styled: true })
  expect(Object.keys(results).sort()).toEqual([
    'no-button-label-is-clipped',
    'the-makeup-knob-shows-its-own-value-while-auto-makeup-is-off',
    'the-makeup-knob-shows-the-applied-makeup-while-auto-makeup-is-on',
    'the-panel-stays-700-px-wide',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
