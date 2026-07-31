import { expect, test } from "bun:test"
import type { DesktopPluginCatalogEntry } from "~/lib/desktop/attached-host-controller"
import type { NativeVst3CatalogSelection } from "~/lib/desktop/native-vst3-insertion"
import {
  filterNativeVst3CatalogSelections,
} from "./useTimelineBrowserController"

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
    hostingStatus: "unavailable",
    unavailableReason: "Preflight required.",
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
