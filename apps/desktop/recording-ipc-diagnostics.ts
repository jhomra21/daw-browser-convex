const percentile = (values: readonly number[], ratio: number) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

const distribution = (values: readonly number[]) => ({
  min: values.length ? Math.min(...values) : 0,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Math.max(...values) : 0,
})

export const createRecordingIpcDiagnostics = (startedAt: number) => {
  const frameCounts = new Float64Array(512)
  const payloadBytes = new Float64Array(512)
  const sendDurations = new Float64Array(512)
  const channelCounts = new Uint8Array(3)
  let sends = 0
  let totalPayloadBytes = 0
  let count = 0
  return {
    recordBlock(input: { frameCount: number; channelCount: number; payloadBytes: number }) {
      frameCounts[count % 512] = input.frameCount
      payloadBytes[count % 512] = input.payloadBytes
      count += 1
      if (input.channelCount === 1 || input.channelCount === 2) channelCounts[input.channelCount] = 1
      totalPayloadBytes += input.payloadBytes
    },
    recordSend(sendMs: number) {
      sendDurations[sends % 512] = sendMs
      sends += 1
    },
    report(at: number) {
      const seconds = Math.max(0.001, (at - startedAt) / 1_000)
      const durations = Array.from(sendDurations.subarray(0, Math.min(sends, 512)))
      return {
        seconds,
        count,
        blocksPerSecond: count / seconds,
        channelCounts: [1, 2].filter((channel) => channelCounts[channel] === 1),
        frameCount: distribution(Array.from(frameCounts.subarray(0, Math.min(count, 512)))),
        payloadBytes: distribution(Array.from(payloadBytes.subarray(0, Math.min(count, 512)))),
        payloadBytesPerSecond: totalPayloadBytes / seconds,
        sendMs: {
          p50: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
          p99: percentile(durations, 0.99),
          max: durations.length ? Math.max(...durations) : 0,
        },
      }
    },
  }
}

export const createRendererTrafficDiagnostics = (startedAt: number) => {
  const channels = new Map(["recording-block", "recording-status", "meter-batch", "spectrum-frame", "schedule-progress"]
    .map((channel) => [channel, { count: 0, bytes: 0 }]))
  return {
    record(channel: string, estimatedBytes: number) {
      const current = channels.get(channel)
      if (!current) return
      current.count += 1
      current.bytes += Math.max(0, estimatedBytes)
    },
    report(at: number) {
      const seconds = Math.max(0.001, (at - startedAt) / 1_000)
      return {
        seconds,
        channels: Object.fromEntries([...channels].filter(([, value]) => value.count > 0).map(([channel, value]) => [channel, {
          count: value.count,
          messagesPerSecond: value.count / seconds,
          estimatedBytesPerSecond: value.bytes / seconds,
        }])),
      }
    },
  }
}
