export const benchmarkSabRecordingEnabled = (bridge: { benchmarkSabRecording?: boolean } | undefined) => (
  bridge?.benchmarkSabRecording === true
)
