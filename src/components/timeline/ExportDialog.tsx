import { type Component, createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import type { ExportRange } from '@daw-browser/audio-engine/export-mixdown'
import { getExportAudioBitrate, getExportAudioFormatMetadata, type ExportAudioFormat } from '@daw-browser/shared'
import { getCachedSupportedExportAudioFormats, probeSupportedExportAudioFormats } from '~/lib/export-format-support'
import { useExportContext } from '~/context/export'
import type { ExportOutput } from '~/lib/export/run-export-job'
import ExportProgressStatus from '~/components/export/ExportProgressStatus'
import { createCustomExportRange, getExportRangeDuration, type ExportSampleRate } from '~/lib/export/export-settings'

type ExportSource = 'mixdown' | 'all-stems' | 'selected-stems'
type ExportRangeMode = ExportRange['mode']

type Props = {
  isOpen: boolean
  onClose: () => void
  getTracks: () => RuntimeTrack[]
  selectedTrackIds: readonly string[]
  bpm: number
  masterVolume: number
  loopEnabled: boolean
  loopStartSec: number
  loopEndSec: number
  projectId?: string
  userId?: string
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
}

const ExportSection: Component<{ title: string; children: JSX.Element }> = (props) => (
  <section class="grid gap-3">
    <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</div>
    <div class="grid gap-3">{props.children}</div>
  </section>
)

const ExportField: Component<{ label: string; children: JSX.Element }> = (props) => (
  <div class="grid grid-cols-3 items-center gap-3">
    <div class="text-sm text-muted-foreground">{props.label}</div>
    <div class="col-span-2 min-w-0">{props.children}</div>
  </div>
)

const ExportFormatOption: Component<{
  format: ExportAudioFormat
  selected: boolean
  supported: boolean
  onChange: (checked: boolean) => void
}> = (props) => {
  const metadata = () => getExportAudioFormatMetadata(props.format)
  return (
    <label
      class="flex min-h-8 items-center gap-2 px-1 text-sm"
      classList={{ "text-muted-foreground": !props.supported }}
    >
      <input
        type="checkbox"
        checked={props.selected}
        disabled={!props.supported}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      {props.supported ? metadata().label : `${metadata().label} unavailable`}
    </label>
  )
}

const roundExportTime = (value: number): number => Math.round(value * 100) / 100

const ExportDialog: Component<Props> = (props) => {
  const initialDuration = () => getExportRangeDuration(props.getTracks(), { mode: 'whole' })
  const initialRangeMode: ExportRangeMode = props.loopEnabled ? 'loop' : 'whole'
  const [rangeMode, setRangeMode] = createSignal<ExportRangeMode>(initialRangeMode)
  const [source, setSource] = createSignal<ExportSource>('mixdown')
  const [renderStartSec, setRenderStartSec] = createSignal(props.loopEnabled ? props.loopStartSec : 0)
  const [renderLengthSec, setRenderLengthSec] = createSignal(props.loopEnabled
    ? Math.max(0.001, props.loopEndSec - props.loopStartSec)
    : initialDuration())
  const [sampleRate, setSampleRate] = createSignal<ExportSampleRate>(44100)
  const [numberOfChannels, setNumberOfChannels] = createSignal<1 | 2>(2)
  const [normalize, setNormalize] = createSignal(false)
  const [mp3Bitrate, setMp3Bitrate] = createSignal(getExportAudioBitrate('mp3') ?? 192000)
  const [opusBitrate, setOpusBitrate] = createSignal(getExportAudioBitrate('ogg-opus') ?? 128000)
  const [busy, setBusy] = createSignal(false)
  const [selectedFormats, setSelectedFormats] = createSignal<ExportAudioFormat[]>(['wav'])
  const [supportedFormats, setSupportedFormats] = createSignal<ExportAudioFormat[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [outputs, setOutputs] = createSignal<readonly ExportOutput[]>([])
  const exportContext = useExportContext()

  const renderSettings = () => ({
    sampleRate: sampleRate(),
    numberOfChannels: numberOfChannels(),
    normalize: normalize(),
  })
  const encodingSettings = () => ({
    bitrateByFormat: { mp3: mp3Bitrate(), 'ogg-opus': opusBitrate() },
  })
  const supportRequest = createMemo(() => ({
    ...renderSettings(),
    ...encodingSettings(),
  }))

  createEffect(() => {
    if (!props.isOpen) return
    const request = supportRequest()
    let canceled = false
    const applySupportedFormats = (formats: ExportAudioFormat[]) => {
      if (canceled) return
      setSupportedFormats(formats)
      setSelectedFormats((selected) => {
        const supportedSelected = selected.filter((format) => formats.includes(format))
        if (supportedSelected.length === selected.length) return selected
        if (supportedSelected.length > 0) return supportedSelected
        return formats.includes('wav') ? ['wav'] : formats.slice(0, 1)
      })
    }
    const cached = getCachedSupportedExportAudioFormats(request)
    if (cached) {
      applySupportedFormats(cached)
      return
    }
    setSupportedFormats(null)
    void probeSupportedExportAudioFormats(request).then(applySupportedFormats)
    onCleanup(() => { canceled = true })
  })

  const formatSupported = (format: ExportAudioFormat) => supportedFormats()?.includes(format) ?? format === 'wav'
  const selectedStemAvailable = () => props.selectedTrackIds.length > 0
  const currentRange = (): ExportRange => {
    const mode = rangeMode()
    if (mode === 'whole') return { mode }
    if (mode === 'loop') {
      return {
        mode,
        startSec: props.loopStartSec,
        endSec: props.loopEndSec,
      }
    }
    return createCustomExportRange(renderStartSec(), renderLengthSec())
  }
  const durationSec = () => getExportRangeDuration(props.getTracks(), currentRange())
  const selectedFormatLabels = () => selectedFormats().map((format) => {
    const label = getExportAudioFormatMetadata(format).label
    if (format === 'mp3') return `${label} ${mp3Bitrate() / 1000} kbps`
    if (format === 'ogg-opus') return `${label} ${opusBitrate() / 1000} kbps`
    return label
  }).join(', ')
  const sourceLabel = () => source() === 'mixdown'
    ? 'Main'
    : source() === 'all-stems' ? 'All Individual Tracks' : 'Selected Tracks Only'

  const setWholeTimeline = () => {
    setRangeMode('whole')
    setRenderStartSec(0)
    setRenderLengthSec(initialDuration())
  }
  const setLoopRegion = () => {
    if (!props.loopEnabled) return
    setRangeMode('loop')
    setRenderStartSec(props.loopStartSec)
    setRenderLengthSec(Math.max(0.001, props.loopEndSec - props.loopStartSec))
  }
  const updateCustomStart = (value: number) => {
    setRenderStartSec(value)
    setRangeMode('custom')
  }
  const updateCustomLength = (value: number) => {
    setRenderLengthSec(value)
    setRangeMode('custom')
  }
  const toggleFormat = (format: ExportAudioFormat, checked: boolean) => {
    if (!formatSupported(format)) return
    setSelectedFormats((formats) => checked
      ? formats.includes(format) ? formats : [...formats, format]
      : formats.filter((item) => item !== format))
  }

  const cloudOutputs = createMemo(() => outputs().filter((output) => output.destination === 'cloud'))
  const localOutputs = createMemo(() => outputs().filter((output) => output.destination === 'local'))
  const activeExportJob = () => exportContext.activeJob()
  const exportDisabled = () => (
    busy()
    || selectedFormats().length === 0
    || selectedFormats().some((format) => !formatSupported(format))
    || (source() === 'selected-stems' && !selectedStemAvailable())
  )

  async function handleExport() {
    setError(null)
    setOutputs([])
    setBusy(true)
    try {
      const currentSource = source()
      const baseRequest = {
        getTracks: props.getTracks,
        bpm: props.bpm,
        masterVolume: props.masterVolume,
        range: currentRange(),
        formats: selectedFormats(),
        render: renderSettings(),
        encoding: encodingSettings(),
        projectId: props.projectId,
        userId: props.userId,
        ensureClipBuffer: props.ensureClipBuffer,
      }
      const outcome = currentSource === 'mixdown'
        ? await exportContext.enqueueTimelineExport(baseRequest)
        : await exportContext.enqueueStemExport({
          ...baseRequest,
          stemMode: currentSource === 'all-stems' ? 'all-tracks' : 'selected-tracks',
          selectedTrackIds: props.selectedTrackIds,
        })
      setOutputs(outcome.outputs)
      if (outcome.type === 'error') setError(outcome.message)
      else if (outcome.type === 'canceled') setError(outcome.outputs.length > 0 ? 'Export canceled after saving completed outputs.' : 'Export canceled.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={(open) => { if (!open) props.onClose() }}>
      <DialogContent class="max-w-3xl border border-border bg-app-surface text-foreground">
        <DialogHeader>
          <DialogTitle>Export Audio</DialogTitle>
          <DialogDescription>Configure the selection, rendering, and audio encoding.</DialogDescription>
        </DialogHeader>
        <div class="grid gap-6 py-2">
          <ExportSection title="Selection Options">
            <ExportField label="Rendered Track">
              <select class="w-full border border-border bg-app-surface px-2 py-1 text-sm text-foreground disabled:opacity-50" value={source()} onChange={(event) => {
                const value = event.currentTarget.value
                setSource(value === 'all-stems' || value === 'selected-stems' ? value : 'mixdown')
              }}>
                <option value="mixdown">Main</option>
                <option value="all-stems">All Individual Tracks</option>
                <option value="selected-stems" disabled={!selectedStemAvailable()}>Selected Tracks Only</option>
              </select>
            </ExportField>
            <ExportField label="Range Shortcuts">
              <div class="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={setWholeTimeline}>Whole Timeline</Button>
                <Button type="button" variant="outline" size="sm" disabled={!props.loopEnabled} onClick={setLoopRegion}>Loop Region</Button>
              </div>
            </ExportField>
            <ExportField label="Render Start">
              <input type="number" min="0" step="0.01" class="w-full border border-border bg-app-surface px-2 py-1 text-sm text-foreground" value={roundExportTime(renderStartSec())} onInput={(event) => updateCustomStart(event.currentTarget.valueAsNumber)} />
            </ExportField>
            <ExportField label="Render Length">
              <input type="number" min="0.001" step="0.01" class="w-full border border-border bg-app-surface px-2 py-1 text-sm text-foreground" value={roundExportTime(renderLengthSec())} onInput={(event) => updateCustomLength(event.currentTarget.valueAsNumber)} />
            </ExportField>
          </ExportSection>

          <ExportSection title="Rendering Options">
            <ExportField label="Sample Rate">
              <select class="w-full border border-border bg-app-surface px-2 py-1 text-sm text-foreground disabled:opacity-50" value={sampleRate()} onChange={(event) => {
                const value = Number(event.currentTarget.value)
                setSampleRate(value === 48000 || value === 96000 ? value : 44100)
              }}>
                <option value="44100">44.1 kHz</option>
                <option value="48000">48 kHz</option>
                <option value="96000">96 kHz</option>
              </select>
            </ExportField>
            <ExportField label="Channel Mode">
              <select class="w-full border border-border bg-app-surface px-2 py-1 text-sm text-foreground disabled:opacity-50" value={numberOfChannels()} onChange={(event) => setNumberOfChannels(event.currentTarget.value === '1' ? 1 : 2)}>
                <option value="2">Stereo</option>
                <option value="1">Convert to Mono</option>
              </select>
            </ExportField>
            <ExportField label="Normalize">
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={normalize()} onChange={(event) => setNormalize(event.currentTarget.checked)} />
                Normalize peak level to 0 dBFS
              </label>
            </ExportField>
          </ExportSection>

          <ExportSection title="Encoding Options">
            <div class="grid gap-2">
              <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Lossless</div>
              <div class="grid grid-cols-2 gap-x-6">
                <ExportFormatOption
                  format="wav"
                  selected={selectedFormats().includes('wav')}
                  supported={formatSupported('wav')}
                  onChange={(checked) => toggleFormat('wav', checked)}
                />
                <ExportFormatOption
                  format="flac"
                  selected={selectedFormats().includes('flac')}
                  supported={formatSupported('flac')}
                  onChange={(checked) => toggleFormat('flac', checked)}
                />
              </div>
            </div>
            <div class="grid gap-2">
              <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Compressed</div>
              <div class="grid grid-cols-2 gap-x-6">
                <ExportFormatOption
                  format="mp3"
                  selected={selectedFormats().includes('mp3')}
                  supported={formatSupported('mp3')}
                  onChange={(checked) => toggleFormat('mp3', checked)}
                />
                <ExportFormatOption
                  format="ogg-opus"
                  selected={selectedFormats().includes('ogg-opus')}
                  supported={formatSupported('ogg-opus')}
                  onChange={(checked) => toggleFormat('ogg-opus', checked)}
                />
              </div>
            </div>
            <Show when={selectedFormats().includes('mp3') && formatSupported('mp3')}>
              <ExportField label="MP3 Bitrate">
                <select class="w-full border border-border bg-app-surface px-2 py-1 text-sm text-foreground disabled:opacity-50" value={mp3Bitrate()} onChange={(event) => setMp3Bitrate(Number(event.currentTarget.value))}>
                  <For each={getExportAudioFormatMetadata('mp3').bitratePresets}>{(bitrate) => <option value={bitrate}>{bitrate / 1000} kbps</option>}</For>
                </select>
              </ExportField>
            </Show>
            <Show when={selectedFormats().includes('ogg-opus') && formatSupported('ogg-opus')}>
              <ExportField label="Opus Bitrate">
                <select class="w-full border border-border bg-app-surface px-2 py-1 text-sm text-foreground disabled:opacity-50" value={opusBitrate()} onChange={(event) => setOpusBitrate(Number(event.currentTarget.value))}>
                  <For each={getExportAudioFormatMetadata('ogg-opus').bitratePresets}>{(bitrate) => <option value={bitrate}>{bitrate / 1000} kbps</option>}</For>
                </select>
              </ExportField>
            </Show>
          </ExportSection>

          <div class="text-sm">
            <div class="font-medium">Export Configuration</div>
            <div class="mt-1 text-muted-foreground">
              {sourceLabel()}{source() === 'selected-stems' ? ` (${props.selectedTrackIds.length} tracks)` : ''}, {durationSec().toFixed(2)} s, {numberOfChannels() === 1 ? 'Mono' : 'Stereo'}, {sampleRate() / 1000} kHz, {normalize() ? 'Normalized' : 'Not normalized'}, {selectedFormatLabels() || 'No format selected'}
            </div>
          </div>

          <Show when={error()}><div aria-live="polite" class="text-sm text-red-400">{error()}</div></Show>
          <Show when={cloudOutputs().length === 1 ? cloudOutputs()[0] : undefined}>{(output) => <div aria-live="polite" class="text-sm">Saved export: <a class="text-green-400 underline" href={output().url} target="_blank">Open</a></div>}</Show>
          <Show when={cloudOutputs().length > 1}><div aria-live="polite" class="text-sm text-green-400">Saved {cloudOutputs().length} exports to cloud.</div></Show>
          <Show when={localOutputs().length === 1}><div aria-live="polite" class="text-sm text-green-400">Saved export locally: {localOutputs()[0].name}</div></Show>
          <Show when={localOutputs().length > 1}><div aria-live="polite" class="text-sm text-green-400">Saved {localOutputs().length} exports locally.</div></Show>
          <Show when={activeExportJob()}>{(job) => <div aria-live="polite" class="flex items-center gap-3 px-1 py-1 text-sm"><ExportProgressStatus job={job()} onCancel={exportContext.cancelExport} /></div>}</Show>
          <Show when={busy() && !activeExportJob()}><div aria-live="polite" class="px-1 py-1 text-sm">Preparing export...</div></Show>
          <Show when={source() !== 'mixdown'}><div class="text-xs text-muted-foreground">Stems are local-only and save into a stems folder inside the folder you choose.</div></Show>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={busy()}>Close</Button>
          <Button onClick={() => { void handleExport() }} disabled={exportDisabled()}>{busy() ? 'Queued…' : 'Render & Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ExportDialog
