import { expect, test } from 'bun:test'
import { createLiveMidiRouter, type LiveMidiNoteHandle } from './live-midi-router'

const noteOn = (sourceId: string, channel: number, note: number, timeStamp: number) => ({
  sourceId, channel, note, timeStamp, velocity: 1, kind: 'note-on' as const,
})
const noteOff = (sourceId: string, channel: number, note: number, timeStamp: number) => ({
  sourceId, channel, note, timeStamp, velocity: 0, kind: 'note-off' as const,
})

test('releases duplicate note-ons FIFO without crossing source or channel boundaries', () => {
  const released: number[] = []
  let nextId = 1
  const router = createLiveMidiRouter({
    acceptsChannel: () => true,
    startNote: () => ({ id: nextId++ }),
    releaseNote: (handle) => released.push(handle.id),
    applyExpression: () => undefined,
  })
  router.receive(noteOn('one', 1, 60, 1))
  router.receive(noteOn('one', 1, 60, 2))
  router.receive(noteOn('two', 1, 60, 3))
  router.receive(noteOff('one', 1, 60, 4))
  router.receive(noteOff('two', 1, 60, 5))
  router.receive(noteOff('one', 1, 60, 6))
  expect(released).toEqual([1, 3, 2])
})

test('defers note-off under sustain and drains it on pedal release', () => {
  const released: LiveMidiNoteHandle[] = []
  const router = createLiveMidiRouter({
    acceptsChannel: () => true,
    startNote: () => ({ id: 1 }),
    releaseNote: (handle) => released.push(handle),
    applyExpression: () => undefined,
  })
  router.receive(noteOn('one', 1, 60, 1))
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 2, kind: 'control-change', controller: 64, value: 1 })
  router.receive(noteOff('one', 1, 60, 3))
  expect(released).toEqual([])
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 4, kind: 'control-change', controller: 64, value: 0 })
  expect(released).toEqual([{ id: 1 }])
})

test('source resets release only the source state', () => {
  const released: number[] = []
  let nextId = 1
  const router = createLiveMidiRouter({
    acceptsChannel: () => true,
    startNote: () => ({ id: nextId++ }),
    releaseNote: (handle) => released.push(handle.id),
    applyExpression: () => undefined,
  })
  router.receive(noteOn('one', 1, 60, 1))
  router.receive(noteOn('two', 1, 60, 2))
  router.resetSource('one')
  expect(released).toEqual([1])
  router.panic()
  expect(released).toEqual([1, 2])
})

test('all sound off releases held notes even when sustain is active', () => {
  const released: Array<{ id: number; force: boolean | undefined }> = []
  const router = createLiveMidiRouter({
    acceptsChannel: () => true,
    startNote: () => ({ id: 1 }),
    releaseNote: (handle, _timeStamp, force) => released.push({ id: handle.id, force }),
    applyExpression: () => undefined,
  })
  router.receive(noteOn('one', 1, 60, 1))
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 2, kind: 'control-change', controller: 64, value: 1 })
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 3, kind: 'control-change', controller: 120, value: 0 })
  expect(released).toEqual([{ id: 1, force: true }])
})

test('all notes off uses ordinary release and respects sustain', () => {
  const released: Array<{ id: number; force: boolean | undefined }> = []
  const router = createLiveMidiRouter({
    acceptsChannel: () => true,
    startNote: () => ({ id: 1 }),
    releaseNote: (handle, _timeStamp, force) => released.push({ id: handle.id, force }),
    applyExpression: () => undefined,
  })
  router.receive(noteOn('one', 1, 60, 1))
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 2, kind: 'control-change', controller: 123, value: 0 })
  expect(released).toEqual([{ id: 1, force: false }])

  router.receive(noteOn('one', 1, 61, 3))
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 4, kind: 'control-change', controller: 64, value: 1 })
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 5, kind: 'control-change', controller: 123, value: 0 })
  expect(released).toEqual([{ id: 1, force: false }])
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 6, kind: 'control-change', controller: 64, value: 0 })
  expect(released).toEqual([{ id: 1, force: false }, { id: 1, force: false }])
})

test('reset all controllers releases only sustain-deferred notes', () => {
  const released: number[] = []
  let nextId = 1
  const router = createLiveMidiRouter({
    acceptsChannel: () => true,
    startNote: () => ({ id: nextId++ }),
    releaseNote: (handle) => released.push(handle.id),
    applyExpression: () => undefined,
  })
  router.receive(noteOn('one', 1, 60, 1))
  router.receive(noteOn('one', 1, 61, 2))
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 3, kind: 'control-change', controller: 64, value: 1 })
  router.receive(noteOff('one', 1, 60, 4))
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 5, kind: 'control-change', controller: 121, value: 0 })
  expect(released).toEqual([1])
  router.receive(noteOff('one', 1, 61, 6))
  expect(released).toEqual([1, 2])
})

test('selection changes preserve an admitted note until ordinary note-off', () => {
  const released: Array<{ id: number; force: boolean | undefined }> = []
  let admitted = true
  const router = createLiveMidiRouter({
    acceptsChannel: () => admitted,
    startNote: () => ({ id: 1 }),
    releaseNote: (handle, _timeStamp, force) => released.push({ id: handle.id, force }),
    applyExpression: () => undefined,
  })
  router.receive(noteOn('one', 1, 60, 1))
  admitted = false
  router.receive(noteOff('one', 1, 60, 2))
  expect(released).toEqual([{ id: 1, force: false }])
})

test('panic clears filtered sustain state before a newly admitted note arrives', () => {
  const released: number[] = []
  let admitted = false
  const router = createLiveMidiRouter({
    acceptsChannel: () => admitted,
    startNote: () => ({ id: 1 }),
    releaseNote: (handle) => released.push(handle.id),
    applyExpression: () => undefined,
  })
  router.receive({ sourceId: 'one', channel: 1, timeStamp: 1, kind: 'control-change', controller: 64, value: 1 })
  admitted = true
  router.panic()
  router.receive(noteOn('one', 1, 60, 2))
  router.receive(noteOff('one', 1, 60, 3))
  expect(released).toEqual([1])
})

test('routes sustain and panic controllers through expression exactly once', () => {
  const expressions: Array<{ controller: number; value: number; channel: number; sourceId: string }> = []
  const router = createLiveMidiRouter({
    acceptsChannel: () => true,
    startNote: () => ({ id: 1 }),
    releaseNote: () => undefined,
    applyExpression: (event) => {
      if (event.kind === 'control-change') {
        expressions.push({
          controller: event.controller,
          value: event.value,
          channel: event.channel,
          sourceId: event.sourceId,
        })
      }
    },
  })

  for (const controller of [64, 120, 121, 123]) {
    router.receive({ sourceId: 'device-1', channel: 3, timeStamp: controller, kind: 'control-change', controller, value: 0.5 })
  }

  expect(expressions).toEqual([
    { controller: 64, value: 0.5, channel: 3, sourceId: 'device-1' },
    { controller: 120, value: 0.5, channel: 3, sourceId: 'device-1' },
    { controller: 121, value: 0.5, channel: 3, sourceId: 'device-1' },
    { controller: 123, value: 0.5, channel: 3, sourceId: 'device-1' },
  ])
})
