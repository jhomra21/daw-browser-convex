export const createBenchmarkBlockCost = () => {
  let lastPublishedAt = 0
  let blocks = 0
  let copyMaxMs = 0
  let enqueueMaxMs = 0
  let totalMaxMs = 0
  return {
    add(atMs: number, copyMs: number, enqueueMs: number, totalMs: number) {
      blocks += 1
      copyMaxMs = Math.max(copyMaxMs, copyMs)
      enqueueMaxMs = Math.max(enqueueMaxMs, enqueueMs)
      totalMaxMs = Math.max(totalMaxMs, totalMs)
      if (atMs - lastPublishedAt < 5_000) return null
      lastPublishedAt = atMs
      const result = { blocks, copyMaxMs, enqueueMaxMs, totalMaxMs }
      blocks = 0
      copyMaxMs = 0
      enqueueMaxMs = 0
      totalMaxMs = 0
      return result
    },
  }
}
