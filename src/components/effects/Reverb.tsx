import { createSignal, createUniqueId, For, type JSX } from 'solid-js'
import EffectShell from '~/components/effects/EffectShell'
import Knob from '~/components/ui/knob'
import {
  REVERB_DECAY_SEC_MAX,
  REVERB_DECAY_SEC_MIN,
  REVERB_HIGH_CUT_HZ_MAX,
  REVERB_HIGH_CUT_HZ_MIN,
  REVERB_LOW_CUT_HZ_MAX,
  REVERB_LOW_CUT_HZ_MIN,
  REVERB_PRE_DELAY_MS_MAX,
  REVERB_PRE_DELAY_MS_MIN,
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
const normalizeUnitParam = (value: number) => Math.round(clamp(value, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX) * 100) / 100
const normalizeLowCut = (value: number) => Math.round(clamp(value, REVERB_LOW_CUT_HZ_MIN, REVERB_LOW_CUT_HZ_MAX))
const normalizeHighCut = (value: number) => Math.round(clamp(value, REVERB_HIGH_CUT_HZ_MIN, REVERB_HIGH_CUT_HZ_MAX) / 100) * 100
const normalizeStereoWidth = (value: number) => Math.round(clamp(value, REVERB_STEREO_WIDTH_MIN, REVERB_STEREO_WIDTH_MAX) * 100) / 100

const formatPercent = (value: number) => `${Math.round(normalizeWet(value) * 100)}%`
const formatUnitPercent = (value: number) => `${Math.round(normalizeUnitParam(value) * 100)}%`
const formatSeconds = (value: number) => `${normalizeDecay(value).toFixed(1)}s`
const formatMilliseconds = (value: number) => `${normalizePreDelay(value)}ms`
const formatFrequencyWithUnit = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k Hz` : `${Math.round(value)} Hz`
const formatStereoWidth = (value: number) => `${normalizeStereoWidth(value).toFixed(2)}x`
const LOW_CUT_TOGGLE_HZ = 830
const HIGH_CUT_TOGGLE_HZ = 6000

function DeviceSection(props: {
  title: string
  class?: string
  children: JSX.Element
}) {
  return (
    <div class={cn('flex min-h-0 min-w-0 flex-col bg-transparent', props.class)}>
      <div class="overflow-hidden whitespace-nowrap px-1 py-1 text-xs font-semibold tracking-wide text-neutral-400">
        {props.title}
      </div>
      {props.children}
    </div>
  )
}

function ReverbKnobControl(props: {
  label: string
  valueLabel: string
  class?: string
  children: JSX.Element
}) {
  return (
    <div class={cn('flex flex-col items-center gap-1 px-1 py-1', props.class)}>
      <div class="text-[10px] leading-none text-neutral-400">{props.label}</div>
      {props.children}
      <div class="max-w-full truncate font-mono text-[10px] leading-none text-cyan-300">
        {props.valueLabel}
      </div>
    </div>
  )
}

function ReverbParameterButton(props: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class={cn(
        'whitespace-nowrap border border-neutral-700 px-1 py-1 text-center text-[10px] font-medium leading-none disabled:cursor-not-allowed disabled:opacity-50',
        props.active ? 'bg-amber-400 text-neutral-950' : 'bg-neutral-700 text-neutral-200',
      )}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

function ReverbValueBox(props: { value: string }) {
  return (
    <div class="grid grid-cols-[minmax(0,1fr)_8px] overflow-hidden border border-neutral-700 bg-neutral-300 font-mono text-[10px] leading-none text-neutral-950">
      <div class="overflow-hidden whitespace-nowrap bg-orange-400 px-1 py-1">{props.value}</div>
      <div />
    </div>
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
  onSpaceChange: (updates: Pick<ReverbParams, 'size' | 'decaySec' | 'diffusion'>) => void
  onDecayChange: (value: number) => void
  onDiffusionChange: (value: number) => void
  onDensityChange: (value: number) => void
}) {
  return (
    <DeviceSection title="Diffusion Network">
      <div class="grid grid-cols-[minmax(0,1fr)_4.25rem] gap-2 pt-1">
        <div class="min-w-0">
          <SpaceGraph
            params={props.params}
            disabled={props.disabled}
            onSpaceChange={props.onSpaceChange}
          />
        </div>

        <div class="flex flex-col justify-center gap-4">
          <DiffusionNetworkReadout label="Diffusion" value={formatUnitPercent(props.params.diffusion)} />
          <DiffusionNetworkReadout label="Scale" value={formatUnitPercent(props.params.size)} />
        </div>
      </div>

      <div class="mt-auto grid shrink-0 grid-cols-3 items-center gap-1 pb-2 pt-3">
        <ReverbKnobControl label="Decay" valueLabel={formatSeconds(props.params.decaySec)} class="px-0">
          <Knob
            value={props.params.decaySec}
            min={REVERB_DECAY_SEC_MIN}
            max={REVERB_DECAY_SEC_MAX}
            step={0.1}
            label=""
            unit="s"
            disabled={props.disabled}
            showValue={false}
            onValueChange={props.onDecayChange}
          />
        </ReverbKnobControl>
        <ReverbKnobControl label="Diff" valueLabel={formatUnitPercent(props.params.diffusion)} class="px-0">
          <Knob
            value={props.params.diffusion}
            min={REVERB_UNIT_PARAM_MIN}
            max={REVERB_UNIT_PARAM_MAX}
            step={0.01}
            label=""
            disabled={props.disabled}
            showValue={false}
            onValueChange={props.onDiffusionChange}
          />
        </ReverbKnobControl>
        <ReverbKnobControl label="Dens" valueLabel={formatUnitPercent(props.params.density)} class="px-0">
          <Knob
            value={props.params.density}
            min={REVERB_UNIT_PARAM_MIN}
            max={REVERB_UNIT_PARAM_MAX}
            step={0.01}
            label=""
            disabled={props.disabled}
            showValue={false}
            onValueChange={props.onDensityChange}
          />
        </ReverbKnobControl>
      </div>
    </DeviceSection>
  )
}

export default function Reverb(props: ReverbProps) {
  const updateParam = (updates: Partial<ReverbParams>) => {
    const changed: Partial<ReverbParams> = {}
    if (updates.wet !== undefined && props.params.wet !== updates.wet) changed.wet = updates.wet
    if (updates.decaySec !== undefined && props.params.decaySec !== updates.decaySec) changed.decaySec = updates.decaySec
    if (updates.preDelayMs !== undefined && props.params.preDelayMs !== updates.preDelayMs) changed.preDelayMs = updates.preDelayMs
    if (updates.size !== undefined && props.params.size !== updates.size) changed.size = updates.size
    if (updates.diffusion !== undefined && props.params.diffusion !== updates.diffusion) changed.diffusion = updates.diffusion
    if (updates.density !== undefined && props.params.density !== updates.density) changed.density = updates.density
    if (updates.lowCutHz !== undefined && props.params.lowCutHz !== updates.lowCutHz) changed.lowCutHz = updates.lowCutHz
    if (updates.highCutHz !== undefined && props.params.highCutHz !== updates.highCutHz) changed.highCutHz = updates.highCutHz
    if (updates.stereoWidth !== undefined && props.params.stereoWidth !== updates.stereoWidth) changed.stereoWidth = updates.stereoWidth
    if (Object.keys(changed).length > 0) props.onChange(changed)
  }

  const updateWet = (value: number) => updateParam({ wet: normalizeWet(value) })
  const updateDecay = (value: number) => updateParam({ decaySec: normalizeDecay(value) })
  const updatePreDelay = (value: number) => updateParam({ preDelayMs: normalizePreDelay(value) })
  const updateSize = (value: number) => updateParam({ size: normalizeUnitParam(value) })
  const updateDiffusion = (value: number) => updateParam({ diffusion: normalizeUnitParam(value) })
  const updateDensity = (value: number) => updateParam({ density: normalizeUnitParam(value) })
  const updateLowCut = (value: number) => updateParam({ lowCutHz: normalizeLowCut(value) })
  const updateHighCut = (value: number) => updateParam({ highCutHz: normalizeHighCut(value) })
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

  return (
    <EffectShell
      title="Reverb"
      typeLabel="Stereo"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[700px] min-w-[700px]', props.class)}
    >
      <div class={cn('grid min-h-0 flex-1 grid-cols-[115px_110px_320px_72px] items-stretch gap-3 px-4 py-3', !props.params.enabled && 'opacity-70')}>
        <DeviceSection title="Input Processing">
          <div class="grid grid-cols-2 gap-1 pb-2">
            <ReverbParameterButton label="Lo Cut" active={lowCutActive()} disabled={!props.params.enabled} onClick={toggleLowCut} />
            <ReverbParameterButton label="Hi Cut" active={highCutActive()} disabled={!props.params.enabled} onClick={toggleHighCut} />
          </div>
          <div class="flex shrink-0 flex-col gap-2">
            <FilterGraph
              params={props.params}
              disabled={!props.params.enabled}
              lowCutActive={lowCutActive()}
              highCutActive={highCutActive()}
              onLowCutChange={updateLowCut}
              onHighCutChange={updateHighCut}
            />
            <div class="grid grid-cols-2 gap-1">
              <ReverbValueBox value={formatFrequencyWithUnit(props.params.lowCutHz)} />
              <ReverbValueBox value={formatFrequencyWithUnit(props.params.highCutHz)} />
            </div>
          </div>
          <div class="mt-auto w-24 self-center pb-2 pt-3">
            <ReverbKnobControl label="Predelay" valueLabel={formatMilliseconds(props.params.preDelayMs)}>
              <Knob
                value={props.params.preDelayMs}
                min={REVERB_PRE_DELAY_MS_MIN}
                max={REVERB_PRE_DELAY_MS_MAX}
                step={1}
                label=""
                unit="ms"
                disabled={!props.params.enabled}
                showValue={false}
                onValueChange={updatePreDelay}
              />
            </ReverbKnobControl>
          </div>
        </DeviceSection>

        <DeviceSection title="Reflections">
          <div class="flex min-h-0 flex-1 items-end justify-center pb-2">
            <ReverbKnobControl label="Size" valueLabel={formatUnitPercent(props.params.size)}>
              <Knob
                value={props.params.size}
                min={REVERB_UNIT_PARAM_MIN}
                max={REVERB_UNIT_PARAM_MAX}
                step={0.01}
                label=""
                disabled={!props.params.enabled}
                showValue={false}
                onValueChange={updateSize}
              />
            </ReverbKnobControl>
          </div>
        </DeviceSection>

        <DiffusionNetworkPanel
          params={props.params}
          disabled={!props.params.enabled}
          onSpaceChange={updateSpace}
          onDecayChange={updateDecay}
          onDiffusionChange={updateDiffusion}
          onDensityChange={updateDensity}
        />

        <DeviceSection title="Mix">
          <div class="flex min-h-0 flex-1 flex-col justify-end gap-5 pb-2">
            <ReverbKnobControl label="Width" valueLabel={formatStereoWidth(props.params.stereoWidth)}>
              <Knob
                value={props.params.stereoWidth}
                min={REVERB_STEREO_WIDTH_MIN}
                max={REVERB_STEREO_WIDTH_MAX}
                step={0.01}
                label=""
                disabled={!props.params.enabled}
                showValue={false}
                onValueChange={updateStereoWidth}
              />
            </ReverbKnobControl>
            <ReverbKnobControl label="Dry/Wet" valueLabel={formatPercent(props.params.wet)}>
              <Knob
                value={props.params.wet}
                min={REVERB_WET_MIN}
                max={REVERB_WET_MAX}
                step={0.01}
                label=""
                disabled={!props.params.enabled}
                showValue={false}
                onValueChange={updateWet}
              />
            </ReverbKnobControl>
          </div>
        </DeviceSection>
      </div>
    </EffectShell>
  )
}
