import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { build } from 'bun'
import { z } from 'zod'
import {
  comparisonDurationSec,
  comparisonKickBursts,
  comparisonSampleRate,
  createComparisonProject,
  type ComparisonVariant,
  PlanarAudioBuffer,
} from './portable-export-comparison-project'
import { compilePortableExportSnapshot } from './portable-export-snapshot'
import { renderThroughExportWorker } from './portable-export-render-harness'

// One envelope sample covers a quarter of a millisecond, which is the timing resolution of the alignment check.
const envelopeFrames = 12
const windowFrames = comparisonSampleRate / 20
const publicDirectory = new URL('../../../public', import.meta.url).pathname

const rmsEnvelope = (samples: Float32Array, frames: number) => Array.from(
  { length: Math.floor(samples.length / frames) },
  (_, index) => Math.sqrt(samples.subarray(index * frames, (index + 1) * frames).reduce((sum, sample) => sum + sample * sample, 0) / frames),
)

const windowedDb = (envelope: readonly number[]) => {
  const perWindow = windowFrames / envelopeFrames

  return Array.from({ length: Math.floor(envelope.length / perWindow) }, (_, index) => {
    const energy = envelope.slice(index * perWindow, (index + 1) * perWindow).reduce((sum, value) => sum + value * value, 0) / perWindow

    return 10 * Math.log10(Math.max(energy, 1e-12))
  })
}

/** The lag, in envelope samples, at which the portable envelope best matches the legacy one. */
const bestLag = (legacy: readonly number[], portable: readonly number[], maxLag: number) => {
  let best = { lag: 0, error: Number.POSITIVE_INFINITY }

  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let error = 0

    for (let index = maxLag; index < legacy.length - maxLag; index += 1) error += (legacy[index] - (portable[index + lag] ?? 0)) ** 2

    if (error < best.error) best = { lag, error }
  }

  return best.lag
}

const renderLegacyInChromium = async (variants: readonly ComparisonVariant[]) => {
  const directory = `/tmp/daw-export-comparison-${crypto.randomUUID()}`
  const session = `export-comparison-${crypto.randomUUID()}`

  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION

    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    if (exitCode !== 0) throw new Error(`agent-browser ${args[0]}: ${stderr || stdout}`)

    return stdout.trim()
  }

  await mkdir(directory, { recursive: true })
  let server: ReturnType<typeof Bun.serve> | undefined

  try {
    const entry = `${directory}/fixture.ts`

    await Bun.write(entry, `import { renderMixdown } from '${new URL('./export-mixdown.ts', import.meta.url).pathname}'
import { createComparisonProject } from '${new URL('./portable-export-comparison-project.ts', import.meta.url).pathname}'
window.renderLegacy = async (variant, envelopeFrames) => {
  const project = createComparisonProject((planes, sampleRate) => {
    const buffer = new AudioBuffer({ length: planes[0].length, numberOfChannels: 2, sampleRate })
    buffer.copyToChannel(planes[0], 0)
    buffer.copyToChannel(planes[1], 1)

    return buffer
  }, variant)

  // No prepared Stretch repository, so renderMixdown takes the OfflineAudioContext path.
  const rendered = await renderMixdown({
    tracks: project.tracks,
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: ${comparisonDurationSec} },
    sampleRate: ${comparisonSampleRate},
    fx: project.fx,
    automationEnvelopes: project.automationEnvelopes,
    sidechainRoutes: project.sidechainRoutes,
  })

  const samples = rendered.getChannelData(0)
  const envelope = []

  for (let start = 0; start + envelopeFrames <= samples.length; start += envelopeFrames) {
    let sum = 0
    for (let index = start; index < start + envelopeFrames; index += 1) sum += samples[index] * samples[index]
    envelope.push(Math.sqrt(sum / envelopeFrames))
  }

  return { length: samples.length, envelope }
}`)

    const bundle = await build({ entrypoints: [entry], target: 'browser', format: 'iife' })

    expect(bundle.success).toBe(true)
    const script = await bundle.outputs[0]?.text()

    if (!script) throw new Error('Export comparison bundle is missing.')

    const page = `<!doctype html><script>${script.replaceAll('import.meta.url', JSON.stringify('http://localhost/bundle.js')).replaceAll('import.meta.env.BASE_URL', JSON.stringify('/'))}</script>`

    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname } = new URL(request.url)
        const file = pathname === '/' ? undefined : Bun.file(`${publicDirectory}${pathname}`)

        if (file && await file.exists()) return new Response(file)

        return new Response(page, { headers: { 'content-type': 'text/html' } })
      },
    })

    await browser('open', `http://localhost:${server.port}/`)

    const result = z.object({ length: z.number(), envelope: z.array(z.number()) })
    const rendered: Record<string, z.infer<typeof result>> = {}

    for (const variant of variants) {
      rendered[variant] = result.parse(JSON.parse(await browser('eval', `window.renderLegacy('${variant}', ${envelopeFrames})`)))
    }

    return rendered
  } finally {
    await browser('close').catch(() => undefined)
    server?.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

const renderPortable = async (variant: ComparisonVariant) => {
  const project = createComparisonProject((planes, sampleRate) => new PlanarAudioBuffer(planes.map((plane) => new Float32Array(plane)), sampleRate), variant)

  const snapshot = compilePortableExportSnapshot({
    tracks: project.tracks,
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: comparisonDurationSec },
    sampleRateHz: comparisonSampleRate,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    fx: project.fx,
    automationEnvelopes: project.automationEnvelopes,
    sidechainRoutes: project.sidechainRoutes,
  })

  if (!snapshot.supported) throw new Error(snapshot.reasons.join('\n'))

  const rendered = await renderThroughExportWorker(snapshot, {
    sampleRateHz: comparisonSampleRate,
    frameCount: comparisonSampleRate * comparisonDurationSec + snapshot.graphLatencyFrames,
  })

  expect(rendered.failures).toEqual([])

  return rmsEnvelope(rendered.planes[0].subarray(snapshot.graphLatencyFrames), envelopeFrames)
}

const compare = (legacy: readonly number[], portable: readonly number[]) => {
  const legacyDb = windowedDb(legacy)
  const portableDb = windowedDb(portable)

  return {
    windows: legacyDb.map((value, index) => ({ window: index, legacyDb: value, portableDb: portableDb[index], diffDb: Math.abs(value - portableDb[index]) })),
    lagMs: bestLag(legacy, portable, 16) * envelopeFrames / comparisonSampleRate * 1000,
  }
}

test('the portable export worker matches the legacy OfflineAudioContext render', async () => {
  const legacy = await renderLegacyInChromium(['automation', 'full'])

  // Automation alone (mixer volume and a delay's wet mix) must agree everywhere and land on the same millisecond.
  const automation = compare(legacy.automation.envelope, await renderPortable('automation'))
  const automationWorstDb = Math.max(...automation.windows.map((entry) => entry.diffDb))

  // The two compressors differ in how they align the key's lookahead, so the sidechain project is compared outside the
  // 50 ms windows that contain a key edge. The legacy sidechain render is not repeatable run to run (1.2 to 3.2 dB observed
  // against the same portable output), so this bound only shows the ducking and its release agree in shape and depth.
  const full = compare(legacy.full.envelope, await renderPortable('full'))
  const keyEdgeWindows = new Set(comparisonKickBursts.flatMap((burst) => [burst.startSec, burst.endSec].map((sec) => Math.round(sec * 20))))
  const fullWorstDb = Math.max(...full.windows.filter((entry) => !keyEdgeWindows.has(entry.window)).map((entry) => entry.diffDb))

  console.log(JSON.stringify({ automationWorstDb, automationLagMs: automation.lagMs, fullWorstDbOutsideKeyEdges: fullWorstDb, fullLagMs: full.lagMs }))
  expect(automation.windows).toHaveLength(60)
  expect(automationWorstDb).toBeLessThan(0.5)
  expect(Math.abs(automation.lagMs)).toBeLessThanOrEqual(1)
  expect(fullWorstDb).toBeLessThan(3.5)
}, 120_000)
