import { normalizeCompressorParams, type CompressorParamsLite } from '@daw-browser/shared'
import { loadWorkletModule } from '../worklet-loader'
import { compressorWorklet, resolveWorkletModuleUrl } from '../worklet-manifest'

export type CompressorMeterFrame = {
  inputDb: number
  outputDb: number
  gainReductionDb: number
  thresholdDb: number
}

export type CompressorMeterListener = (frame: CompressorMeterFrame) => void

export function computeCompressorWorkletCurveDb(inputDb: number, params: CompressorParamsLite): number {
  const normalized = normalizeCompressorParams(params)
  const threshold = normalized.thresholdDb
  const ratio = normalized.ratio
  const knee = normalized.kneeDb
  if (normalized.dynamicsMode === 'expand') {
    if (inputDb >= threshold) return inputDb
    const expanded = threshold + (inputDb - threshold) * ratio
    if (knee <= 0 || inputDb <= threshold - knee / 2) return expanded
    const distance = threshold - inputDb
    return inputDb - (2 * (ratio - 1) * distance * distance) / knee
  }
  const compressed = threshold + (inputDb - threshold) / ratio
  if (knee <= 0) return inputDb <= threshold ? inputDb : compressed
  const lower = threshold - knee / 2
  const upper = threshold + knee / 2
  if (inputDb <= lower) return inputDb
  if (inputDb >= upper) return compressed
  const x = inputDb - lower
  return inputDb + ((1 / ratio - 1) * x * x) / (2 * knee)
}

export async function ensureCompressorWorklet(ctx: BaseAudioContext): Promise<void> {
  await loadWorkletModule(ctx, resolveWorkletModuleUrl(compressorWorklet.modulePath))
}

export function postCompressorParams(node: AudioWorkletNode, params: CompressorParamsLite) {
  node.port.postMessage({ type: 'params', params: normalizeCompressorParams(params) })
}

export function setCompressorMeteringEnabled(node: AudioWorkletNode, enabled: boolean) {
  node.port.postMessage({ type: 'metering', enabled })
}

type CompressorMeterFields = {
  type?: unknown
  inputDb?: unknown
  outputDb?: unknown
  gainReductionDb?: unknown
  thresholdDb?: unknown
}

const isCompressorMeterFields = <Value>(value: Value): value is Value & CompressorMeterFields => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isFiniteNumber = <Value>(value: Value): value is Value & number => (
  typeof value === 'number' && Number.isFinite(value)
)

export function readCompressorMeterFrame<Value>(data: Value): CompressorMeterFrame | null {
  if (!isCompressorMeterFields(data) || data.type !== 'meter') return null
  if (!isFiniteNumber(data.inputDb)) return null
  if (!isFiniteNumber(data.outputDb)) return null
  if (!isFiniteNumber(data.gainReductionDb)) return null
  if (!isFiniteNumber(data.thresholdDb)) return null
  return {
    inputDb: data.inputDb,
    outputDb: data.outputDb,
    gainReductionDb: data.gainReductionDb,
    thresholdDb: data.thresholdDb,
  }
}
