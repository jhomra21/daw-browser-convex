import { type JSX } from 'solid-js'
import EffectShell from '~/components/effects/EffectShell'
import { DraggableDeviceGraph, handleGraphKeyDelta } from '~/components/effects/draggable-device-graph'
import { DeviceToggleButton, DeviceValueStrip } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import {
  createDefaultReverbParams,
  REVERB_DECAY_SEC_MAX,
  REVERB_DECAY_SEC_MIN,
  REVERB_DIFFUSION_HIGH_CUT_HZ_MAX,
  REVERB_DIFFUSION_HIGH_CUT_HZ_MIN,
  REVERB_DIFFUSION_LOW_CUT_HZ_MAX,
  REVERB_DIFFUSION_LOW_CUT_HZ_MIN,
  REVERB_HIGH_CUT_HZ_MAX,
  REVERB_HIGH_CUT_HZ_MIN,
  REVERB_LOW_CUT_HZ_MAX,
  REVERB_LOW_CUT_HZ_MIN,
  REVERB_PRE_DELAY_MS_MAX,
  REVERB_PRE_DELAY_MS_MIN,
  REVERB_REFLECTION_MOD_AMOUNT_MS_MAX,
  REVERB_REFLECTION_MOD_AMOUNT_MS_MIN,
  REVERB_REFLECTION_MOD_RATE_HZ_MAX,
  REVERB_REFLECTION_MOD_RATE_HZ_MIN,
  type ReverbParams,
  REVERB_STEREO_WIDTH_MAX,
  REVERB_STEREO_WIDTH_MIN,
  REVERB_UNIT_PARAM_MAX,
  REVERB_UNIT_PARAM_MIN,
  REVERB_WET_MAX,
  REVERB_WET_MIN,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'

type ReverbProps = {
  params: ReverbParams
  onChange: (updates: Partial<ReverbParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const normalizeWet = (value: number) => Math.round(clamp(value, REVERB_WET_MIN, REVERB_WET_MAX) * 100) / 100
const normalizeDecay = (value: number) => Math.round(clamp(value, REVERB_DECAY_SEC_MIN, REVERB_DECAY_SEC_MAX) * 10) / 10
const normalizePreDelay = (value: number) => Math.round(clamp(value, REVERB_PRE_DELAY_MS_MIN, REVERB_PRE_DELAY_MS_MAX))
const normalizeReflectionModAmount = (value: number) => Math.round(clamp(value, REVERB_REFLECTION_MOD_AMOUNT_MS_MIN, REVERB_REFLECTION_MOD_AMOUNT_MS_MAX) * 10) / 10
const normalizeReflectionModRate = (value: number) => Math.round(clamp(value, REVERB_REFLECTION_MOD_RATE_HZ_MIN, REVERB_REFLECTION_MOD_RATE_HZ_MAX) * 100) / 100
const normalizeUnitParam = (value: number) => Math.round(clamp(value, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX) * 100) / 100
const normalizeLowCut = (value: number) => Math.round(clamp(value, REVERB_LOW_CUT_HZ_MIN, REVERB_LOW_CUT_HZ_MAX))
const normalizeHighCut = (value: number) => Math.round(clamp(value, REVERB_HIGH_CUT_HZ_MIN, REVERB_HIGH_CUT_HZ_MAX) / 100) * 100
const normalizeDiffusionLowCut = (value: number) => Math.round(clamp(value, REVERB_DIFFUSION_LOW_CUT_HZ_MIN, REVERB_DIFFUSION_LOW_CUT_HZ_MAX))
const normalizeDiffusionHighCut = (value: number) => Math.round(clamp(value, REVERB_DIFFUSION_HIGH_CUT_HZ_MIN, REVERB_DIFFUSION_HIGH_CUT_HZ_MAX) / 100) * 100
const normalizeStereoWidth = (value: number) => Math.round(clamp(value, REVERB_STEREO_WIDTH_MIN, REVERB_STEREO_WIDTH_MAX) * 100) / 100

const formatPercent = (value: number) => `${Math.round(normalizeWet(value) * 100)}%`
const formatUnitPercent = (value: number) => `${Math.round(normalizeUnitParam(value) * 100)}%`
const formatSeconds = (value: number) => `${normalizeDecay(value).toFixed(1)}s`
const formatMilliseconds = (value: number) => `${normalizePreDelay(value)}ms`
const formatReflectionMilliseconds = (value: number) => `${normalizeReflectionModAmount(value).toFixed(1)}ms`
const formatHertz = (value: number) => `${normalizeReflectionModRate(value).toFixed(2)}Hz`
const formatFrequencyWithUnit = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k Hz` : `${Math.round(value)} Hz`
const formatStereoWidth = (value: number) => `${normalizeStereoWidth(value).toFixed(2)}x`
const LOW_CUT_TOGGLE_HZ = 830
const HIGH_CUT_TOGGLE_HZ = 6000
const DIFFUSION_LOW_CUT_TOGGLE_HZ = 830
const DIFFUSION_HIGH_CUT_TOGGLE_HZ = 6000
const DEFAULT_REVERB_PARAMS = createDefaultReverbParams()

function DeviceSection(props: {
  title: string
  class?: string
  children: JSX.Element
}) {
  return (
    <div class={cn('flex min-h-0 min-w-0 flex-col bg-transparent', props.class)}>
      <div
        class="mb-1 shrink-0 overflow-hidden whitespace-nowrap pt-1 text-xs font-semibold tracking-wide text-neutral-400"
        style={{ height: '20px' }}
      >
        {props.title}
      </div>
      {props.children}
    </div>
  )
}

function ReverbGraphSection(props: {
  title: string
  class?: string
  topControls: JSX.Element
  graph: JSX.Element
  bottomControls: JSX.Element
  side?: JSX.Element
  bottomKnobs?: JSX.Element
}) {
  return (
    <DeviceSection title={props.title} class={props.class}>
      <div class={cn('grid gap-3', props.side ? 'grid-cols-[minmax(0,1fr)_4.25rem]' : 'grid-cols-1')}>
        <div class="flex min-w-0 flex-col gap-2">
          {props.topControls}
          {props.graph}
          {props.bottomControls}
        </div>
        {props.side}
      </div>
      {props.bottomKnobs}
    </DeviceSection>
  )
}

function DiffusionNetworkReadout(props: { label: string, value: string }) {
  return (
    <div class="flex flex-col gap-1 text-[11px] leading-none">
      <span class="text-neutral-400">{props.label}</span>
      <span class="font-mono text-amber-300">{props.value}</span>
    </div>
  )
}

function FilterGraph(props: {
  params: ReverbParams
  disabled: boolean
  lowCutActive: boolean
  highCutActive: boolean
  onLowCutChange: (value: number) => void
  onHighCutChange: (value: number) => void
}) {
  const lowCutX = () => 8 + clamp((props.params.lowCutHz - REVERB_LOW_CUT_HZ_MIN) / (REVERB_LOW_CUT_HZ_MAX - REVERB_LOW_CUT_HZ_MIN), 0, 1) * 46
  const highCutX = () => 74 + clamp((props.params.highCutHz - REVERB_HIGH_CUT_HZ_MIN) / (REVERB_HIGH_CUT_HZ_MAX - REVERB_HIGH_CUT_HZ_MIN), 0, 1) * 88
  const pointToLowCut = (x: number) => REVERB_LOW_CUT_HZ_MIN + (clamp((x - 8) / 46, 0, 1) * (REVERB_LOW_CUT_HZ_MAX - REVERB_LOW_CUT_HZ_MIN))
  const pointToHighCut = (x: number) => REVERB_HIGH_CUT_HZ_MIN + (clamp((x - 74) / 88, 0, 1) * (REVERB_HIGH_CUT_HZ_MAX - REVERB_HIGH_CUT_HZ_MIN))
  const onLowCutKeyDown = (event: KeyboardEvent) => handleGraphKeyDelta(event, {
    ArrowRight: () => props.onLowCutChange(props.params.lowCutHz + 10),
    ArrowUp: () => props.onLowCutChange(props.params.lowCutHz + 10),
    ArrowLeft: () => props.onLowCutChange(props.params.lowCutHz - 10),
    ArrowDown: () => props.onLowCutChange(props.params.lowCutHz - 10),
    PageUp: () => props.onLowCutChange(props.params.lowCutHz + 100),
    PageDown: () => props.onLowCutChange(props.params.lowCutHz - 100),
    Home: () => props.onLowCutChange(REVERB_LOW_CUT_HZ_MIN),
    End: () => props.onLowCutChange(REVERB_LOW_CUT_HZ_MAX),
  })
  const onHighCutKeyDown = (event: KeyboardEvent) => handleGraphKeyDelta(event, {
    ArrowRight: () => props.onHighCutChange(props.params.highCutHz + 100),
    ArrowUp: () => props.onHighCutChange(props.params.highCutHz + 100),
    ArrowLeft: () => props.onHighCutChange(props.params.highCutHz - 100),
    ArrowDown: () => props.onHighCutChange(props.params.highCutHz - 100),
    PageUp: () => props.onHighCutChange(props.params.highCutHz + 1000),
    PageDown: () => props.onHighCutChange(props.params.highCutHz - 1000),
    Home: () => props.onHighCutChange(REVERB_HIGH_CUT_HZ_MIN),
    End: () => props.onHighCutChange(REVERB_HIGH_CUT_HZ_MAX),
  })
  const filterPath = () => {
    const startY = props.lowCutActive ? 42 : 30
    const endY = props.highCutActive ? 48 : 30
    const lowCurve = props.lowCutActive
      ? `M 0 ${startY} C ${lowCutX()} ${startY} ${lowCutX()} 30 ${lowCutX() + 24} 30`
      : 'M 0 30 L 54 30'
    const highCurve = props.highCutActive
      ? `L ${highCutX() - 22} 30 C ${highCutX()} 30 ${highCutX()} ${endY} 180 ${endY}`
      : 'L 180 30'
    return `${lowCurve} ${highCurve}`
  }
  const handles = () => [
    ...(props.lowCutActive ? [{ label: 'Low cut frequency', x: lowCutX, y: () => 31, onDrag: (point: { x: number, y: number }) => props.onLowCutChange(pointToLowCut(point.x)), onKeyDown: onLowCutKeyDown }] : []),
    ...(props.highCutActive ? [{ label: 'High cut frequency', x: highCutX, y: () => 32, onDrag: (point: { x: number, y: number }) => props.onHighCutChange(pointToHighCut(point.x)), onKeyDown: onHighCutKeyDown }] : []),
  ]

  return (
    <DraggableDeviceGraph
      disabled={props.disabled}
      path={filterPath}
      handles={handles()}
    />
  )
}

function SpaceGraph(props: {
  params: ReverbParams
  disabled: boolean
  onSpaceChange: (updates: Pick<ReverbParams, 'size' | 'decaySec' | 'diffusion'>) => void
}) {
  const size = () => normalizeUnitParam(props.params.size)
  const decay = () => clamp(props.params.decaySec / REVERB_DECAY_SEC_MAX, 0, 1)
  const diffusion = () => normalizeUnitParam(props.params.diffusion)
  const firstX = () => 42 + size() * 52
  const firstY = () => 36 - diffusion() * 18
  const secondX = () => 112 + decay() * 42
  const secondY = () => 28 + diffusion() * 18
  const pointToSize = (x: number) => clamp((x - 42) / 52, 0, 1)
  const pointToDecay = (x: number) => REVERB_DECAY_SEC_MIN + (clamp((x - 112) / 42, 0, 1) * (REVERB_DECAY_SEC_MAX - REVERB_DECAY_SEC_MIN))
  const firstPointToDiffusion = (y: number) => clamp((36 - y) / 18, 0, 1)
  const secondPointToDiffusion = (y: number) => clamp((y - 28) / 18, 0, 1)
  const updateSpace = (updates: Partial<Pick<ReverbParams, 'size' | 'decaySec' | 'diffusion'>>) => props.onSpaceChange({
    size: props.params.size,
    decaySec: props.params.decaySec,
    diffusion: props.params.diffusion,
    ...updates,
  })
  const onFirstHandleKeyDown = (event: KeyboardEvent) => handleGraphKeyDelta(event, {
    ArrowRight: () => updateSpace({ size: props.params.size + 0.02 }),
    ArrowLeft: () => updateSpace({ size: props.params.size - 0.02 }),
    PageUp: () => updateSpace({ size: props.params.size + 0.1 }),
    PageDown: () => updateSpace({ size: props.params.size - 0.1 }),
    ArrowUp: () => updateSpace({ diffusion: props.params.diffusion + 0.02 }),
    ArrowDown: () => updateSpace({ diffusion: props.params.diffusion - 0.02 }),
  })
  const onSecondHandleKeyDown = (event: KeyboardEvent) => handleGraphKeyDelta(event, {
    ArrowRight: () => updateSpace({ decaySec: props.params.decaySec + 0.1 }),
    ArrowLeft: () => updateSpace({ decaySec: props.params.decaySec - 0.1 }),
    PageUp: () => updateSpace({ decaySec: props.params.decaySec + 1 }),
    PageDown: () => updateSpace({ decaySec: props.params.decaySec - 1 }),
    ArrowUp: () => updateSpace({ diffusion: props.params.diffusion + 0.02 }),
    ArrowDown: () => updateSpace({ diffusion: props.params.diffusion - 0.02 }),
  })

  return (
    <DraggableDeviceGraph
      disabled={props.disabled}
      path={() => `M 0 ${42 - size() * 12} C 38 ${28 - diffusion() * 8} 72 ${26 + size() * 10} 104 ${30 - decay() * 8} C 132 ${34 + diffusion() * 8} 152 ${40 - decay() * 8} 180 ${38 + size() * 8}`}
      handles={[
        {
          label: 'Reverb size and diffusion',
          x: firstX,
          y: firstY,
          onKeyDown: onFirstHandleKeyDown,
          onDrag: (point) => {
            props.onSpaceChange({
              size: pointToSize(point.x),
              decaySec: props.params.decaySec,
              diffusion: firstPointToDiffusion(point.y),
            })
          },
        },
        {
          label: 'Reverb decay and diffusion',
          x: secondX,
          y: secondY,
          onKeyDown: onSecondHandleKeyDown,
          onDrag: (point) => {
            props.onSpaceChange({
              size: props.params.size,
              decaySec: pointToDecay(point.x),
              diffusion: secondPointToDiffusion(point.y),
            })
          },
        },
      ]}
    />
  )
}

function DiffusionNetworkPanel(props: {
  params: ReverbParams
  disabled: boolean
  class?: string
  highCutActive: boolean
  lowCutActive: boolean
  onHighCutToggle: () => void
  onLowCutToggle: () => void
  onSpaceChange: (updates: Pick<ReverbParams, 'size' | 'decaySec' | 'diffusion'>) => void
  onDecayChange: (value: number) => void
  onDiffusionChange: (value: number) => void
  onDensityChange: (value: number) => void
}) {
  return (
    <ReverbGraphSection
      class={props.class}
      title="Diffusion Network"
      topControls={
        <div class="grid grid-cols-[3rem_minmax(5.75rem,1fr)_2.9rem] gap-1">
          <DeviceToggleButton label="High" active={props.highCutActive} disabled={props.disabled} onClick={props.onHighCutToggle} />
          <DeviceValueStrip value={formatFrequencyWithUnit(props.params.diffusionHighCutHz)} />
          <DeviceValueStrip value={props.params.density.toFixed(2)} />
        </div>
      }
      graph={
        <SpaceGraph
          params={props.params}
          disabled={props.disabled}
          onSpaceChange={props.onSpaceChange}
        />
      }
      bottomControls={
        <div class="grid grid-cols-[3rem_minmax(7.5rem,1fr)_2.9rem] gap-1">
          <DeviceToggleButton label="Low" active={props.lowCutActive} disabled={props.disabled} onClick={props.onLowCutToggle} />
          <DeviceValueStrip value={formatFrequencyWithUnit(props.params.diffusionLowCutHz)} />
          <DeviceValueStrip value={props.params.size.toFixed(2)} />
        </div>
      }
      side={
        <div class="flex flex-col justify-center gap-4">
          <DiffusionNetworkReadout label="Diffusion" value={formatUnitPercent(props.params.diffusion)} />
          <DiffusionNetworkReadout label="Scale" value={formatUnitPercent(props.params.size)} />
        </div>
      }
      bottomKnobs={
        <div class="mt-auto grid shrink-0 grid-cols-[minmax(0,1fr)_4.25rem] gap-3 pb-2 pt-3">
          <div class="-mx-2.5 flex items-center justify-between">
            <Knob
              class="w-12 px-0 py-1"
              label="Decay"
              valueLabel={formatSeconds(props.params.decaySec)}
              value={props.params.decaySec}
              resetValue={DEFAULT_REVERB_PARAMS.decaySec}
              min={REVERB_DECAY_SEC_MIN}
              max={REVERB_DECAY_SEC_MAX}
              step={0.1}
              unit="s"
              disabled={props.disabled}
              onValueChange={props.onDecayChange}
            />
            <Knob
              class="w-12 px-0 py-1"
              label="Diff"
              valueLabel={formatUnitPercent(props.params.diffusion)}
              value={props.params.diffusion}
              resetValue={DEFAULT_REVERB_PARAMS.diffusion}
              min={REVERB_UNIT_PARAM_MIN}
              max={REVERB_UNIT_PARAM_MAX}
              step={0.01}
              disabled={props.disabled}
              onValueChange={props.onDiffusionChange}
            />
            <Knob
              class="w-12 px-0 py-1"
              label="Dens"
              valueLabel={formatUnitPercent(props.params.density)}
              value={props.params.density}
              resetValue={DEFAULT_REVERB_PARAMS.density}
              min={REVERB_UNIT_PARAM_MIN}
              max={REVERB_UNIT_PARAM_MAX}
              step={0.01}
              disabled={props.disabled}
              onValueChange={props.onDensityChange}
            />
          </div>
          <div />
        </div>
      }
    />
  )
}

function EarlyReflectionsPanel(props: {
  params: ReverbParams
  disabled: boolean
  class?: string
  onSpinToggle: () => void
  onReflectChange: (value: number) => void
  onShapeChange: (value: number) => void
  onModAmountChange: (value: number) => void
  onModRateChange: (value: number) => void
}) {
  return (
    <DeviceSection title="Early Reflections" class={props.class}>
      <div class="flex pb-2">
        <DeviceToggleButton label="Spin" active={props.params.reflectionSpin} disabled={props.disabled} onClick={props.onSpinToggle} />
      </div>
      <div class="grid grid-cols-2 gap-1">
        <Knob
          class="px-1 py-1"
          label="Reflect"
          valueLabel={formatUnitPercent(props.params.reflections)}
          value={props.params.reflections}
          resetValue={DEFAULT_REVERB_PARAMS.reflections}
          min={REVERB_UNIT_PARAM_MIN}
          max={REVERB_UNIT_PARAM_MAX}
          step={0.01}
          disabled={props.disabled}
          onValueChange={props.onReflectChange}
        />
        <Knob
          class="px-1 py-1"
          label="Shape"
          valueLabel={formatUnitPercent(props.params.reflectionShape)}
          value={props.params.reflectionShape}
          resetValue={DEFAULT_REVERB_PARAMS.reflectionShape}
          min={REVERB_UNIT_PARAM_MIN}
          max={REVERB_UNIT_PARAM_MAX}
          step={0.01}
          disabled={props.disabled}
          onValueChange={props.onShapeChange}
        />
        <Knob
          class="px-1 py-1"
          label="Amount"
          valueLabel={formatReflectionMilliseconds(props.params.reflectionModAmountMs)}
          value={props.params.reflectionModAmountMs}
          resetValue={DEFAULT_REVERB_PARAMS.reflectionModAmountMs}
          min={REVERB_REFLECTION_MOD_AMOUNT_MS_MIN}
          max={REVERB_REFLECTION_MOD_AMOUNT_MS_MAX}
          step={0.1}
          unit="ms"
          disabled={props.disabled}
          onValueChange={props.onModAmountChange}
        />
        <Knob
          class="px-1 py-1"
          label="Rate"
          valueLabel={formatHertz(props.params.reflectionModRateHz)}
          value={props.params.reflectionModRateHz}
          resetValue={DEFAULT_REVERB_PARAMS.reflectionModRateHz}
          min={REVERB_REFLECTION_MOD_RATE_HZ_MIN}
          max={REVERB_REFLECTION_MOD_RATE_HZ_MAX}
          step={0.01}
          unit="Hz"
          disabled={props.disabled}
          onValueChange={props.onModRateChange}
        />
      </div>
    </DeviceSection>
  )
}

export default function Reverb(props: ReverbProps) {
  const automationRange = (parameterId: string) => props.automationRangesByParameterId?.get(parameterId)
  const touchAutomation = (parameterId: string) => props.onAutomationParameterTouch?.(parameterId)
  const updateWet = (value: number) => {
    const wet = normalizeWet(value)
    if (wet !== props.params.wet) {
      props.onManualAutomationOverride?.('reverb.wet')
      props.onChange({ wet })
    }
  }
  const updateDecay = (value: number) => {
    const decaySec = normalizeDecay(value)
    if (decaySec !== props.params.decaySec) props.onChange({ decaySec })
  }
  const updatePreDelay = (value: number) => {
    const preDelayMs = normalizePreDelay(value)
    if (preDelayMs !== props.params.preDelayMs) {
      props.onManualAutomationOverride?.('reverb.preDelayMs')
      props.onChange({ preDelayMs })
    }
  }
  const updateReflections = (value: number) => {
    const reflections = normalizeUnitParam(value)
    if (reflections !== props.params.reflections) props.onChange({ reflections })
  }
  const updateReflectionShape = (value: number) => {
    const reflectionShape = normalizeUnitParam(value)
    if (reflectionShape !== props.params.reflectionShape) props.onChange({ reflectionShape })
  }
  const updateReflectionModAmount = (value: number) => {
    const reflectionModAmountMs = normalizeReflectionModAmount(value)
    if (reflectionModAmountMs !== props.params.reflectionModAmountMs) props.onChange({ reflectionModAmountMs })
  }
  const updateReflectionModRate = (value: number) => {
    const reflectionModRateHz = normalizeReflectionModRate(value)
    if (reflectionModRateHz !== props.params.reflectionModRateHz) props.onChange({ reflectionModRateHz })
  }
  const updateDiffuse = (value: number) => {
    const diffuse = normalizeUnitParam(value)
    if (diffuse !== props.params.diffuse) props.onChange({ diffuse })
  }
  const updateDiffusion = (value: number) => {
    const diffusion = normalizeUnitParam(value)
    if (diffusion !== props.params.diffusion) props.onChange({ diffusion })
  }
  const updateDensity = (value: number) => {
    const density = normalizeUnitParam(value)
    if (density !== props.params.density) props.onChange({ density })
  }
  const updateLowCut = (value: number) => {
    const lowCutHz = normalizeLowCut(value)
    if (lowCutHz !== props.params.lowCutHz) props.onChange({ lowCutHz })
  }
  const updateHighCut = (value: number) => {
    const highCutHz = normalizeHighCut(value)
    if (highCutHz !== props.params.highCutHz) props.onChange({ highCutHz })
  }
  const updateDiffusionLowCut = (value: number) => {
    const diffusionLowCutHz = normalizeDiffusionLowCut(value)
    if (diffusionLowCutHz !== props.params.diffusionLowCutHz) props.onChange({ diffusionLowCutHz })
  }
  const updateDiffusionHighCut = (value: number) => {
    const diffusionHighCutHz = normalizeDiffusionHighCut(value)
    if (diffusionHighCutHz !== props.params.diffusionHighCutHz) props.onChange({ diffusionHighCutHz })
  }
  const updateStereoWidth = (value: number) => {
    const stereoWidth = normalizeStereoWidth(value)
    if (stereoWidth !== props.params.stereoWidth) {
      props.onManualAutomationOverride?.('reverb.stereoWidth')
      props.onChange({ stereoWidth })
    }
  }
  const updateSpace = (updates: Pick<ReverbParams, 'size' | 'decaySec' | 'diffusion'>) => {
    const size = normalizeUnitParam(updates.size)
    const decaySec = normalizeDecay(updates.decaySec)
    const diffusion = normalizeUnitParam(updates.diffusion)
    if (size === props.params.size && decaySec === props.params.decaySec && diffusion === props.params.diffusion) return
    props.onChange({ size, decaySec, diffusion })
  }
  const lowCutActive = () => props.params.lowCutHz > REVERB_LOW_CUT_HZ_MIN
  const highCutActive = () => props.params.highCutHz < REVERB_HIGH_CUT_HZ_MAX
  const toggleLowCut = () => updateLowCut(lowCutActive() ? REVERB_LOW_CUT_HZ_MIN : LOW_CUT_TOGGLE_HZ)
  const toggleHighCut = () => updateHighCut(highCutActive() ? REVERB_HIGH_CUT_HZ_MAX : HIGH_CUT_TOGGLE_HZ)
  const diffusionLowCutActive = () => props.params.diffusionLowCutHz > REVERB_DIFFUSION_LOW_CUT_HZ_MIN
  const diffusionHighCutActive = () => props.params.diffusionHighCutHz < REVERB_DIFFUSION_HIGH_CUT_HZ_MAX
  const toggleDiffusionLowCut = () => updateDiffusionLowCut(diffusionLowCutActive() ? REVERB_DIFFUSION_LOW_CUT_HZ_MIN : DIFFUSION_LOW_CUT_TOGGLE_HZ)
  const toggleDiffusionHighCut = () => updateDiffusionHighCut(diffusionHighCutActive() ? REVERB_DIFFUSION_HIGH_CUT_HZ_MAX : DIFFUSION_HIGH_CUT_TOGGLE_HZ)
  const toggleReflectionSpin = () => props.onChange({ reflectionSpin: !props.params.reflectionSpin })

  return (
    <EffectShell
      title="Reverb"
      typeLabel="Stereo"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[637px] min-w-[637px]', props.class)}
    >
      <div class={cn('grid min-h-0 flex-1 grid-cols-[115px_12px_320px_2px_112px_2px_56px] items-stretch px-2 py-3', !props.params.enabled && 'opacity-70')}>
        <ReverbGraphSection
          class="col-start-1"
          title="Input Processing"
          topControls={
            <div class="grid grid-cols-2 gap-1">
              <DeviceToggleButton label="Lo Cut" active={lowCutActive()} disabled={!props.params.enabled} onClick={toggleLowCut} />
              <DeviceToggleButton label="Hi Cut" active={highCutActive()} disabled={!props.params.enabled} onClick={toggleHighCut} />
            </div>
          }
          graph={
            <FilterGraph
              params={props.params}
              disabled={!props.params.enabled}
              lowCutActive={lowCutActive()}
              highCutActive={highCutActive()}
              onLowCutChange={updateLowCut}
              onHighCutChange={updateHighCut}
            />
          }
          bottomControls={
            <div class="grid grid-cols-2 gap-1">
              <DeviceValueStrip value={formatFrequencyWithUnit(props.params.lowCutHz)} />
              <DeviceValueStrip value={formatFrequencyWithUnit(props.params.highCutHz)} />
            </div>
          }
          bottomKnobs={
            <div class="mt-auto w-24 self-center pb-2 pt-3">
              <Knob
                class="px-1 py-1"
                label="Predelay"
                valueLabel={formatMilliseconds(props.params.preDelayMs)}
                value={props.params.preDelayMs}
                resetValue={DEFAULT_REVERB_PARAMS.preDelayMs}
                min={REVERB_PRE_DELAY_MS_MIN}
                max={REVERB_PRE_DELAY_MS_MAX}
                step={1}
                unit="ms"
                disabled={!props.params.enabled}
                automationRange={automationRange('reverb.preDelayMs')}
                automated={!!automationRange('reverb.preDelayMs')}
                onAutomationSelect={() => touchAutomation('reverb.preDelayMs')}
                onValueChange={updatePreDelay}
              />
            </div>
          }
        />

        <DiffusionNetworkPanel
          class="col-start-3"
          params={props.params}
          disabled={!props.params.enabled}
          highCutActive={diffusionHighCutActive()}
          lowCutActive={diffusionLowCutActive()}
          onHighCutToggle={toggleDiffusionHighCut}
          onLowCutToggle={toggleDiffusionLowCut}
          onSpaceChange={updateSpace}
          onDecayChange={updateDecay}
          onDiffusionChange={updateDiffusion}
          onDensityChange={updateDensity}
        />

        <EarlyReflectionsPanel
          class="col-start-5"
          params={props.params}
          disabled={!props.params.enabled}
          onSpinToggle={toggleReflectionSpin}
          onReflectChange={updateReflections}
          onShapeChange={updateReflectionShape}
          onModAmountChange={updateReflectionModAmount}
          onModRateChange={updateReflectionModRate}
        />

        <div class="col-start-7 flex min-h-0 min-w-0 translate-x-[7px] flex-col bg-transparent">
          <div class="flex min-h-0 flex-1 flex-col justify-end gap-5">
            <Knob
              class="w-14 px-0 py-1"
              label="Diffuse"
              valueLabel={formatUnitPercent(props.params.diffuse)}
              value={props.params.diffuse}
              resetValue={DEFAULT_REVERB_PARAMS.diffuse}
              min={REVERB_UNIT_PARAM_MIN}
              max={REVERB_UNIT_PARAM_MAX}
              step={0.01}
              disabled={!props.params.enabled}
              onValueChange={updateDiffuse}
            />
            <Knob
              class="w-14 px-0 py-1"
              label="Width"
              valueLabel={formatStereoWidth(props.params.stereoWidth)}
              value={props.params.stereoWidth}
              resetValue={DEFAULT_REVERB_PARAMS.stereoWidth}
              min={REVERB_STEREO_WIDTH_MIN}
              max={REVERB_STEREO_WIDTH_MAX}
              step={0.01}
              disabled={!props.params.enabled}
              automationRange={automationRange('reverb.stereoWidth')}
              automated={!!automationRange('reverb.stereoWidth')}
              onAutomationSelect={() => touchAutomation('reverb.stereoWidth')}
              onValueChange={updateStereoWidth}
            />
            <Knob
              class="w-14 px-0 py-1"
              label="Dry/Wet"
              valueLabel={formatPercent(props.params.wet)}
              value={props.params.wet}
              resetValue={DEFAULT_REVERB_PARAMS.wet}
              min={REVERB_WET_MIN}
              max={REVERB_WET_MAX}
              step={0.01}
              disabled={!props.params.enabled}
              automationRange={automationRange('reverb.wet')}
              automated={!!automationRange('reverb.wet')}
              onAutomationSelect={() => touchAutomation('reverb.wet')}
              onValueChange={updateWet}
            />
          </div>
        </div>
      </div>
    </EffectShell>
  )
}
