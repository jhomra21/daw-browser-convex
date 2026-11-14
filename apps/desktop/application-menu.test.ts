import { describe, expect, test } from "bun:test"
import {
  applicationMenuItemIds,
  createApplicationMenuController,
  createApplicationMenuTemplate,
  type ApplicationMenuTemplate,
} from "./application-menu"
import {
  desktopApplicationMenuCommands,
  type DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu"

const flatten = (items: ApplicationMenuTemplate[]): ApplicationMenuTemplate[] => (
  items.flatMap((item) => [item, ...(item.submenu ? flatten(item.submenu) : [])])
)

type FakeMenuItem = {
  enabled: boolean
  visible: boolean
  checked: boolean
  click?: (menuItem: FakeMenuItem, focusedWindow: { webContents?: FakeWebContents } | undefined) => void
}

type FakeWebContents = { cut: () => void; copy: () => void; paste: () => void; selectAll: () => void }

const createFakeMenu = (template: ApplicationMenuTemplate[]) => {
  const items = new Map<string, FakeMenuItem>()
  for (const item of flatten(template)) {
    if (!item.id) continue
    items.set(item.id, {
      enabled: item.enabled ?? true,
      visible: item.visible ?? true,
      checked: item.checked ?? false,
    })
  }
  return {
    items,
    menu: {
      getMenuItemById: (id: string) => items.get(id) ?? null,
    },
  }
}

describe("native application menu", () => {
  test("contains exactly the renderer menu commands", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const commands: unknown[] = []
      const template = createApplicationMenuTemplate(platform, (command) => commands.push(command))
      for (const item of flatten(template)) item.click?.()
      expect(new Set(commands)).toEqual(new Set(desktopApplicationMenuCommands))
      expect(commands).toHaveLength(desktopApplicationMenuCommands.length)
    }
  })

  test("uses native platform templates and control types", () => {
    const macTemplate = createApplicationMenuTemplate("darwin", () => {})
    const windowsTemplate = createApplicationMenuTemplate("win32", () => {})
    const macApplicationMenu = macTemplate[0]
    const macFileMenu = macTemplate.find((item) => item.label === "File")
    const windowsFileMenu = windowsTemplate.find((item) => item.label === "File")
    expect(macApplicationMenu?.label).toBe("daw-browser")
    expect(macApplicationMenu?.submenu?.[1]).toMatchObject({
      id: applicationMenuItemIds.generalSettings,
      label: "Settings…",
      accelerator: "Command+,",
    })
    expect(macApplicationMenu?.submenu?.[2]).toMatchObject({
      id: applicationMenuItemIds.timelineSettings,
      label: "Timeline / DAW Settings",
    })
    expect(macApplicationMenu?.submenu?.[3]).toMatchObject({
      id: applicationMenuItemIds.audioSettings,
      label: "Audio Settings",
    })
    expect(macApplicationMenu?.submenu?.some((item) => item.label === "Settings" && item.submenu !== undefined)).toBe(false)
    expect(flatten(macTemplate).filter((item) => item.accelerator)).toEqual([
      expect.objectContaining({ id: applicationMenuItemIds.generalSettings, accelerator: "Command+," }),
      expect.objectContaining({ id: applicationMenuItemIds.undo, accelerator: "CmdOrCtrl+Z" }),
      expect.objectContaining({ id: applicationMenuItemIds.redo, accelerator: "CmdOrCtrl+Shift+Z" }),
      expect.objectContaining({ id: applicationMenuItemIds.cut, accelerator: "CmdOrCtrl+X" }),
      expect.objectContaining({ id: applicationMenuItemIds.copy, accelerator: "CmdOrCtrl+C" }),
      expect.objectContaining({ id: applicationMenuItemIds.paste, accelerator: "CmdOrCtrl+V" }),
      expect.objectContaining({ id: applicationMenuItemIds.selectAll, accelerator: "CmdOrCtrl+A" }),
      expect.objectContaining({ id: applicationMenuItemIds.duplicate, accelerator: "CmdOrCtrl+D" }),
      expect.objectContaining({ id: applicationMenuItemIds.follow, accelerator: "Alt+Shift+F" }),
    ])
    expect(macFileMenu?.submenu?.at(-1)).toEqual(expect.objectContaining({ role: "close" }))
    expect(macFileMenu?.submenu?.at(-2)?.type).toBe("separator")
    expect(windowsFileMenu?.submenu?.at(-1)).toEqual(expect.objectContaining({ role: "quit" }))
    expect(windowsFileMenu?.submenu?.at(-2)?.type).toBe("separator")
    expect(windowsTemplate).toContainEqual(expect.objectContaining({ label: "Settings" }))
    expect(windowsTemplate).toContainEqual(expect.objectContaining({ label: "Help", role: "help" }))
    const windowsEditMenu = windowsTemplate.find((item) => item.label === "Edit")
    expect(windowsEditMenu?.submenu?.[0]).toMatchObject({ id: applicationMenuItemIds.undo, accelerator: "CmdOrCtrl+Z", registerAccelerator: false })
    expect(windowsEditMenu?.submenu?.find((item) => item.id === applicationMenuItemIds.delete)).toMatchObject({ accelerator: "Delete", registerAccelerator: false })
    expect(windowsEditMenu?.submenu?.find((item) => item.id === applicationMenuItemIds.copy)).toMatchObject({ accelerator: "CmdOrCtrl+C", registerAccelerator: false })

    const allItems = flatten(macTemplate)
    expect(allItems.find((item) => item.id === applicationMenuItemIds.metronome)?.type).toBe("checkbox")
    expect(allItems.find((item) => item.id === applicationMenuItemIds.follow)?.type).toBe("checkbox")
    expect(allItems.find((item) => item.id === applicationMenuItemIds.syncMix)?.type).toBe("checkbox")
    expect(allItems.filter((item) => item.type === "radio")).toHaveLength(5)
    expect(allItems.find((item) => item.role === "togglefullscreen")).toBeDefined()
    expect(allItems.find((item) => item.role === "window")).toBeDefined()
  })

  test("mutates one installed menu for live state", () => {
    const sent: unknown[] = []
    const controller = createApplicationMenuController({
      platform: "darwin",
      sendCommand: (command) => sent.push(command),
    })
    const template = createApplicationMenuTemplate("darwin", () => {})
    const fake = createFakeMenu(template)
    let installedTemplate: ApplicationMenuTemplate[] = []
    controller.install({
      buildFromTemplate: (next) => {
        installedTemplate = next
        return fake.menu
      },
      setApplicationMenu: () => {},
    })
    expect(fake.items.get(applicationMenuItemIds.newProject)?.enabled).toBe(false)

    controller.setState({
      ready: true,
      canExportArchive: true,
      canUndo: true,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
      canSelectAll: true,
      canDuplicateSelection: true,
      canDeleteSelection: false,
      editableFocused: false,
      signedIn: true,
      metronomeEnabled: true,
      loopEnabled: false,
      gridEnabled: true,
      followEnabled: true,
      syncMix: true,
      gridDenominator: 8,
    })
    expect(fake.items.get(applicationMenuItemIds.newProject)?.enabled).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.exportArchive)?.enabled).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.undo)?.enabled).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.redo)?.enabled).toBe(false)
    expect(fake.items.get(applicationMenuItemIds.duplicate)?.enabled).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.delete)?.enabled).toBe(false)
    expect(fake.items.get(applicationMenuItemIds.cut)?.enabled).toBe(false)
    expect(fake.items.get(applicationMenuItemIds.copy)?.enabled).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.paste)?.enabled).toBe(false)
    expect(fake.items.get(applicationMenuItemIds.selectAll)?.enabled).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.signIn)?.visible).toBe(false)
    expect(fake.items.get(applicationMenuItemIds.logout)?.visible).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.metronome)?.checked).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.grid8)?.checked).toBe(true)
    expect([...fake.items.entries()].filter(([id, item]) => id.startsWith("daw-menu-grid-") && item.checked)).toHaveLength(1)

    const grid = fake.items.get(applicationMenuItemIds.grid)
    if (!grid) throw new Error("Grid menu item was not installed.")
    grid.checked = false
    flatten(installedTemplate).find((item) => item.id === applicationMenuItemIds.grid)?.click?.()
    expect(sent).toEqual(["toggle-grid"])
    expect(grid.checked).toBe(true)
  })

  test("sends Edit cut, copy, paste and select all to the focused field, else to the timeline", () => {
    const sent: unknown[] = []
    const nativeCalls: string[] = []
    const controller = createApplicationMenuController({
      platform: "darwin",
      sendCommand: (command) => sent.push(command),
    })
    const fake = createFakeMenu(createApplicationMenuTemplate("darwin", () => {}))
    controller.install({
      buildFromTemplate: () => fake.menu,
      setApplicationMenu: () => {},
    })
    const webContents = {
      cut: () => nativeCalls.push("cut"),
      copy: () => nativeCalls.push("copy"),
      paste: () => nativeCalls.push("paste"),
      selectAll: () => nativeCalls.push("selectAll"),
    }
    const focusedWindow = { webContents }
    const invoke = (id: string) => {
      const item = fake.items.get(id)
      if (!item?.click) throw new Error(`${id} has no click`)
      item.click(item, focusedWindow)
    }
    const state: DesktopApplicationMenuState = {
      ready: true,
      canExportArchive: false,
      canUndo: false,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
      canDuplicateSelection: false,
      canDeleteSelection: false,
      editableFocused: true,
      signedIn: false,
      metronomeEnabled: false,
      loopEnabled: false,
      gridEnabled: false,
      followEnabled: false,
      syncMix: false,
      gridDenominator: 4,
    }

    controller.setState(state)
    invoke(applicationMenuItemIds.cut)
    invoke(applicationMenuItemIds.copy)
    invoke(applicationMenuItemIds.paste)
    invoke(applicationMenuItemIds.selectAll)
    expect(nativeCalls).toEqual(["cut", "copy", "paste", "selectAll"])
    expect(sent).toEqual([])

    controller.setState({ ...state, canCut: false, editableFocused: false })
    expect(fake.items.get(applicationMenuItemIds.cut)?.enabled).toBe(false)
    invoke(applicationMenuItemIds.copy)
    invoke(applicationMenuItemIds.paste)
    invoke(applicationMenuItemIds.selectAll)
    expect(nativeCalls).toHaveLength(4)
    expect(sent).toEqual(["copy", "paste", "select-all"])
  })

  test("resets state after renderer loss", () => {
    const controller = createApplicationMenuController({
      platform: "linux",
      sendCommand: () => {},
    })
    const fake = createFakeMenu(createApplicationMenuTemplate("linux", () => {}))
    controller.install({
      buildFromTemplate: () => fake.menu,
      setApplicationMenu: () => {},
    })
    controller.setState({
      ready: true,
      canExportArchive: true,
      canUndo: true,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
      canSelectAll: true,
      canDuplicateSelection: true,
      canDeleteSelection: false,
      editableFocused: false,
      signedIn: true,
      metronomeEnabled: true,
      loopEnabled: true,
      gridEnabled: true,
      followEnabled: true,
      syncMix: true,
      gridDenominator: 16,
    })
    controller.reset()
    expect(fake.items.get(applicationMenuItemIds.newProject)?.enabled).toBe(false)
    expect(fake.items.get(applicationMenuItemIds.exportArchive)?.enabled).toBe(false)
    expect(fake.items.get(applicationMenuItemIds.signIn)?.visible).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.logout)?.visible).toBe(false)
  })

  test("keeps IPC and renderer integration constrained", async () => {
    const read = async (relativePath: string) => Bun.file(new URL(relativePath, import.meta.url)).text()
    const mainSource = await read("./main.ts")
    const ipcSource = await read("./ipc/application-menu-ipc.ts")
    const preloadSource = await read("./preload.ts")
    const rendererSource = await read("../../src/hooks/useDesktopApplicationMenu.ts")
    const transportSource = await read("../../src/components/timeline/TransportControls.tsx")

    expect(mainSource).toContain("event.senderFrame === event.sender.mainFrame")
    expect(mainSource).toContain("sameAppOrigin(event.senderFrame.url)")
    expect(ipcSource).toContain("desktopApplicationMenuStateSchema.safeParse(value)")
    expect(mainSource.match(/applicationMenuController\.reset\(\)/g)?.length).toBe(1)
    expect(mainSource).toContain("invalidateRendererGeneration")
    expect(preloadSource).toContain("desktopApplicationMenuMessageSchema.safeParse(value)")
    expect(preloadSource).toContain("desktopApplicationMenuStateSchema.safeParse(state)")
    expect(preloadSource).toContain("removeListener(applicationMenuCommandChannel, notify)")
    expect(rendererSource).not.toContain("desktopApplicationMenuStateSchema.parse")
    expect(rendererSource).toContain("ready: true")
    expect(rendererSource).toContain("ready: false")
    expect(rendererSource).toContain("transport.browser.onSelectTab")
    expect(rendererSource).toContain("transport.browser.onOpen")
    expect(transportSource).toContain('import.meta.env.VITE_DESKTOP !== "true"')
    expect(transportSource).toContain("<Menubar class=")
  })
})
