import type { RecordingDeliveryDump } from "./recording-delivery-trace"

declare global {
  var __dawRecordingDeliveryTraceEnabled: boolean | undefined
  var __dawRecordingDeliveryEvidence: RecordingDeliveryDump | undefined
  var __dawRecordingMainDeliveryEvidence: RecordingDeliveryDump | undefined
}

export type RecordingDeliveryEvidenceObserver = {
  enabled(): boolean
  reset(): void
  publishRenderer(dump: NonNullable<RecordingDeliveryDump>): void
}

export const createRecordingDeliveryEvidenceObserver = (
  target: Pick<typeof globalThis, "__dawRecordingDeliveryTraceEnabled" | "__dawRecordingDeliveryEvidence" | "__dawRecordingMainDeliveryEvidence">,
): RecordingDeliveryEvidenceObserver => ({
  enabled: () => target.__dawRecordingDeliveryTraceEnabled === true,
  reset() {
    target.__dawRecordingDeliveryEvidence = null
    target.__dawRecordingMainDeliveryEvidence = null
  },
  publishRenderer(dump) {
    target.__dawRecordingDeliveryEvidence = dump
  },
})
