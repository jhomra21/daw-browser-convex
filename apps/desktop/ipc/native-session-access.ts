type SenderFrame = { url: string }

export type NativeSessionEvent = {
  sender: { id: number; mainFrame: SenderFrame }
  senderFrame: SenderFrame | null
}

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
  && input.rendererId !== undefined
  && input.acceptsPrivilegedRequests
  && input.event.sender.id === input.rendererId
  && input.event.senderFrame !== null
  && input.sameAppOrigin(input.event.senderFrame.url)
)
