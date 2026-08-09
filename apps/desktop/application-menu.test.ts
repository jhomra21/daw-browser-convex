import { describe, expect, test } from "bun:test"
import {
  applicationMenuItemIds,
  createApplicationMenuController,
  createApplicationMenuTemplate,
  type ApplicationMenuTemplate,
} from "./application-menu"
import { desktopApplicationMenuCommands } from "@daw-browser/desktop-protocol/application-menu"

const flatten = (items: ApplicationMenuTemplate[]): ApplicationMenuTemplate[] => (
  items.flatMap((item) => [item, ...(item.submenu ? flatten(item.submenu) : [])])
)

const createFakeMenu = (template: ApplicationMenuTemplate[]) => {
  const items = new Map<string, { enabled: boolean; visible: boolean; checked: boolean }>()
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
  test("contains exactly the 39 renderer menu commands", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const commands: string[] = []
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
    ])
    expect(macFileMenu?.submenu?.at(-1)).toEqual(expect.objectContaining({ role: "close" }))
    expect(macFileMenu?.submenu?.at(-2)?.type).toBe("separator")
    expect(windowsFileMenu?.submenu?.at(-1)).toEqual(expect.objectContaining({ role: "quit" }))
    expect(windowsFileMenu?.submenu?.at(-2)?.type).toBe("separator")
    expect(windowsTemplate).toContainEqual(expect.objectContaining({ label: "Settings" }))
    expect(windowsTemplate).toContainEqual(expect.objectContaining({ label: "Help", role: "help" }))

    const allItems = flatten(macTemplate)
    expect(allItems.find((item) => item.id === applicationMenuItemIds.metronome)?.type).toBe("checkbox")
    expect(allItems.find((item) => item.id === applicationMenuItemIds.syncMix)?.type).toBe("checkbox")
    expect(allItems.filter((item) => item.type === "radio")).toHaveLength(5)
    expect(allItems.find((item) => item.role === "togglefullscreen")).toBeDefined()
    expect(allItems.find((item) => item.role === "window")).toBeDefined()
  })

  test("mutates one installed menu for live state", () => {
    const sent: string[] = []
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
      signedIn: true,
      metronomeEnabled: true,
      loopEnabled: false,
      gridEnabled: true,
      syncMix: true,
      gridDenominator: 8,
    })
    expect(fake.items.get(applicationMenuItemIds.newProject)?.enabled).toBe(true)
    expect(fake.items.get(applicationMenuItemIds.exportArchive)?.enabled).toBe(true)
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
      signedIn: true,
      metronomeEnabled: true,
      loopEnabled: true,
      gridEnabled: true,
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
    const preloadSource = await read("./preload.ts")
    const rendererSource = await read("../../src/hooks/useDesktopApplicationMenu.ts")
    const transportSource = await read("../../src/components/timeline/TransportControls.tsx")

    expect(mainSource).toContain("event.senderFrame === event.sender.mainFrame")
    expect(mainSource).toContain("sameAppOrigin(event.senderFrame.url)")
    expect(mainSource).toContain("desktopApplicationMenuStateSchema.safeParse(value)")
    expect(mainSource.match(/applicationMenuController\.reset\(\)/g)?.length).toBe(2)
    expect(preloadSource).toContain("desktopApplicationMenuCommandSchema.safeParse(value)")
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
