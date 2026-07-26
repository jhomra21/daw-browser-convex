import { expect, test } from 'bun:test'
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { nativeVst3WorkerArtifactId } from "@daw-browser/plugin-host-protocol"
import forgeConfig, {
  getMacReleaseConfiguration,
  getPluginHostReleaseArtifactPlan,
  requireMacReleaseConfiguration,
  validatePluginHostReleaseArtifactPlan,
  validatePortableWasmReleaseAssets,
} from './forge.config'
import {
  nativeAudioHostArtifactName,
  nativeReleaseArtifactManifestName,
  nativeVst3ScannerArtifactName,
  writePackagedNativeReleaseArtifactManifest,
  writeNativeReleaseArtifactManifest,
} from "./native-release-artifacts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

test('does not plan VST3 host artifacts without the explicit release gate', () => {
  expect(forgeConfig.packagerConfig?.asar).toBeTrue()
  expect(getPluginHostReleaseArtifactPlan({})).toEqual([])
})

test('requires explicit scanner, worker, and CoreAudio host paths when native hosting is enabled', () => {
  expect(() => getPluginHostReleaseArtifactPlan({
    DAW_ENABLE_VST3_HOSTING: '1',
  })).toThrow('DAW_VST3_SCANNER_PATH, DAW_VST3_WORKER_PATH, and DAW_AUDIO_HOST_PATH')
})

test('pins all packaged native artifact identities in the release plan', () => {
  const plan = getPluginHostReleaseArtifactPlan({
    DAW_ENABLE_VST3_HOSTING: '1',
    DAW_VST3_SCANNER_PATH: `/artifacts/${nativeVst3ScannerArtifactName}`,
    DAW_VST3_WORKER_PATH: `/artifacts/${nativeVst3WorkerArtifactId}`,
    DAW_AUDIO_HOST_PATH: `/artifacts/${nativeAudioHostArtifactName}`,
  })
  expect(plan.map((artifact) => artifact.name)).toEqual([
    nativeVst3ScannerArtifactName,
    nativeVst3WorkerArtifactId,
    nativeAudioHostArtifactName,
  ])
})

test('requires the native release artifact manifest for a gated package', async () => {
  const plan = getPluginHostReleaseArtifactPlan({
    DAW_ENABLE_VST3_HOSTING: '1',
    DAW_VST3_SCANNER_PATH: `/artifacts/${nativeVst3ScannerArtifactName}`,
    DAW_VST3_WORKER_PATH: `/artifacts/${nativeVst3WorkerArtifactId}`,
    DAW_AUDIO_HOST_PATH: `/artifacts/${nativeAudioHostArtifactName}`,
  })
  await expect(validatePluginHostReleaseArtifactPlan(plan, undefined)).rejects.toThrow("DAW_NATIVE_ARTIFACT_MANIFEST_PATH")
})

test('validates exact native artifact names and hashes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-native-artifacts-"))
  const values = new Map([
    [nativeVst3ScannerArtifactName, "scanner"],
    [nativeVst3WorkerArtifactId, "worker"],
    [nativeAudioHostArtifactName, "audio-host"],
  ])
  const manifestPath = path.join(directory, nativeReleaseArtifactManifestName)
  try {
    for (const [name, value] of values) await writeFile(path.join(directory, name), value)
    const plan = getPluginHostReleaseArtifactPlan({
      DAW_ENABLE_VST3_HOSTING: '1',
      DAW_VST3_SCANNER_PATH: path.join(directory, nativeVst3ScannerArtifactName),
      DAW_VST3_WORKER_PATH: path.join(directory, nativeVst3WorkerArtifactId),
      DAW_AUDIO_HOST_PATH: path.join(directory, nativeAudioHostArtifactName),
    })
    await writeNativeReleaseArtifactManifest(plan, manifestPath)
    await expect(validatePluginHostReleaseArtifactPlan(plan, manifestPath)).resolves.toBeUndefined()
    await writeFile(path.join(directory, nativeVst3WorkerArtifactId), "tampered")
    await expect(validatePluginHostReleaseArtifactPlan(plan, manifestPath)).rejects.toThrow("hash does not match")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("generates the packaged manifest only after signed artifact bytes are final", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-packaged-native-artifacts-"))
  const sourceDirectory = path.join(directory, "source")
  const resourcesDirectory = path.join(directory, "app", "Contents", "Resources")
  const names = [
    nativeVst3ScannerArtifactName,
    nativeVst3WorkerArtifactId,
    nativeAudioHostArtifactName,
  ]
  try {
    await mkdir(sourceDirectory)
    await mkdir(resourcesDirectory, { recursive: true })
    for (const name of names) {
      await writeFile(path.join(sourceDirectory, name), `unsigned-${name}`)
      await writeFile(path.join(resourcesDirectory, name), `unsigned-${name}`)
    }
    const sourcePlan = getPluginHostReleaseArtifactPlan({
      DAW_ENABLE_VST3_HOSTING: "1",
      DAW_VST3_SCANNER_PATH: path.join(sourceDirectory, nativeVst3ScannerArtifactName),
      DAW_VST3_WORKER_PATH: path.join(sourceDirectory, nativeVst3WorkerArtifactId),
      DAW_AUDIO_HOST_PATH: path.join(sourceDirectory, nativeAudioHostArtifactName),
    })
    const sourceManifestPath = path.join(directory, nativeReleaseArtifactManifestName)
    await writeNativeReleaseArtifactManifest(sourcePlan, sourceManifestPath)
    await writeFile(
      path.join(resourcesDirectory, nativeReleaseArtifactManifestName),
      await readFile(sourceManifestPath),
    )
    for (const name of names) await writeFile(path.join(resourcesDirectory, name), `signed-${name}`)
    await expect(validatePluginHostReleaseArtifactPlan(sourcePlan, sourceManifestPath)).resolves.toBeUndefined()
    await expect(
      validatePluginHostReleaseArtifactPlan(
        sourcePlan.map(({ name }) => ({ name, sourcePath: path.join(resourcesDirectory, name) })),
        path.join(resourcesDirectory, nativeReleaseArtifactManifestName),
      ),
    ).rejects.toThrow("hash does not match")
    await writePackagedNativeReleaseArtifactManifest(resourcesDirectory)
    await expect(
      validatePluginHostReleaseArtifactPlan(
        sourcePlan.map(({ name }) => ({ name, sourcePath: path.join(resourcesDirectory, name) })),
        path.join(resourcesDirectory, nativeReleaseArtifactManifestName),
      ),
    ).resolves.toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails closed without macOS release identity and notarization credentials", () => {
  expect(getMacReleaseConfiguration({
    APPLE_NOTARY_KEYCHAIN_PROFILE: "release-notary",
  })).toBeUndefined()
  expect(() => requireMacReleaseConfiguration({})).toThrow("APPLE_SIGNING_IDENTITY")
  expect(() => requireMacReleaseConfiguration({
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
  })).toThrow("notarytool credentials")
})

test("routes only the VST worker through the library-validation entitlement", () => {
  const configuration = getMacReleaseConfiguration({
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
    APPLE_NOTARY_KEYCHAIN_PROFILE: "release-notary",
  })
  expect(configuration?.sign.hardenedRuntime).toBeTrue()
  expect(configuration?.sign.optionsForFile(`/Resources/${nativeVst3WorkerArtifactId}`).entitlements).toEndWith("vst3-worker.plist")
  expect(configuration?.sign.optionsForFile(`/Resources/${nativeVst3ScannerArtifactName}`).entitlements).toEndWith("native.plist")
  expect(configuration?.sign.optionsForFile(`/Resources/${nativeAudioHostArtifactName}`).entitlements).toEndWith("native.plist")
  expect(configuration?.sign.optionsForFile("/Applications/daw-browser.app").entitlements).toEndWith("app.plist")
  expect(configuration?.sign.optionsForFile("/Applications/daw-browser.app/Contents/Frameworks/daw-browser Helper.app").entitlements).toEndWith("helper.plist")
})

test("limits dynamic-load entitlement exceptions to the VST worker", async () => {
  const entitlements = path.join(import.meta.dirname, "entitlements")
  expect(await readFile(path.join(entitlements, "vst3-worker.plist"), "utf8")).toContain("com.apple.security.cs.disable-library-validation")
  for (const name of ["app.plist", "helper.plist", "native.plist"]) {
    expect(await readFile(path.join(entitlements, name), "utf8")).not.toContain("com.apple.security.cs.disable-library-validation")
  }
})

test("removes recursive codesign verification from the pinned signing implementation", async () => {
  const signingImplementation = await readFile(
    path.resolve(import.meta.dirname, "../../node_modules/@electron/osx-sign/dist/cjs/sign.js"),
    "utf8",
  )
  expect(signingImplementation).not.toContain("['--verify', '--deep']")
})

test('requires generated portable Wasm assets to match their manifest hash', async () => {
  const publicDirectory = await mkdtemp(path.join(tmpdir(), "daw-public-assets-"))
  try {
    await mkdir(path.join(publicDirectory, "audio-core"))
    await writeFile(path.join(publicDirectory, "audio-core", "daw-audio-core.wasm"), "wasm")
    await expect(validatePortableWasmReleaseAssets(publicDirectory)).rejects.toThrow("daw-audio-core.manifest.json")
    const manifestPath = path.join(publicDirectory, "audio-core", "daw-audio-core.manifest.json")
    const manifest = {
      artifactKind: "production",
      buildType: "Release",
      lto: true,
      sizeBytes: 4,
      maximumBytes: 4,
      sha256: hash("wrong"),
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(validatePortableWasmReleaseAssets(publicDirectory)).rejects.toThrow("hash does not match")
    await writeFile(manifestPath, JSON.stringify({ ...manifest, maximumBytes: 3, sha256: hash("wasm") }))
    await expect(validatePortableWasmReleaseAssets(publicDirectory)).rejects.toThrow("size budget")
    await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: hash("wasm") }))
    await expect(validatePortableWasmReleaseAssets(publicDirectory)).resolves.toBeUndefined()
  } finally {
    await rm(publicDirectory, { recursive: true, force: true })
  }
})
