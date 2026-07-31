import { mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import {
  assembleReleaseEnvironment,
  discoverSigningIdentity,
  formatReleaseDiagnostic,
  getNativeReleaseManifestPath,
  prepareNativeReleaseManifest,
  rebuildNativePackageArtifacts,
  resolveNativeArtifactPaths,
  resolveNotaryProfile,
} from "../release.config"

export type ReleaseCommand = "package" | "make"

export type ReleasePreparation = {
  command: ReleaseCommand
  identity: string
  notaryProfile: string
  artifactPaths: ReturnType<typeof resolveNativeArtifactPaths>
  manifestPath: string
  environment: NodeJS.ProcessEnv
}

export const createReleasePreparation = (
  command: ReleaseCommand,
  sourceEnvironment: NodeJS.ProcessEnv,
  identity: string,
  notaryProfile: string,
  artifactPaths: ReturnType<typeof resolveNativeArtifactPaths>,
  manifestPath: string,
): ReleasePreparation => ({
  command,
  identity,
  notaryProfile,
  artifactPaths,
  manifestPath,
  environment: assembleReleaseEnvironment(
    sourceEnvironment,
    identity,
    notaryProfile,
    artifactPaths,
    manifestPath,
  ),
})

const commandArgument = process.argv[2]
const arguments_ = process.argv.slice(3)
const diagnostic = arguments_.includes("--dry-run") || arguments_.includes("--diagnostic")
const forgeArguments = arguments_.filter((argument) => argument !== "--dry-run" && argument !== "--diagnostic")

const isReleaseCommand = (value: string | undefined): value is ReleaseCommand =>
  value === "package" || value === "make"

const fail = (message: string): never => {
  throw new Error(message)
}

const main = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    fail("The macOS release helper must run on macOS.")
  }
  const command = isReleaseCommand(commandArgument)
    ? commandArgument
    : fail("Usage: bun scripts/run-release.ts <package|make> [--dry-run|--diagnostic] [Forge arguments...]")

  const desktopRoot = path.resolve(import.meta.dirname, "..")
  const projectRoot = path.resolve(desktopRoot, "../..")
  if (!diagnostic) rebuildNativePackageArtifacts(projectRoot)
  const artifactPaths = resolveNativeArtifactPaths(projectRoot)
  const identity = discoverSigningIdentity()
  const notaryProfile = resolveNotaryProfile()
  const manifestPath = getNativeReleaseManifestPath(desktopRoot)
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await prepareNativeReleaseManifest(artifactPaths, manifestPath)

  const preparation = createReleasePreparation(
    command,
    process.env,
    identity,
    notaryProfile,
    artifactPaths,
    manifestPath,
  )

  if (diagnostic) {
    process.stdout.write(`${formatReleaseDiagnostic(
      preparation.command,
      identity,
      notaryProfile,
      artifactPaths,
      manifestPath,
    )}\n`)
    return
  }

  const forgeRunner = path.join(import.meta.dirname, "run-forge.ts")
  const result = spawnSync(process.execPath, [forgeRunner, preparation.command, ...forgeArguments], {
    cwd: desktopRoot,
    env: preparation.environment,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
