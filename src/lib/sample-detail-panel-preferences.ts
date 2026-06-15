import { canUseLocalStorage } from '~/lib/timeline-storage'

export const SAMPLE_DETAIL_PANEL_DEFAULT_HEIGHT_PX = 260
const SAMPLE_DETAIL_PANEL_MIN_HEIGHT_PX = 180
const SAMPLE_DETAIL_PANEL_HEIGHT_KEY_PREFIX = 'sample-detail-panel-height:'

export const clampSampleDetailPanelHeight = (heightPx: number, viewportHeightPx: number) => {
  const maxHeight = Math.max(SAMPLE_DETAIL_PANEL_MIN_HEIGHT_PX, Math.floor(viewportHeightPx * 0.5))
  return Math.min(maxHeight, Math.max(SAMPLE_DETAIL_PANEL_MIN_HEIGHT_PX, Math.round(heightPx)))
}

export const loadSampleDetailPanelHeight = (scopeId: string, viewportHeightPx: number) => {
  if (!canUseLocalStorage()) return clampSampleDetailPanelHeight(SAMPLE_DETAIL_PANEL_DEFAULT_HEIGHT_PX, viewportHeightPx)
  try {
    const stored = localStorage.getItem(`${SAMPLE_DETAIL_PANEL_HEIGHT_KEY_PREFIX}${scopeId}`)
    return clampSampleDetailPanelHeight(stored ? Number(stored) : SAMPLE_DETAIL_PANEL_DEFAULT_HEIGHT_PX, viewportHeightPx)
  } catch {
    return clampSampleDetailPanelHeight(SAMPLE_DETAIL_PANEL_DEFAULT_HEIGHT_PX, viewportHeightPx)
  }
}

export const saveSampleDetailPanelHeight = (scopeId: string, heightPx: number, viewportHeightPx: number) => {
  const clamped = clampSampleDetailPanelHeight(heightPx, viewportHeightPx)
  if (!canUseLocalStorage()) return clamped
  try {
    localStorage.setItem(`${SAMPLE_DETAIL_PANEL_HEIGHT_KEY_PREFIX}${scopeId}`, String(clamped))
  } catch {}
  return clamped
}
