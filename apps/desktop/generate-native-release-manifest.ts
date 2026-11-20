import path from "node:path"
import { nativeVst3WorkerArtifactId } from "@daw-browser/plugin-host-protocol"
import {
  nativeAudioHostArtifactName,
  nativeVst3ScannerArtifactName,
  writeNativeReleaseArtifactManifest,
} from "./native-release-artifacts"
import { desktopEnv } from "./env"

const scannerPath = desktopEnv.vst3ScannerPath()
const workerPath = desktopEnv.vst3WorkerPath()
const audioHostPath = desktopEnv.audioHostPath()
const manifestPath = desktopEnv.nativeArtifactManifestPath()

if (!scannerPath || !workerPath || !audioHostPath || !manifestPath) {
  throw new Error(
    "Manifest generation requires DAW_VST3_SCANNER_PATH, DAW_VST3_WORKER_PATH, DAW_AUDIO_HOST_PATH, and DAW_NATIVE_ARTIFACT_MANIFEST_PATH.",
  )
}

await writeNativeReleaseArtifactManifest([
  { name: nativeVst3ScannerArtifactName, sourcePath: path.resolve(scannerPath) },
  { name: nativeVst3WorkerArtifactId, sourcePath: path.resolve(workerPath) },
  { name: nativeAudioHostArtifactName, sourcePath: path.resolve(audioHostPath) },
], path.resolve(manifestPath))
