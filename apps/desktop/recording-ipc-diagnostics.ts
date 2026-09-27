export type RecordingForwardMode = "full" | "drop" | "metadata" | "batch4" | "batch8"

export const parseRecordingForwardMode = (value: string | undefined): RecordingForwardMode =>
  value === "drop" || value === "metadata" || value === "batch4" || value === "batch8" ? value : "full"

type ForwardedRecordingBlock = {
  generation: number
  sessionId: bigint
  sequence: number
  frameCount: number
  channelCount: number
  planarPcm: Uint8Array
}

export const createRecordingBlockForwarder = <Block extends ForwardedRecordingBlock>(mode: RecordingForwardMode) => {
  const batchSize = mode === "batch4" ? 4 : mode === "batch8" ? 8 : 1
  let queued: Block[] = []
  const flush = () => {
    if (queued.length === 0) return []
    const blocks = queued
    queued = []
    return [{ kind: "blocks" as const, blocks }]
  }
  return {
    push(block: Block) {
      if (mode === "drop") return []
      if (mode === "metadata") return [{
        kind: "metadata" as const,
        metadata: {
          generation: block.generation,
          sessionId: block.sessionId,
          sequence: block.sequence,
          frameCount: block.frameCount,
          channelCount: block.channelCount,
          payloadByteLength: block.planarPcm.byteLength,
        },
      }]
      if (mode === "full") return [{ kind: "blocks" as const, blocks: [block] }]
      queued.push(block)
      return queued.length === batchSize ? flush() : []
    },
    flush,
  }
}

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

export const createStatusSampler = () => {
  let lastForwardedAt = Number.NEGATIVE_INFINITY
  let lastState = ""
  return {
    shouldForward(status: {
      generation: number
      sessionId: bigint
      configured: boolean
      active: boolean
      fatal: boolean
      queuedBlocks: number
    }, at: number) {
      const state = `${status.generation}:${status.sessionId}:${status.configured}:${status.active}:${status.fatal}:${!status.active && status.queuedBlocks === 0}`
      if (state === lastState && at - lastForwardedAt < 250) return false
      lastState = state
      lastForwardedAt = at
      return true
    },
  }
}
