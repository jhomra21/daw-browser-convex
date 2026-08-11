import type { ForgeConfig } from "@electron-forge/shared-types"
import { FuseV1Options, FuseVersion } from "@electron/fuses"
import { nativeVst3WorkerArtifactId } from "@daw-browser/plugin-host-protocol"
import { execFile } from "node:child_process"
import { chmod, mkdir, open, readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { computePortableWasmSourceHash } from "../../native/audio-core/scripts/portable-wasm-source-hash"
import {
  nativeAudioHostArtifactName,
  nativeReleaseArtifactManifestName,
  nativeVst3ScannerArtifactName,
  getPackagedNativeReleaseArtifacts,
  sha256ReleaseArtifact,
  validateNativeReleaseArtifacts,
  verifyPackagedNativeReleaseArtifacts,
  writePackagedNativeReleaseArtifactManifest,
  type NativeReleaseArtifact,
} from "./native-release-artifacts"

const run = promisify(execFile)
type PluginHostReleaseArtifact = NativeReleaseArtifact

const desktopDirectory = import.meta.dirname
const repositoryRoot = path.resolve(desktopDirectory, "../..")

const portableWasmReleaseAssetNames = [
  "daw-audio-core.wasm",
  "daw-audio-core.manifest.json",
] as const

export const validatePortableWasmReleaseAssets = async (
  publicDirectory = path.join(repositoryRoot, "public"),
  sourceRepositoryRoot = repositoryRoot,
): Promise<void> => {
  const [wasmName, manifestName] = portableWasmReleaseAssetNames
  const wasmPath = path.join(publicDirectory, "audio-core", wasmName)
  const manifestPath = path.join(publicDirectory, "audio-core", manifestName)
  if (!await isFile(wasmPath)) throw new Error(`Required portable Wasm release asset is missing: ${wasmPath}`)
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch {
    throw new Error(`Required portable Wasm release asset is missing or invalid: ${manifestPath}`)
  }
  if (typeof manifest !== "object" || manifest === null
    || !("artifactKind" in manifest) || manifest.artifactKind !== "production"
    || !("buildType" in manifest) || manifest.buildType !== "Release"
    || !("lto" in manifest) || manifest.lto !== true
    || !("sizeBytes" in manifest) || typeof manifest.sizeBytes !== "number"
    || !("maximumBytes" in manifest) || typeof manifest.maximumBytes !== "number"
    || !("sha256" in manifest) || typeof manifest.sha256 !== "string"
    || !("sourceHash" in manifest) || typeof manifest.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceHash)) {
    throw new Error(`Required portable Wasm release asset is invalid: ${manifestPath}`)
  }
  const sourceHash = await computePortableWasmSourceHash(sourceRepositoryRoot)
  if (manifest.sourceHash !== sourceHash) {
    throw new Error(`Portable Wasm release asset source hash is stale: ${manifestPath}`)
  }
  const size = (await stat(wasmPath)).size
  if (size !== manifest.sizeBytes || size > manifest.maximumBytes) {
    throw new Error(`Portable Wasm release asset exceeds or does not match its manifest size budget: ${wasmPath}`)
  }
  const hash = await sha256ReleaseArtifact(wasmPath)
  if (hash !== manifest.sha256) throw new Error(`Portable Wasm release asset hash does not match its manifest: ${wasmPath}`)
}

export const getPluginHostReleaseArtifactPlan = (
  environment: NodeJS.ProcessEnv = process.env,
): PluginHostReleaseArtifact[] => {
  if (environment.DAW_ENABLE_VST3_HOSTING !== "1") return []
  const scannerPath = environment.DAW_VST3_SCANNER_PATH
  const workerPath = environment.DAW_VST3_WORKER_PATH
  const audioHostPath = environment.DAW_AUDIO_HOST_PATH
  if (!scannerPath || !workerPath || !audioHostPath) {
    throw new Error("DAW_ENABLE_VST3_HOSTING=1 requires DAW_VST3_SCANNER_PATH, DAW_VST3_WORKER_PATH, and DAW_AUDIO_HOST_PATH.")
  }
  return [
    { sourcePath: path.resolve(scannerPath), name: nativeVst3ScannerArtifactName },
    { sourcePath: path.resolve(workerPath), name: nativeVst3WorkerArtifactId },
    { sourcePath: path.resolve(audioHostPath), name: nativeAudioHostArtifactName },
  ]
}

export const validatePluginHostReleaseArtifactPlan = async (
  plan: readonly PluginHostReleaseArtifact[],
  manifestPath = process.env.DAW_NATIVE_ARTIFACT_MANIFEST_PATH,
): Promise<void> => {
  if (plan.length === 0) return
  if (!manifestPath) throw new Error("DAW_ENABLE_VST3_HOSTING=1 requires DAW_NATIVE_ARTIFACT_MANIFEST_PATH.")
  if (path.basename(manifestPath) !== nativeReleaseArtifactManifestName) {
    throw new Error(`Native release artifact manifest must be named ${nativeReleaseArtifactManifestName}.`)
  }
  await validateNativeReleaseArtifacts(plan, path.resolve(manifestPath))
}

const pluginHostReleaseArtifacts = getPluginHostReleaseArtifactPlan()
const isFile = async (filePath: string) => stat(filePath).then((entry) => entry.isFile()).catch(() => false)

type NotaryCredentials =
  | { keychainProfile: string; keychain?: string }
  | { appleId: string; appleIdPassword: string; teamId: string }
  | { appleApiKey: string; appleApiKeyId: string; appleApiIssuer: string }

const notaryCredentials = (environment: NodeJS.ProcessEnv): NotaryCredentials | undefined => {
  if (environment.APPLE_NOTARY_KEYCHAIN_PROFILE) {
    return {
      keychainProfile: environment.APPLE_NOTARY_KEYCHAIN_PROFILE,
      ...(environment.APPLE_NOTARY_KEYCHAIN ? { keychain: environment.APPLE_NOTARY_KEYCHAIN } : {}),
    }
  }
  if (environment.APPLE_ID && environment.APPLE_APP_SPECIFIC_PASSWORD && environment.APPLE_TEAM_ID) {
    return {
      appleId: environment.APPLE_ID,
      appleIdPassword: environment.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: environment.APPLE_TEAM_ID,
    }
  }
  if (environment.APPLE_API_KEY && environment.APPLE_API_KEY_ID && environment.APPLE_API_ISSUER) {
    return {
      appleApiKey: environment.APPLE_API_KEY,
      appleApiKeyId: environment.APPLE_API_KEY_ID,
      appleApiIssuer: environment.APPLE_API_ISSUER,
    }
  }
  return undefined
}

const entitlementsDirectory = path.join(desktopDirectory, "entitlements")
const appEntitlements = path.join(entitlementsDirectory, "app.plist")
const helperEntitlements = path.join(entitlementsDirectory, "helper.plist")
const nativeEntitlements = path.join(entitlementsDirectory, "native.plist")
const vstScannerEntitlements = path.join(entitlementsDirectory, "vst3-scanner.plist")
const vstWorkerEntitlements = path.join(entitlementsDirectory, "vst3-worker.plist")

export const getMacReleaseConfiguration = (environment: NodeJS.ProcessEnv = process.env) => {
  const identity = environment.APPLE_SIGNING_IDENTITY
  const notarize = notaryCredentials(environment)
  if (!identity || (!notarize && environment.DAW_SKIP_NOTARIZATION !== "1")) return undefined
  return {
    sign: {
      identity,
      identityValidation: true,
      hardenedRuntime: true,
      signatureFlags: ["runtime"],
      strictVerify: true,
      preAutoEntitlements: false,
      ignore: pluginHostReleaseArtifacts.length > 0
        ? (filePath: string) => pluginHostReleaseArtifacts.some((artifact) => path.basename(filePath) === artifact.name)
        : undefined,
      optionsForFile: (filePath: string) => {
        const basename = path.basename(filePath)
        if (basename === nativeVst3WorkerArtifactId) {
          return { entitlements: vstWorkerEntitlements, hardenedRuntime: true, signatureFlags: ["runtime"] }
        }
        if (basename === nativeVst3ScannerArtifactName) {
          return { entitlements: vstScannerEntitlements, hardenedRuntime: true, signatureFlags: ["runtime"] }
        }
        if (basename === nativeAudioHostArtifactName) {
          return { entitlements: nativeEntitlements, hardenedRuntime: true, signatureFlags: ["runtime"] }
        }
        if (filePath.endsWith(".app")) {
          return {
            entitlements: filePath.includes(".app/") ? helperEntitlements : appEntitlements,
            hardenedRuntime: true,
            signatureFlags: ["runtime"],
          }
        }
        return { entitlements: nativeEntitlements, hardenedRuntime: true, signatureFlags: ["runtime"] }
      },
    },
    ...(notarize ? { notarize } : {}),
  }
}

export const requireMacReleaseConfiguration = (environment: NodeJS.ProcessEnv = process.env) => {
  const configuration = getMacReleaseConfiguration(environment)
  if (!environment.APPLE_SIGNING_IDENTITY) {
    throw new Error("macOS packaging requires APPLE_SIGNING_IDENTITY; ad-hoc release signing is not allowed.")
  }
  if (!configuration) {
    throw new Error("macOS packaging requires complete notarytool credentials or an APPLE_NOTARY_KEYCHAIN_PROFILE.")
  }
  return configuration
}

export const isExplicitLocalUnsignedPackage = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean => environment.DAW_LOCAL_UNSIGNED_PACKAGE === "1"

export const shouldRequireMacReleaseConfiguration = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean => !isExplicitLocalUnsignedPackage(environment)

export const shouldVerifySignedMacPackage = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean => shouldRequireMacReleaseConfiguration(environment)

const localUnsignedPackage = isExplicitLocalUnsignedPackage()
const macReleaseConfiguration = localUnsignedPackage ? undefined : getMacReleaseConfiguration()

const machOMagic = new Set([
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
])

const isMachOFile = async (filePath: string) => {
  const handle = await open(filePath, "r")
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead === header.length && machOMagic.has(header.toString("hex"))
  } finally {
    await handle.close()
  }
}

const signedCodeCandidates = async (root: string): Promise<string[]> => {
  const candidates: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      candidates.push(...await signedCodeCandidates(entryPath))
      if ([".app", ".framework", ".xpc", ".bundle"].includes(path.extname(entryPath))) candidates.push(entryPath)
      continue
    }
    if (!entry.isFile()) continue
    if (await isMachOFile(entryPath)) candidates.push(entryPath)
  }
  return candidates
}

export const getPackagedMacResourcesPath = async (buildPath: string) => {
  const appBundles = (await readdir(buildPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
  if (appBundles.length !== 1) {
    throw new Error(`Expected exactly one packaged macOS app bundle in ${buildPath}.`)
  }
  return path.join(buildPath, appBundles[0].name, "Contents", "Resources")
}

const signPackagedNativeReleaseArtifacts = async (
  resourcesPath: string,
  configuration: NonNullable<ReturnType<typeof getMacReleaseConfiguration>>,
): Promise<void> => {
  const artifacts = getPackagedNativeReleaseArtifacts(resourcesPath)
  for (const artifact of artifacts) {
    const options = configuration.sign.optionsForFile(artifact.sourcePath)
    const arguments_ = [
      "--sign",
      configuration.sign.identity,
      "--force",
      "--timestamp",
      "--options",
      Array.isArray(options.signatureFlags) ? options.signatureFlags.join(",") : options.signatureFlags,
      "--entitlements",
      options.entitlements,
      artifact.sourcePath,
    ]
    await run("codesign", arguments_)
    await run("codesign", ["--verify", "--strict", "--verbose=2", artifact.sourcePath])
  }
  await writePackagedNativeReleaseArtifactManifest(resourcesPath)
}

const verifySignedPackage = async (appPath: string) => {
  if (pluginHostReleaseArtifacts.length > 0) {
    await verifyPackagedNativeReleaseArtifacts(path.join(appPath, "Contents", "Resources"))
  }
  const candidates = [...await signedCodeCandidates(appPath), appPath]
  for (const candidate of candidates) {
    await run("codesign", ["--verify", "--strict", "--verbose=2", candidate])
  }
}
const compileNativeFileCapabilityHelper = async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const nativeDirectory = path.join(desktopDirectory, ".native")
  await mkdir(nativeDirectory, { recursive: true })
  const source = path.join(desktopDirectory, "native", "file-capability-helper.c")
  const output = path.join(nativeDirectory, "file-capability-helper")
  const platformDefinition = process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_GNU_SOURCE"
  await run("clang", ["-std=c17", "-Wall", "-Wextra", "-Werror", platformDefinition, source, "-o", output])
  await chmod(output, 0o755)
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    prune: true,
    extraResource: process.platform === "darwin" || process.platform === "linux"
      ? [
          ".native/file-capability-helper",
          ...pluginHostReleaseArtifacts.map((artifact) => artifact.sourcePath),
          ...(pluginHostReleaseArtifacts.length > 0 && process.env.DAW_NATIVE_ARTIFACT_MANIFEST_PATH
            ? [path.resolve(process.env.DAW_NATIVE_ARTIFACT_MANIFEST_PATH)]
            : []),
        ]
      : [],
    afterCopyExtraResources: pluginHostReleaseArtifacts.length > 0 && macReleaseConfiguration
      ? [(buildPath, _electronVersion, platform, _arch, callback) => {
          if (platform !== "darwin") {
            callback()
            return
          }
          void getPackagedMacResourcesPath(buildPath)
            .then((resourcesPath) => signPackagedNativeReleaseArtifacts(resourcesPath, requireMacReleaseConfiguration()))
            .then(() => callback(), (error: unknown) => callback(
              error instanceof Error ? error : new Error(String(error)),
            ))
        }]
      : undefined,
    osxSign: macReleaseConfiguration?.sign,
    osxNotarize: macReleaseConfiguration?.notarize,
  },
  hooks: {
    preStart: async () => {
      await compileNativeFileCapabilityHelper()
    },
    prePackage: async (_config, platform) => {
      if (platform === "darwin" && shouldRequireMacReleaseConfiguration()) requireMacReleaseConfiguration()
      await validatePluginHostReleaseArtifactPlan(pluginHostReleaseArtifacts)
      await validatePortableWasmReleaseAssets(path.join(repositoryRoot, "public"), repositoryRoot)
      await compileNativeFileCapabilityHelper()
    },
    postPackage: async (_config, packageResult) => {
      if (packageResult.platform !== "darwin" || !shouldVerifySignedMacPackage()) return
      const packageApps = (await Promise.all(packageResult.outputPaths.map(async (outputPath) =>
        (await readdir(outputPath)).filter((entry) => entry.endsWith(".app")).map((entry) => path.join(outputPath, entry)),
      ))).flat()
      await Promise.all(packageApps.map(verifySignedPackage))
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
