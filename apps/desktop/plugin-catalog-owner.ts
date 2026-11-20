import path from "node:path"
import { canonicalVst3SearchPaths, createPluginCatalogStore } from "./plugin-catalog"
import { createVst3ScannerSupervisor } from "./vst3-scanner"

/** The plug-in catalog store with the scanner that fills it and the worker that trusts its entries. */
export const createPluginCatalogOwner = (options: {
  userData: string
  home: string
  scannerPath: string | undefined
  workerPath: string | undefined
}) => {
  const { scannerPath } = options

  const scanner = scannerPath ? createVst3ScannerSupervisor({
    platform: process.platform,
    arch: process.arch,
    scannerPath,
  }) : undefined

  const store = createPluginCatalogStore({ filePath: path.join(options.userData, "plugin-catalog-v1.json") })

  const initialize = async () => {
    if (process.platform !== "darwin") return

    await store.initialize(
      canonicalVst3SearchPaths(options.home),
      scanner
        ? (entry, directories) => scanner.scan(entry, directories)
        : undefined,
    )
  }

  return { store, scanner, workerPath: options.workerPath, initialize }
}
