import type { VstLaunchReference } from "@daw-browser/external-plugins"
import type { PluginCatalogData, Vst3CatalogEntry } from "./plugin-catalog"

export type ResolvedVst3Eligibility = {
  classId: string
  vendorId: string
  role: "effect" | "instrument"
  canonicalBundlePath: string
  canonicalExecutablePath: string
  bundleFingerprint: string
  binaryFingerprint: string
  scannerProtocolVersion: 2
}

export type Vst3CatalogView = Omit<PluginCatalogData, "entries"> & {
  entries: Array<Omit<Vst3CatalogEntry, "bundlePath" | "configuredDirectory" | "launchEligibility"> & {
    catalogReference?: {
      version: 1
      architecture: "arm64"
      bundleFingerprint: string
      binaryFingerprint: string
      scannerCatalogVersion: 2
    }
  }>
}

export const catalogViewForRenderer = (catalog: PluginCatalogData): Vst3CatalogView => ({
  ...catalog,
  entries: catalog.entries.map(({ bundlePath: _bundlePath, configuredDirectory: _configuredDirectory, launchEligibility, ...entry }) => ({
    ...entry,
    catalogReference: launchEligibility === undefined ? undefined : {
        version: 1,
        architecture: launchEligibility.architecture,
        bundleFingerprint: launchEligibility.bundleFingerprint,
        binaryFingerprint: launchEligibility.binaryFingerprint,
        scannerCatalogVersion: launchEligibility.scannerProtocolVersion,
      },
  })),
})

export const resolveVst3Attachment = (
  catalog: PluginCatalogData,
  reference: VstLaunchReference,
): ResolvedVst3Eligibility | undefined => {
  if (reference.version !== 1 || reference.architecture !== "arm64") return undefined
  const entry = catalog.entries.find((candidate) => (
    candidate.scanHealth === "scanned"
    && candidate.binaryFingerprint === reference.binaryFingerprint
    && candidate.launchEligibility?.bundleFingerprint === reference.bundleFingerprint
    && candidate.launchEligibility.scannerProtocolVersion === reference.scannerCatalogVersion
  ))
  const pluginClass = entry?.classes.find((candidate) => (
    candidate.classId === reference.classId && candidate.vendor === reference.vendorId
  ))
  const eligibility = entry?.launchEligibility
  if (
    !eligibility
    || !pluginClass
    || eligibility.architecture !== "arm64"
    || eligibility.quarantinePresent
    || eligibility.binaryFingerprint !== reference.binaryFingerprint
    || eligibility.bundleFingerprint !== reference.bundleFingerprint
    || eligibility.scannerProtocolVersion !== reference.scannerCatalogVersion
  ) return undefined
  return {
    classId: reference.classId,
    vendorId: reference.vendorId,
    role: pluginClass.role,
    canonicalBundlePath: eligibility.canonicalBundlePath,
    canonicalExecutablePath: eligibility.canonicalExecutablePath,
    bundleFingerprint: eligibility.bundleFingerprint,
    binaryFingerprint: eligibility.binaryFingerprint,
    scannerProtocolVersion: eligibility.scannerProtocolVersion,
  }
}
