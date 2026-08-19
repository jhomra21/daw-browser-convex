export type RendererDeliveryTarget = {
  isDestroyed: () => boolean
  getURL: () => string
  send: (channel: string, ...args: unknown[]) => void
}

type RendererDeliveryOptions = {
  getTarget: () => RendererDeliveryTarget | undefined
  channel: string
  args: readonly unknown[]
  sameOrigin: (url: string) => boolean
  isFinishingQuit?: () => boolean
}

const isElectronDestroyedError = (error: Error) => error.message.includes("Object has been destroyed")

export const deliverToRenderer = ({
  getTarget,
  channel,
  args,
  sameOrigin,
  isFinishingQuit = () => false,
}: RendererDeliveryOptions) => {
  const target = getTarget()
  if (!target || isFinishingQuit()) return false

  try {
    if (target.isDestroyed() || !sameOrigin(target.getURL())) return false
    if (getTarget() !== target || isFinishingQuit() || target.isDestroyed() || !sameOrigin(target.getURL())) return false
    target.send(channel, ...args)
    return true
  } catch (error) {
    if (error instanceof Error && isElectronDestroyedError(error)) return false
    throw error
  }
}
