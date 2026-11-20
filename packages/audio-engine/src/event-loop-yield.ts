export const yieldToEventLoop = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    channel.port2.close()
    resolve()
  }

  channel.port2.postMessage(null)
})
