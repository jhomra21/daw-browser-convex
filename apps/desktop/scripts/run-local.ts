import { mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import {
  getNativeReleaseManifestPath,
  prepareNativeReleaseManifest,
  rebuildNativePackageArtifacts,
  resolveNativeArtifactPaths,
  type NativeReleaseArtifactPaths,
} from "../release.config"

export type LocalPackageCommand = "package" | "make"

export type LocalPackagePreparation = {
  command: LocalPackageCommand
  artifactPaths: NativeReleaseArtifactPaths
  manifestPath: string
  environment: NodeJS.ProcessEnv
}

const signingEnvironmentKeys = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_NOTARY_KEYCHAIN_PROFILE",
  "APPLE_NOTARY_KEYCHAIN",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "DAW_NOTARY_PROFILE",
  "DAW_SKIP_NOTARIZATION",
] as const

export const createLocalPackageEnvironment = (
  sourceEnvironment: NodeJS.ProcessEnv,
  artifactPaths: NativeReleaseArtifactPaths,
  manifestPath: string,
): NodeJS.ProcessEnv => {
  const environment = { ...sourceEnvironment }
  for (const key of signingEnvironmentKeys) delete environment[key]
  return {
    ...environment,
    DAW_LOCAL_UNSIGNED_PACKAGE: "1",
    DAW_ENABLE_VST3_HOSTING: "1",
    DAW_VST3_SCANNER_PATH: artifactPaths.scannerPath,
    DAW_VST3_WORKER_PATH: artifactPaths.workerPath,
    DAW_AUDIO_HOST_PATH: artifactPaths.audioHostPath,
    DAW_NATIVE_ARTIFACT_MANIFEST_PATH: manifestPath,
  }
}

export const createLocalPackagePreparation = (
  command: LocalPackageCommand,
  sourceEnvironment: NodeJS.ProcessEnv,
  artifactPaths: NativeReleaseArtifactPaths,
  manifestPath: string,
): LocalPackagePreparation => ({
  command,
  artifactPaths,
  manifestPath,
  environment: createLocalPackageEnvironment(sourceEnvironment, artifactPaths, manifestPath),
})

const commandArgument = process.argv[2]
const arguments_ = process.argv.slice(3)
const diagnostic = arguments_.includes("--dry-run") || arguments_.includes("--diagnostic")
const forgeArguments = arguments_.filter((argument) => argument !== "--dry-run" && argument !== "--diagnostic")

const isLocalPackageCommand = (value: string | undefined): value is LocalPackageCommand =>
  value === "package" || value === "make"

const fail = (message: string): never => {
  throw new Error(message)
}

const main = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    fail("The local macOS packaging helper must run on macOS.")
  }
  const command = isLocalPackageCommand(commandArgument)
    ? commandArgument
    : fail("Usage: bun scripts/run-local.ts <package|make> [--dry-run|--diagnostic] [Forge arguments...]")

  const desktopRoot = path.resolve(import.meta.dirname, "..")
  const projectRoot = path.resolve(desktopRoot, "../..")
  if (!diagnostic) rebuildNativePackageArtifacts(projectRoot)
  const artifactPaths = resolveNativeArtifactPaths(projectRoot)
  const manifestPath = getNativeReleaseManifestPath(desktopRoot)
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await prepareNativeReleaseManifest(artifactPaths, manifestPath)

  const preparation = createLocalPackagePreparation(
    command,
    process.env,
    artifactPaths,
    manifestPath,
  )

  if (diagnostic) {
    process.stdout.write([
      `command: ${preparation.command}`,
      "mode: unsigned-local",
      "native VST3 hosting: enabled",
      `scanner: ${artifactPaths.scannerPath}`,
      `worker: ${artifactPaths.workerPath}`,
      `audio host: ${artifactPaths.audioHostPath}`,
      `manifest: ${manifestPath}`,
    ].join("\n") + "\n")
    return
  }

  const forgeRunner = path.join(import.meta.dirname, "run-forge.ts")
  const result = spawnSync(process.execPath, [forgeRunner, preparation.command, ...forgeArguments], {
    cwd: desktopRoot,
    env: preparation.environment,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
