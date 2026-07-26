import { flushRegisteredLocalProjectWrites } from '~/lib/local-project-write-flushers'
import type { PendingWriteKind } from '~/lib/local-project-write-flushers'
import { flushLocalTimelineWrites } from '~/lib/timeline-repository/local-timeline-repository'
export { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-write-flushers'

export const flushLocalProjectPendingWrites = async (
  projectId: string,
  options?: { excludeKinds?: readonly PendingWriteKind[] },
): Promise<void> => {
  await flushRegisteredLocalProjectWrites(projectId, options)
  await flushLocalTimelineWrites(projectId)
}
