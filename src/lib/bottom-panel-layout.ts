export const BOTTOM_PANEL_EDGE_PADDING_PX = 4;
export const BOTTOM_PANEL_RESIZE_HANDLE_OVERHANG_PX = 8;
export const BOTTOM_PANEL_FOOTER_HEIGHT_PX = 28;

export type BottomPanelMode = "effects" | "sample-detail";

type BottomPanelFootprintInput = {
  open: boolean;
  heightPx: number;
};

export const getBottomPanelMountedFootprintPx = (input: BottomPanelFootprintInput) => {
  if (input.open) {
    return input.heightPx + BOTTOM_PANEL_FOOTER_HEIGHT_PX + BOTTOM_PANEL_EDGE_PADDING_PX;
  }
  return BOTTOM_PANEL_FOOTER_HEIGHT_PX + BOTTOM_PANEL_EDGE_PADDING_PX;
};
