import { expect, test } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  finalizeSerializableSha256State,
  initialSerializableSha256State,
  parseSerializableSha256State,
  updateSerializableSha256State,
} from './resumable-sha256'

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

test('serializable SHA-256 state matches noble across awkward chunk boundaries', () => {
  const input = new Uint8Array(257)
  for (let index = 0; index < input.length; index += 1) input[index] = (index * 31 + 7) % 256
  let state = initialSerializableSha256State()
  for (const [start, end] of [[0, 1], [1, 63], [63, 64], [64, 129], [129, 193], [193, 257]]) {
    state = updateSerializableSha256State(state, input.slice(start, end))
    expect(state.totalBytes).toBe(end)
    expect(state.tail.length).toBe(end % 64)
    expect(parseSerializableSha256State(state)).toEqual(state)
  }
  expect(finalizeSerializableSha256State(state)).toBe(hex(sha256(input)))
})

test('serializable SHA-256 state rejects malformed and oversized tails', () => {
  expect(() => parseSerializableSha256State({
    words: [0, 0, 0, 0, 0, 0, 0],
    totalBytes: 0,
    tail: [],
  })).toThrow()
  expect(() => parseSerializableSha256State({
    words: [0, 0, 0, 0, 0, 0, 0, 0],
    totalBytes: 1,
    tail: [],
  })).toThrow()
})
