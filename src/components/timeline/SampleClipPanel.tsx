import { For, type Component, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { isStretchQualityWarning, type AudioEngine, type AudioStretchRenderState } from '@daw-browser/audio-engine/audio-engine'
import type { AudioWarp, Clip } from '@daw-browser/timeline-core/types'
import type { BpmDetectionService, BpmSuggestionState } from '~/lib/bpm-detection-service'
import { buildNextAudioWarp } from '~/lib/audio-warp-patch'

type SampleClipPanelProps = {
  audioEngine: AudioEngine
  sample: {
    clip: Clip
    projectBpm: number
    bpmDetection?: BpmDetectionService
    ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
    canWrite: boolean
    onWarpChange: (audioWarp: AudioWarp) => Promise<boolean> | boolean | void
  }
}

const resolveSourceBpm = (clip: Clip, projectBpm: number) => clip.audioWarp?.sourceBpm ?? projectBpm

const SampleClipPanel: Component<SampleClipPanelProps> = (props) => {
  const sourceBpm = createMemo(() => resolveSourceBpm(props.sample.clip, props.sample.projectBpm))
  const sourceBeatOffset = createMemo(() => props.sample.clip.audioWarp?.sourceBeatOffset ?? 0)
  const ratio = createMemo(() => props.sample.projectBpm / sourceBpm())
  const [renderState, setRenderState] = createSignal<AudioStretchRenderState>({ status: 'idle' })
  const [bpmState, setBpmState] = createSignal<BpmSuggestionState>({ status: 'idle' })
  const bpmFailureMessage = createMemo(() => {
    const state = bpmState()
    return state.status === 'failed' ? state.message : ''
  })
  const bpmSuggestion = createMemo(() => {
    const state = bpmState()
    return state.status === 'suggested' || state.status === 'applied' ? state : null
  })
  const stretchWarning = createMemo(() => (
    props.sample.clip.audioWarp?.enabled === true
    && props.sample.clip.audioWarp.mode === 'stretch'
    && isStretchQualityWarning(ratio())
  ))
  const stretchEnabled = createMemo(() => props.sample.clip.audioWarp?.enabled === true && props.sample.clip.audioWarp.mode === 'stretch')
  const stretchStatusText = createMemo(() => {
    if (!stretchEnabled()) return ''
    const state = renderState()
    if (state.status === 'ready') return 'Stretch render ready.'
    if (state.status === 'rendering') return 'Rendering Stretch. Re-Pitch fallback is playing until ready.'
    if (state.status === 'failed') return `Stretch render failed. Re-Pitch fallback is playing.${state.error ? ` ${state.error.message}` : ''}`
    return 'Stretch render will start on playback or export.'
  })

  createEffect(() => {
    if (!stretchEnabled()) {
      setRenderState({ status: 'idle' })
      return
    }
    props.audioEngine.ensureStretchRender(props.sample.clip)
    setRenderState(props.audioEngine.getStretchRenderState(props.sample.clip))
  })

  createEffect(() => {
    const unsubscribe = props.audioEngine.subscribeStretchRenderState(() => {
      setRenderState(props.audioEngine.getStretchRenderState(props.sample.clip))
    })
    onCleanup(unsubscribe)
  })

  createEffect(() => {
    setBpmState(props.sample.bpmDetection?.getState(props.sample.clip.id) ?? { status: 'idle' })
  })

  createEffect(() => {
    const unsubscribe = props.sample.bpmDetection?.subscribe(() => {
      setBpmState(props.sample.bpmDetection?.getState(props.sample.clip.id) ?? { status: 'idle' })
    })
    if (unsubscribe) onCleanup(unsubscribe)
  })

  const commit = (patch: Partial<AudioWarp>) => {
    const audioWarp = buildNextAudioWarp(props.sample.projectBpm, props.sample.clip.audioWarp, { sourceBpm: sourceBpm(), ...patch })
    if (audioWarp) return props.sample.onWarpChange(audioWarp)
    return false
  }

  return (
    <section class="flex min-w-72 flex-col gap-2 border border-neutral-800 bg-neutral-950 px-3 py-2 text-neutral-200">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-400">Sample</div>
          <div class="max-w-48 truncate text-sm text-neutral-100">{props.sample.clip.name}</div>
        </div>
        <label class="flex items-center gap-2 text-xs text-neutral-300">
          <input
            type="checkbox"
            checked={props.sample.clip.audioWarp?.enabled ?? false}
            disabled={!props.sample.canWrite}
            onChange={(event) => commit({ enabled: event.currentTarget.checked })}
          />
          Warp
        </label>
      </div>
      <div class="grid grid-cols-4 items-end gap-2 text-xs">
        <label class="flex flex-col gap-1 text-neutral-400">
          Source BPM
          <input
            class="h-7 w-20 border border-neutral-700 bg-neutral-900 px-2 text-neutral-100 disabled:opacity-50"
            type="number"
            min="1"
            step="0.01"
            value={sourceBpm()}
            disabled={!props.sample.canWrite}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber
              if (Number.isFinite(value) && value > 0) commit({ sourceBpm: value })
            }}
          />
        </label>
        <div class="flex flex-col gap-1 text-neutral-400">
          Project BPM
          <div class="flex h-7 w-20 items-center border border-neutral-800 bg-neutral-900 px-2 text-neutral-200">
            {props.sample.projectBpm.toFixed(2)}
          </div>
        </div>
        <div class="flex flex-col gap-1 text-neutral-400">
          Ratio
          <div class="flex h-7 w-20 items-center border border-neutral-800 bg-neutral-900 px-2 text-neutral-200">
            {ratio().toFixed(3)}x
          </div>
        </div>
        <div class="flex flex-col gap-1 text-neutral-400">
          Mode
          <select
            class="h-7 w-24 border border-neutral-700 bg-neutral-900 px-2 text-neutral-100 disabled:opacity-50"
            value={props.sample.clip.audioWarp?.mode ?? 'repitch'}
            disabled={!props.sample.canWrite}
            onChange={(event) => commit({ mode: event.currentTarget.value === 'stretch' ? 'stretch' : 'repitch' })}
          >
            <option value="repitch">Re-Pitch</option>
            <option value="stretch">Stretch</option>
          </select>
        </div>
      </div>
      {stretchWarning() && (
        <div class="text-xs text-amber-300">
          Stretch quality is best between 0.75x and 1.33x. Playback falls back to Re-Pitch until rendering is ready.
        </div>
      )}
      {stretchEnabled() && (
        <div class={renderState().status === 'failed' ? 'text-xs text-red-300' : 'text-xs text-neutral-400'}>
          {stretchStatusText()}
        </div>
      )}
      {props.sample.clip.audioWarp?.enabled === true && (
        <div class="flex items-end gap-2 border-t border-neutral-800 pt-2 text-xs">
          <label class="flex flex-col gap-1 text-neutral-400">
            Beat Offset
            <input
              class="h-7 w-24 border border-neutral-700 bg-neutral-900 px-2 text-neutral-100 disabled:opacity-50"
              type="number"
              min="-16"
              max="16"
              step="0.001"
              value={sourceBeatOffset()}
              disabled={!props.sample.canWrite}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber
                if (Number.isFinite(value)) commit({ sourceBeatOffset: value })
              }}
            />
          </label>
          {sourceBeatOffset() !== 0 && (
            <button
              class="h-7 border border-neutral-700 px-2 text-neutral-200 disabled:opacity-50"
              type="button"
              disabled={!props.sample.canWrite}
              onClick={() => commit({ sourceBeatOffset: 0 })}
            >
              Reset
            </button>
          )}
        </div>
      )}
      <div class="flex flex-col gap-1 border-t border-neutral-800 pt-2 text-xs text-neutral-400">
        <div class="flex items-center justify-between gap-2">
          <span>Auto BPM</span>
          <button
            class="border border-neutral-700 px-2 py-1 text-neutral-200 disabled:opacity-50"
            type="button"
            disabled={!props.sample.bpmDetection || bpmState().status === 'analyzing'}
            onClick={() => {
              void Promise.resolve(props.sample.ensureClipBuffer?.(props.sample.clip.id, props.sample.clip.sampleUrl)).then(() => props.sample.bpmDetection?.analyzeClip({
                clip: props.sample.clip,
                canWrite: props.sample.canWrite,
                autoApply: (audioWarp) => Promise.resolve(props.sample.onWarpChange(audioWarp)).then((value) => value !== false),
              }))
            }}
          >
            Analyze
          </button>
        </div>
        {bpmState().status === 'idle' && <div>No BPM suggestion yet.</div>}
        {bpmState().status === 'analyzing' && <div>Analyzing loop tempo…</div>}
        {bpmState().status === 'failed' && <div class="text-red-300">{bpmFailureMessage()}</div>}
        {bpmSuggestion() && (
          <div class="flex flex-col gap-1">
            <div>
              Suggested {bpmSuggestion()?.result.bpm.toFixed(2)} BPM, confidence {((bpmSuggestion()?.result.confidence ?? 0) * 100).toFixed(0)}%.
              {bpmState().status === 'applied' ? ' Applied.' : ''}
            </div>
            <div>
              Alternatives: <For each={bpmSuggestion()?.result.alternatives}>{(item, index) => (
                <span>{index() > 0 ? ', ' : ''}{item.bpm.toFixed(2)}</span>
              )}</For>
            </div>
            {bpmState().status === 'suggested' && (
              <button
                class="w-fit border border-neutral-700 px-2 py-1 text-neutral-200 disabled:opacity-50"
                type="button"
                disabled={!props.sample.canWrite}
                onClick={() => {
                  const state = bpmState()
                  if (state.status !== 'suggested') return
                  void Promise.resolve(commit({ enabled: true, sourceBpm: state.result.bpm, mode: 'stretch' })).then((value) => {
                    if (value !== false) props.sample.bpmDetection?.markApplied(props.sample.clip.id)
                  })
                }}
              >
                Apply Source BPM
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export default SampleClipPanel
