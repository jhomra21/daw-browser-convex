import { createStoredValue } from '~/lib/stored-value'
import { FX_PANEL_HEIGHT_PX } from '~/lib/timeline-utils'

const BOTTOM_PANEL_MIN_HEIGHT_PX = FX_PANEL_HEIGHT_PX
export const BOTTOM_PANEL_DEFAULT_HEIGHT_PX = FX_PANEL_HEIGHT_PX
const BOTTOM_PANEL_HEIGHT_KEY_PREFIX = 'bottom-panel-height:'

export const clampBottomPanelHeight = (heightPx: number, viewportHeightPx: number) => {
  const safeHeightPx = Number.isFinite(heightPx) ? heightPx : BOTTOM_PANEL_DEFAULT_HEIGHT_PX
  const maxHeight = Math.max(BOTTOM_PANEL_MIN_HEIGHT_PX, Math.floor(viewportHeightPx * 0.5))

  return Math.min(maxHeight, Math.max(BOTTOM_PANEL_MIN_HEIGHT_PX, Math.round(safeHeightPx)))
}

const bottomPanelHeight = createStoredValue<number>({
  key: (scopeId) => `${BOTTOM_PANEL_HEIGHT_KEY_PREFIX}${scopeId}`,
  fallback: () => BOTTOM_PANEL_DEFAULT_HEIGHT_PX,
  parse: Number,
  serialize: String,
})

export const loadBottomPanelHeight = (scopeId: string, viewportHeightPx: number) => (
  clampBottomPanelHeight(bottomPanelHeight.read(scopeId), viewportHeightPx)
)

export const saveBottomPanelHeight = (scopeId: string, heightPx: number, viewportHeightPx: number) => {
  const clamped = clampBottomPanelHeight(heightPx, viewportHeightPx)

  bottomPanelHeight.write(scopeId, clamped)

  return clamped
}
