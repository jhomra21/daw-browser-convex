export const BOTTOM_PANEL_EDGE_PADDING_PX = 4;
export const BOTTOM_PANEL_RESIZE_HANDLE_OVERHANG_PX = 8;
export const EFFECTS_PANEL_FOOTER_HEIGHT_PX = 28;

export type BottomPanelMode = "effects" | "sample-detail";

type BottomPanelFootprintInput = {
  open: boolean;
  heightPx: number;
  footerHeightPx: number;
};

export const getBottomPanelFooterHeightPx = (mode: BottomPanelMode) => mode === "effects" ? EFFECTS_PANEL_FOOTER_HEIGHT_PX : 0;

export const getBottomPanelMountedFootprintPx = (input: BottomPanelFootprintInput) => {
  if (input.open) {
    return input.heightPx + input.footerHeightPx + BOTTOM_PANEL_EDGE_PADDING_PX + BOTTOM_PANEL_RESIZE_HANDLE_OVERHANG_PX;
  }
  return input.footerHeightPx > 0 ? input.footerHeightPx + BOTTOM_PANEL_EDGE_PADDING_PX : 0;
};
