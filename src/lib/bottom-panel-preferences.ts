import { canUseLocalStorage } from '~/lib/timeline-storage'
import { FX_PANEL_HEIGHT_PX } from '~/lib/timeline-utils'

const BOTTOM_PANEL_MIN_HEIGHT_PX = FX_PANEL_HEIGHT_PX
export const BOTTOM_PANEL_DEFAULT_HEIGHT_PX = FX_PANEL_HEIGHT_PX
const BOTTOM_PANEL_HEIGHT_KEY_PREFIX = 'bottom-panel-height:'

export const clampBottomPanelHeight = (heightPx: number, viewportHeightPx: number) => {
  const safeHeightPx = Number.isFinite(heightPx) ? heightPx : BOTTOM_PANEL_DEFAULT_HEIGHT_PX
  const maxHeight = Math.max(BOTTOM_PANEL_MIN_HEIGHT_PX, Math.floor(viewportHeightPx * 0.5))
  return Math.min(maxHeight, Math.max(BOTTOM_PANEL_MIN_HEIGHT_PX, Math.round(safeHeightPx)))
}

export const loadBottomPanelHeight = (scopeId: string, viewportHeightPx: number) => {
  if (!canUseLocalStorage()) return clampBottomPanelHeight(BOTTOM_PANEL_DEFAULT_HEIGHT_PX, viewportHeightPx)
  try {
    const stored = localStorage.getItem(`${BOTTOM_PANEL_HEIGHT_KEY_PREFIX}${scopeId}`)
    const parsed = stored === null ? BOTTOM_PANEL_DEFAULT_HEIGHT_PX : Number(stored)
    return clampBottomPanelHeight(parsed, viewportHeightPx)
  } catch {
    return clampBottomPanelHeight(BOTTOM_PANEL_DEFAULT_HEIGHT_PX, viewportHeightPx)
  }
}

export const saveBottomPanelHeight = (scopeId: string, heightPx: number, viewportHeightPx: number) => {
  const clamped = clampBottomPanelHeight(heightPx, viewportHeightPx)
  if (!canUseLocalStorage()) return clamped
  try {
    localStorage.setItem(`${BOTTOM_PANEL_HEIGHT_KEY_PREFIX}${scopeId}`, String(clamped))
  } catch {}
  return clamped
}
