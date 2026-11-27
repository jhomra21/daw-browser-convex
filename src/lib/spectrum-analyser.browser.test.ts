import { mkdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

const artifacts = '/tmp/spectrum-analyser-browser'

// The browser path reads the real AnalyserNode; the keys carry what it measured, so the artifact is the record.
test('the browser spectrum analyser reads calibrated dBFS, honours block and channel, and resolves close partials', async () => {
  await mkdir(artifacts, { recursive: true })
  const results = await runBrowserFixture(new URL('./spectrum-analyser.browser-runtime.ts', import.meta.url))
  await Bun.write(`${artifacts}/results.json`, JSON.stringify(results, null, 2))
  expect(Object.keys(results)).toHaveLength(11)
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 120_000)
