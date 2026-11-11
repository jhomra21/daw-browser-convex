// Solid re-dispatches delegated events from portalled overlays (context menus) to their logical ancestors,
// so a handler can receive a pointerdown whose target is outside its own DOM subtree. Pointer capture on
// that event steals the overlay item's pointerup and click.
export const isEventFromDomDescendant = (event: Pick<Event, "currentTarget" | "target">) => (
  event.currentTarget instanceof Node
  && event.target instanceof Node
  && event.currentTarget.contains(event.target)
)
