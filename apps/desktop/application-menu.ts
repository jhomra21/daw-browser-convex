import type {
  DesktopApplicationMenuCommand,
  DesktopApplicationMenuMessage,
  DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu"

type DesktopApplicationMenuPlatform = "darwin" | "win32" | "linux"

type ApplicationMenuRole =
  | "services"
  | "hide"
  | "hideOthers"
  | "unhide"
  | "quit"
  | "window"
  | "minimize"
  | "zoom"
  | "close"
  | "togglefullscreen"
  | "help"

export type ApplicationMenuTemplate = {
  id?: string
  label?: string
  role?: ApplicationMenuRole
  type?: "normal" | "separator" | "submenu" | "checkbox" | "radio"
  enabled?: boolean
  visible?: boolean
  checked?: boolean
  accelerator?: string
  registerAccelerator?: boolean
  submenu?: ApplicationMenuTemplate[]
  click?: () => void
}

type ApplicationMenuItem = {
  enabled: boolean
  visible: boolean
  checked: boolean
  label?: string
  click?: unknown
}

type ApplicationMenu = {
  getMenuItemById: (id: string) => ApplicationMenuItem | null
}

type ApplicationMenuInstallBoundary<TMenu extends ApplicationMenu> = {
  buildFromTemplate: (template: ApplicationMenuTemplate[]) => TMenu
  setApplicationMenu: (menu: TMenu) => void
}

type ApplicationMenuControllerOptions = {
  platform: DesktopApplicationMenuPlatform
  sendCommand: (command: DesktopApplicationMenuMessage) => void
}

export const applicationMenuItemIds = {
  newProject: "daw-menu-new-project",
  openProjectsDashboard: "daw-menu-open-projects-dashboard",
  openSamplesDashboard: "daw-menu-open-samples-dashboard",
  openExportDashboard: "daw-menu-open-export-dashboard",
  importAudio: "daw-menu-import-audio",
  importArchive: "daw-menu-import-archive",
  exportArchive: "daw-menu-export-archive",
  exportMixdown: "daw-menu-export-mixdown",
  signIn: "daw-menu-sign-in",
  account: "daw-menu-account",
  logout: "daw-menu-logout",
  undo: "daw-menu-undo",
  redo: "daw-menu-redo",
  cut: "daw-menu-cut",
  copy: "daw-menu-copy",
  paste: "daw-menu-paste",
  selectAll: "daw-menu-select-all",
  duplicate: "daw-menu-duplicate",
  delete: "daw-menu-delete",
  keyboardShortcuts: "daw-menu-keyboard-shortcuts",
  assetsBrowser: "daw-menu-assets-browser",
  effectsBrowser: "daw-menu-effects-browser",
  midiInstrumentsBrowser: "daw-menu-midi-instruments-browser",
  metronome: "daw-menu-metronome",
  loop: "daw-menu-loop",
  grid: "daw-menu-grid",
  follow: "daw-menu-follow",
  zoomIn: "daw-menu-zoom-in",
  zoomOut: "daw-menu-zoom-out",
  zoomToFit: "daw-menu-zoom-to-fit",
  grid2: "daw-menu-grid-2",
  grid4: "daw-menu-grid-4",
  grid8: "daw-menu-grid-8",
  grid12: "daw-menu-grid-12",
  grid16: "daw-menu-grid-16",
  generalSettings: "daw-menu-general-settings",
  timelineSettings: "daw-menu-timeline-settings",
  audioSettings: "daw-menu-audio-settings",
  about: "daw-menu-about",
  syncMix: "daw-menu-sync-mix",
  addAudioTrack: "daw-menu-add-audio-track",
  addReturnTrack: "daw-menu-add-return-track",
  addGroupTrack: "daw-menu-add-group-track",
  addInstrumentTrack: "daw-menu-add-instrument-track",
  extensionSlot: (index: number) => `daw-menu-extension-${index}`,
} as const

const menuIds = applicationMenuItemIds

const initialState: DesktopApplicationMenuState = {
  ready: false,
  canExportArchive: false,
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false,
  canDuplicateSelection: false,
  canDeleteSelection: false,
  editableFocused: false,
  signedIn: false,
  metronomeEnabled: false,
  loopEnabled: false,
  gridEnabled: false,
  followEnabled: false,
  syncMix: false,
  gridDenominator: 4,
  extensionContributions: [],
}

type MenuCommandSpec = {
  id: string
  label: string
  // Availability beyond `ready`; omitted means always available once the renderer is ready.
  enabled?: (state: DesktopApplicationMenuState) => boolean
  checked?: (state: DesktopApplicationMenuState) => boolean
  visible?: (state: DesktopApplicationMenuState) => boolean
}

const gridResolution = (denominator: DesktopApplicationMenuState["gridDenominator"]) =>
  (state: DesktopApplicationMenuState) => state.gridDenominator === denominator

// Every renderer command once: its menu item id, label, and how menu state enables, checks and shows it.
const menuCommands: Readonly<Record<DesktopApplicationMenuCommand, MenuCommandSpec>> = {
  "new-project": { id: menuIds.newProject, label: "New Project" },
  "open-projects-dashboard": { id: menuIds.openProjectsDashboard, label: "Open Projects Dashboard" },
  "open-samples-dashboard": { id: menuIds.openSamplesDashboard, label: "Open Samples Dashboard" },
  "open-export-dashboard": { id: menuIds.openExportDashboard, label: "Open Export Dashboard" },
  "import-audio": { id: menuIds.importAudio, label: "Import Audio Files…" },
  "import-archive": { id: menuIds.importArchive, label: "Import .dawproject…" },
  "export-archive": { id: menuIds.exportArchive, label: "Export .dawproject…", enabled: (state) => state.canExportArchive },
  "export-mixdown": { id: menuIds.exportMixdown, label: "Export Mixdown…" },
  "sign-in": { id: menuIds.signIn, label: "Sign In", visible: (state) => !state.signedIn },
  "open-account-dashboard": { id: menuIds.account, label: "Account", visible: (state) => state.signedIn },
  logout: { id: menuIds.logout, label: "Logout", visible: (state) => state.signedIn },
  undo: { id: menuIds.undo, label: "Undo", enabled: (state) => state.canUndo },
  redo: { id: menuIds.redo, label: "Redo", enabled: (state) => state.canRedo },
  copy: { id: menuIds.copy, label: "Copy", enabled: (state) => state.canCopy },
  paste: { id: menuIds.paste, label: "Paste", enabled: (state) => state.canPaste },
  "select-all": { id: menuIds.selectAll, label: "Select All", enabled: (state) => state.canSelectAll },
  duplicate: { id: menuIds.duplicate, label: "Duplicate", enabled: (state) => state.canDuplicateSelection },
  delete: { id: menuIds.delete, label: "Delete", enabled: (state) => state.canDeleteSelection },
  "keyboard-shortcuts": { id: menuIds.keyboardShortcuts, label: "Keyboard Shortcuts" },
  "open-assets-browser": { id: menuIds.assetsBrowser, label: "Assets Browser" },
  "open-effects-browser": { id: menuIds.effectsBrowser, label: "Effects Browser" },
  "open-midi-instruments-browser": { id: menuIds.midiInstrumentsBrowser, label: "MIDI Instruments Browser" },
  "toggle-metronome": { id: menuIds.metronome, label: "Metronome", checked: (state) => state.metronomeEnabled },
  "toggle-loop": { id: menuIds.loop, label: "Loop", checked: (state) => state.loopEnabled },
  "toggle-grid": { id: menuIds.grid, label: "Grid", checked: (state) => state.gridEnabled },
  "toggle-follow": { id: menuIds.follow, label: "Follow", checked: (state) => state.followEnabled },
  "zoom-in": { id: menuIds.zoomIn, label: "Zoom In" },
  "zoom-out": { id: menuIds.zoomOut, label: "Zoom Out" },
  "zoom-to-fit": { id: menuIds.zoomToFit, label: "Zoom to Fit" },
  "set-grid-denominator-2": { id: menuIds.grid2, label: "1/2", checked: gridResolution(2) },
  "set-grid-denominator-4": { id: menuIds.grid4, label: "1/4", checked: gridResolution(4) },
  "set-grid-denominator-8": { id: menuIds.grid8, label: "1/8", checked: gridResolution(8) },
  "set-grid-denominator-12": { id: menuIds.grid12, label: "1/12", checked: gridResolution(12) },
  "set-grid-denominator-16": { id: menuIds.grid16, label: "1/16", checked: gridResolution(16) },
  "open-general-settings": { id: menuIds.generalSettings, label: "Dashboard settings" },
  "open-timeline-settings": { id: menuIds.timelineSettings, label: "Timeline / DAW dashboard" },
  "open-audio-settings": { id: menuIds.audioSettings, label: "Audio settings" },
  about: { id: menuIds.about, label: "About daw-browser" },
  "toggle-sync-mix": { id: menuIds.syncMix, label: "Sync Mix", checked: (state) => state.syncMix },
  "add-audio-track": { id: menuIds.addAudioTrack, label: "Add Audio Track" },
  "add-return-track": { id: menuIds.addReturnTrack, label: "Add Return Track" },
  "add-group-track": { id: menuIds.addGroupTrack, label: "Add Group Track" },
  "add-instrument-track": { id: menuIds.addInstrumentTrack, label: "Add Instrument Track" },
}

const commandItem = (
  command: DesktopApplicationMenuCommand,
  sendCommand: (command: DesktopApplicationMenuMessage) => void,
): ApplicationMenuTemplate => ({
  id: menuCommands[command].id,
  label: menuCommands[command].label,
  click: () => sendCommand(command),
})

const separator = (): ApplicationMenuTemplate => ({ type: "separator" })

const extensionMenuSlots = Array.from({ length: 16 }, (_, index) => index)

export const createApplicationMenuTemplate = (
  platform: DesktopApplicationMenuPlatform,
  sendCommand: (command: DesktopApplicationMenuMessage) => void,
): ApplicationMenuTemplate[] => {
  const fileMenu: ApplicationMenuTemplate = {
    label: "File",
    submenu: [
      commandItem("new-project", sendCommand),
      commandItem("open-projects-dashboard", sendCommand),
      commandItem("open-samples-dashboard", sendCommand),
      commandItem("open-export-dashboard", sendCommand),
      separator(),
      commandItem("import-audio", sendCommand),
      commandItem("import-archive", sendCommand),
      commandItem("export-archive", sendCommand),
      commandItem("export-mixdown", sendCommand),
      separator(),
      commandItem("sign-in", sendCommand),
      commandItem("open-account-dashboard", sendCommand),
      commandItem("logout", sendCommand),
      separator(),
      platform === "darwin" ? { role: "close" } : { role: "quit" },
    ],
  }

  // macOS: the menu key equivalent owns the key (it fires before the renderer sees it), and the renderer
  // routes text-field undo/redo itself. Elsewhere the renderer owns the key and the menu only displays it.
  const menuShortcut = (accelerator: string, options: { macOwnsKey: boolean }): ApplicationMenuTemplate => {
    if (platform !== "darwin") return { accelerator, registerAccelerator: false }

    return options.macOwnsKey ? { accelerator } : {}
  }

  const editMenu: ApplicationMenuTemplate = {
    label: "Edit",
    submenu: [
      { ...commandItem("undo", sendCommand), ...menuShortcut("CmdOrCtrl+Z", { macOwnsKey: true }) },
      { ...commandItem("redo", sendCommand), ...menuShortcut("CmdOrCtrl+Shift+Z", { macOwnsKey: true }) },
      separator(),
      // Cut has no timeline action, so its click is set in applyState and always targets the focused field.
      { id: menuIds.cut, label: "Cut", ...menuShortcut("CmdOrCtrl+X", { macOwnsKey: true }) },
      { ...commandItem("copy", sendCommand), ...menuShortcut("CmdOrCtrl+C", { macOwnsKey: true }) },
      { ...commandItem("paste", sendCommand), ...menuShortcut("CmdOrCtrl+V", { macOwnsKey: true }) },
      { ...commandItem("select-all", sendCommand), ...menuShortcut("CmdOrCtrl+A", { macOwnsKey: true }) },
      separator(),
      { ...commandItem("duplicate", sendCommand), ...menuShortcut("CmdOrCtrl+D", { macOwnsKey: true }) },
      { ...commandItem("delete", sendCommand), ...menuShortcut("Delete", { macOwnsKey: false }) },
      separator(),
      commandItem("keyboard-shortcuts", sendCommand),
    ],
  }

  const viewMenu: ApplicationMenuTemplate = {
    label: "View",
    submenu: [
      commandItem("open-assets-browser", sendCommand),
      commandItem("open-effects-browser", sendCommand),
      commandItem("open-midi-instruments-browser", sendCommand),
      separator(),
      { ...commandItem("toggle-metronome", sendCommand), type: "checkbox" },
      { ...commandItem("toggle-loop", sendCommand), type: "checkbox" },
      { ...commandItem("toggle-grid", sendCommand), type: "checkbox" },
      {
        ...commandItem("toggle-follow", sendCommand),
        type: "checkbox",
        ...menuShortcut(platform === "darwin" ? "Alt+Shift+F" : "CmdOrCtrl+Shift+F", { macOwnsKey: true }),
      },
      separator(),
      commandItem("zoom-in", sendCommand),
      commandItem("zoom-out", sendCommand),
      commandItem("zoom-to-fit", sendCommand),
      separator(),
      {
        label: "Grid Resolution",
        submenu: [
          { ...commandItem("set-grid-denominator-2", sendCommand), type: "radio" },
          { ...commandItem("set-grid-denominator-4", sendCommand), type: "radio" },
          { ...commandItem("set-grid-denominator-8", sendCommand), type: "radio" },
          { ...commandItem("set-grid-denominator-12", sendCommand), type: "radio" },
          { ...commandItem("set-grid-denominator-16", sendCommand), type: "radio" },
        ],
      },
      {
        label: "Extension Commands",
        submenu: extensionMenuSlots.map((index) => ({
          id: menuIds.extensionSlot(index),
          label: "",
          visible: false,
          enabled: false,
        })),
      },
      separator(),
      { label: "Full Screen", role: "togglefullscreen" },
    ],
  }

  const settingsMenu: ApplicationMenuTemplate = {
    label: "Settings",
    submenu: [
      commandItem("open-general-settings", sendCommand),
      commandItem("open-timeline-settings", sendCommand),
      commandItem("open-audio-settings", sendCommand),
    ],
  }

  const tracksMenu: ApplicationMenuTemplate = {
    label: "Tracks",
    submenu: [
      { ...commandItem("toggle-sync-mix", sendCommand), type: "checkbox" },
      separator(),
      commandItem("add-audio-track", sendCommand),
      commandItem("add-return-track", sendCommand),
      commandItem("add-group-track", sendCommand),
      commandItem("add-instrument-track", sendCommand),
    ],
  }

  const windowMenu: ApplicationMenuTemplate = {
    label: "Window",
    role: "window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      separator(),
      { role: "close" },
    ],
  }

  const macApplicationMenu: ApplicationMenuTemplate = {
    label: "daw-browser",
    submenu: [
      commandItem("about", sendCommand),
      {
        ...commandItem("open-general-settings", sendCommand),
        label: "Settings…",
        accelerator: "Command+,",
      },
      { ...commandItem("open-timeline-settings", sendCommand), label: "Timeline / DAW Settings" },
      { ...commandItem("open-audio-settings", sendCommand), label: "Audio Settings" },
      separator(),
      { role: "services" },
      separator(),
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      separator(),
      { role: "quit" },
    ],
  }

  const helpMenu: ApplicationMenuTemplate = {
    label: "Help",
    role: "help",
    submenu: [
      commandItem("about", sendCommand),
    ],
  }

  return platform === "darwin"
    ? [macApplicationMenu, fileMenu, editMenu, viewMenu, tracksMenu, windowMenu]
    : [fileMenu, editMenu, viewMenu, settingsMenu, tracksMenu, windowMenu, helpMenu]
}

type EditingWebContents = {
  cut: () => void
  copy: () => void
  paste: () => void
  selectAll: () => void
}

// Electron types the click window as BaseWindow; the focused BrowserWindow carries webContents at runtime.
const editingClick = (
  state: DesktopApplicationMenuState,
  sendCommand: (command: DesktopApplicationMenuMessage) => void,
  native: keyof EditingWebContents,
  command: DesktopApplicationMenuMessage | null,
) => (_menuItem: ApplicationMenuItem, focusedWindow: { webContents?: EditingWebContents } | undefined) => {
  // A focused field gets the native editing command from the page, like Electron's role items.
  if (state.editableFocused || command === null) focusedWindow?.webContents?.[native]()
  else sendCommand(command)
}

const applyState = (
  menu: ApplicationMenu,
  state: DesktopApplicationMenuState,
  sendCommand: (command: DesktopApplicationMenuMessage) => void,
) => {
  for (const spec of Object.values(menuCommands)) {
    const item = menu.getMenuItemById(spec.id)

    if (!item) continue

    item.enabled = state.ready && (spec.enabled?.(state) ?? true)

    if (spec.checked) item.checked = spec.checked(state)

    if (spec.visible) item.visible = spec.visible(state)
  }

  const editing: ReadonlyArray<readonly [string, boolean, keyof EditingWebContents, DesktopApplicationMenuMessage | null]> = [
    [menuIds.cut, state.canCut, "cut", null],
    [menuIds.copy, state.canCopy, "copy", "copy"],
    [menuIds.paste, state.canPaste, "paste", "paste"],
    [menuIds.selectAll, state.canSelectAll, "selectAll", "select-all"],
  ]

  for (const [id, available, native, command] of editing) {
    const item = menu.getMenuItemById(id)

    if (!item) continue
    item.enabled = state.ready && available
    item.click = editingClick(state, sendCommand, native, command)
  }

  const contributions = [...(state.extensionContributions ?? [])]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

  for (const index of extensionMenuSlots) {
    const item = menu.getMenuItemById(menuIds.extensionSlot(index))

    if (!item) continue
    const contribution = contributions[index]
    item.visible = contribution !== undefined
    item.enabled = contribution?.enabled ?? false
    item.checked = contribution?.checked ?? false
    item.label = contribution?.title ?? ""
    item.click = contribution === undefined
      ? undefined
      : () => sendCommand({
        kind: "extension",
        id: contribution.id,
        commandId: contribution.commandId,
      })
  }
}

export const createApplicationMenuController = <TMenu extends ApplicationMenu = ApplicationMenu>(
  options: ApplicationMenuControllerOptions,
) => {
  let menu: TMenu | undefined
  let state = initialState

  const reapplyState = () => {
    if (menu) applyState(menu, state, sendCommand)
  }

  const sendCommand = (command: DesktopApplicationMenuMessage) => {
    options.sendCommand(command)
    reapplyState()
  }

  return {
    install(boundary: ApplicationMenuInstallBoundary<TMenu>) {
      menu = boundary.buildFromTemplate(createApplicationMenuTemplate(options.platform, sendCommand))
      boundary.setApplicationMenu(menu)
      reapplyState()
    },
    setState(next: DesktopApplicationMenuState) {
      state = next
      reapplyState()
    },
    reset() {
      state = initialState
      reapplyState()
    },
  }
}
