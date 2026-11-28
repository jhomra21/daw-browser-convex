type SenderFrame = { url: string }

export type RendererSenderEvent = {
  sender: { id: number; mainFrame: SenderFrame }
  senderFrame: SenderFrame | null
}

export type RendererSenderPolicy = {
  rendererId: number | undefined
  sameAppOrigin: (url: string) => boolean
  // Requests that act on the renderer's privileges also require the lifecycle to be accepting them.
  privileged: { required: boolean; accepted: boolean }
  mainFrameOnly: boolean
}

/** The one decision on whether an IPC sender is the trusted renderer window. */
export const rendererSenderAllowed = (event: RendererSenderEvent, policy: RendererSenderPolicy) => (
  policy.rendererId !== undefined
  && (!policy.privileged.required || policy.privileged.accepted)
  && event.sender.id === policy.rendererId
  && event.senderFrame !== null
  && (!policy.mainFrameOnly || event.senderFrame === event.sender.mainFrame)
  && policy.sameAppOrigin(event.senderFrame.url)
)
