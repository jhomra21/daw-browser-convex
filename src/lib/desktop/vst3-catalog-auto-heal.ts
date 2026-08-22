import type { DesktopBridge, DesktopPluginCatalog, DesktopPluginCatalogReply } from "~/types/desktop-bridge"

type PluginCatalogBridge = NonNullable<DesktopBridge["pluginCatalog"]>

type AutoHealInput = {
  catalog: DesktopPluginCatalog
  bridge: Pick<PluginCatalogBridge, "scan">
  trustAcknowledged: boolean
  onCatalog?: (catalog: DesktopPluginCatalog) => void
}

type ActiveScan = {
  promise: Promise<DesktopPluginCatalogReply>
  eventDispatched: boolean
}

const attemptedStaleCatalogIdentities = new Set<string>()
let activeScan: ActiveScan | undefined

const catalogIdentity = (catalog: DesktopPluginCatalog): string => JSON.stringify({
  version: catalog.version,
  directories: catalog.directories,
  entries: catalog.entries
    .map((entry) => ({
      displayName: entry.displayName,
      hostingStatus: entry.hostingStatus,
      unavailableReason: entry.unavailableReason,
      scanHealth: entry.scanHealth,
      scannerVersion: entry.scannerVersion,
      sdkVersion: entry.sdkVersion,
      binaryFingerprint: entry.binaryFingerprint,
      catalogReference: entry.catalogReference,
      classes: entry.classes
        .map((pluginClass) => ({
          classId: pluginClass.classId,
          vendor: pluginClass.vendor,
          name: pluginClass.name,
          version: pluginClass.version,
          role: pluginClass.role,
          source: pluginClass.source,
          sdkVersion: pluginClass.sdkVersion,
        }))
        .sort((left, right) => left.classId.localeCompare(right.classId)),
    }))
    .sort((left, right) => (
      left.displayName.localeCompare(right.displayName)
      || (left.binaryFingerprint ?? "").localeCompare(right.binaryFingerprint ?? "")
    )),
})

export const hasStaleVst3CatalogEntries = (catalog: DesktopPluginCatalog): boolean => (
  catalog.entries.some((entry) => (
    entry.hostingStatus !== "ready"
    || entry.scanHealth !== "scanned"
    || entry.catalogReference === undefined
  ))
)

const dispatchCatalogChanged = () => {
  const browserWindow = globalThis.window
  if (!browserWindow) return
  browserWindow.dispatchEvent(new Event("daw-plugin-catalog-changed"))
}

const getActiveScan = (bridge: Pick<PluginCatalogBridge, "scan">): ActiveScan => {
  if (activeScan) return activeScan
  const state: ActiveScan = {
    promise: bridge.scan(),
    eventDispatched: false,
  }
  activeScan = state
  void state.promise.then(
    () => {
      if (activeScan === state) activeScan = undefined
    },
    () => {
      if (activeScan === state) activeScan = undefined
    },
  )
  return state
}

export const autoHealStaleVst3Catalog = async (
  input: AutoHealInput,
): Promise<DesktopPluginCatalogReply | undefined> => {
  if (!input.trustAcknowledged || !hasStaleVst3CatalogEntries(input.catalog)) return undefined
  const identity = catalogIdentity(input.catalog)
  if (attemptedStaleCatalogIdentities.has(identity)) {
    if (!activeScan) return undefined
    const result = await activeScan.promise
    if ("catalog" in result) input.onCatalog?.(result.catalog)
    return result
  }
  attemptedStaleCatalogIdentities.add(identity)

  const scan = getActiveScan(input.bridge)
  const result = await scan.promise
  if ("catalog" in result) {
    input.onCatalog?.(result.catalog)
    if (!scan.eventDispatched) {
      scan.eventDispatched = true
      dispatchCatalogChanged()
    }
  }
  return result
}
