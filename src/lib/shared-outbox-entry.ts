import type { SharedTimelineOperationKind } from '~/lib/shared-timeline-operations-api'
import type { LocalProjectStoredValue } from '~/lib/local-project-db'
import type { Track } from '@daw-browser/timeline-core/types'
import type { TrackAutomationSnapshot, TrackEffectSnapshot } from '~/lib/undo/types'

export type SharedOutboxStatus = 'pending' | 'failed' | 'dead-letter' | 'completed'

export type SharedOutboxKind = SharedTimelineOperationKind | 'clips.createUploadedAudio'

export type SharedOutboxEntry = {
  id: string
  kind: SharedOutboxKind
  projectId: string
  userId: string
  payload: LocalProjectStoredValue
  completion?: SharedOutboxCompletion
  // The publisher reads this entry's result after admission, so a result another drain records waits for it.
  ownerAwaitsCompletion?: true
  status: SharedOutboxStatus
  attempts: number
  nextAttemptAt: number
  lastError?: string
  sequence?: number
  claimOwner?: string
  claimToken?: string
  leaseExpiresAt?: number
  retryFileCleanup?: { projectId: string; storagePath: string }
  createdAt: number
  updatedAt: number
}

export type SharedOutboxCompletion = {
  kind: 'tracks.ungroup'
  tracks: Track[]
  groupTrack: Track
  effects: TrackEffectSnapshot
  automation: TrackAutomationSnapshot
}
