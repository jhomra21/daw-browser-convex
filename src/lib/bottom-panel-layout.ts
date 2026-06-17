export const BOTTOM_PANEL_EDGE_PADDING_PX = 4;
export const EFFECTS_PANEL_FOOTER_HEIGHT_PX = 28;

export type BottomPanelMode = "effects" | "sample-detail";

type BottomPanelFootprintInput = {
  open: boolean;
  mode: BottomPanelMode;
  heightPx: number;
};

export const getBottomPanelMountedFootprintPx = (input: BottomPanelFootprintInput) => {
  const footerHeightPx = input.mode === "effects" ? EFFECTS_PANEL_FOOTER_HEIGHT_PX : 0;
  if (input.open) return input.heightPx + footerHeightPx + BOTTOM_PANEL_EDGE_PADDING_PX;
  return footerHeightPx > 0 ? footerHeightPx + BOTTOM_PANEL_EDGE_PADDING_PX : 0;
};
