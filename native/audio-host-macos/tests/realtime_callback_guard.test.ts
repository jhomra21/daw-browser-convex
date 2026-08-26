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

test('AudioHost publishes running state before opening CoreAudio', async () => {
  const source = await Bun.file(new URL('../src/audio-host.cpp', import.meta.url)).text()
  const start = source.slice(source.indexOf('bool AudioHost::Start()'))
  const runningPublication = start.indexOf('impl_->state.store(LifecycleState::kRunning')
  const deviceOpen = start.indexOf('StartCoreAudioDevice(')
  expect(runningPublication).toBeGreaterThanOrEqual(0)
  expect(deviceOpen).toBeGreaterThan(runningPublication)
})

test('render-enabled native VST processing is not gated by tail metadata or silence gaps', async () => {
  const source = await Bun.file(new URL('../src/audio-host.cpp', import.meta.url)).text()
  const processStart = source.indexOf('void Process(const daw::audio_core::NativeGraphNodeRender& render)')
  const processEnd = source.indexOf('\n  }\n};', processStart)
  expect(processStart).toBeGreaterThanOrEqual(0)
  expect(processEnd).toBeGreaterThan(processStart)
  const process = source.slice(processStart, processEnd)
  expect(process).toContain('if (!metadata.render_enabled)')
  expect(process).toContain('port.Submit(')
  expect(process).not.toContain('ReadTailMetadata')
  expect(process).not.toContain('tail_remaining_frames')
  expect(process).not.toContain('silent_completion')
  expect(process).not.toContain('kNativeVstTailGraceFrames')
})
