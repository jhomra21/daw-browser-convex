import { expect, test } from "bun:test"
import {
  assembleReleaseEnvironment,
  defaultNotaryProfile,
  discoverSigningIdentity,
  formatReleaseDiagnostic,
  parseDeveloperIdApplicationIdentities,
  rebuildNativePackageArtifacts,
  resolveNativeArtifactPaths,
  resolveNotaryProfile,
  type NativeReleaseArtifactPaths,
} from "./release.config"
import {
  nativeAudioHostArtifactName,
  nativeVst3ScannerArtifactName,
} from "./native-release-artifacts"
import { nativeVst3WorkerArtifactId } from "@daw-browser/plugin-host-protocol"

const artifactPaths: NativeReleaseArtifactPaths = {
  scannerPath: `/build/${nativeVst3ScannerArtifactName}`,
  workerPath: `/build/${nativeVst3WorkerArtifactId}`,
  audioHostPath: `/build/${nativeAudioHostArtifactName}`,
}

test("parses valid Developer ID Application identities and ignores other certificates", () => {
  expect(parseDeveloperIdApplicationIdentities([
    `  1) B564926D00637B449E75CBB86B3F62C5C7081FEB "Apple Development: example@icloud.com (TEAMID)"`,
    `  2) 784124C9079315765EBBAF9D5B73F61B289C8EE3 "Developer ID Application: Example (TEAMID)"`,
    `  3) 784124C9079315765EBBAF9D5B73F61B289C8EE3 "Developer ID Installer: Example (TEAMID)"`,
  ].join("\n"))).toEqual(["Developer ID Application: Example (TEAMID)"])
})

test("discovers the first Developer ID Application identity from security output", () => {
  const output = [
    `  1) 784124C9079315765EBBAF9D5B73F61B289C8EE3 "Developer ID Application: First (TEAMID)"`,
    `  2) B564926D00637B449E75CBB86B3F62C5C7081FEB "Developer ID Application: Second (TEAMID)"`,
  ].join("\n")
  let invocation: { command: string; arguments_: readonly string[] } | undefined
  expect(discoverSigningIdentity((command, arguments_) => {
    invocation = { command, arguments_ }
    return { status: 0, stdout: output, stderr: "" }
  })).toBe("Developer ID Application: First (TEAMID)")
  expect(invocation).toEqual({
    command: "security",
    arguments_: ["find-identity", "-v", "-p", "codesigning"],
  })
})

test("fails clearly when no Developer ID Application identity is available", () => {
  expect(() => discoverSigningIdentity(() => ({
    status: 0,
    stdout: `  1) B564926D00637B449E75CBB86B3F62C5C7081FEB "Apple Development: example@icloud.com (TEAMID)"`,
    stderr: "",
  }))).toThrow("No valid Developer ID Application identity was found")
})

test("resolves release artifact candidates with the release audio host preferred", () => {
  const existing = new Set([
    "/project/native/build/vst3-worker-debug/plugin-host/daw-vst3-scanner",
    "/project/native/build/vst3-worker-debug/plugin-host/daw-vst3-worker",
    "/project/native/build/audio-host-macos-debug/audio-host-macos/daw-audio-host-macos",
  ])
  expect(resolveNativeArtifactPaths("/project", (filePath) => existing.has(filePath))).toEqual({
    scannerPath: "/project/native/build/vst3-worker-debug/plugin-host/daw-vst3-scanner",
    workerPath: "/project/native/build/vst3-worker-debug/plugin-host/daw-vst3-worker",
    audioHostPath: "/project/native/build/audio-host-macos-debug/audio-host-macos/daw-audio-host-macos",
  })
})

test("rebuilds every native artifact used by desktop packaging", () => {
  const calls: Array<{ command: string; arguments_: readonly string[] }> = []
  rebuildNativePackageArtifacts("/project", (command, arguments_) => {
    calls.push({ command, arguments_ })
    return { status: 0 }
  })

  expect(calls).toEqual([
    {
      command: "cmake",
      arguments_: [
        "-S",
        "/project/native",
        "-B",
        "/project/native/build/vst3-worker-debug",
        "-DCMAKE_BUILD_TYPE=Debug",
        "-DDAW_BUILD_PLUGIN_HOST=ON",
        "-DDAW_BUILD_AUDIO_HOST_MACOS=OFF",
        "-DBUILD_TESTING=ON",
      ],
    },
    {
      command: "cmake",
      arguments_: [
        "--build",
        "/project/native/build/vst3-worker-debug",
        "--target",
        "daw-vst3-scanner",
        "daw-vst3-worker",
        "--parallel",
      ],
    },
    {
      command: "cmake",
      arguments_: [
        "-S",
        "/project/native",
        "-B",
        "/project/native/build/audio-host-macos-release",
        "-DCMAKE_BUILD_TYPE=Release",
        "-DDAW_BUILD_PLUGIN_HOST=ON",
        "-DDAW_BUILD_AUDIO_HOST_MACOS=ON",
        "-DBUILD_TESTING=OFF",
      ],
    },
    {
      command: "cmake",
      arguments_: [
        "--build",
        "/project/native/build/audio-host-macos-release",
        "--target",
        "daw-audio-host-macos",
        "--parallel",
      ],
    },
  ])
})

test("uses the committed notary profile unless explicitly overridden", () => {
  expect(resolveNotaryProfile({})).toBe(defaultNotaryProfile)
  expect(resolveNotaryProfile({ DAW_NOTARY_PROFILE: "local-profile" })).toBe("local-profile")
  expect(resolveNotaryProfile({ APPLE_NOTARY_KEYCHAIN_PROFILE: "explicit-profile" })).toBe("explicit-profile")
})

test("assembles only the release environment passed to the Forge child", () => {
  const environment = assembleReleaseEnvironment(
    { PATH: "/usr/bin", NOT_SECRET_TO_CHILD: "kept" },
    "Developer ID Application: Example (TEAMID)",
    defaultNotaryProfile,
    artifactPaths,
    "/project/apps/desktop/.native/daw-native-artifacts-v1.json",
  )
  expect(environment).toMatchObject({
    PATH: "/usr/bin",
    NOT_SECRET_TO_CHILD: "kept",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAMID)",
    APPLE_NOTARY_KEYCHAIN_PROFILE: defaultNotaryProfile,
    DAW_ENABLE_VST3_HOSTING: "1",
    DAW_VST3_SCANNER_PATH: artifactPaths.scannerPath,
    DAW_VST3_WORKER_PATH: artifactPaths.workerPath,
    DAW_AUDIO_HOST_PATH: artifactPaths.audioHostPath,
    DAW_NATIVE_ARTIFACT_MANIFEST_PATH: "/project/apps/desktop/.native/daw-native-artifacts-v1.json",
  })
})

test("reports every candidate when a native release artifact is missing", () => {
  const existing = new Set([
    "/project/native/build/vst3-worker-debug/plugin-host/daw-vst3-scanner",
    "/project/native/build/vst3-worker-debug/plugin-host/daw-vst3-worker",
  ])
  expect(() => resolveNativeArtifactPaths("/project", (filePath) => existing.has(filePath))).toThrow(
    [
      "Required macOS native Audio host artifact is missing. Checked:",
      "- /project/native/build/audio-host-macos-release/audio-host-macos/daw-audio-host-macos",
      "- /project/native/build/audio-host-macos-debug/audio-host-macos/daw-audio-host-macos",
    ].join("\n"),
  )
})

test("diagnostics omit environment secrets", () => {
  const diagnostic = formatReleaseDiagnostic(
    "package",
    "Developer ID Application: Example (TEAMID)",
    defaultNotaryProfile,
    artifactPaths,
    "/project/apps/desktop/.native/daw-native-artifacts-v1.json",
  )
  expect(diagnostic).toContain("Developer ID Application: Example (TEAMID)")
  expect(diagnostic).toContain(defaultNotaryProfile)
  expect(diagnostic).not.toContain("APPLE_API_KEY")
  expect(diagnostic).not.toContain("APPLE_APP_SPECIFIC_PASSWORD")
  expect(diagnostic).not.toContain("secret")
})
