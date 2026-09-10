import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'bun:test'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const validatorPath = path.join(repositoryRoot, 'native/audio-core/scripts/validate-wasm-artifact.ts')
const publicArtifactPath = path.join(repositoryRoot, 'public/audio-core/daw-audio-core.wasm')
const publicManifestPath = path.join(repositoryRoot, 'public/audio-core/daw-audio-core.manifest.json')

const runValidator = (artifactPath: string, manifestPath: string) => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, validatorPath, artifactPath, manifestPath],
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
  }
}

const createFixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daw-portable-wasm-validation-'))
  const artifactPath = path.join(directory, 'daw-audio-core.wasm')
  const manifestPath = path.join(directory, 'daw-audio-core.manifest.json')
  await copyFile(publicArtifactPath, artifactPath)
  await copyFile(publicManifestPath, manifestPath)
  return { directory, artifactPath, manifestPath }
}

test('validates the tracked production Wasm assets', () => {
  const result = runValidator(publicArtifactPath, publicManifestPath)

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
})

test('rejects a missing production Wasm manifest', async () => {
  const fixture = await createFixture()
  try {
    await rm(fixture.manifestPath)
    const result = runValidator(fixture.artifactPath, fixture.manifestPath)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('ENOENT')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects a missing production Wasm artifact', async () => {
  const fixture = await createFixture()
  try {
    await rm(fixture.artifactPath)
    const result = runValidator(fixture.artifactPath, fixture.manifestPath)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('ENOENT')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects a stale production Wasm source hash', async () => {
  const fixture = await createFixture()
  try {
    const manifest = await readFile(fixture.manifestPath, 'utf8')
    await writeFile(
      fixture.manifestPath,
      manifest.replace(/"sourceHash":"[a-f0-9]{64}"/, `"sourceHash":"${'0'.repeat(64)}"`),
    )
    const result = runValidator(fixture.artifactPath, fixture.manifestPath)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('source hash does not match')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects a production Wasm hash mismatch', async () => {
  const fixture = await createFixture()
  try {
    const bytes = await readFile(fixture.artifactPath)
    bytes[0] = bytes[0] ^ 1
    await writeFile(fixture.artifactPath, bytes)
    const result = runValidator(fixture.artifactPath, fixture.manifestPath)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('hash does not match')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects a production Wasm artifact with the wrong ABI version', async () => {
  const fixture = await createFixture()
  try {
    const manifest = await readFile(fixture.manifestPath, 'utf8')
    await writeFile(fixture.manifestPath, manifest.replace('"abiVersion":4', '"abiVersion":3'))
    const result = runValidator(fixture.artifactPath, fixture.manifestPath)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('manifest is invalid')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects a production Wasm manifest with the wrong release version', async () => {
  const fixture = await createFixture()
  try {
    const manifest = await readFile(fixture.manifestPath, 'utf8')
    await writeFile(fixture.manifestPath, manifest.replace('"version":4', '"version":3'))
    const result = runValidator(fixture.artifactPath, fixture.manifestPath)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('manifest is invalid')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
