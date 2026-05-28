import { flushPendingPersistedEffectWrites } from '~/lib/local-effect-write-flush'
import { flushPendingProjectStateWrites } from '~/lib/local-project-state-write-flush'
import { flushLocalTimelineWrites } from '~/lib/timeline-repository/local-timeline-repository'

export const flushLocalProjectPendingWrites = async (projectId: string): Promise<void> => {
  await flushPendingPersistedEffectWrites(projectId)
  await flushPendingProjectStateWrites(projectId)
  await flushLocalTimelineWrites(projectId)
}
