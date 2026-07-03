export type DawThemePalette = {
  neutral: string
  ink: string
  primary: string
  success: string
  warning: string
  error: string
  info: string
  accent?: string
  interactive?: string
}

export type DawThemeTokenOverrides = Partial<Record<string, string>>

export type DawThemeVariant = {
  palette: DawThemePalette
  overrides?: DawThemeTokenOverrides
}

export type DawTheme = {
  id: string
  name: string
  light: DawThemeVariant
  dark: DawThemeVariant
}

export const dawThemeTokenNames: readonly string[] = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "error",
  "error-foreground",
  "border",
  "input",
  "ring",
  "app-surface",
  "app-surface-muted",
  "timeline-background",
  "timeline-surface",
  "timeline-surface-muted",
  "timeline-grid-minor",
  "timeline-grid-major",
  "timeline-playhead",
  "clip-audio",
  "clip-audio-foreground",
  "clip-midi",
  "clip-midi-foreground",
  "clip-selected",
  "clip-selected-foreground",
  "clip-recording",
  "meter-safe",
  "meter-warning",
  "meter-clipping",
  "device-graph-background",
  "device-graph-grid",
  "device-graph-accent",
  "recording",
  "automation",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring"
]
