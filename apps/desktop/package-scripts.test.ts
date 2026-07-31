import { readFile } from "node:fs/promises"
import { expect, test } from "bun:test"
import {
  createReleasePreparation,
  type ReleaseCommand,
} from "./scripts/run-release"
import {
  createLocalPackageEnvironment,
} from "./scripts/run-local"
import {
  defaultNotaryProfile,
  type NativeReleaseArtifactPaths,
} from "./release.config"

const packageJson = await readFile(new URL("./package.json", import.meta.url), "utf8")

test("uses the local helper for package and the release helper for make", () => {
  expect(packageJson).toContain('"package": "bun scripts/run-local.ts package"')
  expect(packageJson).toContain('"make": "bun scripts/run-release.ts make"')
  expect(packageJson).toContain('"release:mac:package": "bun scripts/run-release.ts package"')
  expect(packageJson).toContain('"release:mac:make": "bun scripts/run-release.ts make"')
})

test("prepares the dry-run release environment with native artifact paths", () => {
  const command: ReleaseCommand = "package"
  const artifactPaths: NativeReleaseArtifactPaths = {
    scannerPath: "/project/native/vst3-scanner",
    workerPath: "/project/native/vst3-worker",
    audioHostPath: "/project/native/audio-host",
  }
  const manifestPath = "/project/apps/desktop/.native/daw-native-artifacts-v1.json"
  const preparation = createReleasePreparation(
    command,
    {
      PATH: "/usr/bin",
      APPLE_API_KEY: "not-forwarded-by-diagnostic",
    },
    "Developer ID Application: Example (TEAMID)",
    defaultNotaryProfile,
    artifactPaths,
    manifestPath,
  )

  expect(preparation.command).toBe("package")
  expect(preparation.artifactPaths).toEqual(artifactPaths)
  expect(preparation.manifestPath).toBe(manifestPath)
  expect(preparation.environment).toMatchObject({
    PATH: "/usr/bin",
    APPLE_API_KEY: "not-forwarded-by-diagnostic",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAMID)",
    APPLE_NOTARY_KEYCHAIN_PROFILE: defaultNotaryProfile,
    DAW_ENABLE_VST3_HOSTING: "1",
    DAW_VST3_SCANNER_PATH: artifactPaths.scannerPath,
    DAW_VST3_WORKER_PATH: artifactPaths.workerPath,
    DAW_AUDIO_HOST_PATH: artifactPaths.audioHostPath,
    DAW_NATIVE_ARTIFACT_MANIFEST_PATH: manifestPath,
  })
})

test("assembles local package environment without signing or notarization", () => {
  const artifactPaths: NativeReleaseArtifactPaths = {
    scannerPath: "/project/native/vst3-scanner",
    workerPath: "/project/native/vst3-worker",
    audioHostPath: "/project/native/audio-host",
  }
  const manifestPath = "/project/apps/desktop/.native/daw-native-artifacts-v1.json"
  const environment = createLocalPackageEnvironment({
    PATH: "/usr/bin",
    APPLE_SIGNING_IDENTITY: "must-not-forward",
    APPLE_NOTARY_KEYCHAIN_PROFILE: "must-not-forward",
    DAW_NOTARY_PROFILE: "must-not-forward",
    DAW_SKIP_NOTARIZATION: "1",
  }, artifactPaths, manifestPath)

  expect(environment).toMatchObject({
    PATH: "/usr/bin",
    DAW_LOCAL_UNSIGNED_PACKAGE: "1",
    DAW_ENABLE_VST3_HOSTING: "1",
    DAW_VST3_SCANNER_PATH: artifactPaths.scannerPath,
    DAW_VST3_WORKER_PATH: artifactPaths.workerPath,
    DAW_AUDIO_HOST_PATH: artifactPaths.audioHostPath,
    DAW_NATIVE_ARTIFACT_MANIFEST_PATH: manifestPath,
  })
  expect(environment).not.toHaveProperty("APPLE_SIGNING_IDENTITY")
  expect(environment).not.toHaveProperty("APPLE_NOTARY_KEYCHAIN_PROFILE")
  expect(environment).not.toHaveProperty("DAW_NOTARY_PROFILE")
  expect(environment).not.toHaveProperty("DAW_SKIP_NOTARIZATION")
})
