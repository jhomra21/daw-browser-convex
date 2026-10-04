import type { NativeSabRecordingWriterInput } from '~/lib/recording/native-sab-recording-writer'

export const benchmarkSabRecordingWriterFor = (
  bridge: { benchmarkSabRecording?: boolean } | undefined,
) => (
  bridge?.benchmarkSabRecording === true
    ? async (input: NativeSabRecordingWriterInput) => (
        await import('~/lib/recording/benchmark-sab-worker')
      ).createBenchmarkSabRecordingWriter(input)
    : undefined
)
