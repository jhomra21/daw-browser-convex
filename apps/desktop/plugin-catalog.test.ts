import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  canonicalizeVst3ScannerBundlePath,
  createPluginCatalogStore,
  discoverVst3Bundles,
  fingerprintPluginBinary,
  fingerprintVst3Bundle,
  normalizeConfiguredDirectories,
  parsePluginCatalogData,
  type Vst3CatalogEntry,
} from './plugin-catalog'
import { resolveVst3Attachment } from './vst3-attachment'

test('fingerprints plugin files through a stream', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const filePath = path.join(directory, 'plugin.bin')
  try {
    await writeFile(filePath, 'plugin-binary')
    await expect(fingerprintPluginBinary(filePath)).resolves.toBe(
      '7f512da80a46ab9883d159705be0e5467d4e2e8f03d4efc75c9165e7c7c597f6',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fingerprints complete VST3 bundle contents deterministically', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const bundlePath = path.join(directory, 'Plugin.vst3')
  try {
    await mkdir(path.join(bundlePath, 'Contents'), { recursive: true })
    await writeFile(path.join(bundlePath, 'Contents', 'binary'), 'plugin-binary')
    await expect(fingerprintVst3Bundle(bundlePath)).resolves.toBe(
      '784473b8e1a5482b0376a21eae1f4f627472f4917f3562bd937bfab756ac4673',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects oversize and stream failures through the injectable binary reader', async () => {
  const oversizeReader = {
    stat: async () => ({ isFile: () => true, size: 2 * 1024 * 1024 * 1024 + 1 }),
    async *createReadStream() {},
  }
  await expect(fingerprintPluginBinary('/plugin', oversizeReader)).rejects.toThrow('exceeds the scanner size limit')

  const failingReader = {
    stat: async () => ({ isFile: () => true, size: 1 }),
    async *createReadStream() {
      yield new Uint8Array()
      throw new Error('stream failure')
    },
  }
  await expect(fingerprintPluginBinary('/plugin', failingReader)).rejects.toThrow('stream failure')
})

test('accepts VST3 bundle directories only for scanner discovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const bundlePath = path.join(directory, 'Plugin.vst3')
  try {
    await mkdir(bundlePath)
    await expect(canonicalizeVst3ScannerBundlePath(bundlePath)).resolves.toEndWith('/Plugin.vst3')
    await expect(fingerprintPluginBinary(bundlePath)).rejects.toThrow('Plugin binary is unavailable')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('discovers VST3 bundles deterministically without descending into bundles or symlinks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const alpha = path.join(directory, 'nested', 'Alpha.vst3')
  const beta = path.join(directory, 'Beta.vst3')
  try {
    await mkdir(path.join(alpha, 'Nested.vst3'), { recursive: true })
    await mkdir(beta)
    await symlink(path.join(directory, 'nested'), path.join(directory, 'linked'))
    const directories = await normalizeConfiguredDirectories([directory, directory])
    const catalog = await discoverVst3Bundles(directories, () => 123)
    expect(catalog.entries.map((entry) => path.basename(entry.bundlePath))).toEqual(['Beta.vst3', 'Alpha.vst3'])
    expect(catalog.entries.map((entry) => entry.displayName)).toEqual(['Beta', 'Alpha'])
    expect(catalog.entries.every((entry) => entry.hostingStatus === 'discovered')).toBe(true)
    expect(catalog.entries.every((entry) => entry.discoveredAtMs === 123)).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('records unavailable configured directories and bounds configured directory input', async () => {
  const missing = path.join(tmpdir(), 'daw-plugin-catalog-does-not-exist')
  const catalog = await discoverVst3Bundles([missing])
  expect(catalog.entries).toEqual([])
  expect(catalog.diagnostics[0]?.message).toContain('unavailable')
  await expect(normalizeConfiguredDirectories([`/${'a'.repeat(4097)}`])).resolves.toEqual([])
})

test('bounds persisted diagnostics to stable path-free messages', () => {
  const catalog = parsePluginCatalogData({
    version: 3,
    directories: ['/Plugins'],
    entries: [],
    diagnostics: [{ directory: '/private/secret', message: 'native scanner leaked /private/secret' }],
    scannedAtMs: null,
  })
  expect(catalog?.diagnostics).toEqual([{
    directory: 'configured-directory',
    message: 'The plug-in directory could not be scanned.',
  }])
})

test('falls back to an empty catalog for corrupt persisted data and persists scans atomically', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const filePath = path.join(directory, 'plugin-catalog-v1.json')
  const pluginDirectory = path.join(directory, 'plugins')
  try {
    await mkdir(path.join(pluginDirectory, 'Only.vst3'), { recursive: true })
    await writeFile(filePath, '{not-json')
    const store = createPluginCatalogStore({ filePath, now: () => 456 })
    await expect(store.load()).resolves.toEqual({
      version: 3,
      directories: [],
      entries: [],
      diagnostics: [],
      scannedAtMs: null,
    })
    await writeFile(filePath, JSON.stringify({
      version: 3,
      directories: [],
      entries: [],
      diagnostics: [],
      scannedAtMs: 999,
    }))
    expect((await store.reload()).scannedAtMs).toBe(999)
    await store.addDirectory(pluginDirectory)
    const scanned = await store.scan()
    expect(scanned.entries).toHaveLength(1)
    expect(scanned.entries[0]?.displayName).toBe('Only')
    expect(scanned.scannedAtMs).toBe(456)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('migrates persisted catalogs without trusting invalid eligibility', () => {
  const legacy = {
    version: 2,
    directories: ['/Plugins'],
    entries: [{
      bundlePath: '/Plugins/Example.vst3',
      displayName: 'Example',
      configuredDirectory: '/Plugins',
      discoveredAtMs: 1,
      architecture: 'unknown',
      hostingStatus: 'discovered',
      classes: [],
      scanHealth: 'scanned',
      binaryFingerprint: 'a'.repeat(64),
    }],
    diagnostics: [],
    scannedAtMs: 1,
  }
  const migrated = parsePluginCatalogData(legacy)
  expect(migrated?.version).toBe(3)
  expect(migrated?.entries[0]?.launchEligibility).toBeUndefined()

  const valid = {
    ...legacy,
    version: 3,
    entries: [{
      ...legacy.entries[0],
      launchEligibility: {
        canonicalBundlePath: '/Plugins/Example.vst3',
        canonicalExecutablePath: '/Plugins/Example.vst3/Contents/MacOS/Example',
        bundleFingerprint: 'b'.repeat(64),
        binaryFingerprint: 'a'.repeat(64),
        architecture: 'arm64',
        codeSignVerifiedAtMs: 1,
        quarantinePresent: false,
        scannerProtocolVersion: 2,
      },
    }],
  }
  const catalog = parsePluginCatalogData(valid)
  expect(catalog?.entries[0]?.hostingStatus).toBe('discovered')
  expect(parsePluginCatalogData({
    ...valid,
    entries: [{ ...valid.entries[0], launchEligibility: { ...valid.entries[0].launchEligibility, quarantinePresent: true } }],
  })).toBeUndefined()
})

test('keeps scanned eligibility in-session but strips it from a fresh persisted store until rescan', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const pluginDirectory = path.join(directory, 'plugins')
  const filePath = path.join(directory, 'plugin-catalog-v1.json')
  const bundleFingerprint = 'b'.repeat(64)
  const binaryFingerprint = 'a'.repeat(64)
  try {
    await mkdir(path.join(pluginDirectory, 'Example.vst3'), { recursive: true })
    const store = createPluginCatalogStore({ filePath })
    await store.addDirectory(pluginDirectory)
    const scanBundle = async (entry: Vst3CatalogEntry) => ({
      classes: [{
        classId: 'example-effect',
        vendor: 'Example Vendor',
        name: 'Example',
        version: '1',
        role: 'effect' as const,
        source: 'factory' as const,
      }],
      scanHealth: 'scanned' as const,
      binaryFingerprint,
      launchEligibility: {
        canonicalBundlePath: entry.bundlePath,
        canonicalExecutablePath: path.join(entry.bundlePath, 'Contents', 'MacOS', 'Example'),
        bundleFingerprint,
        binaryFingerprint,
        architecture: 'arm64' as const,
        codeSignVerifiedAtMs: 1,
        quarantinePresent: false as const,
        scannerProtocolVersion: 2 as const,
      },
    })
    const scanned = await store.scan(scanBundle)
    const reference = {
      version: 1 as const,
      classId: 'example-effect',
      vendorId: 'Example Vendor',
      architecture: 'arm64' as const,
      bundleFingerprint,
      binaryFingerprint,
      scannerCatalogVersion: 2 as const,
    }
    expect(scanned.entries[0]?.launchEligibility).toBeDefined()
    expect(resolveVst3Attachment(scanned, reference)).toBeDefined()

    const freshStore = createPluginCatalogStore({ filePath })
    const persisted = await freshStore.load()
    expect(persisted.entries[0]?.launchEligibility).toBeUndefined()
    expect(resolveVst3Attachment(persisted, reference)).toBeUndefined()

    const rescanned = await freshStore.scan(scanBundle)
    expect(resolveVst3Attachment(rescanned, reference)).toBeDefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('seeds standard directories and revalidates trusted entries during initialization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const filePath = path.join(directory, 'plugin-catalog-v1.json')
  const bundlePath = path.join(directory, 'Example.vst3')
  try {
    await mkdir(bundlePath)
    const store = createPluginCatalogStore({ filePath })
    await store.addDirectory(directory)
    const fingerprint = 'a'.repeat(64)
    await store.scan(async (entry) => ({
      classes: [{
        classId: 'example',
        vendor: 'Vendor',
        name: 'Example',
        version: '1',
        role: 'effect',
        source: 'factory',
      }],
      scanHealth: 'scanned',
      binaryFingerprint: fingerprint,
      launchEligibility: {
        canonicalBundlePath: entry.bundlePath,
        canonicalExecutablePath: `${entry.bundlePath}/Contents/MacOS/Example`,
        bundleFingerprint: 'b'.repeat(64),
        binaryFingerprint: fingerprint,
        architecture: 'arm64',
        codeSignVerifiedAtMs: 1,
        quarantinePresent: false,
        scannerProtocolVersion: 2,
      },
    }))
    const restarted = createPluginCatalogStore({ filePath })
    const result = await restarted.initialize([directory], async (entry) => ({
      classes: [{
        classId: 'example',
        vendor: 'Vendor',
        name: 'Example',
        version: '1',
        role: 'effect',
        source: 'factory',
      }],
      scanHealth: 'scanned',
      binaryFingerprint: fingerprint,
      launchEligibility: {
        canonicalBundlePath: entry.bundlePath,
        canonicalExecutablePath: `${entry.bundlePath}/Contents/MacOS/Example`,
        bundleFingerprint: 'b'.repeat(64),
        binaryFingerprint: fingerprint,
        architecture: 'arm64',
        codeSignVerifiedAtMs: 2,
        quarantinePresent: false,
        scannerProtocolVersion: 2,
      },
    }))
    expect(result.directories).toContain(await realpath(directory))
    expect(result.entries[0]?.hostingStatus).toBe('ready')
    expect(result.entries[0]?.launchEligibility).toBeDefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('preserves a concrete scan failure reason without launch eligibility', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  try {
    await mkdir(path.join(directory, 'Broken.vst3'))
    const store = createPluginCatalogStore({ filePath: path.join(directory, 'catalog.json') })
    await store.addDirectory(directory)
    const catalog = await store.scan(async () => {
      throw new Error('Code signing verification failed.')
    })
    expect(catalog.entries[0]?.hostingStatus).toBe('failed')
    expect(catalog.entries[0]?.unavailableReason).toBe('The VST3 scanner failed.')
    expect(catalog.entries[0]?.launchEligibility).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('initialization skips missing and non-directory standard paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const customDirectory = path.join(directory, 'custom')
  const filePath = path.join(directory, 'catalog.json')
  const fileCandidate = path.join(directory, 'not-a-directory')
  try {
    await mkdir(customDirectory)
    await writeFile(fileCandidate, 'not a directory')
    const store = createPluginCatalogStore({ filePath })
    await store.addDirectory(customDirectory)
    const result = await store.initialize([
      path.join(directory, 'missing'),
      fileCandidate,
    ])
    expect(result.directories).toEqual([await realpath(customDirectory)])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('preserves trusted entries and custom directories when initialization has no scanner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const customDirectory = path.join(directory, 'custom')
  const bundlePath = path.join(customDirectory, 'Example.vst3')
  const filePath = path.join(directory, 'catalog.json')
  try {
    await mkdir(bundlePath, { recursive: true })
    const store = createPluginCatalogStore({ filePath })
    await store.addDirectory(customDirectory)
    const scanBundle = async (entry: Vst3CatalogEntry) => ({
      scanHealth: 'scanned' as const,
      binaryFingerprint: 'a'.repeat(64),
      launchEligibility: {
        canonicalBundlePath: entry.bundlePath,
        canonicalExecutablePath: path.join(entry.bundlePath, 'Contents', 'MacOS', 'Example'),
        bundleFingerprint: 'b'.repeat(64),
        binaryFingerprint: 'a'.repeat(64),
        architecture: 'arm64' as const,
        codeSignVerifiedAtMs: 1,
        quarantinePresent: false as const,
        scannerProtocolVersion: 2 as const,
      },
    })
    await store.scan(scanBundle)
    const canonicalBundlePath = await realpath(bundlePath)
    await rm(bundlePath, { recursive: true, force: true })

    const restarted = createPluginCatalogStore({ filePath })
    const initialized = await restarted.initialize([])
    expect(initialized.directories).toEqual([await realpath(customDirectory)])
    expect(initialized.entries).toHaveLength(1)
    expect(initialized.entries[0]?.launchEligibility).toBeUndefined()
    expect(initialized.entries[0]?.hasTrustedScan).toBe(true)

    const freshStore = createPluginCatalogStore({ filePath })
    const persisted = await freshStore.load()
    expect(persisted.directories).toEqual([await realpath(customDirectory)])
    expect(persisted.entries).toHaveLength(1)
    expect(persisted.entries[0]?.bundlePath).toBe(canonicalBundlePath)

    await mkdir(bundlePath)
    const recovered = await freshStore.revalidate(scanBundle)
    expect(recovered.entries[0]?.hostingStatus).toBe('ready')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('revalidates a previously trusted entry after a transient scan failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  const bundlePath = path.join(directory, 'Example.vst3')
  try {
    await mkdir(bundlePath)
    const store = createPluginCatalogStore({ filePath: path.join(directory, 'catalog.json') })
    await store.addDirectory(directory)
    const scanBundle = async (entry: Vst3CatalogEntry) => ({
      classes: [{
        classId: 'example',
        vendor: 'Vendor',
        name: 'Example',
        version: '1',
        role: 'effect' as const,
        source: 'factory' as const,
      }],
      scanHealth: 'scanned' as const,
      binaryFingerprint: 'a'.repeat(64),
      launchEligibility: {
        canonicalBundlePath: entry.bundlePath,
        canonicalExecutablePath: path.join(entry.bundlePath, 'Contents', 'MacOS', 'Example'),
        bundleFingerprint: 'b'.repeat(64),
        binaryFingerprint: 'a'.repeat(64),
        architecture: 'arm64' as const,
        codeSignVerifiedAtMs: 1,
        quarantinePresent: false as const,
        scannerProtocolVersion: 2 as const,
      },
    })
    await store.scan(scanBundle)
    await expect(store.scan(async () => { throw new Error('temporary') })).resolves.toMatchObject({
      entries: [{ hostingStatus: 'failed', hasTrustedScan: true }],
    })
    let calls = 0
    const result = await store.revalidate(async (entry) => {
      calls += 1
      return scanBundle(entry)
    })
    expect(calls).toBe(1)
    expect(result.entries[0]?.hostingStatus).toBe('ready')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('serializes scans and shares concurrent revalidation work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  try {
    await mkdir(path.join(directory, 'Example.vst3'))
    const store = createPluginCatalogStore({ filePath: path.join(directory, 'catalog.json') })
    await store.addDirectory(directory)
    let active = 0
    let maximumActive = 0
    let releaseScan: (() => void) | undefined
    const scanBlocked = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    const scanBundle = async (entry: Vst3CatalogEntry) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await scanBlocked
      active -= 1
      return {
        scanHealth: 'scanned' as const,
        binaryFingerprint: 'a'.repeat(64),
        launchEligibility: {
          canonicalBundlePath: entry.bundlePath,
          canonicalExecutablePath: path.join(entry.bundlePath, 'Contents', 'MacOS', 'Example'),
          bundleFingerprint: 'b'.repeat(64),
          binaryFingerprint: 'a'.repeat(64),
          architecture: 'arm64' as const,
          codeSignVerifiedAtMs: 1,
          quarantinePresent: false as const,
          scannerProtocolVersion: 2 as const,
        },
      }
    }
    const firstScan = store.scan(scanBundle)
    const secondScan = store.scan(scanBundle)
    releaseScan?.()
    await Promise.all([firstScan, secondScan])
    expect(maximumActive).toBe(1)

    const restarted = createPluginCatalogStore({ filePath: path.join(directory, 'catalog.json') })
    let revalidateCalls = 0
    await Promise.all([
      restarted.revalidate(async (entry) => {
        revalidateCalls += 1
        return scanBundle(entry)
      }),
      restarted.revalidate(async (entry) => {
        revalidateCalls += 1
        return scanBundle(entry)
      }),
    ])
    expect(revalidateCalls).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('never marks an unscanned or ineligible result ready and preserves the directory cap', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-plugin-catalog-'))
  try {
    await mkdir(path.join(directory, 'Example.vst3'))
    const store = createPluginCatalogStore({ filePath: path.join(directory, 'catalog.json') })
    await store.addDirectory(directory)
    await expect(store.scan(async () => ({
      scanHealth: 'scanned' as const,
      binaryFingerprint: 'a'.repeat(64),
    }))).resolves.toMatchObject({
      entries: [{ hostingStatus: 'failed', scanHealth: 'scan-failed' }],
    })
    const empty = await store.scan()
    expect(empty.entries[0]?.hostingStatus).toBe('discovered')

    const cappedDirectories = await Promise.all(
      Array.from({ length: 64 }, async (_, index) => {
        const candidate = path.join(directory, `directory-${index}`)
        await mkdir(candidate)
        return realpath(candidate)
      }),
    )
    await writeFile(path.join(directory, 'capped.json'), JSON.stringify({
      version: 3,
      directories: cappedDirectories,
      entries: [],
      diagnostics: [],
      scannedAtMs: null,
    }))
    const capped = createPluginCatalogStore({ filePath: path.join(directory, 'capped.json') })
    await capped.initialize([directory])
    expect((await capped.load()).directories).toHaveLength(64)
    await expect(capped.addDirectory(directory)).rejects.toThrow('Too many configured')
    expect((await capped.load()).directories).toHaveLength(64)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
