import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import path from "node:path"
import {
  nativeAudioHostArtifactName,
  nativeReleaseArtifactManifestName,
  nativeVst3ScannerArtifactName,
  writeNativeReleaseArtifactManifest,
  validateNativeReleaseArtifacts,
  type NativeReleaseArtifact,
} from "./native-release-artifacts"
import { nativeVst3WorkerArtifactId } from "@daw-browser/plugin-host-protocol"

export const defaultNotaryProfile = "DAW_NOTARY_PROFILE"

export type NativeReleaseArtifactPaths = {
  scannerPath: string
  workerPath: string
  audioHostPath: string
}

export type NativeReleaseEnvironment = NodeJS.ProcessEnv

type SecurityCommandResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

type SecurityCommand = (
  command: string,
  arguments_: readonly string[],
) => SecurityCommandResult

type NativeBuildCommandResult = {
  status: number | null
  error?: Error
}

type NativeBuildCommand = (
  command: string,
  arguments_: readonly string[],
) => NativeBuildCommandResult

const runSecurityCommand: SecurityCommand = (command, arguments_) => {
  const result = spawnSync(command, [...arguments_], { encoding: "utf8" })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  }
}

const runNativeBuildCommand: NativeBuildCommand = (command, arguments_) => {
  const result = spawnSync(command, [...arguments_], { stdio: "inherit" })
  return {
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  }
}

export const rebuildNativePackageArtifacts = (
  projectRoot: string,
  runCommand: NativeBuildCommand = runNativeBuildCommand,
): void => {
  const nativeRoot = path.join(projectRoot, "native")
  const builds = [
    {
      name: "VST3 scanner and worker",
      directory: path.join(nativeRoot, "build", "vst3-worker-debug"),
      configureArguments: [
        "-DCMAKE_BUILD_TYPE=Debug",
        "-DDAW_BUILD_PLUGIN_HOST=ON",
        "-DDAW_BUILD_AUDIO_HOST_MACOS=OFF",
        "-DBUILD_TESTING=ON",
      ],
      targets: ["daw-vst3-scanner", "daw-vst3-worker"],
    },
    {
      name: "macOS audio host",
      directory: path.join(nativeRoot, "build", "audio-host-macos-release"),
      configureArguments: [
        "-DCMAKE_BUILD_TYPE=Release",
        "-DDAW_BUILD_PLUGIN_HOST=ON",
        "-DDAW_BUILD_AUDIO_HOST_MACOS=ON",
        "-DBUILD_TESTING=OFF",
      ],
      targets: ["daw-audio-host-macos"],
    },
  ] as const

  for (const build of builds) {
    const configure = runCommand("cmake", [
      "-S",
      nativeRoot,
      "-B",
      build.directory,
      ...build.configureArguments,
    ])
    if (configure.error || configure.status !== 0) {
      throw new Error(`CMake configure failed for ${build.name}.`)
    }
    const compile = runCommand("cmake", [
      "--build",
      build.directory,
      "--target",
      ...build.targets,
      "--parallel",
    ])
    if (compile.error || compile.status !== 0) {
      throw new Error(`CMake build failed for ${build.name}.`)
    }
  }
}

export const parseDeveloperIdApplicationIdentities = (output: string): string[] => {
  const identities: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"(Developer ID Application:[^"]+)"\s*$/)
    if (match?.[1]) identities.push(match[1])
  }
  return identities
}

export const discoverSigningIdentity = (
  runCommand: SecurityCommand = runSecurityCommand,
): string => {
  const result = runCommand("security", ["find-identity", "-v", "-p", "codesigning"])
  if (result.error || result.status !== 0) {
    throw new Error("Unable to inspect macOS code-signing identities with security find-identity.")
  }
  const identity = parseDeveloperIdApplicationIdentities(result.stdout)[0]
  if (!identity) {
    throw new Error(
      "No valid Developer ID Application identity was found. Install a Developer ID Application certificate in the macOS keychain.",
    )
  }
  return identity
}

export const resolveNotaryProfile = (
  environment: NodeJS.ProcessEnv = process.env,
): string => environment.APPLE_NOTARY_KEYCHAIN_PROFILE
  ?? environment.DAW_NOTARY_PROFILE
  ?? defaultNotaryProfile

const artifactCandidates = (projectRoot: string) => ({
  scannerPath: [
    path.join(projectRoot, "native", "build", "vst3-worker-debug", "plugin-host", nativeVst3ScannerArtifactName),
  ],
  workerPath: [
    path.join(projectRoot, "native", "build", "vst3-worker-debug", "plugin-host", nativeVst3WorkerArtifactId),
  ],
  audioHostPath: [
    path.join(projectRoot, "native", "build", "audio-host-macos-release", "audio-host-macos", nativeAudioHostArtifactName),
    path.join(projectRoot, "native", "build", "audio-host-macos-debug", "audio-host-macos", nativeAudioHostArtifactName),
  ],
})

const resolveCandidate = (
  name: string,
  candidates: readonly string[],
  fileExists: (filePath: string) => boolean,
): string => {
  const resolved = candidates.find(fileExists)
  if (resolved) return resolved
  throw new Error(
    `Required macOS native ${name} artifact is missing. Checked:\n${candidates.map((candidate) => `- ${candidate}`).join("\n")}`,
  )
}

const isFile = (filePath: string): boolean => {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

export const resolveNativeArtifactPaths = (
  projectRoot: string,
  fileExists: (filePath: string) => boolean = isFile,
): NativeReleaseArtifactPaths => {
  const candidates = artifactCandidates(projectRoot)
  return {
    scannerPath: resolveCandidate("VST3 scanner", candidates.scannerPath, fileExists),
    workerPath: resolveCandidate("VST3 worker", candidates.workerPath, fileExists),
    audioHostPath: resolveCandidate("Audio host", candidates.audioHostPath, fileExists),
  }
}

export const getNativeReleaseArtifacts = (
  artifactPaths: NativeReleaseArtifactPaths,
): NativeReleaseArtifact[] => [
  { name: nativeVst3ScannerArtifactName, sourcePath: artifactPaths.scannerPath },
  { name: nativeVst3WorkerArtifactId, sourcePath: artifactPaths.workerPath },
  { name: nativeAudioHostArtifactName, sourcePath: artifactPaths.audioHostPath },
]

export const getNativeReleaseManifestPath = (
  desktopRoot: string,
): string => path.join(desktopRoot, ".native", nativeReleaseArtifactManifestName)

export const assembleReleaseEnvironment = (
  environment: NodeJS.ProcessEnv,
  identity: string,
  notaryProfile: string,
  artifactPaths: NativeReleaseArtifactPaths,
  manifestPath: string,
): NativeReleaseEnvironment => ({
  ...environment,
  APPLE_SIGNING_IDENTITY: identity,
  APPLE_NOTARY_KEYCHAIN_PROFILE: notaryProfile,
  DAW_ENABLE_VST3_HOSTING: "1",
  DAW_VST3_SCANNER_PATH: artifactPaths.scannerPath,
  DAW_VST3_WORKER_PATH: artifactPaths.workerPath,
  DAW_AUDIO_HOST_PATH: artifactPaths.audioHostPath,
  DAW_NATIVE_ARTIFACT_MANIFEST_PATH: manifestPath,
})

export const formatReleaseDiagnostic = (
  command: string,
  identity: string,
  notaryProfile: string,
  artifactPaths: NativeReleaseArtifactPaths,
  manifestPath: string,
): string => [
  `command: ${command}`,
  `signing identity: ${identity}`,
  `notary profile: ${notaryProfile}`,
  `scanner: ${artifactPaths.scannerPath}`,
  `worker: ${artifactPaths.workerPath}`,
  `audio host: ${artifactPaths.audioHostPath}`,
  `manifest: ${manifestPath}`,
].join("\n")

export const prepareNativeReleaseManifest = async (
  artifactPaths: NativeReleaseArtifactPaths,
  manifestPath: string,
): Promise<void> => {
  const artifacts = getNativeReleaseArtifacts(artifactPaths)
  await writeNativeReleaseArtifactManifest(artifacts, manifestPath)
  await validateNativeReleaseArtifacts(artifacts, manifestPath)
}
