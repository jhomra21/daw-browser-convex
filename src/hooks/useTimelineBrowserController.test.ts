import { expect, test } from "bun:test"
import type {
  DesktopPluginCatalog,
  DesktopPluginCatalogEntry,
} from "~/lib/desktop/attached-host-controller"
import type { NativeVst3CatalogSelection } from "~/lib/desktop/native-vst3-insertion"
import { nativeVst3InsertionAvailability } from "~/lib/desktop/native-vst3-insertion"
import {
  filterNativeVst3CatalogSelections,
} from "./useTimelineBrowserController"
import {
  autoHealStaleVst3Catalog,
  hasStaleVst3CatalogEntries,
} from "~/lib/desktop/vst3-catalog-auto-heal"

const selection = (role: "effect" | "instrument"): NativeVst3CatalogSelection => {
  const pluginClass = {
    classId: `class-${role}`,
    vendor: "Vendor",
    name: `Example ${role}`,
    version: "1",
    role,
    source: "factory" as const,
  }
  const entry: DesktopPluginCatalogEntry = {
    displayName: "Example",
    discoveredAtMs: 1,
    architecture: "unknown",
    hostingStatus: "ready",
    classes: [pluginClass],
    scanHealth: "scanned",
    binaryFingerprint: "a".repeat(64),
    catalogReference: {
      version: 1,
      architecture: "arm64",
      bundleFingerprint: "b".repeat(64),
      binaryFingerprint: "a".repeat(64),
      scannerCatalogVersion: 2,
    },
  }
  return { entry, pluginClass }
}

test("keeps external effects and instruments in their matching browser sections", () => {
  const selections = [selection("effect"), selection("instrument")]
  expect(filterNativeVst3CatalogSelections(selections, "effect").map(({ pluginClass }) => pluginClass.role))
    .toEqual(["effect"])
  expect(filterNativeVst3CatalogSelections(selections, "instrument").map(({ pluginClass }) => pluginClass.role))
    .toEqual(["instrument"])
})

const catalog = (
  identity: string,
  state: DesktopPluginCatalog["entries"][number]["hostingStatus"],
  scanHealth: DesktopPluginCatalog["entries"][number]["scanHealth"],
  withReference: boolean,
): DesktopPluginCatalog => ({
  version: 3,
  directories: ["/Library/Audio/Plug-Ins/VST3"],
  entries: (() => {
    const entry: DesktopPluginCatalog["entries"][number] = {
    displayName: `Example ${identity}`,
    discoveredAtMs: 1,
    architecture: "unknown",
    hostingStatus: state,
    classes: [{
      classId: `class-${identity}`,
      vendor: "Vendor",
      name: "Example Effect",
      version: "1",
      role: "effect",
      source: "factory",
    }],
    scanHealth,
    binaryFingerprint: identity,
    }
    if (withReference) {
      entry.catalogReference = {
        version: 1,
        architecture: "arm64",
        bundleFingerprint: identity,
        binaryFingerprint: identity,
        scannerCatalogVersion: 2,
      }
    }
    return [entry]
  })(),
  diagnostics: [],
  scannedAtMs: null,
})

test("auto-heals an already-trusted stale catalog once and applies the scanned catalog", async () => {
  const stale = catalog("auto-heal-once", "discovered", "filesystem-only", false)
  const scanned = catalog("auto-heal-once", "ready", "scanned", true)
  let scans = 0
  let refreshed: DesktopPluginCatalog | undefined
  const bridge = { scan: async () => {
    scans += 1
    return { ok: true as const, catalog: scanned }
  } }

  expect(hasStaleVst3CatalogEntries(stale)).toBeTrue()
  const result = await autoHealStaleVst3Catalog({
    catalog: stale,
    bridge,
    trustAcknowledged: true,
    onCatalog: (next) => { refreshed = next },
  })

  expect(result).toMatchObject({ ok: true })
  expect(scans).toBe(1)
  expect(refreshed?.entries[0]?.hostingStatus).toBe("ready")
  expect(hasStaleVst3CatalogEntries(scanned)).toBeFalse()
  expect(nativeVst3InsertionAvailability({
    selection: { entry: scanned.entries[0]!, pluginClass: scanned.entries[0]!.classes[0]! },
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: {
      id: "track-1",
      kind: "audio",
      channelRole: "track",
      groupId: undefined,
      outputTargetId: undefined,
      sends: [],
    },
    canWrite: true,
    bridgeAvailable: true,
    busy: false,
  })).toMatchObject({ enabled: true })
})

test("does not auto-heal before trust or loop on a persistent failed result", async () => {
  const stale = catalog("persistent-failure", "failed", "scan-failed", false)
  let scans = 0
  const bridge = { scan: async () => {
    scans += 1
    return { ok: true as const, catalog: stale }
  } }

  expect(await autoHealStaleVst3Catalog({ catalog: stale, bridge, trustAcknowledged: false })).toBeUndefined()
  expect(scans).toBe(0)
  await autoHealStaleVst3Catalog({ catalog: stale, bridge, trustAcknowledged: true })
  await autoHealStaleVst3Catalog({ catalog: stale, bridge, trustAcknowledged: true })
  expect(scans).toBe(1)
})

test("does not rescan a persistent stale catalog when a read changes discovery time", async () => {
  const first = catalog("persistent-failure-timestamp", "failed", "scan-failed", false)
  const second: DesktopPluginCatalog = {
    ...first,
    entries: first.entries.map((entry) => ({
      ...entry,
      discoveredAtMs: entry.discoveredAtMs + 1,
    })),
  }
  let scans = 0
  const bridge = { scan: async () => {
    scans += 1
    return { ok: true as const, catalog: first }
  } }
  let readTriggered: ReturnType<typeof autoHealStaleVst3Catalog> | undefined
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        if (event.type === "daw-plugin-catalog-changed") {
          readTriggered = autoHealStaleVst3Catalog({
            catalog: second,
            bridge,
            trustAcknowledged: true,
          })
        }
        return true
      },
    },
  })

  try {
    await autoHealStaleVst3Catalog({ catalog: first, bridge, trustAcknowledged: true })
    if (!readTriggered) throw new Error("Expected catalog change to trigger a catalog read.")
    await readTriggered
    expect(scans).toBe(1)
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
})

test("auto-heals a new stale catalog identity once", async () => {
  const first = catalog("new-identity-one", "discovered", "filesystem-only", false)
  const second = catalog("new-identity-two", "discovered", "filesystem-only", false)
  let scans = 0
  const bridge = { scan: async () => {
    scans += 1
    return { ok: true as const, catalog: scans === 1 ? first : second }
  } }

  await autoHealStaleVst3Catalog({ catalog: first, bridge, trustAcknowledged: true })
  await autoHealStaleVst3Catalog({ catalog: second, bridge, trustAcknowledged: true })
  expect(scans).toBe(2)
})
