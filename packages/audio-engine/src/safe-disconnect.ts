// Disconnecting a node that is not connected to the target throws, and teardown must go on to the next node.
export const safeDisconnect = (node: AudioNode | null | undefined, target?: AudioNode) => {
  try {
    if (target) node?.disconnect(target)
    else node?.disconnect()
  } catch {}
}
