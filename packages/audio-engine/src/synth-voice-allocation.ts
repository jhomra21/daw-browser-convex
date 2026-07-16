type SynthVoiceAllocation = {
  id: number
  scheduledStartTime: number
  releaseTime: number
  effectiveEndTime: number
}

export const isSynthVoiceSoundingAt = (voice: SynthVoiceAllocation, when: number) => (
  voice.scheduledStartTime <= when && voice.effectiveEndTime > when
)

export const pruneSynthVoiceAllocations = <Voice extends SynthVoiceAllocation>(
  voices: readonly Voice[],
  when: number,
) => voices.filter((voice) => voice.effectiveEndTime > when)

export const chooseSynthVoiceVictim = <Voice extends SynthVoiceAllocation>(
  voices: readonly Voice[],
  polyphony: number,
  when: number,
): Voice | undefined => {
  let sounding = 0
  let oldestSounding: Voice | undefined
  let oldestReleased: Voice | undefined
  const isOlder = (candidate: Voice, current: Voice | undefined) => (
    !current
      || candidate.releaseTime < current.releaseTime
      || (candidate.releaseTime === current.releaseTime && (
        candidate.scheduledStartTime < current.scheduledStartTime
        || (candidate.scheduledStartTime === current.scheduledStartTime && candidate.id < current.id)
      ))
  )
  for (const voice of voices) {
    if (!isSynthVoiceSoundingAt(voice, when)) continue
    sounding += 1
    if (isOlder(voice, oldestSounding)) oldestSounding = voice
    if (voice.releaseTime <= when && isOlder(voice, oldestReleased)) oldestReleased = voice
  }
  return sounding < polyphony ? undefined : oldestReleased ?? oldestSounding
}
