import {
  createDefaultAutoPanParams,
  createDefaultChorusParams,
  createDefaultEnsembleParams,
  createDefaultFlangerParams,
  createDefaultPhaserParams,
  createDefaultTremoloParams,
  createDefaultAutoFilterParams,
  createDefaultGateParams,
  createDefaultLimiterParams,
  createDefaultLoFiParams,
  createDefaultUtilityParams,
  normalizeCompressorParams,
  normalizeGateParamsEnvelope,
  normalizeUtilityParamsEnvelope,
} from '@daw-browser/shared'
import { createCompressorNodeChain } from './effects/chain'
import { createStaticWorkletNodeChain } from './effects/static-worklet-chain'
import type { StaticWorkletKind } from './effects/static-worklet-chain'
import { measureAudio, measureChannelLeakageDb } from './dsp-characterization'

type BrowserCharacterizationCase = {
  status: 'pass' | 'fail' | 'unsupported'
  metrics?: Readonly<Record<string, number | boolean>>
  message?: string
}

export type StaticModuleCharacterization = {
  kind: StaticWorkletKind
  sampleRate: number
  channels: number
  supported: boolean
  declaredLatencyFrames: number | null
  registrationStatus: BrowserCharacterizationCase['status']
  renderStatus: BrowserCharacterizationCase['status']
  finiteOutput: boolean | null
  message?: string
}

export type BrowserCharacterizationReport = {
  userAgent: string
  sampleRates: Readonly<Record<string, BrowserCharacterizationCase>>
  dryGain: BrowserCharacterizationCase
  stereoIsolation: BrowserCharacterizationCase
  eq: BrowserCharacterizationCase
  compressorRegistration: BrowserCharacterizationCase
  compressorProcessing: BrowserCharacterizationCase
  utilityWorklet: Readonly<Record<string, BrowserCharacterizationCase>>
  gateWorklet: Readonly<Record<string, BrowserCharacterizationCase>>
  modulationWorklet: Readonly<Record<string, BrowserCharacterizationCase>>
  staticModules: readonly StaticModuleCharacterization[]
  timing: {
    declared: Readonly<Record<string, number>>
    measured: BrowserCharacterizationCase
  }
  liveAlignment: BrowserCharacterizationCase
  cueRouting: BrowserCharacterizationCase
  externalSidechain: BrowserCharacterizationCase
}

const readBuffer = (buffer: AudioBuffer) =>
  Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))

const render = async (
  sampleRate: number,
  channels: number,
  frames: number,
  connect: (context: OfflineAudioContext, source: AudioBufferSourceNode) => Promise<void> | void,
) => {
  const context = new OfflineAudioContext(channels, frames, sampleRate)
  const buffer = context.createBuffer(channels, frames, sampleRate)
  const source = context.createBufferSource()
  source.buffer = buffer
  await connect(context, source)
  source.start()
  return context.startRendering()
}

const capture = async (run: () => Promise<BrowserCharacterizationCase>): Promise<BrowserCharacterizationCase> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<BrowserCharacterizationCase>((resolve) => {
        // Browser worklet registration can remain pending indefinitely, so the diagnostic must terminate with evidence.
        timeoutId = setTimeout(() => resolve({ status: 'fail', message: 'Browser characterization timed out.' }), 8_000)
      }),
    ])
  } catch (error) {
    return { status: 'fail', message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

const envelope = <State>(state: State): { version: 1; state: State } => ({ version: 1, state })

const staticParams = (kind: StaticWorkletKind) => {
  if (kind === 'utility') return envelope({ ...createDefaultUtilityParams(), enabled: false })
  if (kind === 'autofilter') return envelope({ ...createDefaultAutoFilterParams(), enabled: false })
  if (kind === 'gate') return envelope({ ...createDefaultGateParams(), enabled: false })
  if (kind === 'limiter') return envelope({ ...createDefaultLimiterParams(), enabled: false })
  if (kind === 'lofi') return envelope({ ...createDefaultLoFiParams(), enabled: false })
  if (kind === 'chorus') return envelope({ ...createDefaultChorusParams(), enabled: false })
  if (kind === 'flanger') return envelope({ ...createDefaultFlangerParams(), enabled: false })
  if (kind === 'phaser') return envelope({ ...createDefaultPhaserParams(), enabled: false })
  if (kind === 'tremolo') return envelope({ ...createDefaultTremoloParams(), enabled: false })
  if (kind === 'autopan') return envelope({ ...createDefaultAutoPanParams(), enabled: false })
  return envelope({ ...createDefaultEnsembleParams(), enabled: false })
}

export const getStaticModuleDeclaredLatencyFrames = (
  kind: StaticWorkletKind,
  sampleRate: number,
): number => kind === 'autofilter'
  ? 6
  : kind === 'gate'
    ? Math.ceil(0.002 * sampleRate)
    : kind === 'limiter'
      ? Math.ceil(0.005 * sampleRate)
      : 0

export function isStaticModuleCharacterization(value: unknown): value is StaticModuleCharacterization {
  if (typeof value !== 'object' || value === null) return false
  if (!('kind' in value) || !('sampleRate' in value) || !('channels' in value)
    || !('supported' in value) || !('declaredLatencyFrames' in value)
    || !('registrationStatus' in value) || !('renderStatus' in value)
    || !('finiteOutput' in value)) return false
  const validStatus = (status: unknown) => status === 'pass' || status === 'fail' || status === 'unsupported'
  return typeof value.kind === 'string'
    && typeof value.sampleRate === 'number'
    && (value.channels === 1 || value.channels === 2)
    && typeof value.supported === 'boolean'
    && (typeof value.declaredLatencyFrames === 'number' || value.declaredLatencyFrames === null)
    && validStatus(value.registrationStatus)
    && validStatus(value.renderStatus)
    && (typeof value.finiteOutput === 'boolean' || value.finiteOutput === null)
}

const characterizeStaticModule = async (
  kind: StaticWorkletKind,
  sampleRate: number,
  channels: number,
): Promise<StaticModuleCharacterization> => {
  const declaredLatencyFrames = getStaticModuleDeclaredLatencyFrames(kind, sampleRate)
  if (!('audioWorklet' in OfflineAudioContext.prototype)) {
    return {
      kind,
      sampleRate,
      channels,
      supported: false,
      declaredLatencyFrames,
      registrationStatus: 'unsupported',
      renderStatus: 'unsupported',
      finiteOutput: null,
      message: 'OfflineAudioContext AudioWorklet registration is unavailable.',
    }
  }
  let registered = false
  const result = await capture(async () => {
    const frames = Math.max(128, declaredLatencyFrames + 2)
    const rendered = await render(sampleRate, channels, frames, async (context, source) => {
      for (let channel = 0; channel < channels; channel += 1) {
        source.buffer?.getChannelData(channel).fill(channel === 0 ? 0.25 : -0.125)
      }
      const chain = await createStaticWorkletNodeChain(context, kind, staticParams(kind))
      registered = true
      source.connect(chain.node)
      chain.node.connect(context.destination)
    })
    const metrics = measureAudio(readBuffer(rendered))
    return {
      status: metrics.containsNonFiniteSamples ? 'fail' : 'pass',
      metrics: { containsNonFiniteSamples: metrics.containsNonFiniteSamples },
    }
  })
  return {
    kind,
    sampleRate,
    channels,
    supported: true,
    declaredLatencyFrames,
    registrationStatus: registered ? 'pass' : result.status,
    renderStatus: result.status,
    finiteOutput: result.metrics && typeof result.metrics.containsNonFiniteSamples === 'boolean'
      ? !result.metrics.containsNonFiniteSamples
      : null,
    message: result.message,
  }
}

export async function runBrowserCharacterization(): Promise<BrowserCharacterizationReport> {
  const sampleRates: Record<string, BrowserCharacterizationCase> = {}
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    sampleRates[String(sampleRate)] = await capture(async () => {
      const context = new OfflineAudioContext(1, 1, sampleRate)
      const rendered = await context.startRendering()
      return {
        status: rendered.sampleRate === sampleRate ? 'pass' : 'fail',
        metrics: { requestedSampleRate: sampleRate, activeSampleRate: rendered.sampleRate },
      }
    })
  }

  const dryGain = await capture(async () => {
    const rendered = await render(48_000, 1, 128, (context, source) => {
      source.buffer?.getChannelData(0).fill(0.25)
      const gain = context.createGain()
      gain.gain.value = 2
      source.connect(gain)
      gain.connect(context.destination)
    })
    const metrics = measureAudio(readBuffer(rendered))
    return { status: Math.abs(metrics.peak - 0.5) < 1e-3 ? 'pass' : 'fail', metrics: { peak: metrics.peak, rms: metrics.rms } }
  })

  const stereoIsolation = await capture(async () => {
    const rendered = await render(48_000, 2, 128, (context, source) => {
      if (source.buffer) {
        source.buffer.getChannelData(0)[0] = 1
        source.buffer.getChannelData(1)[0] = 0
      }
      source.connect(context.destination)
    })
    const leftPeak = measureAudio([rendered.getChannelData(0)]).peak
    const rightPeak = measureAudio([rendered.getChannelData(1)]).peak
    const leakageDetected = Number.isFinite(measureChannelLeakageDb(leftPeak, rightPeak))
    return {
      status: Math.abs(leftPeak - 1) < 1e-3 && rightPeak < 1e-6 ? 'pass' : 'fail',
      metrics: { leftPeak, rightPeak, leakageDetected },
    }
  })

  const eq = await capture(async () => {
    const rendered = await render(48_000, 1, 4_800, (context, source) => {
      if (source.buffer) {
        const channel = source.buffer.getChannelData(0)
        for (let frame = 0; frame < channel.length; frame += 1) channel[frame] = Math.sin(2 * Math.PI * 1_000 * frame / 48_000) * 0.25
      }
      const filter = context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = 1_000
      filter.Q.value = 1
      filter.gain.value = 6
      source.connect(filter)
      filter.connect(context.destination)
    })
    const rms = measureAudio(readBuffer(rendered)).rms
    return { status: rms > 0.3 && rms < 0.4 ? 'pass' : 'fail', metrics: { rms } }
  })

  const compressorRegistration = await capture(async () => {
    const rendered = await render(48_000, 2, 128, async (context, source) => {
      if (source.buffer) {
        source.buffer.getChannelData(0)[16] = 0.5
        source.buffer.getChannelData(1)[80] = -0.25
      }
      const chain = await createCompressorNodeChain(context, normalizeCompressorParams({ enabled: true, dryWet: 0 }))
      source.connect(chain.input)
      chain.output.connect(context.destination)
    })
    const left = rendered.getChannelData(0)
    const right = rendered.getChannelData(1)
    const expectedFramesMatch = left[16] === 0.5
      && right[80] === -0.25
      && left[80] === 0
      && right[16] === 0
    return {
      status: expectedFramesMatch ? 'pass' : 'fail',
      metrics: {
        expectedFramesMatch,
        leftFrame16: left[16],
        rightFrame80: right[80],
        leftFrame80: left[80],
        rightFrame16: right[16],
      },
    }
  })

  const compressorProcessing = await capture(async () => {
    const inputLevel = 0.5
    const rendered = await render(48_000, 2, 4_800, async (context, source) => {
      source.buffer?.getChannelData(0).fill(inputLevel)
      source.buffer?.getChannelData(1).fill(inputLevel)
      const chain = await createCompressorNodeChain(context, normalizeCompressorParams({
        enabled: true,
        thresholdDb: -30,
        ratio: 20,
        attackMs: 0.1,
        releaseMs: 5,
        autoRelease: false,
        dryWet: 1,
        kneeDb: 0,
        detectorMode: 'peak',
      }))
      source.connect(chain.input)
      chain.output.connect(context.destination)
    })
    const settled = rendered.getChannelData(0).subarray(2_400)
    const metrics = measureAudio([settled])
    return {
      status: !metrics.containsNonFiniteSamples && metrics.rms < inputLevel * 0.5 ? 'pass' : 'fail',
      metrics: {
        inputLevel,
        settledPeak: metrics.peak,
        settledRms: metrics.rms,
        containsNonFiniteSamples: metrics.containsNonFiniteSamples,
      },
    }
  })

  const characterizeStaticWorklet = async (kind: 'utility' | 'gate', sampleRate: number) => capture(async () => {
    if (!('audioWorklet' in OfflineAudioContext.prototype)) {
      return { status: 'unsupported', message: 'OfflineAudioContext AudioWorklet registration is unavailable.' }
    }
    const frames = Math.ceil(sampleRate * 0.002) + 2
    const rendered = await render(sampleRate, 2, frames, async (context, source) => {
      if (source.buffer) {
        source.buffer.getChannelData(0)[0] = 0.5
        source.buffer.getChannelData(1)[0] = -0.25
      }
      const params = kind === 'utility' ? normalizeUtilityParamsEnvelope({}) : normalizeGateParamsEnvelope({ state: { enabled: false } })
      const chain = await createStaticWorkletNodeChain(context, kind, params)
      source.connect(chain.node)
      chain.node.connect(context.destination)
    })
    const expectedFrame = kind === 'gate' ? Math.ceil(sampleRate * 0.002) : 0
    const left = rendered.getChannelData(0)[expectedFrame]
    const right = rendered.getChannelData(1)[expectedFrame]
    const matches = Math.abs(left - 0.5) <= 1e-6 && Math.abs(right + 0.25) <= 1e-6
    return { status: matches ? 'pass' : 'fail', metrics: { sampleRate, expectedFrame, left, right } }
  })
  const utilityWorklet: Record<string, BrowserCharacterizationCase> = {}
  const gateWorklet: Record<string, BrowserCharacterizationCase> = {}
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    utilityWorklet[String(sampleRate)] = await characterizeStaticWorklet('utility', sampleRate)
    gateWorklet[String(sampleRate)] = await characterizeStaticWorklet('gate', sampleRate)
  }
  const modulationDefaults = {
    chorus: createDefaultChorusParams,
    flanger: createDefaultFlangerParams,
    phaser: createDefaultPhaserParams,
    tremolo: createDefaultTremoloParams,
    autopan: createDefaultAutoPanParams,
    ensemble: createDefaultEnsembleParams,
  }
  const modulationWorklet: Record<string, BrowserCharacterizationCase> = {}
  const modulationKinds: Array<keyof typeof modulationDefaults> = ['chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble']
  for (const kind of modulationKinds) {
    modulationWorklet[kind] = await capture(async () => {
      if (!('audioWorklet' in OfflineAudioContext.prototype)) {
        return { status: 'unsupported', message: 'OfflineAudioContext AudioWorklet registration is unavailable.' }
      }
      const rendered = await render(48_000, 2, 128, async (context, source) => {
        source.buffer?.getChannelData(0).fill(0.25)
        source.buffer?.getChannelData(1).fill(-0.125)
        const chain = kind === 'chorus'
          ? await createStaticWorkletNodeChain(context, kind, { version: 1, state: { ...createDefaultChorusParams(), enabled: false } })
          : kind === 'flanger'
            ? await createStaticWorkletNodeChain(context, kind, { version: 1, state: { ...createDefaultFlangerParams(), enabled: false } })
            : kind === 'phaser'
              ? await createStaticWorkletNodeChain(context, kind, { version: 1, state: { ...createDefaultPhaserParams(), enabled: false } })
              : kind === 'tremolo'
                ? await createStaticWorkletNodeChain(context, kind, { version: 1, state: { ...createDefaultTremoloParams(), enabled: false } })
                : kind === 'autopan'
                  ? await createStaticWorkletNodeChain(context, kind, { version: 1, state: { ...createDefaultAutoPanParams(), enabled: false } })
                  : await createStaticWorkletNodeChain(context, kind, { version: 1, state: { ...createDefaultEnsembleParams(), enabled: false } })
        source.connect(chain.node)
        chain.node.connect(context.destination)
      })
      const left = rendered.getChannelData(0)[0]
      const right = rendered.getChannelData(1)[0]
      return { status: left === 0.25 && right === -0.125 ? 'pass' : 'fail', metrics: { left, right } }
    })
  }

  const staticKinds: StaticWorkletKind[] = [
    'utility',
    'autofilter',
    'gate',
    'limiter',
    'lofi',
    'chorus',
    'flanger',
    'phaser',
    'tremolo',
    'autopan',
    'ensemble',
  ]
  const staticModules = await Promise.all(staticKinds.flatMap((kind) =>
    [44_100, 48_000, 96_000].flatMap((sampleRate) =>
      [1, 2].map((channels) => characterizeStaticModule(kind, sampleRate, channels)))))

  return {
    userAgent: navigator.userAgent,
    sampleRates,
    dryGain,
    stereoIsolation,
    eq,
    compressorRegistration,
    compressorProcessing,
    utilityWorklet,
    gateWorklet,
    modulationWorklet,
    staticModules,
    timing: {
      declared: {
        compressorMaximumLookaheadMs: 10,
        liveDelayRampMs: 10,
      },
      measured: {
        status: 'unsupported',
        message: 'This offline characterization cannot measure live AudioContext output timing.',
      },
    },
    liveAlignment: {
      status: 'unsupported',
      message: 'Live graph alignment requires a running AudioContext and loopback capture.',
    },
    cueRouting: {
      status: 'unsupported',
      message: 'Cue output isolation requires a selectable live output device.',
    },
    externalSidechain: {
      status: 'unsupported',
      message: 'External sidechain timing requires the live routing probe.',
    },
  }
}
