const percentile = (values: readonly number[], ratio: number) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

const distribution = (values: readonly number[]) => ({
  min: Math.min(...values),
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
})

export const createRecordingIpcDiagnostics = (startedAt: number) => {
  const frameCounts: number[] = []
  const channelCounts = new Set<number>()
  const payloadBytes: number[] = []
  const sendDurations: number[] = []
  let totalPayloadBytes = 0
  let count = 0
  return {
    recordBlock(input: { frameCount: number; channelCount: number; payloadBytes: number }) {
      count += 1
      if (frameCounts.length < 2_048) {
        frameCounts.push(input.frameCount)
        payloadBytes.push(input.payloadBytes)
      }
      channelCounts.add(input.channelCount)
      totalPayloadBytes += input.payloadBytes
    },
    recordSend(sendMs: number) {
      if (sendDurations.length < 2_048) sendDurations.push(sendMs)
    },
    report(at: number) {
      const seconds = Math.max(0.001, (at - startedAt) / 1_000)
      return {
        seconds,
        count,
        blocksPerSecond: count / seconds,
        channelCounts: [...channelCounts].sort((left, right) => left - right),
        frameCount: distribution(frameCounts),
        payloadBytes: distribution(payloadBytes),
        payloadBytesPerSecond: totalPayloadBytes / seconds,
        sendMs: {
          p50: percentile(sendDurations, 0.5),
          p95: percentile(sendDurations, 0.95),
          p99: percentile(sendDurations, 0.99),
          max: Math.max(...sendDurations),
        },
      }
    },
  }
}

export const createRendererTrafficDiagnostics = (startedAt: number) => {
  const channels = new Map<string, { count: number; bytes: number }>()
  return {
    record(channel: string, estimatedBytes: number) {
      const current = channels.get(channel) ?? { count: 0, bytes: 0 }
      channels.set(channel, {
        count: current.count + 1,
        bytes: current.bytes + Math.max(0, estimatedBytes),
      })
    },
    report(at: number) {
      const seconds = Math.max(0.001, (at - startedAt) / 1_000)
      return {
        seconds,
        channels: Object.fromEntries([...channels].map(([channel, value]) => [channel, {
          count: value.count,
          messagesPerSecond: value.count / seconds,
          estimatedBytesPerSecond: value.bytes / seconds,
        }])),
      }
    },
  }
}
