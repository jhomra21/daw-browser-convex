import { z } from 'zod'
import { parseSharedTimelineOperation, type SharedTimelineOperation } from './shared-timeline-operations'

export const sharedTimelineOperationSchema = z.preprocess(
  parseSharedTimelineOperation,
  z.custom<SharedTimelineOperation>((value) => value !== null),
)
