import { expect, test } from 'bun:test'
import { readWriterOutboundMessage } from './recording-protocol'

test('accepts bounded return timestamps and rejects invalid timestamps', () => {
  const message = { type: 'return', generation: 1, sessionId: 'take', blockId: 0, buffer: new ArrayBuffer(8) }
  expect(readWriterOutboundMessage({ ...message, returnedAtMs: 1234 })).toMatchObject({ returnedAtMs: 1234 })
  for (const returnedAtMs of [-1, Infinity, NaN, '1234', Number.MAX_SAFE_INTEGER + 1]) {
    expect(readWriterOutboundMessage({ ...message, returnedAtMs })).toBeNull()
  }
  expect(readWriterOutboundMessage(message)).not.toBeNull()
})
