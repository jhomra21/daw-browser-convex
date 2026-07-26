import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { nativeVst3WorkerArtifactId } from "@daw-browser/plugin-host-protocol"

export const nativeReleaseArtifactManifestName = "daw-native-artifacts-v1.json"
export const nativeVst3ScannerArtifactName = "daw-vst3-scanner"
export const nativeAudioHostArtifactName = "daw-audio-host-macos"

export type NativeReleaseArtifactName =
  | typeof nativeVst3ScannerArtifactName
  | typeof nativeVst3WorkerArtifactId
  | typeof nativeAudioHostArtifactName

export type NativeReleaseArtifact = {
  name: NativeReleaseArtifactName
  sourcePath: string
}

type NativeReleaseArtifactManifest = {
  version: 1
  artifacts: Array<{
    name: NativeReleaseArtifactName
    sha256: string
  }>
}

const artifactNames: readonly NativeReleaseArtifactName[] = [
  nativeVst3ScannerArtifactName,
  nativeVst3WorkerArtifactId,
  nativeAudioHostArtifactName,
]

const isArtifactName = (value: unknown): value is NativeReleaseArtifactName => (
  typeof value === "string" && artifactNames.some((name) => name === value)
)

const isManifest = (value: unknown): value is NativeReleaseArtifactManifest => {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
    || !("artifacts" in value) || !Array.isArray(value.artifacts)
    || value.artifacts.length !== artifactNames.length) return false
  const names = new Set<NativeReleaseArtifactName>()
  for (const artifact of value.artifacts) {
    if (typeof artifact !== "object" || artifact === null
      || !("name" in artifact) || !isArtifactName(artifact.name)
      || !("sha256" in artifact) || typeof artifact.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(artifact.sha256) || names.has(artifact.name)) return false
    names.add(artifact.name)
  }
  return artifactNames.every((name) => names.has(name))
}

export const sha256ReleaseArtifact = async (filePath: string) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) {
    if (!(chunk instanceof Uint8Array)) throw new Error(`Release artifact could not be hashed: ${filePath}`)
    hash.update(chunk)
  }
  return hash.digest("hex")
}

const readNativeReleaseArtifactManifest = async (
  manifestPath: string,
): Promise<NativeReleaseArtifactManifest> => {
  let value: unknown
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch {
    throw new Error(`Native release artifact manifest is unavailable: ${manifestPath}`)
  }
  if (!isManifest(value)) throw new Error(`Native release artifact manifest is invalid: ${manifestPath}`)
  return value
}

export const validateNativeReleaseArtifactPlan = (
  artifacts: readonly NativeReleaseArtifact[],
): readonly NativeReleaseArtifact[] => {
  if (artifacts.length !== artifactNames.length) throw new Error("Native release artifact plan is incomplete.")
  const artifactsByName = new Map<NativeReleaseArtifactName, NativeReleaseArtifact>()
  for (const artifact of artifacts) {
    if (artifactsByName.has(artifact.name) || path.basename(artifact.sourcePath) !== artifact.name) {
      throw new Error(`Native release artifact path does not preserve its packaged identity: ${artifact.sourcePath}`)
    }
    artifactsByName.set(artifact.name, artifact)
  }
  const ordered: NativeReleaseArtifact[] = []
  for (const name of artifactNames) {
    const artifact = artifactsByName.get(name)
    if (!artifact) throw new Error("Native release artifact plan is incomplete.")
    ordered.push(artifact)
  }
  return ordered
}

export const validateNativeReleaseArtifacts = async (
  artifacts: readonly NativeReleaseArtifact[],
  manifestPath: string,
): Promise<void> => {
  const ordered = validateNativeReleaseArtifactPlan(artifacts)
  const manifest = await readNativeReleaseArtifactManifest(manifestPath)
  const manifestByName = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact.sha256]))
  for (const artifact of ordered) {
    const details = await stat(artifact.sourcePath).catch(() => undefined)
    if (!details?.isFile()) throw new Error(`Required native release artifact is not a file: ${artifact.sourcePath}`)
    if (await sha256ReleaseArtifact(artifact.sourcePath) !== manifestByName.get(artifact.name)) {
      throw new Error(`Native release artifact hash does not match its manifest: ${artifact.name}`)
    }
  }
}

export const writeNativeReleaseArtifactManifest = async (
  artifacts: readonly NativeReleaseArtifact[],
  manifestPath: string,
): Promise<void> => {
  if (path.basename(manifestPath) !== nativeReleaseArtifactManifestName) {
    throw new Error(`Native release artifact manifest must be named ${nativeReleaseArtifactManifestName}.`)
  }
  const ordered = validateNativeReleaseArtifactPlan(artifacts)
  const manifestArtifacts: NativeReleaseArtifactManifest["artifacts"] = []
  for (const artifact of ordered) {
    const details = await stat(artifact.sourcePath).catch(() => undefined)
    if (!details?.isFile()) throw new Error(`Required native release artifact is not a file: ${artifact.sourcePath}`)
    manifestArtifacts.push({ name: artifact.name, sha256: await sha256ReleaseArtifact(artifact.sourcePath) })
  }
  await writeFile(manifestPath, `${JSON.stringify({ version: 1, artifacts: manifestArtifacts }, null, 2)}\n`, {
    encoding: "utf8",
  })
}

export const getPackagedNativeReleaseArtifacts = (resourcesPath: string): NativeReleaseArtifact[] => (
  artifactNames.map((name) => ({ name, sourcePath: path.join(resourcesPath, name) }))
)

export const writePackagedNativeReleaseArtifactManifest = async (resourcesPath: string): Promise<void> => {
  await writeNativeReleaseArtifactManifest(
    getPackagedNativeReleaseArtifacts(resourcesPath),
    path.join(resourcesPath, nativeReleaseArtifactManifestName),
  )
}

export const verifyPackagedNativeReleaseArtifacts = async (resourcesPath: string) => {
  const artifacts = getPackagedNativeReleaseArtifacts(resourcesPath)
  await validateNativeReleaseArtifacts(
    artifacts,
    path.join(resourcesPath, nativeReleaseArtifactManifestName),
  )
  return {
    scannerPath: path.join(resourcesPath, nativeVst3ScannerArtifactName),
    workerPath: path.join(resourcesPath, nativeVst3WorkerArtifactId),
    audioHostPath: path.join(resourcesPath, nativeAudioHostArtifactName),
  }
}
