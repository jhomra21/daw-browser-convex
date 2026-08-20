export {
  controlApprovalRequirementV1,
  destructiveControlActionKindsV1,
  planControlRequestV1,
  rebaseRecoveryAutomationParameterIdV1,
} from './planner'
export type {
  ControlPlanError,
  ControlPlanV1,
  PlannedControlActionV1,
} from './planner'

export {
  normalizeControlMidiActionV1,
  resolveControlMidiActionV1,
} from './midi'
export { buildTimelineRangeDeletePatchV1 } from './timeline-range-delete'
export type { TimelineRangeDeletePatchV1 } from './timeline-range-delete'
export {
  collectDeletedTrackIdsV1,
  collectTrackDeletionAffectedIdsV1,
} from './trackDeletion'
export { mergeRecoveryTrackOrderV1 } from './recovery-track-order'

export {
  compareControlSnapshotText,
  projectControlSnapshotCoreV1,
  projectControlSnapshotCoreV2,
} from './projection'
export type { ControlProjectSnapshotInput } from './projection'

import {
  projectControlSnapshotCoreV1,
  projectControlSnapshotCoreV2,
  type ControlProjectSnapshotInput,
} from './projection'
import {
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
} from '@daw-browser/control'

export const projectControlSnapshotV1 = (input: ControlProjectSnapshotInput) => (
  projectControlSnapshotCoreV1(input, projectSnapshotSchemaV1)
)
export const projectControlSnapshotV2 = (input: ControlProjectSnapshotInput) => (
  projectControlSnapshotCoreV2(input, projectSnapshotSchemaV2)
)
