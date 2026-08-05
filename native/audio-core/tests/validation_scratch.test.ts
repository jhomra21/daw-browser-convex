import { expect, test } from 'bun:test'

const coreSourceUrl = new URL('../src/audio_core.cpp', import.meta.url)
const cmakeUrl = new URL('../CMakeLists.txt', import.meta.url)
const wasmBuildScriptUrl = new URL('../scripts/build-wasm.sh', import.meta.url)
const publishWasmAssetsUrl = new URL('../scripts/publish-wasm-assets.sh', import.meta.url)

test('native validation scratch stays persistent while Wasm uses its configured stack', async () => {
  const source = await Bun.file(coreSourceUrl).text()
  const persistentScratchStart = source.indexOf('#if defined(DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH)')
  const persistentScratchEnd = source.indexOf('#endif', persistentScratchStart)
  const validationStart = source.indexOf('  std::copy((*core.published_instruments).begin()')
  const validationEnd = source.indexOf('  for (auto &indices : core.instrument_event_indices)', validationStart)

  expect(persistentScratchStart).toBeGreaterThanOrEqual(0)
  expect(persistentScratchEnd).toBeGreaterThan(persistentScratchStart)
  expect(source.slice(persistentScratchStart, persistentScratchEnd)).toContain('proposed_instruments{}')
  expect(validationStart).toBeGreaterThanOrEqual(0)
  expect(validationEnd).toBeGreaterThan(validationStart)

  const validation = source.slice(validationStart, validationEnd)
  expect(validation).toContain('std::copy((*core.published_instruments).begin(), (*core.published_instruments).end(), core.proposed_instruments.begin())')
  expect(validation).toContain('auto &proposed_instruments = core.proposed_instruments')
  expect(validation).not.toContain('std::array<InstrumentNodeState, kMaximumGraphNodes> proposed_instruments')
})

test('Wasm build validates a same-filesystem directory before publication', async () => {
  const cmake = await Bun.file(cmakeUrl).text()
  const buildScript = await Bun.file(wasmBuildScriptUrl).text()
  const publishScript = await Bun.file(publishWasmAssetsUrl).text()

  expect(cmake).toContain('DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH=1')
  expect(cmake).toContain('if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")')
  expect(buildScript).toContain('maximum_bytes=524288')
  expect(buildScript).toContain('bun native/audio-core/scripts/validate-wasm-artifact.ts "$artifact" "$artifact_manifest"')
  expect(buildScript).toContain('public_parent=$(dirname "$public_artifact_dir")')
  expect(buildScript).toContain('staging_dir=$(mktemp -d "$public_parent/.audio-core-staging.XXXXXX")')
  expect(buildScript).not.toContain('TMPDIR')
  const stagedValidation = buildScript.indexOf('  "$staging_dir/daw-audio-core.wasm"')
  expect(stagedValidation).toBeGreaterThan(buildScript.indexOf('staging_dir=$(mktemp -d'))
  expect(buildScript.indexOf('sh native/audio-core/scripts/publish-wasm-assets.sh'))
    .toBeGreaterThan(stagedValidation)
  expect(buildScript).not.toMatch(/mv[^\n]*daw-audio-core\.(wasm|manifest\.json)/)

  expect(publishScript).toContain('mv "$public_artifact_dir" "$backup_dir"')
  expect(publishScript).toContain('mv "$staging_dir" "$public_artifact_dir"')
  expect(publishScript).not.toMatch(/mv[^\n]*daw-audio-core\.(wasm|manifest\.json)/)
})

test('native graph stages cache built-in renderers outside the callback', async () => {
  const source = await Bun.file(coreSourceUrl).text()
  const nativeStageStart = source.indexOf('struct NativeGraphStage {')
  const nativeStageEnd = source.indexOf('struct NativeGraphHooks {', nativeStageStart)
  const callbackStart = source.indexOf('    const NativeGraphHooks &native_stages = core.published_native_hooks;')
  const callbackEnd = source.indexOf('#else', callbackStart)

  expect(nativeStageStart).toBeGreaterThanOrEqual(0)
  expect(nativeStageEnd).toBeGreaterThan(nativeStageStart)
  expect(source.slice(nativeStageStart, nativeStageEnd)).toContain('ProcessorRenderer renderer = nullptr')
  expect(source).toContain('static_assert(std::is_trivially_copyable_v<NativeGraphStage>)')
  expect(source).toContain('const ProcessorRenderer renderer = find_processor_renderer(graph.processors[processor_index].kind)')
  expect(source).toContain('if (renderer == nullptr) return false')
  expect(callbackStart).toBeGreaterThanOrEqual(0)
  expect(callbackEnd).toBeGreaterThan(callbackStart)
  expect(source.slice(callbackStart, callbackEnd)).not.toContain('find_processor_renderer')
})

test('Wasm directory publication restores the old asset set when the replacement fails', async () => {
  const tempResult = Bun.spawnSync({
    cmd: ['mktemp', '-d', '/tmp/daw-audio-core-publish-test.XXXXXX'],
    stdout: 'pipe',
  })
  expect(tempResult.exitCode).toBe(0)
  const root = new TextDecoder().decode(tempResult.stdout).trim()
  const publicDir = `${root}/public/audio-core`
  const stagingDir = `${root}/public/.audio-core-staging-test`
  const wrapperDir = `${root}/bin`
  const countFile = `${root}/mv-count`
  const realMv = Bun.spawnSync({ cmd: ['sh', '-c', 'command -v mv'], stdout: 'pipe' })
  const realMvPath = new TextDecoder().decode(realMv.stdout).trim()

  try {
    Bun.spawnSync({ cmd: ['mkdir', '-p', publicDir, stagingDir, wrapperDir] })
    await Bun.write(`${publicDir}/daw-audio-core.wasm`, 'old wasm')
    await Bun.write(`${publicDir}/daw-audio-core.manifest.json`, 'old manifest')
    await Bun.write(`${stagingDir}/daw-audio-core.wasm`, 'new wasm')
    await Bun.write(`${stagingDir}/daw-audio-core.manifest.json`, 'new manifest')
    await Bun.write(countFile, '0')
    await Bun.write(`${wrapperDir}/mv`, `#!/bin/sh
count=$(cat "${countFile}")
count=$((count + 1))
printf '%s' "$count" > "${countFile}"
if [ "$count" -eq 2 ]; then exit 1; fi
exec "${realMvPath}" "$@"
`)
    Bun.spawnSync({ cmd: ['chmod', '+x', `${wrapperDir}/mv`] })

    const result = Bun.spawnSync({
      cmd: ['sh', publishWasmAssetsUrl.pathname, stagingDir, publicDir],
      env: { ...process.env, PATH: `${wrapperDir}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).not.toBe(0)
    expect(await Bun.file(`${publicDir}/daw-audio-core.wasm`).text()).toBe('old wasm')
    expect(await Bun.file(`${publicDir}/daw-audio-core.manifest.json`).text()).toBe('old manifest')
    expect(await Bun.file(`${stagingDir}/daw-audio-core.wasm`).exists()).toBe(false)
  } finally {
    Bun.spawnSync({ cmd: ['rm', '-rf', root] })
  }
})
