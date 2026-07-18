import type { ForgeConfig } from "@electron-forge/shared-types"
import { FuseV1Options, FuseVersion } from "@electron/fuses"
import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    prune: true,
    // Fuses are flipped during packaging before Electron Packager signs the final app.
    osxSign: { identity: "-" },
  },
  hooks: {
    postPackage: async (_config, packageResult) => {
      if (packageResult.platform !== "darwin") return
      const packageApps = (await Promise.all(packageResult.outputPaths.map(async (outputPath) =>
        (await readdir(outputPath)).filter((entry) => entry.endsWith(".app")).map((entry) => path.join(outputPath, entry)),
      ))).flat()
      await Promise.all(packageApps.map((appPath) => run("codesign", ["--deep", "--force", "--sign", "-", appPath])))
    },
  },
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "linux"], config: {} },
    { name: "@electron-forge/maker-dmg", platforms: ["darwin"], config: {} },
    { name: "@electron-forge/maker-squirrel", platforms: ["win32"], config: {} },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          { entry: "main.ts", config: "vite.main.config.ts" },
          { entry: "preload.ts", config: "vite.preload.config.ts" },
        ],
        renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
      },
    },
    {
      name: "@electron-forge/plugin-fuses",
      config: {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: false,
      },
    },
  ],
}

export default config
