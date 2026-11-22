// Ref callback that attaches a native listener, bypassing Solid's delegated events.
// Pass it to `ref` on an element that needs the listener to fire on the element itself.
export const nativeListener = <K extends keyof GlobalEventHandlersEventMap>(
  type: K,
  handler: (event: GlobalEventHandlersEventMap[K]) => void,
  options?: AddEventListenerOptions,
) => (element: GlobalEventHandlers) => {
  element.addEventListener(type, handler, options)
}
