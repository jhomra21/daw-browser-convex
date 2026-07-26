import { expect, test } from "bun:test"
import type { VstLaunchReference } from "@daw-browser/external-plugins"
import type { PluginCatalogData } from "./plugin-catalog"
import { catalogViewForRenderer, resolveVst3Attachment } from "./vst3-attachment"

const reference: VstLaunchReference = {
  version: 1,
  classId: "0123456789abcdef0123456789abcdef",
  vendorId: "Example Vendor",
  architecture: "arm64",
  bundleFingerprint: "b".repeat(64),
  binaryFingerprint: "a".repeat(64),
  scannerCatalogVersion: 2,
}

const catalog = (): PluginCatalogData => ({
  version: 3,
  directories: ["/Library/Audio/Plug-Ins/VST3"],
  entries: [{
    bundlePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
    displayName: "Example",
    configuredDirectory: "/Library/Audio/Plug-Ins/VST3",
    discoveredAtMs: 1,
    architecture: "unknown",
    hostingStatus: "unavailable",
    unavailableReason: "VST3 discovery is available, but native VST3 audio hosting is not active.",
    classes: [{
      classId: reference.classId,
      vendor: reference.vendorId,
      name: "Example",
      version: "1.0",
      role: "effect",
      source: "factory",
    }],
    scanHealth: "scanned",
    binaryFingerprint: reference.binaryFingerprint,
    launchEligibility: {
      canonicalBundlePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
      canonicalExecutablePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3/Contents/MacOS/Example",
      bundleFingerprint: reference.bundleFingerprint,
      binaryFingerprint: reference.binaryFingerprint,
      architecture: "arm64",
      codeSignVerifiedAtMs: 1,
      quarantinePresent: false,
      scannerProtocolVersion: 2,
    },
  }],
  diagnostics: [],
  scannedAtMs: 1,
})

test("resolves only current, matching scanner eligibility", () => {
  expect(resolveVst3Attachment(catalog(), reference)).toMatchObject({
    classId: reference.classId,
    canonicalBundlePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
  })
  expect(resolveVst3Attachment(catalog(), { ...reference, binaryFingerprint: "c".repeat(64) })).toBeUndefined()
  expect(resolveVst3Attachment(catalog(), { ...reference, scannerCatalogVersion: 1 })).toBeUndefined()
  expect(resolveVst3Attachment(catalog(), { ...reference, classId: "different" })).toBeUndefined()
})

test("fails closed for stale catalog health and missing signature eligibility", () => {
  const stale = catalog()
  stale.entries[0]!.scanHealth = "scan-failed"
  expect(resolveVst3Attachment(stale, reference)).toBeUndefined()

  const unsigned = catalog()
  unsigned.entries[0]!.launchEligibility = undefined
  expect(resolveVst3Attachment(unsigned, reference)).toBeUndefined()
})

test("never projects bundle or eligibility paths to renderer catalog responses", () => {
  const view = catalogViewForRenderer(catalog())
  expect(view.entries[0]?.catalogReference).toEqual({
    version: 1,
    architecture: "arm64",
    bundleFingerprint: reference.bundleFingerprint,
    binaryFingerprint: reference.binaryFingerprint,
    scannerCatalogVersion: 2,
  })
  expect(JSON.stringify(view)).not.toContain("bundlePath")
  expect(JSON.stringify(view)).not.toContain("configuredDirectory")
  expect(JSON.stringify(view)).not.toContain("canonicalBundlePath")
  expect(JSON.stringify(view)).not.toContain("Example.vst3")
})
