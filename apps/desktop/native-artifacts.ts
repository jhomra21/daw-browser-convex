import { existsSync } from "node:fs"
import path from "node:path"
import { app } from "electron"
import { desktopEnv } from "./env"
import { nativeReleaseArtifactManifestName, verifyPackagedNativeReleaseArtifacts } from "./native-release-artifacts"
import { packagedAudioHostPath } from "./audio-host"
import { packagedVst3ScannerPath } from "./vst3-scanner"
import { packagedVst3WorkerPath } from "./vst3-preflight"

export type NativeReleaseArtifactVerification =
  | { status: "disabled" | "development" | "verified" }
  | { status: "failed"; reason: string }

export const resolveNativeArtifacts = async () => {
  let scannerPath: string | undefined
  let vst3WorkerPath: string | undefined
  let audioHostPath: string | undefined
  let verification: NativeReleaseArtifactVerification = { status: "disabled" }

  if (process.platform === "darwin" && app.isPackaged) {
    const manifestPath = path.join(process.resourcesPath, nativeReleaseArtifactManifestName)

    if (existsSync(manifestPath)) {
      try {
        const artifacts = await verifyPackagedNativeReleaseArtifacts(process.resourcesPath)
        scannerPath = artifacts.scannerPath
        vst3WorkerPath = artifacts.workerPath
        audioHostPath = artifacts.audioHostPath
        verification = { status: "verified" }
      } catch (error) {
        verification = {
          status: "failed",
          reason: error instanceof Error ? error.message : "Native release artifact verification failed.",
        }
      }
    }
  } else if (process.platform === "darwin") {
    scannerPath = packagedVst3ScannerPath(process.resourcesPath, false, desktopEnv.vst3ScannerPath())
    vst3WorkerPath = packagedVst3WorkerPath(process.resourcesPath, false, desktopEnv.vst3WorkerPath())
    audioHostPath = packagedAudioHostPath(process.resourcesPath, false, desktopEnv.audioHostPath())
    verification = { status: "development" }
  }

  return { scannerPath, vst3WorkerPath, audioHostPath, verification }
}
