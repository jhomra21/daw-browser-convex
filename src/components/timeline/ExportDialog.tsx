import { type Component, createEffect, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import type { ExportRange } from '@daw-browser/audio-engine/export-mixdown'
import { exportAudioFormats, getExportAudioFormatMetadata, isExportAudioFormat, type ExportAudioFormat } from '@daw-browser/shared'
import { getCachedSupportedExportAudioFormats, probeSupportedExportAudioFormats, retrySupportedExportAudioFormats } from '~/lib/export-format-support'
import { useExportContext } from '~/context/export'
import { exportPresets } from '~/lib/export/export-presets'

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
  const [format, setFormat] = createSignal<ExportAudioFormat>('wav')
  const [supportedFormats, setSupportedFormats] = createSignal<ExportAudioFormat[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [resultUrl, setResultUrl] = createSignal<string | null>(null)
  const [localSavedName, setLocalSavedName] = createSignal<string | null>(null)
  const exportContext = useExportContext()

  createEffect(() => {
    if (!props.isOpen) return
    let canceled = false
    const applySupportedFormats = (formats: ExportAudioFormat[]) => {
      if (canceled) return
      setSupportedFormats(formats)
      if (!formats.includes(untrack(format))) setFormat('wav')
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

  const readExportFormat = (value: string): ExportAudioFormat => (
    isExportAudioFormat(value) ? value : 'wav'
  )

  const readExportSource = (value: string): ExportSource => (
    value === 'all-stems' || value === 'selected-stems' ? value : 'mixdown'
  )

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
    setResultUrl(null)
    setLocalSavedName(null)
    setBusy(true)
    try {
      const currentSource = source()
      const baseRequest = {
        tracks: props.tracks,
        getTracks: props.getTracks,
        bpm: props.bpm,
        range: computeRange(),
        format: format(),
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
      if (outcome.type === 'success') {
        setResultUrl(outcome.url ?? null)
        setLocalSavedName(outcome.localSavedName ?? null)
      } else if (outcome.type === 'error') {
        setError(outcome.message)
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
            <select class="bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={source()} onChange={(e) => setSource(readExportSource(e.currentTarget.value))}>
              <option value="mixdown">Mixdown</option>
              <option value="all-stems">All track stems</option>
              <option value="selected-stems" disabled={!props.selectedTrackId}>Selected track stem</option>
            </select>
          </div>
          <div class="flex items-center gap-3">
            <label class="text-sm w-24 text-neutral-300">Range</label>
            <select class="bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={mode()} onChange={(e) => setMode(readExportMode(e.currentTarget.value))}>
              <option value="whole">Whole timeline</option>
              <option value="loop" disabled={!props.loopEnabled}>Loop region</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div class="flex items-center gap-3">
            <label class="text-sm w-24 text-neutral-300">Format</label>
            <select class="bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={format()} onChange={(e) => setFormat(readExportFormat(e.currentTarget.value))}>
              <Show when={supportedFormats() !== null} fallback={<option value="wav">WAV</option>}>
                <For each={exportAudioFormats}>
                  {(item) => {
                    const itemMetadata = getExportAudioFormatMetadata(item)
                    const supported = supportedFormats()?.includes(item) ?? false
                    return (
                      <option value={item} disabled={supported ? undefined : true}>
                        {supported ? itemMetadata.label : `${itemMetadata.label} unavailable`}
                      </option>
                    )
                  }}
                </For>
              </Show>
            </select>
          </div>
          <div class="flex items-center gap-3">
            <label class="text-sm w-24 text-neutral-300">Preset</label>
            <select
              class="bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm"
              value=""
              onChange={(event) => {
                const preset = exportPresets.find((item) => item.id === event.currentTarget.value)
                if (preset) setFormat(preset.format)
                event.currentTarget.value = ''
              }}
            >
              <option value="">Choose preset…</option>
              <For each={exportPresets}>
                {(preset) => (
                  <option value={preset.id} disabled={supportedFormats()?.includes(preset.format) ? undefined : true}>
                    {supportedFormats()?.includes(preset.format) ? preset.name : `${preset.name} unavailable`}
                  </option>
                )}
              </For>
            </select>
          </div>
          <Show when={mode() === 'custom'}>
            <div class="flex items-center gap-3">
              <label class="text-sm w-24 text-neutral-300">Start (s)</label>
              <input type="number" step="0.01" class="w-28 bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={startSec()} onInput={(e) => setStartSec(parseFloat(e.currentTarget.value) || 0)} />
              <label class="text-sm text-neutral-300">End (s)</label>
              <input type="number" step="0.01" class="w-28 bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={endSec()} onInput={(e) => setEndSec(parseFloat(e.currentTarget.value) || 0)} />
            </div>
          </Show>
          <Show when={error()}>
            <div class="text-sm text-red-400">{error()}</div>
          </Show>
          <Show when={resultUrl()}>
            <div class="text-sm">
              Saved export: <a class="text-green-400 underline" href={resultUrl()!} target="_blank">Open</a>
            </div>
          </Show>
          <Show when={localSavedName()}>
            <div class="text-sm text-green-400">Saved export locally: {localSavedName()}</div>
          </Show>
          <Show when={source() !== 'mixdown'}>
            <div class="text-xs text-neutral-400">Stems are local-only and save into a stems folder inside the folder you choose.</div>
          </Show>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onClose()} disabled={busy()}>Close</Button>
          <Button onClick={() => { void handleExport() }} disabled={busy()}>
            {busy() ? 'Queued…' : 'Render & Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ExportDialog
