import {
  arrangementWaveformScheduler,
  type ArrangementWaveformDiagnostics,
} from './arrangement-waveform'

export type { ArrangementWaveformDiagnostics }

export const getArrangementWaveformDiagnostics = (): ArrangementWaveformDiagnostics => (
  arrangementWaveformScheduler.getDiagnostics()
)
