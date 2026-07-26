import { expect, test } from 'bun:test'

const realtimeSources = [
  new URL('../src/coreaudio-hal.mm', import.meta.url),
  new URL('../src/audio-host.cpp', import.meta.url),
  new URL('../../plugin-host/src/worker-control-service.cpp', import.meta.url),
]

const forbidden = [
  '.notify_',
  '.wait(',
  '.wait_for(',
  '.wait_until(',
  'condition_variable',
  'lock_guard',
  'mutex',
  'NotifyService(',
  'NotifyRecordingStatus(',
  'scoped_lock',
  'unique_lock',
]

const markedRegions = (source: string) => {
  const regions: string[] = []
  const pattern = /DAW_REALTIME_CALLBACK_(?:REGION|HELPER)_BEGIN[^\n]*\n([\s\S]*?)\/\/ DAW_REALTIME_CALLBACK_(?:REGION|HELPER)_END/g
  for (const match of source.matchAll(pattern)) {
    const region = match[1]
    if (region) regions.push(region)
  }
  return regions
}

test('CoreAudio callback paths contain no scheduler wake, wait, or lock operations', async () => {
  for (const sourceUrl of realtimeSources) {
    const source = await Bun.file(sourceUrl).text()
    const regions = markedRegions(source)
    expect(regions.length).toBeGreaterThan(0)
    for (const region of regions) {
      for (const token of forbidden) expect(region).not.toContain(token)
    }
  }
})
