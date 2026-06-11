import { type Component, createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import type { ExportRange } from '@daw-browser/audio-engine/export-mixdown'
import { exportAudioFormats, getExportAudioFormatMetadata, type ExportAudioFormat } from '@daw-browser/shared'
import { getCachedSupportedExportAudioFormats, probeSupportedExportAudioFormats, retrySupportedExportAudioFormats } from '~/lib/export-format-support'
import { useExportContext } from '~/context/export'
import type { ExportOutput } from '~/lib/export/run-export-job'

type ExportMode = ExportRange['mode']
type ExportSource = 'mixdown' | 'all-stems' | 'selected-stems'

type Props = {
  isOpen: boolean
  onClose: () => void
  tracks: RuntimeTrack[]
  getTracks: () => RuntimeTrack[]
  selectedTrackId?: string
  bpm: number
  loopEnabled: boolean
  loopStartSec: number
  loopEndSec: number
  projectId?: string
  userId?: string
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
}

const ExportDialog: Component<Props> = (props) => {
  const [mode, setMode] = createSignal<ExportMode>(props.loopEnabled ? 'loop' : 'whole')
  const [source, setSource] = createSignal<ExportSource>('mixdown')
  const [startSec, setStartSec] = createSignal(0)
  const [endSec, setEndSec] = createSignal(10)
  const [busy, setBusy] = createSignal(false)
  const [selectedFormats, setSelectedFormats] = createSignal<ExportAudioFormat[]>(['wav'])
  const [supportedFormats, setSupportedFormats] = createSignal<ExportAudioFormat[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [outputs, setOutputs] = createSignal<readonly ExportOutput[]>([])
  const exportContext = useExportContext()

  createEffect(() => {
    if (!props.isOpen) return
    let canceled = false
    const applySupportedFormats = (formats: ExportAudioFormat[]) => {
      if (canceled) return
      setSupportedFormats(formats)
      setSelectedFormats((selected) => {
        const supportedSelected = selected.filter((item) => formats.includes(item))
        if (supportedSelected.length === selected.length) return selected
        if (supportedSelected.length > 0) return supportedSelected
        return formats.includes('wav') ? ['wav'] : formats.slice(0, 1)
      })
    }
    const probeSupportedFormats = (retry = false) => (
      retry ? retrySupportedExportAudioFormats() : probeSupportedExportAudioFormats()
    ).then((formats) => {
      applySupportedFormats(formats)
      return formats
    })
    const cachedSupportedFormats = getCachedSupportedExportAudioFormats()
    const hadCachedSupportedFormats = cachedSupportedFormats !== undefined
    if (cachedSupportedFormats) {
      applySupportedFormats(cachedSupportedFormats)
    } else {
      setSupportedFormats(null)
    }
    let supportProbeTimer: number | undefined
    void probeSupportedFormats().then((formats) => {
      if (canceled) return
      if (hadCachedSupportedFormats || formats.length > 1) return
      // WebCodecs support checks can settle after the dialog chunk mounts; retry once and clean it up.
      supportProbeTimer = window.setTimeout(() => {
        if (canceled) return
        void probeSupportedFormats(true)
      }, 250)
    })
    onCleanup(() => {
      canceled = true
      if (supportProbeTimer !== undefined) window.clearTimeout(supportProbeTimer)
    })
  })

  const readExportMode = (value: string): ExportMode => (
    value === 'loop' || value === 'custom' ? value : 'whole'
  )

  const readExportSource = (value: string): ExportSource => (
    value === 'all-stems' || value === 'selected-stems' ? value : 'mixdown'
  )

  const formatSupported = (format: ExportAudioFormat): boolean => (
    supportedFormats()?.includes(format) ?? format === 'wav'
  )

  const toggleFormat = (format: ExportAudioFormat, checked: boolean) => {
    if (!formatSupported(format)) return
    setSelectedFormats((formats) => {
      if (checked) return formats.includes(format) ? formats : [...formats, format]
      if (!formats.includes(format)) return formats
      return formats.filter((item) => item !== format)
    })
  }

  const exportDisabled = () => busy() || selectedFormats().length === 0
  const cloudOutputs = createMemo(() => outputs().filter((output) => output.destination === 'cloud'))
  const localOutputs = createMemo(() => outputs().filter((output) => output.destination === 'local'))

  const selectedStemAvailable = () => {
    const selectedTrack = props.tracks.find((track) => track.id === props.selectedTrackId)
    return selectedTrack !== undefined && (selectedTrack.channelRole ?? 'track') === 'track' && selectedTrack.clips.length > 0
  }

  const computeRange = (): ExportRange => {
    const m = mode()
    if (m === 'loop') {
      return { mode: 'loop', startSec: props.loopStartSec, endSec: props.loopEndSec }
    } else if (m === 'whole') {
      return { mode: 'whole' }
    }
    const s = Math.max(0, Number(startSec()) || 0)
    const e = Math.max(s + 0.001, Number(endSec()) || (s + 1))
    return { mode: 'custom', startSec: s, endSec: e }
  }

  async function handleExport() {
    setError(null)
    setOutputs([])
    setBusy(true)
    try {
      const currentSource = source()
      const baseRequest = {
        getTracks: props.getTracks,
        bpm: props.bpm,
        range: computeRange(),
        formats: selectedFormats(),
        projectId: props.projectId,
        userId: props.userId,
        ensureClipBuffer: props.ensureClipBuffer,
      }
      const outcome = currentSource === 'mixdown'
        ? await exportContext.enqueueTimelineExport(baseRequest)
        : await exportContext.enqueueStemExport({
          ...baseRequest,
          stemMode: currentSource === 'all-stems' ? 'all-tracks' : 'selected-tracks',
          selectedTrackIds: props.selectedTrackId ? [props.selectedTrackId] : [],
        })
      setOutputs(outcome.outputs)
      if (outcome.type === 'error') {
        setError(outcome.message)
      } else if (outcome.type === 'canceled') {
        setError(outcome.outputs.length > 0 ? 'Export canceled after saving completed outputs.' : 'Export canceled.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={(v) => { if (!v) props.onClose() }}>
      <DialogContent class="bg-neutral-900 text-neutral-100 border border-neutral-800">
        <DialogHeader>
          <DialogTitle>Export timeline</DialogTitle>
          <DialogDescription>Choose range. Export runs in your browser.</DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-3 py-2">
          <div class="flex items-center gap-3">
            <label class="text-sm w-24 text-neutral-300">Source</label>
            <select class="bg-neutral-900 text-neutral-100 border border-neutral-700 px-2 py-1 text-sm" value={source()} onChange={(e) => setSource(readExportSource(e.currentTarget.value))}>
              <option value="mixdown">Mixdown</option>
              <option value="all-stems">All track stems</option>
              <option value="selected-stems" disabled={!selectedStemAvailable()}>Selected track stem</option>
            </select>
          </div>
          <div class="flex items-center gap-3">
            <label class="text-sm w-24 text-neutral-300">Range</label>
            <select class="bg-neutral-900 text-neutral-100 border border-neutral-700 px-2 py-1 text-sm" value={mode()} onChange={(e) => setMode(readExportMode(e.currentTarget.value))}>
              <option value="whole">Whole timeline</option>
              <option value="loop" disabled={!props.loopEnabled}>Loop region</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div class="flex items-center gap-3">
            <label class="text-sm w-24 text-neutral-300">Formats</label>
            <div class="flex flex-wrap gap-2">
              <Show when={supportedFormats() !== null} fallback={<span class="text-sm text-neutral-300">WAV</span>}>
                <For each={exportAudioFormats}>
                  {(item) => {
                    const itemMetadata = getExportAudioFormatMetadata(item)
                    const supported = formatSupported(item)
                    const selected = () => selectedFormats().includes(item)
                    return (
                      <label class="flex items-center gap-1 border border-neutral-700 px-2 py-1 text-sm text-neutral-200">
                        <input
                          type="checkbox"
                          checked={selected()}
                          disabled={!supported}
                          onChange={(event) => toggleFormat(item, event.currentTarget.checked)}
                        />
                        <span>{supported ? itemMetadata.label : `${itemMetadata.label} unavailable`}</span>
                      </label>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
          <Show when={mode() === 'custom'}>
            <div class="flex items-center gap-3">
              <label class="text-sm w-24 text-neutral-300">Start (s)</label>
              <input type="number" step="0.01" class="w-28 bg-neutral-900 text-neutral-100 border border-neutral-700 px-2 py-1 text-sm" value={startSec()} onInput={(e) => setStartSec(parseFloat(e.currentTarget.value) || 0)} />
              <label class="text-sm text-neutral-300">End (s)</label>
              <input type="number" step="0.01" class="w-28 bg-neutral-900 text-neutral-100 border border-neutral-700 px-2 py-1 text-sm" value={endSec()} onInput={(e) => setEndSec(parseFloat(e.currentTarget.value) || 0)} />
            </div>
          </Show>
          <Show when={error()}>
            <div class="text-sm text-red-400">{error()}</div>
          </Show>
          <Show when={cloudOutputs().length === 1 ? cloudOutputs()[0] : undefined}>
            {(output) => (
              <div class="text-sm">
                Saved export: <a class="text-green-400 underline" href={output().url} target="_blank">Open</a>
              </div>
            )}
          </Show>
          <Show when={cloudOutputs().length > 1}>
            <div class="text-sm text-green-400">Saved {cloudOutputs().length} exports to cloud.</div>
          </Show>
          <Show when={localOutputs().length === 1}>
            <div class="text-sm text-green-400">Saved export locally: {localOutputs()[0].name}</div>
          </Show>
          <Show when={localOutputs().length > 1}>
            <div class="text-sm text-green-400">Saved {localOutputs().length} exports locally.</div>
          </Show>
          <Show when={source() !== 'mixdown'}>
            <div class="text-xs text-neutral-400">Stems are local-only and save into a stems folder inside the folder you choose.</div>
          </Show>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onClose()} disabled={busy()}>Close</Button>
          <Button onClick={() => { void handleExport() }} disabled={exportDisabled()}>
            {busy() ? 'Queued…' : 'Render & Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ExportDialog
