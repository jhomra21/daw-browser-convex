import { expect, test } from 'bun:test'

import { runServedBrowserFixture } from '~/test-support/browser-fixture-test-support'

test('a project with an instrument track shows a blocking message and plays nothing when the page has no AudioWorklet', async () => {
  const { results } = await runServedBrowserFixture(new URL('./portable-unavailable.browser-runtime.tsx', import.meta.url))

  expect(Object.keys(results)).toHaveLength(6)
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 120_000)
