import { type Component, createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import type { ExportRange } from '@daw-browser/audio-engine/export-mixdown'
import type { ArpParams, EqParamsLite, ReverbParamsLite, SynthParamsInput } from '@daw-browser/shared'
import { convexClient, convexApi } from '~/lib/convex'
import { exportAudioFormats, formatExportFileTimestamp, getExportAudioFormatMetadata, isExportAudioFormat, isLocalId, type ExportAudioFormat } from '@daw-browser/shared'
import { chooseLocalExportFile, createLocalExportTarget, createLocalExportWritable, saveBlobLocally } from '~/lib/local-export'
import { saveLocalExportMetadata } from '~/lib/local-export-metadata'
import { listLocalEffects, type LocalEffectRow } from '~/lib/local-effects'
import { isAbortError } from '~/lib/dom-errors'
import type { FunctionReturnType } from 'convex/server'

type ExportMode = ExportRange['mode']
type ExportFx = {
  masterEq?: EqParamsLite
  masterReverb?: ReverbParamsLite
  trackFx: Record<string, { eq?: EqParamsLite; reverb?: ReverbParamsLite; arp?: ArpParams; synth?: SynthParamsInput }>
}
type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number]
type ExportUploadResponse = {
  url?: unknown
  key?: unknown
  sizeBytes?: unknown
}

let cachedSupportedExportAudioFormats: ExportAudioFormat[] | undefined
let supportedExportAudioFormatsPromise: Promise<ExportAudioFormat[]> | undefined

const probeSupportedExportAudioFormats = (): Promise<ExportAudioFormat[]> => {
  if (cachedSupportedExportAudioFormats) return Promise.resolve(cachedSupportedExportAudioFormats)
  if (supportedExportAudioFormatsPromise) return supportedExportAudioFormatsPromise
  const supportPromise = import('@daw-browser/audio-engine/export-audio-support').then((exportAudioSupport) => (
    exportAudioSupport.getSupportedExportAudioFormats()
  )).then((formats) => {
    cachedSupportedExportAudioFormats = formats
    return formats
  }).catch(() => {
    const fallbackFormats = ['wav'] satisfies ExportAudioFormat[]
    supportedExportAudioFormatsPromise = undefined
    return fallbackFormats
  })
  supportedExportAudioFormatsPromise = supportPromise
  return supportPromise
}

const retrySupportedExportAudioFormats = (): Promise<ExportAudioFormat[]> => {
  supportedExportAudioFormatsPromise = undefined
  cachedSupportedExportAudioFormats = undefined
  return probeSupportedExportAudioFormats()
}

type Props = {
  isOpen: boolean
  onClose: () => void
  tracks: RuntimeTrack[]
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
  const [startSec, setStartSec] = createSignal(0)
  const [endSec, setEndSec] = createSignal(10)
  const [busy, setBusy] = createSignal(false)
  const [format, setFormat] = createSignal<ExportAudioFormat>('wav')
  const [supportedFormats, setSupportedFormats] = createSignal<ExportAudioFormat[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [resultUrl, setResultUrl] = createSignal<string | null>(null)
  const [localSavedName, setLocalSavedName] = createSignal<string | null>(null)

  createEffect(() => {
    if (!props.isOpen) return
    let canceled = false
    const applySupportedFormats = (formats: ExportAudioFormat[]) => {
      if (canceled) return
      setSupportedFormats(formats)
      if (!formats.includes(format())) setFormat('wav')
    }
    const probeSupportedFormats = (retry = false) => (
      retry ? retrySupportedExportAudioFormats() : probeSupportedExportAudioFormats()
    ).then((formats) => {
      applySupportedFormats(formats)
      return formats
    })
    const hadCachedSupportedFormats = cachedSupportedExportAudioFormats !== undefined
    if (cachedSupportedExportAudioFormats) {
      applySupportedFormats(cachedSupportedExportAudioFormats)
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

  const applyLocalEffectRowsToFx = (fx: ExportFx, rows: LocalEffectRow[]) => {
    for (const row of rows) {
      if (row.effect === 'master-eq') {
        fx.masterEq = row.params
        continue
      }
      if (row.effect === 'master-reverb') {
        fx.masterReverb = row.params
        continue
      }
      const previous = fx.trackFx[row.targetId] ?? {}
      if (row.effect === 'eq') fx.trackFx[row.targetId] = { ...previous, eq: row.params }
      if (row.effect === 'reverb') fx.trackFx[row.targetId] = { ...previous, reverb: row.params }
      if (row.effect === 'arp') fx.trackFx[row.targetId] = { ...previous, arp: row.params }
      if (row.effect === 'synth') fx.trackFx[row.targetId] = { ...previous, synth: row.params }
    }
  }

  const applyRoomEffectRowsToFx = (fx: ExportFx, rows: RoomEffectRow[]) => {
    for (const row of rows) {
      if (row.targetType === 'master') {
        if (row.type === 'eq' && row.params) fx.masterEq = row.params
        if (row.type === 'reverb' && row.params) fx.masterReverb = row.params
        continue
      }
      const trackId = row.trackId
      if (!trackId || !row.params) continue
      const previous = fx.trackFx[trackId] ?? {}
      if (row.type === 'eq') fx.trackFx[trackId] = { ...previous, eq: row.params }
      if (row.type === 'reverb') fx.trackFx[trackId] = { ...previous, reverb: row.params }
      if (row.type === 'arpeggiator') fx.trackFx[trackId] = { ...previous, arp: row.params }
      if (row.type === 'synth') fx.trackFx[trackId] = { ...previous, synth: row.params }
    }
  }

  const readExportUploadResponse = (value: unknown): ExportUploadResponse => (
    value !== null && typeof value === 'object' ? value : {}
  )

  const readExportMode = (value: string): ExportMode => (
    value === 'loop' || value === 'custom' ? value : 'whole'
  )

  const readExportFormat = (value: string): ExportAudioFormat => (
    isExportAudioFormat(value) ? value : 'wav'
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

  async function ensureBuffersForRange(range: ExportRange) {
    const { tracks } = props
    let rs = 0, re = 0
    if (range.mode === 'whole') {
      rs = 0
      re = tracks.reduce((m, t) => Math.max(m, ...t.clips.map(c => c.startSec + c.duration)), 0)
    } else {
      rs = range.startSec; re = range.endSec
    }
    const intersects = (c: RuntimeClip) => {
      const clipStart = c.startSec
      const clipEnd = c.startSec + c.duration
      return clipEnd > rs && clipStart < re
    }
    const jobs: Promise<void>[] = []
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.midi) continue
        if (!intersects(c)) continue
        if (!c.buffer) jobs.push(props.ensureClipBuffer(c.id, c.sampleUrl))
      }
    }
    await Promise.all(jobs)
  }

  async function handleExport() {
    setError(null)
    setResultUrl(null)
    setLocalSavedName(null)
    setBusy(true)
    try {
      const range = computeRange()
      const selectedFormat = format()
      const metadata = getExportAudioFormatMetadata(selectedFormat)
      const fname = `mixdown_${formatExportFileTimestamp(new Date())}${metadata.fileExtension}`
      const localOnly = props.projectId ? isLocalId('project', props.projectId) : false
      const saveTypes = [{
        description: `${metadata.label} audio`,
        accept: { [metadata.mimeType]: [metadata.fileExtension] },
      }]
      const localFileHandle = localOnly
        ? await chooseLocalExportFile({ suggestedName: fname, types: saveTypes })
        : undefined
      const savedName = localFileHandle?.name ?? fname
      const mixdownModule = import('@daw-browser/audio-engine/export-mixdown')
      const effectsPromise = async (): Promise<ExportFx> => {
        const fx: ExportFx = { trackFx: {} }
        if (localOnly && props.projectId) try {
          applyLocalEffectRowsToFx(fx, await listLocalEffects(props.projectId))
        } catch {}
        if (!localOnly && props.projectId && props.userId) try {
          const rows = await convexClient.query(convexApi.effects.listByRoom, {
            projectId: props.projectId,
          })
          applyRoomEffectRowsToFx(fx, rows)
        } catch {}
        return fx
      }
      const [exportMixdown, , fx] = await Promise.all([mixdownModule, ensureBuffersForRange(range), effectsPromise()])
      const { encodeAudioBuffer, renderMixdown } = exportMixdown
      const rendered = await renderMixdown({ tracks: props.tracks, bpm: props.bpm, range, fx })
      const localWritable = localFileHandle ? await createLocalExportWritable(localFileHandle) : undefined
      const enc = await encodeAudioBuffer(rendered, {
        format: selectedFormat,
        target: localWritable ? createLocalExportTarget(localWritable) : { mode: 'buffer' },
      })
      if (localOnly) {
        if (!localWritable) {
          if (!enc.blob) throw new Error('Export did not produce a downloadable file.')
          await saveBlobLocally({
            blob: enc.blob,
            suggestedName: fname,
            types: saveTypes,
          })
        }
        if (props.projectId) {
          await saveLocalExportMetadata(props.projectId, {
            name: savedName,
            format: enc.format,
            durationSec: enc.durationSec,
            sampleRate: enc.sampleRate,
            sizeBytes: enc.sizeBytes,
          })
        }
        setLocalSavedName(savedName)
        return
      }
      const rid = props.projectId
      if (!rid) throw new Error('Missing room')
      const fd = new FormData()
      fd.append('projectId', rid)
      fd.append('duration', String(enc.durationSec))
      fd.append('sampleRate', String(enc.sampleRate))
      fd.append('format', enc.format)
      fd.append('name', fname)
      if (!enc.blob) throw new Error('Export did not produce an uploadable file.')
      fd.append('file', enc.blob, fname)
      const res = await fetch('/api/exports', { method: 'POST', body: fd })
      if (!res.ok) throw new Error('Upload failed')
      const data = readExportUploadResponse(await res.json().catch(() => null))
      const url = typeof data.url === 'string' ? data.url : ''
      const key = typeof data.key === 'string' ? data.key : ''
      const sizeBytes = typeof data.sizeBytes === 'number' ? data.sizeBytes : undefined
      if (!url || !key) throw new Error('Invalid upload response')

      if (props.userId) {
        try {
          await convexClient.mutation(convexApi.exports.create, {
            projectId: rid,
            name: fname,
            url,
            r2Key: key,
            format: enc.format,
            duration: enc.durationSec,
            sampleRate: enc.sampleRate,
            sizeBytes,
          })
        } catch {}
      }

      setResultUrl(url)
    } catch (err) {
      if (isAbortError(err)) return
      setError(err instanceof Error ? err.message : 'Export failed')
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onClose()} disabled={busy()}>Close</Button>
          <Button onClick={() => { void handleExport() }} disabled={busy()}>
            {busy() ? 'Rendering…' : 'Render & Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ExportDialog
