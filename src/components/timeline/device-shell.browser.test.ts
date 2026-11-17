import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/lib/browser-fixture-test-support'

test('a device folds and unfolds in place and shows its native limitation as a neutral status', async () => {
  const results = await runBrowserFixture(new URL('./device-shell.browser-runtime.tsx', import.meta.url))
  expect(Object.keys(results).sort()).toEqual([
    'double-click-on-the-title-unfolds',
    'expanded-device-offers-fold',
    'fold-click-hides-the-body-and-offers-unfold',
    'folded-device-hides-the-notice',
    'native-limit-is-a-neutral-status-with-the-reason',
    'no-limit-shows-no-notice',
    'unfold-click-restores-the-body',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
