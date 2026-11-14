import type {
  DesktopApplicationMenuMessage,
  DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu"

export type DesktopApplicationMenuPlatform = "darwin" | "win32" | "linux"

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

const commandItem = (
  id: string,
  label: string,
  command: DesktopApplicationMenuMessage,
  sendCommand: (command: DesktopApplicationMenuMessage) => void,
): ApplicationMenuTemplate => ({
  id,
  label,
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
      commandItem(menuIds.newProject, "New Project", "new-project", sendCommand),
      commandItem(menuIds.openProjectsDashboard, "Open Projects Dashboard", "open-projects-dashboard", sendCommand),
      commandItem(menuIds.openSamplesDashboard, "Open Samples Dashboard", "open-samples-dashboard", sendCommand),
      commandItem(menuIds.openExportDashboard, "Open Export Dashboard", "open-export-dashboard", sendCommand),
      separator(),
      commandItem(menuIds.importAudio, "Import Audio Files…", "import-audio", sendCommand),
      commandItem(menuIds.importArchive, "Import .dawproject…", "import-archive", sendCommand),
      commandItem(menuIds.exportArchive, "Export .dawproject…", "export-archive", sendCommand),
      commandItem(menuIds.exportMixdown, "Export Mixdown…", "export-mixdown", sendCommand),
      separator(),
      commandItem(menuIds.signIn, "Sign In", "sign-in", sendCommand),
      commandItem(menuIds.account, "Account", "open-account-dashboard", sendCommand),
      commandItem(menuIds.logout, "Logout", "logout", sendCommand),
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
      { ...commandItem(menuIds.undo, "Undo", "undo", sendCommand), ...menuShortcut("CmdOrCtrl+Z", { macOwnsKey: true }) },
      { ...commandItem(menuIds.redo, "Redo", "redo", sendCommand), ...menuShortcut("CmdOrCtrl+Shift+Z", { macOwnsKey: true }) },
      separator(),
      // Cut has no timeline action, so its click is set in applyState and always targets the focused field.
      { id: menuIds.cut, label: "Cut", ...menuShortcut("CmdOrCtrl+X", { macOwnsKey: true }) },
      { ...commandItem(menuIds.copy, "Copy", "copy", sendCommand), ...menuShortcut("CmdOrCtrl+C", { macOwnsKey: true }) },
      { ...commandItem(menuIds.paste, "Paste", "paste", sendCommand), ...menuShortcut("CmdOrCtrl+V", { macOwnsKey: true }) },
      { ...commandItem(menuIds.selectAll, "Select All", "select-all", sendCommand), ...menuShortcut("CmdOrCtrl+A", { macOwnsKey: true }) },
      separator(),
      { ...commandItem(menuIds.duplicate, "Duplicate", "duplicate", sendCommand), ...menuShortcut("CmdOrCtrl+D", { macOwnsKey: true }) },
      { ...commandItem(menuIds.delete, "Delete", "delete", sendCommand), ...menuShortcut("Delete", { macOwnsKey: false }) },
      separator(),
      commandItem(menuIds.keyboardShortcuts, "Keyboard Shortcuts", "keyboard-shortcuts", sendCommand),
    ],
  }

  const viewMenu: ApplicationMenuTemplate = {
    label: "View",
    submenu: [
      commandItem(menuIds.assetsBrowser, "Assets Browser", "open-assets-browser", sendCommand),
      commandItem(menuIds.effectsBrowser, "Effects Browser", "open-effects-browser", sendCommand),
      commandItem(menuIds.midiInstrumentsBrowser, "MIDI Instruments Browser", "open-midi-instruments-browser", sendCommand),
      separator(),
      { ...commandItem(menuIds.metronome, "Metronome", "toggle-metronome", sendCommand), type: "checkbox" },
      { ...commandItem(menuIds.loop, "Loop", "toggle-loop", sendCommand), type: "checkbox" },
      { ...commandItem(menuIds.grid, "Grid", "toggle-grid", sendCommand), type: "checkbox" },
      {
        ...commandItem(menuIds.follow, "Follow", "toggle-follow", sendCommand),
        type: "checkbox",
        ...menuShortcut(platform === "darwin" ? "Alt+Shift+F" : "CmdOrCtrl+Shift+F", { macOwnsKey: true }),
      },
      separator(),
      commandItem(menuIds.zoomIn, "Zoom In", "zoom-in", sendCommand),
      commandItem(menuIds.zoomOut, "Zoom Out", "zoom-out", sendCommand),
      commandItem(menuIds.zoomToFit, "Zoom to Fit", "zoom-to-fit", sendCommand),
      separator(),
      {
        label: "Grid Resolution",
        submenu: [
          { ...commandItem(menuIds.grid2, "1/2", "set-grid-denominator-2", sendCommand), type: "radio" },
          { ...commandItem(menuIds.grid4, "1/4", "set-grid-denominator-4", sendCommand), type: "radio" },
          { ...commandItem(menuIds.grid8, "1/8", "set-grid-denominator-8", sendCommand), type: "radio" },
          { ...commandItem(menuIds.grid12, "1/12", "set-grid-denominator-12", sendCommand), type: "radio" },
          { ...commandItem(menuIds.grid16, "1/16", "set-grid-denominator-16", sendCommand), type: "radio" },
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
      commandItem(menuIds.generalSettings, "Dashboard settings", "open-general-settings", sendCommand),
      commandItem(menuIds.timelineSettings, "Timeline / DAW dashboard", "open-timeline-settings", sendCommand),
      commandItem(menuIds.audioSettings, "Audio settings", "open-audio-settings", sendCommand),
    ],
  }

  const tracksMenu: ApplicationMenuTemplate = {
    label: "Tracks",
    submenu: [
      { ...commandItem(menuIds.syncMix, "Sync Mix", "toggle-sync-mix", sendCommand), type: "checkbox" },
      separator(),
      commandItem(menuIds.addAudioTrack, "Add Audio Track", "add-audio-track", sendCommand),
      commandItem(menuIds.addReturnTrack, "Add Return Track", "add-return-track", sendCommand),
      commandItem(menuIds.addGroupTrack, "Add Group Track", "add-group-track", sendCommand),
      commandItem(menuIds.addInstrumentTrack, "Add Instrument Track", "add-instrument-track", sendCommand),
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
      { id: menuIds.about, label: "About daw-browser", click: () => sendCommand("about") },
      {
        ...commandItem(menuIds.generalSettings, "Settings…", "open-general-settings", sendCommand),
        accelerator: "Command+,",
      },
      commandItem(menuIds.timelineSettings, "Timeline / DAW Settings", "open-timeline-settings", sendCommand),
      commandItem(menuIds.audioSettings, "Audio Settings", "open-audio-settings", sendCommand),
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
      { id: menuIds.about, label: "About daw-browser", click: () => sendCommand("about") },
    ],
  }

  return platform === "darwin"
    ? [macApplicationMenu, fileMenu, editMenu, viewMenu, tracksMenu, windowMenu]
    : [fileMenu, editMenu, viewMenu, settingsMenu, tracksMenu, windowMenu, helpMenu]
}

const statefulIds = [
  menuIds.newProject,
  menuIds.openProjectsDashboard,
  menuIds.openSamplesDashboard,
  menuIds.openExportDashboard,
  menuIds.importAudio,
  menuIds.importArchive,
  menuIds.exportMixdown,
  menuIds.keyboardShortcuts,
  menuIds.assetsBrowser,
  menuIds.effectsBrowser,
  menuIds.midiInstrumentsBrowser,
  menuIds.metronome,
  menuIds.loop,
  menuIds.grid,
  menuIds.follow,
  menuIds.zoomIn,
  menuIds.zoomOut,
  menuIds.zoomToFit,
  menuIds.generalSettings,
  menuIds.timelineSettings,
  menuIds.audioSettings,
  menuIds.about,
  menuIds.addAudioTrack,
  menuIds.addReturnTrack,
  menuIds.addGroupTrack,
  menuIds.addInstrumentTrack,
] as const

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
  for (const id of statefulIds) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = state.ready
  }
  const archive = menu.getMenuItemById(menuIds.exportArchive)
  if (archive) archive.enabled = state.ready && state.canExportArchive
  const availability: ReadonlyArray<readonly [string, boolean]> = [
    [menuIds.undo, state.canUndo],
    [menuIds.redo, state.canRedo],
    [menuIds.duplicate, state.canDuplicateSelection],
    [menuIds.delete, state.canDeleteSelection],
  ]
  for (const [id, available] of availability) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = state.ready && available
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
  const signIn = menu.getMenuItemById(menuIds.signIn)
  if (signIn) {
    signIn.enabled = state.ready
    signIn.visible = !state.signedIn
  }
  const account = menu.getMenuItemById(menuIds.account)
  if (account) {
    account.enabled = state.ready
    account.visible = state.signedIn
  }
  const logout = menu.getMenuItemById(menuIds.logout)
  if (logout) {
    logout.enabled = state.ready
    logout.visible = state.signedIn
  }
  const metronome = menu.getMenuItemById(menuIds.metronome)
  if (metronome) metronome.checked = state.metronomeEnabled
  const loop = menu.getMenuItemById(menuIds.loop)
  if (loop) loop.checked = state.loopEnabled
  const grid = menu.getMenuItemById(menuIds.grid)
  if (grid) grid.checked = state.gridEnabled
  const follow = menu.getMenuItemById(menuIds.follow)
  if (follow) follow.checked = state.followEnabled
  const syncMix = menu.getMenuItemById(menuIds.syncMix)
  if (syncMix) {
    syncMix.enabled = state.ready
    syncMix.checked = state.syncMix
  }
  const gridItems = new Map([
    [2, menuIds.grid2],
    [4, menuIds.grid4],
    [8, menuIds.grid8],
    [12, menuIds.grid12],
    [16, menuIds.grid16],
  ] as const)
  for (const [denominator, id] of gridItems) {
    const item = menu.getMenuItemById(id)
    if (item) {
      item.enabled = state.ready
      item.checked = state.gridDenominator === denominator
    }
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
