// The factory is closure-free so the same tested bounded accumulator runs
// inside the disposable renderer's existing read-only status subscription.
export const createSpoolStatusObservation = () => {
  const statuses: { capturedFrames: number; droppedFrames: number; droppedBlocks: number; availableBlocks: number;
    queuedBlocks: number; fatal: boolean; active: boolean; configured: boolean;
    spool?: { state: number; error: number; systemError: number } | null }[] = []
  const summary = { count: 0, overwritten: 0, maxQueuedBlocks: 0, maxPoolBlocks: 0, failed: false }
  return {
    statuses, summary,
    observe(status: typeof statuses[number]) {
      summary.count++
      summary.maxQueuedBlocks = Math.max(summary.maxQueuedBlocks, status.queuedBlocks)
      summary.maxPoolBlocks = Math.max(summary.maxPoolBlocks, status.availableBlocks + status.queuedBlocks)
      summary.failed ||= status.fatal || status.droppedFrames !== 0 || status.droppedBlocks !== 0
        || !Number.isInteger(status.availableBlocks) || !Number.isInteger(status.queuedBlocks)
        || status.availableBlocks < 0 || status.queuedBlocks < 0 || summary.maxPoolBlocks > 32
        || !status.spool || status.spool.error !== 0 || status.spool.systemError !== 0
      if (statuses.length === 64) { statuses.shift(); summary.overwritten++ }
      statuses.push(status)
    },
  }
}
