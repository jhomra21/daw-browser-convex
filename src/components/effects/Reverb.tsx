import { createSignal, createUniqueId, For, type JSX } from 'solid-js'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton, DeviceValueStrip } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import {
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
const REVERB_UPDATE_KEYS: ReadonlyArray<keyof ReverbParams> = [
  'wet',
  'decaySec',
  'preDelayMs',
  'reflections',
  'reflectionSpin',
  'reflectionModAmountMs',
  'reflectionModRateHz',
  'reflectionShape',
  'diffuse',
  'size',
  'diffusion',
  'density',
  'lowCutHz',
  'highCutHz',
  'diffusionLowCutHz',
  'diffusionHighCutHz',
  'stereoWidth',
]

function addChangedReverbParam<Key extends keyof ReverbParams>(
  changed: Partial<ReverbParams>,
  current: ReverbParams,
  updates: Partial<ReverbParams>,
  key: Key,
) {
  const value = updates[key]
  if (value !== undefined && current[key] !== value) changed[key] = value
}

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
  topControls: JSX.Element
  graph: JSX.Element
  bottomControls: JSX.Element
  side?: JSX.Element
  bottomKnobs?: JSX.Element
}) {
  return (
    <DeviceSection title={props.title}>
      <div class={cn('grid gap-2', props.side ? 'grid-cols-[minmax(0,1fr)_4.25rem]' : 'grid-cols-1')}>
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

type ReverbGraphHandle = {
  x: () => number
  y: () => number
  onDrag: (point: { x: number, y: number }) => void
}

function DraggableReverbGraph(props: {
  patternId: string
  disabled: boolean
  path: () => string
  handles: ReverbGraphHandle[]
}) {
  const [activeHandle, setActiveHandle] = createSignal<ReverbGraphHandle>()
  let graphRef: HTMLDivElement | undefined
  let dragBounds: DOMRect | undefined
  const graphPoint = (event: PointerEvent) => {
    const bounds = dragBounds ?? graphRef?.getBoundingClientRect()
    if (!bounds) return { x: 0, y: 0 }
    return {
      x: clamp(((event.clientX - bounds.left) / bounds.width) * 180, 0, 180),
      y: clamp(((event.clientY - bounds.top) / bounds.height) * 58, 0, 58),
    }
  }
  const dragActiveHandle = (event: PointerEvent) => {
    activeHandle()?.onDrag(graphPoint(event))
  }
  const endDrag = (event: PointerEvent) => {
    if (graphRef?.hasPointerCapture(event.pointerId)) {
      graphRef.releasePointerCapture(event.pointerId)
    }
    dragBounds = undefined
    setActiveHandle()
  }

  return (
    <div
      ref={(element) => (graphRef = element)}
      class="relative h-[116px] shrink-0 touch-none overflow-hidden rounded-sm border border-neutral-800 bg-neutral-950"
      onPointerMove={dragActiveHandle}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <svg
        viewBox="0 0 180 58"
        class="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <pattern id={props.patternId} width="18" height="14" patternUnits="userSpaceOnUse">
            <path d="M 18 0 L 0 0 0 14" fill="none" stroke="#262626" stroke-width="1" />
          </pattern>
        </defs>
        <rect width="180" height="58" fill={`url(#${props.patternId})`} />
        <path d={props.path()} fill="none" stroke="#fb923c" stroke-width="2" vector-effect="non-scaling-stroke" />
      </svg>
      <For each={props.handles}>
        {(handle) => (
          <button
            type="button"
            class={cn(
              'absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-cyan-300 bg-neutral-950',
              props.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-grab active:cursor-grabbing',
            )}
            style={{
              left: `${(handle.x() / 180) * 100}%`,
              top: `${(handle.y() / 58) * 100}%`,
            }}
            disabled={props.disabled}
            onPointerDown={(event) => {
              if (props.disabled) return
              dragBounds = graphRef?.getBoundingClientRect()
              graphRef?.setPointerCapture(event.pointerId)
              setActiveHandle(handle)
              handle.onDrag(graphPoint(event))
            }}
          />
        )}
      </For>
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
  const patternId = createUniqueId()
  const lowCutX = () => 8 + clamp((props.params.lowCutHz - REVERB_LOW_CUT_HZ_MIN) / (REVERB_LOW_CUT_HZ_MAX - REVERB_LOW_CUT_HZ_MIN), 0, 1) * 46
  const highCutX = () => 74 + clamp((props.params.highCutHz - REVERB_HIGH_CUT_HZ_MIN) / (REVERB_HIGH_CUT_HZ_MAX - REVERB_HIGH_CUT_HZ_MIN), 0, 1) * 88
  const pointToLowCut = (x: number) => REVERB_LOW_CUT_HZ_MIN + (clamp((x - 8) / 46, 0, 1) * (REVERB_LOW_CUT_HZ_MAX - REVERB_LOW_CUT_HZ_MIN))
  const pointToHighCut = (x: number) => REVERB_HIGH_CUT_HZ_MIN + (clamp((x - 74) / 88, 0, 1) * (REVERB_HIGH_CUT_HZ_MAX - REVERB_HIGH_CUT_HZ_MIN))
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
    ...(props.lowCutActive ? [{ x: lowCutX, y: () => 31, onDrag: (point: { x: number, y: number }) => props.onLowCutChange(pointToLowCut(point.x)) }] : []),
    ...(props.highCutActive ? [{ x: highCutX, y: () => 32, onDrag: (point: { x: number, y: number }) => props.onHighCutChange(pointToHighCut(point.x)) }] : []),
  ]

  return (
    <DraggableReverbGraph
      patternId={patternId}
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
  const patternId = createUniqueId()
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

  return (
    <DraggableReverbGraph
      patternId={patternId}
      disabled={props.disabled}
      path={() => `M 0 ${42 - size() * 12} C 38 ${28 - diffusion() * 8} 72 ${26 + size() * 10} 104 ${30 - decay() * 8} C 132 ${34 + diffusion() * 8} 152 ${40 - decay() * 8} 180 ${38 + size() * 8}`}
      handles={[
        {
          x: firstX,
          y: firstY,
          onDrag: (point) => {
            props.onSpaceChange({
              size: pointToSize(point.x),
              decaySec: props.params.decaySec,
              diffusion: firstPointToDiffusion(point.y),
            })
          },
        },
        {
          x: secondX,
          y: secondY,
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
        <div class="mt-auto grid shrink-0 grid-cols-[minmax(0,1fr)_4.25rem] gap-2 pb-2 pt-3">
          <div class="-mx-2.5 flex items-center justify-between">
            <Knob
              class="w-12 px-0 py-1"
              label="Decay"
              valueLabel={formatSeconds(props.params.decaySec)}
              value={props.params.decaySec}
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
  onSpinToggle: () => void
  onReflectChange: (value: number) => void
  onShapeChange: (value: number) => void
  onModAmountChange: (value: number) => void
  onModRateChange: (value: number) => void
}) {
  return (
    <DeviceSection title="Early Reflections">
      <div class="flex pb-2">
        <DeviceToggleButton label="Spin" active={props.params.reflectionSpin} disabled={props.disabled} onClick={props.onSpinToggle} />
      </div>
      <div class="grid grid-cols-2 gap-1">
        <Knob
          class="px-1 py-1"
          label="Reflect"
          valueLabel={formatUnitPercent(props.params.reflections)}
          value={props.params.reflections}
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
  const updateParam = (updates: Partial<ReverbParams>) => {
    const changed: Partial<ReverbParams> = {}
    for (const key of REVERB_UPDATE_KEYS) addChangedReverbParam(changed, props.params, updates, key)
    if (Object.keys(changed).length > 0) props.onChange(changed)
  }

  const updateWet = (value: number) => updateParam({ wet: normalizeWet(value) })
  const updateDecay = (value: number) => updateParam({ decaySec: normalizeDecay(value) })
  const updatePreDelay = (value: number) => updateParam({ preDelayMs: normalizePreDelay(value) })
  const updateReflections = (value: number) => updateParam({ reflections: normalizeUnitParam(value) })
  const updateReflectionShape = (value: number) => updateParam({ reflectionShape: normalizeUnitParam(value) })
  const updateReflectionModAmount = (value: number) => updateParam({ reflectionModAmountMs: normalizeReflectionModAmount(value) })
  const updateReflectionModRate = (value: number) => updateParam({ reflectionModRateHz: normalizeReflectionModRate(value) })
  const updateDiffuse = (value: number) => updateParam({ diffuse: normalizeUnitParam(value) })
  const updateDiffusion = (value: number) => updateParam({ diffusion: normalizeUnitParam(value) })
  const updateDensity = (value: number) => updateParam({ density: normalizeUnitParam(value) })
  const updateLowCut = (value: number) => updateParam({ lowCutHz: normalizeLowCut(value) })
  const updateHighCut = (value: number) => updateParam({ highCutHz: normalizeHighCut(value) })
  const updateDiffusionLowCut = (value: number) => updateParam({ diffusionLowCutHz: normalizeDiffusionLowCut(value) })
  const updateDiffusionHighCut = (value: number) => updateParam({ diffusionHighCutHz: normalizeDiffusionHighCut(value) })
  const updateStereoWidth = (value: number) => updateParam({ stereoWidth: normalizeStereoWidth(value) })
  const updateSpace = (updates: Pick<ReverbParams, 'size' | 'decaySec' | 'diffusion'>) => {
    updateParam({
      size: normalizeUnitParam(updates.size),
      decaySec: normalizeDecay(updates.decaySec),
      diffusion: normalizeUnitParam(updates.diffusion),
    })
  }
  const lowCutActive = () => props.params.lowCutHz > REVERB_LOW_CUT_HZ_MIN
  const highCutActive = () => props.params.highCutHz < REVERB_HIGH_CUT_HZ_MAX
  const toggleLowCut = () => updateLowCut(lowCutActive() ? REVERB_LOW_CUT_HZ_MIN : LOW_CUT_TOGGLE_HZ)
  const toggleHighCut = () => updateHighCut(highCutActive() ? REVERB_HIGH_CUT_HZ_MAX : HIGH_CUT_TOGGLE_HZ)
  const diffusionLowCutActive = () => props.params.diffusionLowCutHz > REVERB_DIFFUSION_LOW_CUT_HZ_MIN
  const diffusionHighCutActive = () => props.params.diffusionHighCutHz < REVERB_DIFFUSION_HIGH_CUT_HZ_MAX
  const toggleDiffusionLowCut = () => updateDiffusionLowCut(diffusionLowCutActive() ? REVERB_DIFFUSION_LOW_CUT_HZ_MIN : DIFFUSION_LOW_CUT_TOGGLE_HZ)
  const toggleDiffusionHighCut = () => updateDiffusionHighCut(diffusionHighCutActive() ? REVERB_DIFFUSION_HIGH_CUT_HZ_MAX : DIFFUSION_HIGH_CUT_TOGGLE_HZ)
  const toggleReflectionSpin = () => updateParam({ reflectionSpin: !props.params.reflectionSpin })

  return (
    <EffectShell
      title="Reverb"
      typeLabel="Stereo"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[692px] min-w-[692px]', props.class)}
    >
      <div class={cn('grid min-h-0 flex-1 grid-cols-[115px_320px_129px_72px] items-stretch gap-3 px-4 py-3', !props.params.enabled && 'opacity-70')}>
        <ReverbGraphSection
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
                min={REVERB_PRE_DELAY_MS_MIN}
                max={REVERB_PRE_DELAY_MS_MAX}
                step={1}
                unit="ms"
                disabled={!props.params.enabled}
                onValueChange={updatePreDelay}
              />
            </div>
          }
        />

        <DiffusionNetworkPanel
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
          params={props.params}
          disabled={!props.params.enabled}
          onSpinToggle={toggleReflectionSpin}
          onReflectChange={updateReflections}
          onShapeChange={updateReflectionShape}
          onModAmountChange={updateReflectionModAmount}
          onModRateChange={updateReflectionModRate}
        />

        <div class="flex min-h-0 min-w-0 flex-col bg-transparent">
          <div class="flex min-h-0 flex-1 flex-col justify-end gap-5 pb-2">
            <Knob
              class="px-1 py-1"
              label="Diffuse"
              valueLabel={formatUnitPercent(props.params.diffuse)}
              value={props.params.diffuse}
              min={REVERB_UNIT_PARAM_MIN}
              max={REVERB_UNIT_PARAM_MAX}
              step={0.01}
              disabled={!props.params.enabled}
              onValueChange={updateDiffuse}
            />
            <Knob
              class="px-1 py-1"
              label="Width"
              valueLabel={formatStereoWidth(props.params.stereoWidth)}
              value={props.params.stereoWidth}
              min={REVERB_STEREO_WIDTH_MIN}
              max={REVERB_STEREO_WIDTH_MAX}
              step={0.01}
              disabled={!props.params.enabled}
              onValueChange={updateStereoWidth}
            />
            <Knob
              class="px-1 py-1"
              label="Dry/Wet"
              valueLabel={formatPercent(props.params.wet)}
              value={props.params.wet}
              min={REVERB_WET_MIN}
              max={REVERB_WET_MAX}
              step={0.01}
              disabled={!props.params.enabled}
              onValueChange={updateWet}
            />
          </div>
        </div>
      </div>
    </EffectShell>
  )
}
