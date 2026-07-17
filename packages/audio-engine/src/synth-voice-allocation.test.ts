import { describe, expect, test } from 'bun:test'
import { chooseSynthVoiceVictim, pruneSynthVoiceAllocations } from './synth-voice-allocation'

const voice = (id: number, start: number, release: number, end: number) => ({
  id,
  scheduledStartTime: start,
  releaseTime: release,
  effectiveEndTime: end,
})

describe('synth voice allocation', () => {
  test('does not let future scheduled voices consume current polyphony', () => {
    const future = voice(1, 10, 11, 12)

    expect(chooseSynthVoiceVictim([future], 1, 1)).toBeUndefined()
  })

  test('prefers released voices, then uses oldest deterministic tie-breaking', () => {
    const active = voice(1, 0, 10, 11)
    const released = voice(2, 1, 2, 12)
    const equallyReleased = voice(3, 1, 2, 12)

    expect(chooseSynthVoiceVictim([active, equallyReleased, released], 2, 3)?.id).toBe(2)
  })

  test('prunes only voices ended before the chronological scheduling point', () => {
    const ended = voice(1, 0, 1, 2)
    const future = voice(2, 10, 11, 12)

    expect(pruneSynthVoiceAllocations([ended, future], 3)).toEqual([future])
  })
})
