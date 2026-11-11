import { createMemo, type Accessor } from 'solid-js'
import { isLocalId } from '@daw-browser/shared'
import { getProjectSaveStatus, type ProjectSaveStatusInput } from '~/lib/project-save-status'
import { getLocalEntityWriteStatusAccessor } from '~/lib/local-write-queue'

export const useProjectSaveStatus = (input: Accessor<ProjectSaveStatusInput>) => {
  const localWriteStatus = createMemo(() => {
    const projectId = input().projectId
    return isLocalId('project', projectId)
      ? getLocalEntityWriteStatusAccessor(projectId)()
      : undefined
  })

  const status = createMemo(() => getProjectSaveStatus({
    ...input(),
    localTimelineWriteStatus: localWriteStatus(),
  }))
  return status
}
