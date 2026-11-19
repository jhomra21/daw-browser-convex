import { createMemo, onCleanup, type Accessor } from 'solid-js'
import { isLocalId } from '@daw-browser/shared'
import { getProjectSaveStatus, type ProjectSaveStatusInput } from '~/lib/project-save-status'
import { acquireLocalEntityWriteQueue } from '~/lib/local-write-queue'

export const useProjectSaveStatus = (input: Accessor<ProjectSaveStatusInput>) => {
  const projectId = createMemo(() => input().projectId)
  const localWriteQueue = createMemo(() => {
    if (!isLocalId('project', projectId())) return undefined
    const { queue, release } = acquireLocalEntityWriteQueue(projectId())
    onCleanup(release)
    return queue
  })

  const status = createMemo(() => getProjectSaveStatus({
    ...input(),
    localTimelineWriteStatus: localWriteQueue()?.getStatusAccessor()(),
  }))
  return status
}
