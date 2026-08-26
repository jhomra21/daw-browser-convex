export type LiveProcessorParameterValue = {
  parameterId: string
  value: number
}

export type LiveProcessorControlRequest = {
  instanceId: string
  values: readonly LiveProcessorParameterValue[]
  revision?: number
  epoch?: number
  sequence?: number
}

export type LiveProcessorControlResult =
  | {
      accepted: true
      sequence: number
      appliedSequence?: number
    }
  | {
      accepted: false
      reason: 'unavailable' | 'unprepared' | 'stale' | 'unsupported' | 'overflow' | 'bridge-error'
      error?: string
    }

export type LiveProcessorControlRejectReason = Extract<
  LiveProcessorControlResult,
  { accepted: false }
>["reason"]

export type LiveProcessorControl = {
  preview: (request: LiveProcessorControlRequest) => LiveProcessorControlResult | Promise<LiveProcessorControlResult>
  flush: (request: LiveProcessorControlRequest) => Promise<LiveProcessorControlResult>
  reenableAutomation: (instanceId: string, parameterIds: readonly string[], revision: number, epoch: number) => Promise<LiveProcessorControlResult>
}

export const rejectedLiveProcessorControl = (
  reason: LiveProcessorControlRejectReason,
): LiveProcessorControlResult => ({ accepted: false, reason })
