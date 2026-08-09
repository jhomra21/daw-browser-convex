import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX, untrack } from 'solid-js'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { getExportRangeDuration, type ExportRange } from '@daw-browser/audio-engine/export-range'
import { getExportAudioBitrate, getExportAudioFormatMetadata, type ExportAudioFormat } from '@daw-browser/shared'
import { getCachedSupportedExportAudioFormats, probeSupportedExportAudioFormats } from '~/lib/export-format-support'
import { useExportContext } from '~/context/export'
import type { ExportOutput } from '~/lib/export/run-export-job'
import ExportProgressStatus from '~/components/export/ExportProgressStatus'
import { createCustomExportRange, type ExportSampleRate, loadPersistedExportSettings, savePersistedExportSettings } from '~/lib/export/export-settings'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import type { WavEncodingSettings } from '@daw-browser/audio-engine/export-fidelity'
import type { StemMode } from '@daw-browser/audio-engine/export-mixdown'

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
  sidechainRoutes: ExternalSidechainRoute[]
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
}

const ExportSection: Component<{ title: string; children: JSX.Element }> = (props) => (
  <section class="grid gap-2.5">
    <div class="flex items-center gap-2">
      <div class="shrink-0 text-xs font-semibold uppercase text-muted-foreground">{props.title}</div>
      <div class="h-px flex-1 bg-border" />
    </div>
    <div class="grid gap-2">{props.children}</div>
  </section>
)

const ExportField: Component<{ label: string; labelFor?: string; children: JSX.Element }> = (props) => (
  <div class="grid gap-1.5 sm:grid-cols-2 sm:items-center sm:gap-3">
    <Show
      when={props.labelFor}
      fallback={<div class="text-xs text-muted-foreground">{props.label}</div>}
    >
      {(controlId) => <label for={controlId()} class="text-xs text-muted-foreground">{props.label}</label>}
    </Show>
    <div class="min-w-0">{props.children}</div>
  </div>
)

type ExportSelectProps = {
  id: string
  value: string | number
  onChange: JSX.EventHandler<HTMLSelectElement, Event>
  children: JSX.Element
}

const ExportSelect: Component<ExportSelectProps> = (props) => (
  <div class="relative">
    <select
      id={props.id}
      class="h-7 w-full appearance-none border border-border bg-app-surface pl-2 pr-7 text-xs text-foreground focus:border-foreground/50 focus:outline-none disabled:opacity-50"
      value={props.value}
      onChange={(event) => props.onChange(event)}
    >
      {props.children}
    </select>
    <svg
      viewBox="0 0 8 8"
      class="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
      aria-hidden="true"
    >
      <path
        d="M1 2.5 L4 5.5 L7 2.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
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
      class="flex h-7 min-w-0 items-center gap-2 whitespace-nowrap text-xs"
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
  const nativeDesktop = import.meta.env.VITE_DESKTOP === 'true'
  const persisted = loadPersistedExportSettings()
  const initialDuration = () => getExportRangeDuration(props.getTracks(), { mode: 'whole' })
  const initialRange = untrack(() => ({
    mode: props.loopEnabled ? 'loop' as const : 'whole' as const,
    startSec: props.loopEnabled ? props.loopStartSec : 0,
    lengthSec: props.loopEnabled
      ? Math.max(0.001, props.loopEndSec - props.loopStartSec)
      : initialDuration(),
  }))
  const initialRangeMode: ExportRangeMode = initialRange.mode
  const [rangeMode, setRangeMode] = createSignal<ExportRangeMode>(initialRangeMode)
  const [source, setSource] = createSignal<ExportSource>('mixdown')
  const [stemMode, setStemMode] = createSignal<StemMode>('reachable-routing')
  const [renderStartSec, setRenderStartSec] = createSignal(initialRange.startSec)
  const [renderLengthSec, setRenderLengthSec] = createSignal(initialRange.lengthSec)
  const [sampleRate, setSampleRate] = createSignal<ExportSampleRate>(persisted.render.sampleRate)
  const [numberOfChannels, setNumberOfChannels] = createSignal<1 | 2>(persisted.render.numberOfChannels)
  const [normalizationMode, setNormalizationMode] = createSignal<'none' | 'sample-peak' | 'loudness'>(persisted.render.normalization.mode)
  const [targetLufs, setTargetLufs] = createSignal(persisted.render.normalization.mode === 'loudness' ? persisted.render.normalization.targetLufs : -14)
  const [truePeakCeilingDbtp, setTruePeakCeilingDbtp] = createSignal(persisted.render.normalization.mode === 'loudness' ? persisted.render.normalization.truePeakCeilingDbtp : -1)
  const [truePeakLimiting, setTruePeakLimiting] = createSignal(persisted.render.normalization.mode === 'loudness' && persisted.render.normalization.limiting === 'true-peak')
  const [tailMode, setTailMode] = createSignal<'none' | 'fixed' | 'automatic'>(persisted.render.tail.mode)
  const [fixedTailSec, setFixedTailSec] = createSignal(persisted.render.tail.mode === 'fixed' ? persisted.render.tail.durationSec : 2)
  const [wavCodec, setWavCodec] = createSignal<'pcm-s16' | 'pcm-s24' | 'pcm-f32'>(persisted.encoding.wav.codec)
  const [wavDither, setWavDither] = createSignal<'none' | 'tpdf'>(persisted.encoding.wav.dither)
  const [mp3Bitrate, setMp3Bitrate] = createSignal(getExportAudioBitrate('mp3'))
  const [opusBitrate, setOpusBitrate] = createSignal(getExportAudioBitrate('ogg-opus'))
  const [busy, setBusy] = createSignal(false)
  const [selectedFormats, setSelectedFormats] = createSignal<ExportAudioFormat[]>(['wav'])
  const [supportedFormats, setSupportedFormats] = createSignal<ExportAudioFormat[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [outputs, setOutputs] = createSignal<readonly ExportOutput[]>([])
  const exportContext = useExportContext()
  let wasOpen = false

  createEffect(on(
    () => props.isOpen,
    (isOpen) => {
      if (isOpen && !wasOpen) {
        const mode: ExportRangeMode = props.loopEnabled ? 'loop' : 'whole'
        setRangeMode(mode)
        setRenderStartSec(props.loopEnabled ? props.loopStartSec : 0)
        setRenderLengthSec(props.loopEnabled
          ? Math.max(0.001, props.loopEndSec - props.loopStartSec)
          : initialDuration())
      }
      wasOpen = isOpen
    },
  ))

  const renderSettings = () => ({
    sampleRate: sampleRate(),
    numberOfChannels: numberOfChannels(),
    normalization: normalizationMode() === 'sample-peak'
      ? { mode: 'sample-peak' as const, targetDbfs: 0 }
      : normalizationMode() === 'loudness'
        ? {
            mode: 'loudness' as const,
            targetLufs: targetLufs(),
            truePeakCeilingDbtp: truePeakCeilingDbtp(),
            limiting: truePeakLimiting() ? 'true-peak' as const : 'off' as const,
          }
        : { mode: 'none' as const },
    tail: tailMode() === 'fixed'
      ? { mode: 'fixed' as const, durationSec: fixedTailSec() }
      : tailMode() === 'automatic'
        ? { mode: 'automatic' as const, thresholdDbfs: -60, holdSec: 1, maximumSec: 10 }
        : { mode: 'none' as const },
  })
  const wavSettings = (): WavEncodingSettings => {
    const codec = wavCodec()
    if (codec === 'pcm-f32') return { codec, dither: 'none' }
    return { codec, dither: wavDither() }
  }
  const encodingSettings = () => ({
    bitrateByFormat: { mp3: mp3Bitrate(), 'ogg-opus': opusBitrate() },
    wav: wavSettings(),
  })
  const supportRequest = createMemo(() => ({
    sampleRate: sampleRate(),
    numberOfChannels: numberOfChannels(),
    ...encodingSettings(),
  }))

  createEffect(() => {
    const request = supportRequest()
    let canceled = false
    const applySupportedFormats = (formats: ExportAudioFormat[]) => {
      if (canceled) return
      setSupportedFormats(formats)
      setSelectedFormats((selected) => {
        const supportedSelected = selected.filter((format) => formats.includes(format))
        if (supportedSelected.length === selected.length) return selected
        if (supportedSelected.length > 0) return supportedSelected
        return ['wav']
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
  const bitrateControlVisible = (format: 'mp3' | 'ogg-opus') => (
    selectedFormats().includes(format)
    || (supportedFormats() !== null && !formatSupported(format))
  )
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
  const durationSec = createMemo(() => getExportRangeDuration(props.getTracks(), currentRange()))
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
    setRangeMode('loop')
    setRenderStartSec(props.loopStartSec)
    setRenderLengthSec(Math.max(0.001, props.loopEndSec - props.loopStartSec))
  }
  const updateCustomStart = (value: number) => {
    setRenderStartSec(Number.isFinite(value) ? value : 0)
    setRangeMode('custom')
  }
  const updateCustomLength = (value: number) => {
    setRenderLengthSec(Number.isFinite(value) ? value : 0.001)
    setRangeMode('custom')
  }
  const toggleFormat = (format: ExportAudioFormat, checked: boolean) => {
    if (!formatSupported(format)) return
    setSelectedFormats((formats) => checked
      ? [...formats, format]
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
        sidechainRoutes: props.sidechainRoutes,
        ensureClipBuffer: props.ensureClipBuffer,
      }
      savePersistedExportSettings({ render: baseRequest.render, encoding: baseRequest.encoding })
      const outcome = currentSource === 'mixdown'
        ? await exportContext.enqueueTimelineExport(baseRequest)
        : currentSource === 'all-stems'
          ? await exportContext.enqueueStemExport({ ...baseRequest, stemSelection: 'all-tracks', stemMode: stemMode() })
          : await exportContext.enqueueStemExport({
            ...baseRequest,
            stemSelection: 'selected-tracks',
            stemMode: stemMode(),
            selectedTrackIds: props.selectedTrackIds,
          })
      setOutputs(outcome.outputs)
      if (outcome.type === 'error') setError(outcome.message)
      else if (outcome.type === 'canceled') setError(outcome.outputs.length > 0 ? 'Export canceled after saving completed outputs.' : 'Export canceled.')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={(open) => { if (!open) props.onClose() }}>
      <DialogContent class="w-11/12 max-w-2xl gap-3 border border-border bg-app-surface p-5 text-foreground">
        <DialogHeader class="pr-8">
          <DialogTitle class="text-base">Export Audio</DialogTitle>
          <DialogDescription class="sr-only">Configure the selection, rendering, and audio encoding.</DialogDescription>
        </DialogHeader>
        <div class="grid gap-4 py-1">
          <ExportSection title="Selection Options">
            <ExportField label="Rendered Track" labelFor="export-rendered-track">
              <ExportSelect id="export-rendered-track" value={source()} onChange={(event) => {
                const value = event.currentTarget.value
                setSource(value === 'all-stems' || value === 'selected-stems' ? value : 'mixdown')
              }}>
                <option value="mixdown">Main</option>
                <option value="all-stems" disabled={nativeDesktop}>All Individual Tracks</option>
                <option value="selected-stems" disabled={nativeDesktop || !selectedStemAvailable()}>Selected Tracks Only</option>
              </ExportSelect>
            </ExportField>
            <Show when={source() !== 'mixdown'}>
              <ExportField label="Stem Signal" labelFor="export-stem-mode">
                <ExportSelect id="export-stem-mode" value={stemMode()} onChange={(event) => {
                  const value = event.currentTarget.value
                  setStemMode(
                    value === 'dry-source' || value === 'post-track-fx' || value === 'channel-output' || value === 'full-master-contribution'
                      ? value
                      : 'reachable-routing',
                  )
                }}>
                  <option value="dry-source">Dry Source</option>
                  <option value="post-track-fx">Post Track FX</option>
                  <option value="reachable-routing">Reachable Routing</option>
                  <option value="channel-output">Group / Return Output</option>
                  <option value="full-master-contribution">Full Master Contribution</option>
                </ExportSelect>
              </ExportField>
            </Show>
            <ExportField label="Range Shortcuts">
              <div class="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="h-7 px-2"
                  aria-pressed={rangeMode() === 'whole'}
                  onClick={setWholeTimeline}
                >
                  Whole Timeline
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="h-7 px-2"
                  aria-pressed={rangeMode() === 'loop'}
                  disabled={!props.loopEnabled}
                  onClick={setLoopRegion}
                >
                  Loop Region
                </Button>
              </div>
            </ExportField>
            <ExportField label="Render Start" labelFor="export-render-start">
              <input id="export-render-start" type="number" min="0" step="0.01" class="h-7 w-full border border-border bg-app-surface px-2 text-xs text-foreground focus:border-foreground/50 focus:outline-none" value={roundExportTime(renderStartSec())} onInput={(event) => updateCustomStart(event.currentTarget.valueAsNumber)} />
            </ExportField>
            <ExportField label="Render Length" labelFor="export-render-length">
              <input id="export-render-length" type="number" min="0.001" step="0.01" class="h-7 w-full border border-border bg-app-surface px-2 text-xs text-foreground focus:border-foreground/50 focus:outline-none" value={roundExportTime(renderLengthSec())} onInput={(event) => updateCustomLength(event.currentTarget.valueAsNumber)} />
            </ExportField>
          </ExportSection>

          <ExportSection title="Rendering Options">
            <ExportField label="Sample Rate" labelFor="export-sample-rate">
              <ExportSelect id="export-sample-rate" value={sampleRate()} onChange={(event) => {
                const value = Number(event.currentTarget.value)
                setSampleRate(value === 48000 || value === 96000 ? value : 44100)
              }}>
                <option value="44100">44.1 kHz</option>
                <option value="48000">48 kHz</option>
                <option value="96000">96 kHz</option>
              </ExportSelect>
            </ExportField>
            <ExportField label="Channel Mode" labelFor="export-channel-mode">
              <ExportSelect id="export-channel-mode" value={numberOfChannels()} onChange={(event) => setNumberOfChannels(event.currentTarget.value === '1' ? 1 : 2)}>
                <option value="2">Stereo</option>
                <option value="1">Convert to Mono</option>
              </ExportSelect>
            </ExportField>
            <ExportField label="Normalization" labelFor="export-normalization">
              <ExportSelect id="export-normalization" value={normalizationMode()} onChange={(event) => {
                const value = event.currentTarget.value
                setNormalizationMode(value === 'sample-peak' || value === 'loudness' ? value : 'none')
              }}>
                <option value="none">None</option>
                <option value="sample-peak">Sample peak (0 dBFS)</option>
                <option value="loudness">Loudness</option>
              </ExportSelect>
            </ExportField>
            <Show when={normalizationMode() === 'loudness'}>
              <ExportField label="Target LUFS" labelFor="export-target-lufs">
                <input id="export-target-lufs" type="number" min="-36" max="-5" step="0.1" class="h-7 w-full border border-border bg-app-surface px-2 text-xs" value={targetLufs()} onInput={(event) => setTargetLufs(event.currentTarget.valueAsNumber)} />
              </ExportField>
              <ExportField label="True Peak Ceiling" labelFor="export-true-peak">
                <input id="export-true-peak" type="number" min="-12" max="0" step="0.1" class="h-7 w-full border border-border bg-app-surface px-2 text-xs" value={truePeakCeilingDbtp()} onInput={(event) => setTruePeakCeilingDbtp(event.currentTarget.valueAsNumber)} />
              </ExportField>
              <ExportField label="True Peak Limiter">
                <input type="checkbox" checked={truePeakLimiting()} onChange={(event) => setTruePeakLimiting(event.currentTarget.checked)} />
              </ExportField>
            </Show>
            <ExportField label="Render Tail" labelFor="export-tail">
              <ExportSelect id="export-tail" value={tailMode()} onChange={(event) => {
                const value = event.currentTarget.value
                setTailMode(value === 'fixed' || value === 'automatic' ? value : 'none')
              }}>
                <option value="none">None</option>
                <option value="fixed">Fixed</option>
                <option value="automatic">Automatic</option>
              </ExportSelect>
            </ExportField>
            <Show when={tailMode() === 'fixed'}>
              <ExportField label="Tail Duration" labelFor="export-tail-duration">
                <input id="export-tail-duration" type="number" min="0" max="60" step="0.1" class="h-7 w-full border border-border bg-app-surface px-2 text-xs" value={fixedTailSec()} onInput={(event) => setFixedTailSec(event.currentTarget.valueAsNumber)} />
              </ExportField>
            </Show>
          </ExportSection>

          <ExportSection title="Encoding Options">
            <ExportField label="WAV Depth" labelFor="export-wav-codec">
              <ExportSelect id="export-wav-codec" value={wavCodec()} onChange={(event) => {
                const value = event.currentTarget.value
                setWavCodec(value === 'pcm-s24' || value === 'pcm-f32' ? value : 'pcm-s16')
              }}>
                <option value="pcm-s16">16-bit PCM</option>
                <option value="pcm-s24">24-bit PCM</option>
                <option value="pcm-f32">32-bit Float</option>
              </ExportSelect>
            </ExportField>
            <ExportField label="WAV Dither" labelFor="export-wav-dither">
              <ExportSelect id="export-wav-dither" value={wavCodec() === 'pcm-f32' ? 'none' : wavDither()} onChange={(event) => setWavDither(event.currentTarget.value === 'tpdf' ? 'tpdf' : 'none')}>
                <option value="none">None</option>
                <option value="tpdf" disabled={wavCodec() === 'pcm-f32'}>TPDF</option>
              </ExportSelect>
            </ExportField>
            <ExportField label="Lossless">
              <div class="grid grid-cols-2 gap-x-3">
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
            </ExportField>
            <ExportField label="Compressed">
              <div class="grid grid-cols-2 gap-x-3">
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
            </ExportField>
            <Show when={bitrateControlVisible('mp3')}>
              <ExportField label="MP3 Bitrate" labelFor="export-mp3-bitrate">
                <ExportSelect id="export-mp3-bitrate" value={mp3Bitrate()} onChange={(event) => setMp3Bitrate(Number(event.currentTarget.value))}>
                  <For each={getExportAudioFormatMetadata('mp3').bitratePresets}>{(bitrate) => <option value={bitrate}>{bitrate / 1000} kbps</option>}</For>
                </ExportSelect>
              </ExportField>
            </Show>
            <Show when={bitrateControlVisible('ogg-opus')}>
              <ExportField label="Opus Bitrate" labelFor="export-opus-bitrate">
                <ExportSelect id="export-opus-bitrate" value={opusBitrate()} onChange={(event) => setOpusBitrate(Number(event.currentTarget.value))}>
                  <For each={getExportAudioFormatMetadata('ogg-opus').bitratePresets}>{(bitrate) => <option value={bitrate}>{bitrate / 1000} kbps</option>}</For>
                </ExportSelect>
              </ExportField>
            </Show>
          </ExportSection>

          <div class="border-t border-border pt-3 text-xs">
            <div class="font-medium text-foreground">Export Configuration</div>
            <div class="mt-1 leading-relaxed text-muted-foreground">
              {sourceLabel()}{source() === 'selected-stems' ? ` (${props.selectedTrackIds.length} tracks)` : ''}, {durationSec().toFixed(2)} s, {numberOfChannels() === 1 ? 'Mono' : 'Stereo'}, {sampleRate() / 1000} kHz, {normalizationMode() === 'none' ? 'Not normalized' : normalizationMode() === 'sample-peak' ? 'Sample-peak normalized' : `${targetLufs()} LUFS`}, {selectedFormatLabels() || 'No format selected'}
            </div>
          </div>

          <Show when={error()}><div aria-live="polite" class="text-sm text-red-400">{error()}</div></Show>
          <Show when={cloudOutputs().length === 1 ? cloudOutputs()[0] : undefined}>{(output) => <div aria-live="polite" class="text-sm">Saved export: <a class="text-green-400 underline" href={output().url} target="_blank">Open</a></div>}</Show>
          <Show when={cloudOutputs().length > 1}><div aria-live="polite" class="text-sm text-green-400">Saved {cloudOutputs().length} exports to cloud.</div></Show>
          <Show when={localOutputs().length === 1}><div aria-live="polite" class="text-sm text-green-400">Saved export locally: {localOutputs()[0].name}</div></Show>
          <Show when={localOutputs().length > 1}><div aria-live="polite" class="text-sm text-green-400">Saved {localOutputs().length} exports locally.</div></Show>
          <Show when={activeExportJob()}>{(job) => <div aria-live="polite" class="flex items-center gap-3 px-1 py-1 text-sm"><ExportProgressStatus job={job()} onCancel={exportContext.cancelExport} /></div>}</Show>
          <Show when={busy() && !activeExportJob()}><div aria-live="polite" class="px-1 py-1 text-sm">Preparing export...</div></Show>
          <Show when={source() !== 'mixdown'}>
            <div class="text-xs text-muted-foreground">
              {nativeDesktop ? 'Stems are unavailable in the desktop native renderer.' : 'Stems are local-only and save into a stems folder inside the folder you choose.'}
            </div>
          </Show>
        </div>
        <DialogFooter class="border-t border-border pt-3">
          <Button variant="outline" class="h-8 px-3" onClick={props.onClose} disabled={busy()}>Close</Button>
          <Button class="h-8 px-3" onClick={() => { void handleExport() }} disabled={exportDisabled()}>{busy() ? 'Queued…' : 'Render & Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ExportDialog
