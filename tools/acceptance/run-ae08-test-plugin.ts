#!/usr/bin/env bun
// Runs the environment-gated AE-08 real-plug-in host tests against the failure-injection test VST3.
// Everything lives in /tmp: the bundle is ad-hoc signed there and is never installed into a VST3 folder.
import { homedir } from "node:os"
import path from "node:path"
import { fingerprintVst3Bundle } from "../../apps/desktop/plugin-catalog"

const root = path.resolve(import.meta.dir, "../..")
const buildDirectory = "/tmp/ae08-p6z-native"
const sdk = process.env.VST3_SDK_PATH ?? path.join(homedir(), "Documents/vst3sdk-3.8.0")
const bundle = path.join(buildDirectory, "plugin-host/ae08-test-effect.vst3")
const hostTest = path.join(buildDirectory, "audio-host-macos/daw-audio-host-macos-test")

const run = async (argv: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" })
  const exit = await child.exited
  if (exit !== 0) throw new Error(`${argv.join(" ")} exited ${exit}`)
}

// The host tests use assert(), so NDEBUG must stay off in this Release tree.
await run(["cmake", "-S", path.join(root, "native"), "-B", buildDirectory, "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_CXX_FLAGS_RELEASE=-O2", `-DVST3_SDK_PATH=${sdk}`, "-DBUILD_TESTING=ON", "-DDAW_AUDIO_CORE_BUILD_WASM=OFF",
  "-DDAW_BUILD_AUDIO_HOST_MACOS=ON", "-DDAW_BUILD_PLUGIN_HOST=ON", "-DDAW_BUILD_AE08_TEST_PLUGIN=ON"])
await run(["cmake", "--build", buildDirectory, "--target", "ae08-test-effect", "daw-vst3-worker", "daw-audio-host-macos-test", "-j", "4"])
await run(["codesign", "--force", "--sign", "-", bundle])
await run(["codesign", "--verify", "--strict", bundle])

const binary = new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(bundle, "Contents/MacOS/ae08-test-effect")).bytes()).digest("hex")
await run([hostTest], {
  DAW_AE08_TEST_PLUGIN_BUNDLE: bundle,
  DAW_AE08_TEST_PLUGIN_BUNDLE_FINGERPRINT: await fingerprintVst3Bundle(bundle),
  DAW_AE08_TEST_PLUGIN_BINARY_FINGERPRINT: binary,
})
console.log("ae08 test plug-in host tests passed")
