// A wheel has no terminal event: whatever a burst of wheel ticks opens (a viewport zoom, a device parameter
// gesture) is committed once the wheel has been quiet for this long.
export const WHEEL_IDLE_MS = 150
