import { z } from "zod"

export const desktopApplicationMenuCommands = [
  "new-project",
  "open-projects-dashboard",
  "open-samples-dashboard",
  "open-export-dashboard",
  "import-audio",
  "import-archive",
  "export-archive",
  "export-mixdown",
  "sign-in",
  "open-account-dashboard",
  "logout",
  "undo",
  "redo",
  "duplicate",
  "delete",
  "keyboard-shortcuts",
  "open-assets-browser",
  "open-effects-browser",
  "open-midi-instruments-browser",
  "toggle-metronome",
  "toggle-loop",
  "toggle-grid",
  "zoom-in",
  "zoom-out",
  "zoom-to-fit",
  "set-grid-denominator-2",
  "set-grid-denominator-4",
  "set-grid-denominator-8",
  "set-grid-denominator-12",
  "set-grid-denominator-16",
  "open-general-settings",
  "open-timeline-settings",
  "open-audio-settings",
  "about",
  "toggle-sync-mix",
  "add-audio-track",
  "add-return-track",
  "add-group-track",
  "add-instrument-track",
] as const

export const desktopApplicationMenuCommandSchema = z.enum(desktopApplicationMenuCommands)
export type DesktopApplicationMenuCommand = z.infer<typeof desktopApplicationMenuCommandSchema>

export const desktopApplicationMenuStateSchema = z.object({
  ready: z.boolean(),
  canExportArchive: z.boolean(),
  signedIn: z.boolean(),
  metronomeEnabled: z.boolean(),
  loopEnabled: z.boolean(),
  gridEnabled: z.boolean(),
  syncMix: z.boolean(),
  gridDenominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(12), z.literal(16)]),
}).strict()
export type DesktopApplicationMenuState = z.infer<typeof desktopApplicationMenuStateSchema>
