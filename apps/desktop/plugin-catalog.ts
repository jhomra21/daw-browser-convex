import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DesktopJsonValue } from "@daw-browser/desktop-protocol"

const maxPluginBinaryBytes = 2 * 1024 * 1024 * 1024
const catalogVersion = 3
const maxConfiguredDirectories = 64
const maxDirectoryPathLength = 4096
const maxTraversalDepth = 16
const maxTraversalDirectories = 1000
const maxTraversalEntries = 10000
const maxDiagnostics = 64

export type PluginCatalogDiagnostic = {
  directory: string
  message: string
}

export type Vst3CatalogEntry = {
  bundlePath: string
  displayName: string
  configuredDirectory: string
  discoveredAtMs: number
  architecture: "unknown"
  hostingStatus: "unavailable"
  unavailableReason: "VST3 discovery is available, but native VST3 audio hosting is not active."
  classes: Vst3CatalogClass[]
  scanHealth: "filesystem-only" | "scanned" | "scan-failed"
  scannerVersion?: string
  sdkVersion?: string
  binaryFingerprint?: string
  launchEligibility?: Vst3WorkerLaunchEligibility
}

export type Vst3WorkerLaunchEligibility = {
  canonicalBundlePath: string
  canonicalExecutablePath: string
  bundleFingerprint: string
  binaryFingerprint: string
  architecture: "arm64"
  codeSignVerifiedAtMs: number
  quarantinePresent: false
  scannerProtocolVersion: 2
}

export type Vst3CatalogClass = {
  classId: string
  vendor: string
  name: string
  version: string
  role: "effect" | "instrument"
  source: "moduleinfo" | "factory"
  sdkVersion?: string
}

export type PluginCatalogData = {
  version: 3
  directories: string[]
  entries: Vst3CatalogEntry[]
  diagnostics: PluginCatalogDiagnostic[]
  scannedAtMs: number | null
}

type PluginCatalogFileSystem = {
  mkdir: typeof mkdir
  readdir: (directory: string, options: { withFileTypes: true }) => Promise<Dirent<string>[]>
  readFile: typeof readFile
  realpath: typeof realpath
  rename: typeof rename
  stat: typeof stat
  writeFile: typeof writeFile
}

const nodePluginCatalogFileSystem: PluginCatalogFileSystem = {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
}

const emptyCatalog = (): PluginCatalogData => ({
  version: catalogVersion,
  directories: [],
  entries: [],
  diagnostics: [],
  scannedAtMs: null,
})

const filesystemOnlyEntry = (entry: Omit<Vst3CatalogEntry, "classes" | "scanHealth">): Vst3CatalogEntry => ({
  ...entry,
  classes: [],
  scanHealth: "filesystem-only",
})

const isInsideDirectory = (candidate: string, directory: string) => (
  candidate === directory || candidate.startsWith(`${directory}${path.sep}`)
)

const addDiagnostic = (diagnostics: PluginCatalogDiagnostic[], directory: string, message: string) => {
  if (diagnostics.length < maxDiagnostics) diagnostics.push({ directory, message })
}

const displayNameForBundle = (bundlePath: string) => path.basename(bundlePath, path.extname(bundlePath))

export const normalizeConfiguredDirectory = async (
  candidate: string,
  fileSystem: Pick<PluginCatalogFileSystem, "realpath" | "stat"> = nodePluginCatalogFileSystem,
): Promise<string> => {
  if (!candidate || candidate.length > maxDirectoryPathLength || !path.isAbsolute(candidate)) {
    throw new Error("A configured plug-in directory must be an absolute path.")
  }
  const resolved = await fileSystem.realpath(candidate)
  if (!(await fileSystem.stat(resolved)).isDirectory()) {
    throw new Error("A configured plug-in path must be a directory.")
  }
  return resolved
}

export const normalizeConfiguredDirectories = async (
  candidates: readonly string[],
  fileSystem: Pick<PluginCatalogFileSystem, "realpath" | "stat"> = nodePluginCatalogFileSystem,
): Promise<string[]> => {
  const normalized = new Set<string>()
  for (const candidate of candidates.slice(0, maxConfiguredDirectories)) {
    try {
      normalized.add(await normalizeConfiguredDirectory(candidate, fileSystem))
    } catch {
      continue
    }
  }
  return [...normalized].sort((left, right) => left.localeCompare(right))
}

export const discoverVst3Bundles = async (
  directories: readonly string[],
  now: () => number = Date.now,
  fileSystem: Pick<PluginCatalogFileSystem, "readdir" | "realpath" | "stat"> = nodePluginCatalogFileSystem,
): Promise<Pick<PluginCatalogData, "entries" | "diagnostics" | "scannedAtMs">> => {
  const diagnostics: PluginCatalogDiagnostic[] = []
  const discovered = new Map<string, Vst3CatalogEntry>()
  for (const configuredDirectory of directories) {
    let root: string
    try {
      root = await normalizeConfiguredDirectory(configuredDirectory, fileSystem)
    } catch {
      addDiagnostic(diagnostics, configuredDirectory, "The configured directory is unavailable.")
      continue
    }
    const pending = [{ directory: root, depth: 0 }]
    let directoryCount = 0
    let entryCount = 0
    while (pending.length > 0) {
      const current = pending.shift()!
      if (directoryCount >= maxTraversalDirectories) {
        addDiagnostic(diagnostics, root, "Directory traversal limit reached.")
        break
      }
      directoryCount += 1
      let children: Dirent<string>[]
      try {
        children = await fileSystem.readdir(current.directory, { withFileTypes: true })
      } catch {
        addDiagnostic(diagnostics, current.directory, "The directory could not be read.")
        continue
      }
      for (const child of children) {
        if (entryCount >= maxTraversalEntries) {
          addDiagnostic(diagnostics, root, "Directory entry traversal limit reached.")
          pending.length = 0
          break
        }
        entryCount += 1
        if (child.isSymbolicLink() || !child.isDirectory()) continue
        const childPath = path.join(current.directory, child.name)
        if (path.extname(child.name).toLowerCase() === ".vst3") {
          try {
            const bundlePath = await canonicalizeVst3ScannerBundlePath(childPath)
            if (!isInsideDirectory(bundlePath, root)) {
              addDiagnostic(diagnostics, childPath, "The VST3 bundle resolves outside its configured directory.")
              continue
            }
            if (!discovered.has(bundlePath)) {
              discovered.set(bundlePath, filesystemOnlyEntry({
                bundlePath,
                displayName: displayNameForBundle(bundlePath),
                configuredDirectory: root,
                discoveredAtMs: now(),
                architecture: "unknown",
                hostingStatus: "unavailable",
                unavailableReason: "VST3 discovery is available, but native VST3 audio hosting is not active.",
              }))
            }
          } catch {
            addDiagnostic(diagnostics, childPath, "The VST3 bundle is unavailable.")
          }
          continue
        }
        if (current.depth >= maxTraversalDepth) {
          addDiagnostic(diagnostics, current.directory, "Directory traversal depth limit reached.")
          continue
        }
        pending.push({ directory: childPath, depth: current.depth + 1 })
      }
    }
  }
  return {
    entries: [...discovered.values()].sort((left, right) => left.bundlePath.localeCompare(right.bundlePath)),
    diagnostics,
    scannedAtMs: now(),
  }
}

const isString = (value: DesktopJsonValue): value is string => typeof value === "string"
const isNumber = (value: DesktopJsonValue): value is number => typeof value === "number"
const isJsonObject = (
  value: DesktopJsonValue,
): value is { [key: string]: DesktopJsonValue } => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)
const isStringArray = (value: DesktopJsonValue): value is string[] => (
  Array.isArray(value) && value.every(isString)
)

const isValidClass = (value: DesktopJsonValue): value is DesktopJsonValue & Vst3CatalogClass => {
  if (typeof value !== "object" || value === null) return false
  return "classId" in value && typeof value.classId === "string" && value.classId.length > 0 && value.classId.length <= 256
    && "vendor" in value && typeof value.vendor === "string" && value.vendor.length > 0 && value.vendor.length <= 256
    && "name" in value && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 256
    && "version" in value && typeof value.version === "string" && value.version.length > 0 && value.version.length <= 256
    && "role" in value && (value.role === "effect" || value.role === "instrument")
    && "source" in value && (value.source === "moduleinfo" || value.source === "factory")
    && (!("sdkVersion" in value) || value.sdkVersion === undefined || typeof value.sdkVersion === "string")
}

const isValidEntry = (value: DesktopJsonValue): value is DesktopJsonValue & Vst3CatalogEntry => {
  if (typeof value !== "object" || value === null) return false
  const record = value
  return "bundlePath" in record
    && typeof record.bundlePath === "string"
    && path.isAbsolute(record.bundlePath)
    && path.extname(record.bundlePath).toLowerCase() === ".vst3"
    && "displayName" in record
    && typeof record.displayName === "string"
    && "configuredDirectory" in record
    && typeof record.configuredDirectory === "string"
    && path.isAbsolute(record.configuredDirectory)
    && "discoveredAtMs" in record
    && typeof record.discoveredAtMs === "number"
    && "architecture" in record
    && record.architecture === "unknown"
    && "hostingStatus" in record
    && record.hostingStatus === "unavailable"
    && "unavailableReason" in record
    && record.unavailableReason === "VST3 discovery is available, but native VST3 audio hosting is not active."
    && "classes" in record
    && Array.isArray(record.classes)
    && record.classes.length <= 1024
    && record.classes.every(isValidClass)
    && "scanHealth" in record
    && (record.scanHealth === "filesystem-only" || record.scanHealth === "scanned" || record.scanHealth === "scan-failed")
    && (!("scannerVersion" in record) || record.scannerVersion === undefined || typeof record.scannerVersion === "string")
    && (!("sdkVersion" in record) || record.sdkVersion === undefined || typeof record.sdkVersion === "string")
    && (!("binaryFingerprint" in record) || record.binaryFingerprint === undefined || (typeof record.binaryFingerprint === "string" && /^[a-f0-9]{64}$/.test(record.binaryFingerprint)))
    && (!("launchEligibility" in record) || record.launchEligibility === undefined || isValidLaunchEligibility(record.launchEligibility, record))
}

const isValidLaunchEligibility = (
  value: DesktopJsonValue,
  entry: DesktopJsonValue,
): value is DesktopJsonValue & Vst3WorkerLaunchEligibility => {
  if (typeof value !== "object" || value === null || typeof entry !== "object" || entry === null) return false
  const record = value
  if (!("bundlePath" in entry) || typeof entry.bundlePath !== "string"
    || !("binaryFingerprint" in entry) || typeof entry.binaryFingerprint !== "string") return false
  return "canonicalBundlePath" in record
    && record.canonicalBundlePath === entry.bundlePath
    && "canonicalExecutablePath" in record
    && typeof record.canonicalExecutablePath === "string"
    && path.isAbsolute(record.canonicalExecutablePath)
    && isInsideDirectory(record.canonicalExecutablePath, entry.bundlePath)
    && "binaryFingerprint" in record
    && typeof record.binaryFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(record.binaryFingerprint)
    && record.binaryFingerprint === entry.binaryFingerprint
    && "bundleFingerprint" in record
    && typeof record.bundleFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(record.bundleFingerprint)
    && "architecture" in record
    && record.architecture === "arm64"
    && "codeSignVerifiedAtMs" in record
    && typeof record.codeSignVerifiedAtMs === "number"
    && Number.isSafeInteger(record.codeSignVerifiedAtMs)
    && record.codeSignVerifiedAtMs >= 0
    && "quarantinePresent" in record
    && record.quarantinePresent === false
    && "scannerProtocolVersion" in record
    && record.scannerProtocolVersion === 2
}

const isValidDiagnostic = (
  value: DesktopJsonValue,
): value is DesktopJsonValue & PluginCatalogDiagnostic => {
  if (typeof value !== "object" || value === null) return false
  return "directory" in value
    && typeof value.directory === "string"
    && "message" in value
    && typeof value.message === "string"
}

export const parsePluginCatalogData = (value: DesktopJsonValue): PluginCatalogData | undefined => {
  if (!isJsonObject(value)) return undefined
  const directories = "directories" in value && isStringArray(value.directories) ? value.directories : undefined
  if (
    !("version" in value)
    || (value.version !== 1 && value.version !== 2 && value.version !== catalogVersion)
    || directories === undefined
    || directories.length > maxConfiguredDirectories
    || !directories.every((directory) => path.isAbsolute(directory) && directory.length <= maxDirectoryPathLength)
    || !("entries" in value)
    || !Array.isArray(value.entries)
    || !("diagnostics" in value)
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every(isValidDiagnostic)
    || !("scannedAtMs" in value)
    || (value.scannedAtMs !== null && !isNumber(value.scannedAtMs))
  ) return undefined
  if (value.version === 1) {
    const entries: LegacyVst3CatalogEntry[] = []
    for (const entry of value.entries) {
      if (!isLegacyEntry(entry)
        || !directories.includes(entry.configuredDirectory)
        || !isInsideDirectory(entry.bundlePath, entry.configuredDirectory)) return undefined
      entries.push(entry)
    }
    return {
      version: catalogVersion,
      directories,
      entries: entries.map(filesystemOnlyEntry),
      diagnostics: value.diagnostics,
      scannedAtMs: value.scannedAtMs,
    }
  }
  const entries: Vst3CatalogEntry[] = []
  for (const entry of value.entries) {
    if (!isValidEntry(entry)
      || !directories.includes(entry.configuredDirectory)
      || !isInsideDirectory(entry.bundlePath, entry.configuredDirectory)) return undefined
    entries.push(entry)
  }
  return {
    version: catalogVersion,
    directories,
    entries: entries.map((entry) => ({
      ...entry,
      launchEligibility: undefined,
    })),
    diagnostics: value.diagnostics,
    scannedAtMs: value.scannedAtMs,
  }
}

type LegacyVst3CatalogEntry = Omit<Vst3CatalogEntry, "classes" | "scanHealth" | "scannerVersion" | "sdkVersion" | "binaryFingerprint">
const isLegacyEntry = (
  value: DesktopJsonValue,
): value is DesktopJsonValue & LegacyVst3CatalogEntry => {
  if (typeof value !== "object" || value === null) return false
  const record = value
  return "bundlePath" in record && typeof record.bundlePath === "string" && path.isAbsolute(record.bundlePath)
    && "displayName" in record && typeof record.displayName === "string"
    && "configuredDirectory" in record && typeof record.configuredDirectory === "string" && path.isAbsolute(record.configuredDirectory)
    && "discoveredAtMs" in record && typeof record.discoveredAtMs === "number"
    && "architecture" in record && record.architecture === "unknown"
    && "hostingStatus" in record && record.hostingStatus === "unavailable"
    && "unavailableReason" in record && record.unavailableReason === "VST3 discovery is available, but native VST3 audio hosting is not active."
}

export const createPluginCatalogStore = (options: {
  filePath: string
  fileSystem?: PluginCatalogFileSystem
  now?: () => number
}) => {
  const fileSystem = options.fileSystem ?? nodePluginCatalogFileSystem
  const now = options.now ?? Date.now
  let data: PluginCatalogData | undefined
  const load = async (): Promise<PluginCatalogData> => {
    if (data) return data
    try {
      const contents = await fileSystem.readFile(options.filePath, "utf8")
      const parsed = parsePluginCatalogData(JSON.parse(contents))
      data = parsed ?? emptyCatalog()
    } catch {
      data = emptyCatalog()
    }
    return data
  }
  const reload = async (): Promise<PluginCatalogData> => {
    data = undefined
    return load()
  }
  const save = async (next: PluginCatalogData) => {
    const directory = path.dirname(options.filePath)
    const temporaryPath = `${options.filePath}.tmp`
    await fileSystem.mkdir(directory, { recursive: true })
    await fileSystem.writeFile(temporaryPath, JSON.stringify(next), "utf8")
    await fileSystem.rename(temporaryPath, options.filePath)
    data = next
    return next
  }
  const addDirectory = async (candidate: string) => {
    const current = await load()
    const directory = await normalizeConfiguredDirectory(candidate, fileSystem)
    if (!current.directories.includes(directory) && current.directories.length >= maxConfiguredDirectories) {
      throw new Error("Too many configured plug-in directories.")
    }
    const directories = await normalizeConfiguredDirectories([...current.directories, directory], fileSystem)
    return save({ ...current, directories })
  }
  const removeDirectory = async (candidate: string) => {
    const current = await load()
    if (!path.isAbsolute(candidate) || candidate.length > maxDirectoryPathLength) {
      throw new Error("A configured plug-in directory must be an absolute path.")
    }
    const directories = current.directories.filter((directory) => directory !== candidate)
    return save({
      ...current,
      directories,
      entries: current.entries.filter((entry) => entry.configuredDirectory !== candidate),
    })
  }
  const scan = async (scanBundle?: (entry: Vst3CatalogEntry) => Promise<Partial<Vst3CatalogEntry>>) => {
    const current = await load()
    const directories = current.directories
    const discovery = await discoverVst3Bundles(directories, now, fileSystem)
    const entries = scanBundle
      ? await Promise.all(discovery.entries.map(async (entry) => {
        try {
          return { ...entry, ...await scanBundle(entry) }
        } catch {
          return { ...entry, scanHealth: "scan-failed" as const }
        }
      }))
      : discovery.entries
    return save({ version: catalogVersion, directories, ...discovery, entries })
  }
  return { addDirectory, load, reload, removeDirectory, scan }
}

export const canonicalVst3SearchPaths = (homeDirectory: string) => [
  '/Library/Audio/Plug-Ins/VST3',
  path.join(homeDirectory, 'Library/Audio/Plug-Ins/VST3'),
]

export const canonicalizeVst3ScannerBundlePath = async (candidate: string): Promise<string> => {
  const resolved = await realpath(candidate)
  if (path.extname(resolved).toLowerCase() !== '.vst3') {
    throw new Error('Only VST3 bundle paths are accepted.')
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error('VST3 scanner paths must be bundle directories.')
  }
  return resolved
}

type PluginBinaryReader = {
  stat: (path: string) => Promise<{ isFile: () => boolean; size: number }>
  createReadStream: (path: string) => AsyncIterable<unknown>
}

const nodePluginBinaryReader: PluginBinaryReader = { stat, createReadStream }

export const fingerprintPluginBinary = async (
  binaryPath: string,
  reader: PluginBinaryReader = nodePluginBinaryReader,
): Promise<string> => {
  const details = await reader.stat(binaryPath)
  if (!details.isFile() || details.size > maxPluginBinaryBytes) {
    throw new Error('Plugin binary is unavailable or exceeds the scanner size limit.')
  }
  const hash = createHash('sha256')
  let byteLength = 0
  for await (const chunk of reader.createReadStream(binaryPath)) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Plugin binary stream returned an invalid chunk.')
    byteLength += chunk.byteLength
    if (byteLength > maxPluginBinaryBytes) {
      throw new Error('Plugin binary is unavailable or exceeds the scanner size limit.')
    }
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export const fingerprintVst3Bundle = async (bundlePath: string): Promise<string> => {
  const canonicalBundle = await canonicalizeVst3ScannerBundlePath(bundlePath)
  const hash = createHash('sha256')
  let byteLength = 0
  const hashFile = async (filePath: string, relativePath: string) => {
    const details = await stat(filePath)
    if (!details.isFile() || details.size > maxPluginBinaryBytes - byteLength) {
      throw new Error('Plugin bundle is unavailable or exceeds the scanner size limit.')
    }
    hash.update(`file:${relativePath}:${details.size}\n`)
    for await (const chunk of createReadStream(filePath)) {
      byteLength += chunk.byteLength
      if (byteLength > maxPluginBinaryBytes) {
        throw new Error('Plugin bundle is unavailable or exceeds the scanner size limit.')
      }
      hash.update(chunk)
    }
  }
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.isSymbolicLink()) throw new Error('Plugin bundles containing symbolic links cannot be scanned.')
      const relativePath = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name
      const childPath = path.join(directory, child.name)
      if (child.isDirectory()) {
        hash.update(`directory:${relativePath}\n`)
        await visit(childPath, relativePath)
      } else {
        await hashFile(childPath, relativePath)
      }
    }
  }
  await visit(canonicalBundle, '')
  return hash.digest('hex')
}
