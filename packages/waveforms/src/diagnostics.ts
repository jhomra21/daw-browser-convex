import {
  arrangementWaveformPcmScheduler,
  type ArrangementWaveformPcmDiagnostics,
} from './arrangement-waveform-pcm'

export type ArrangementWaveformDiagnostics = ArrangementWaveformPcmDiagnostics

export const getArrangementWaveformDiagnostics = (): ArrangementWaveformDiagnostics => (
  arrangementWaveformPcmScheduler.getDiagnostics()
)
