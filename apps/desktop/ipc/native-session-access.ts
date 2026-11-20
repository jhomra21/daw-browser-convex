import { rendererSenderAllowed, type RendererSenderEvent } from "./renderer-sender"

export type NativeSessionEvent = RendererSenderEvent

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- IPC input validation happens inside the registered handler.
export type NativeSessionIpcHandler = (event: NativeSessionEvent, value: unknown) => unknown

export const nativeSessionRequestAllowed = (input: {
  platform: string
  architecture: string
  rendererId: number | undefined
  acceptsPrivilegedRequests: boolean
  event: NativeSessionEvent
  sameAppOrigin: (url: string) => boolean
}) => (
  input.platform === "darwin"
  && input.architecture === "arm64"
  && rendererSenderAllowed(input.event, {
    rendererId: input.rendererId,
    sameAppOrigin: input.sameAppOrigin,
    privileged: { required: true, accepted: input.acceptsPrivilegedRequests },
    mainFrameOnly: false,
  })
)
