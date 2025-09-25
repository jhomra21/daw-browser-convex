import { AudioEngine } from "~/lib/audio-engine"

let audioEngineSingleton: AudioEngine | null = null

export const getAudioEngine = () => {
  if (!audioEngineSingleton) {
    audioEngineSingleton = new AudioEngine()
  }
  return audioEngineSingleton
}

export const resetAudioEngine = () => {
  audioEngineSingleton = null
}
