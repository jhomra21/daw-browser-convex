import { detectLoopBpm, getBpmAnalysisFrameCount, type BpmDetectionResult } from '@daw-browser/audio-engine/bpm-detection'
import { normalizeAudioWarp } from '@daw-browser/shared'
import type { AudioWarp, Clip } from '@daw-browser/timeline-core/types'

export type BpmSuggestionState =
  | { status: 'idle' }
  | { status: 'analyzing' }
  | { status: 'suggested'; result: BpmDetectionResult }
  | { status: 'applied'; result: BpmDetectionResult }
  | { status: 'failed'; message: string }

type AnalyzeClipInput = {
  clip: Pick<Clip<AudioBuffer>, 'id' | 'audioWarp' | 'buffer'>
  canWrite: boolean
  autoApply: (audioWarp: AudioWarp) => Promise<boolean>
}

type BpmSuggestionListener = () => void

const HIGH_CONFIDENCE = 0.62

const readChannels = (buffer: AudioBuffer) => {
  const analysisFrames = getBpmAnalysisFrameCount(buffer.length, buffer.sampleRate)
  const channels: Float32Array[] = []
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
    channels.push(buffer.getChannelData(channelIndex).subarray(0, analysisFrames))
  }
  return channels
}

export function createBpmDetectionService() {
  const states = new Map<string, BpmSuggestionState>()
  const tokens = new Map<string, number>()
  const listeners = new Set<BpmSuggestionListener>()
  let nextToken = 1

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const setState = (clipId: string, state: BpmSuggestionState) => {
    states.set(clipId, state)
    notify()
  }

  const analyzeClip = async (input: AnalyzeClipInput) => {
    const buffer = input.clip.buffer
    if (!buffer) {
      setState(input.clip.id, { status: 'failed', message: 'Audio buffer is not loaded.' })
      return null
    }

    const token = nextToken
    nextToken += 1
    tokens.set(input.clip.id, token)
    setState(input.clip.id, { status: 'analyzing' })

    await Promise.resolve()
    const result = detectLoopBpm({
      channels: readChannels(buffer),
      sampleRate: buffer.sampleRate,
    })

    if (tokens.get(input.clip.id) !== token) return result
    if (!result) {
      setState(input.clip.id, { status: 'failed', message: 'No confident loop tempo was found.' })
      return null
    }

    if (result.confidence >= HIGH_CONFIDENCE && input.canWrite) {
      const audioWarp = normalizeAudioWarp({
        enabled: true,
        sourceBpm: result.bpm,
        mode: 'stretch',
      })
      const applied = audioWarp ? await input.autoApply(audioWarp) : false
      setState(input.clip.id, applied ? { status: 'applied', result } : { status: 'suggested', result })
      return result
    }

    setState(input.clip.id, { status: 'suggested', result })
    return result
  }

  const markApplied = (clipId: string) => {
    const state = states.get(clipId)
    if (state?.status !== 'suggested') return
    setState(clipId, { status: 'applied', result: state.result })
  }

  return {
    analyzeClip,
    markApplied,
    getState: (clipId: string) => states.get(clipId) ?? { status: 'idle' },
    subscribe: (listener: BpmSuggestionListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type BpmDetectionService = ReturnType<typeof createBpmDetectionService>
