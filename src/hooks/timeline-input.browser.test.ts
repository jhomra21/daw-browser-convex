import { expect, test } from 'bun:test'

import { runBrowserFixture } from '~/test-support/browser-fixture-test-support'

test('live MIDI follows the docked clip and lifecycle, and lane clicks seek only while stopped', async () => {
  const results = await runBrowserFixture(new URL('./timeline-input.browser-runtime.tsx', import.meta.url))
  expect(Object.keys(results).sort()).toEqual([
    'bpm-change-keeps-held-notes',
    'browser-engine-plays-when-no-native-backend-exists',
    'click-does-not-seek-while-playing',
    'click-seeks-without-listening-while-stopped',
    'click-selects-the-clicked-track-while-playing',
    'click-selects-the-clicked-track-while-stopped',
    'docked-clip-change-force-releases-held-notes',
    'docked-clip-names-the-target',
    'docked-clip-without-midi-yields-no-editor-clip',
    'keyboard-note-routes-to-the-docked-clip-track-on-native',
    'native-preview-reset-force-releases-held-notes',
    'native-required-stays-off-the-browser-engine-while-native-is-pending',
    'native-waits-for-ready-lifecycle',
    'ready-lifecycle-routes-to-native',
    'suspended-lifecycle-blocks-new-notes',
    'suspended-lifecycle-force-releases-held-notes',
    'target-change-force-releases-held-notes',
    'unmount-force-releases-held-notes',
    'unmounted-overlay-ignores-keys',
  ])
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 90_000)
