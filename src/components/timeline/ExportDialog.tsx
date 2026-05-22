import { type Component, createSignal, Show } from 'solid-js'
import type { Track } from '~/types/timeline'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { renderMixdown, encodeAudioBuffer, type ExportRange } from '~/lib/export-mixdown'
import { convexClient, convexApi } from '~/lib/convex'
import { isLocalId } from '~/lib/local-ids'
import { saveBlobLocally } from '~/lib/local-export'
import { saveLocalExportMetadata } from '~/lib/local-export-metadata'
import { listLocalEffects, type LocalEffectRow } from '~/lib/local-effects'

type Props = {
  isOpen: boolean
  onClose: () => void
  tracks: Track[]
  bpm: number
  loopEnabled: boolean
  loopStartSec: number
  loopEndSec: number
  projectId?: string
  userId?: string
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
}

const ExportDialog: Component<Props> = (props) => {
  const [mode, setMode] = createSignal<'loop'|'whole'|'custom'>(props.loopEnabled ? 'loop' : 'whole')
  const [startSec, setStartSec] = createSignal(0)
  const [endSec, setEndSec] = createSignal(10)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [resultUrl, setResultUrl] = createSignal<string | null>(null)
  const [localSavedName, setLocalSavedName] = createSignal<string | null>(null)

  const applyLocalEffectRowsToFx = (fx: any, rows: LocalEffectRow[]) => {
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
    const intersects = (c: Track['clips'][number]) => {
      const clipStart = c.startSec
      const clipEnd = c.startSec + c.duration
      return clipEnd > rs && clipStart < re
    }
    const jobs: Promise<void>[] = []
    for (const t of tracks) {
      for (const c of t.clips) {
        if ((c as any).midi) continue
        if (!intersects(c)) continue
        if (!c.buffer) jobs.push(props.ensureClipBuffer(c.id, c.sampleUrl))
      }
    }
    if (jobs.length) await Promise.allSettled(jobs)
  }

  async function handleExport() {
    setError(null)
    setResultUrl(null)
    setLocalSavedName(null)
    setBusy(true)
    try {
      const range = computeRange()
      await ensureBuffersForRange(range)
      const localOnly = props.projectId ? isLocalId('project', props.projectId) : false
      const fx: any = { trackFx: {} as Record<string, { eq?: any; reverb?: any }> }
      if (localOnly && props.projectId) try {
        applyLocalEffectRowsToFx(fx, await listLocalEffects(props.projectId))
      } catch {}
      if (!localOnly && props.projectId && props.userId) try {
        const rows = await convexClient.query((convexApi as any).effects.listByRoom, {
          projectId: props.projectId,
          userId: props.userId,
        } as any).catch(() => [])
        for (const row of rows) {
          if (row?.targetType === 'master') {
            if (row.type === 'eq' && row.params) fx.masterEq = row.params
            if (row.type === 'reverb' && row.params) fx.masterReverb = row.params
            continue
          }
          const trackId = row?.trackId
          if (!trackId || !row.params) continue
          const previous = fx.trackFx[trackId] ?? {}
          if (row.type === 'eq') fx.trackFx[trackId] = { ...previous, eq: row.params }
          if (row.type === 'reverb') fx.trackFx[trackId] = { ...previous, reverb: row.params }
          if (row.type === 'arpeggiator') fx.trackFx[trackId] = { ...previous, arp: row.params }
          if (row.type === 'synth') fx.trackFx[trackId] = { ...previous, synth: row.params }
        }
      } catch {}

      const rendered = await renderMixdown({ tracks: props.tracks, bpm: props.bpm, range, fx })
      const enc = await encodeAudioBuffer(rendered)
      const fname = `mixdown_${new Date().toISOString().replace(/[-:TZ.]/g, '')}${enc.fileExtension}`
      if (localOnly) {
        await saveBlobLocally({
          blob: enc.blob,
          suggestedName: fname,
          types: [{
            description: 'WAV audio',
            accept: { [enc.mimeType]: [enc.fileExtension] },
          }],
        })
        if (props.projectId) {
          await saveLocalExportMetadata(props.projectId, {
            name: fname,
            format: 'wav',
            durationSec: enc.durationSec,
            sampleRate: enc.sampleRate,
            sizeBytes: enc.blob.size,
          })
        }
        setLocalSavedName(fname)
        return
      }
      // Upload to R2 via worker
      const rid = props.projectId
      if (!rid) throw new Error('Missing room')
      const fd = new FormData()
      fd.append('projectId', rid)
      fd.append('duration', String(enc.durationSec))
      fd.append('sampleRate', String(enc.sampleRate))
      fd.append('name', fname)
      fd.append('file', enc.blob, fname)
      const res = await fetch('/api/exports', { method: 'POST', body: fd })
      if (!res.ok) throw new Error('Upload failed')
      const data: any = await res.json().catch(() => null)
      const url = typeof data?.url === 'string' ? data.url : ''
      const key = typeof data?.key === 'string' ? data.key : ''
      const sizeBytes = typeof data?.sizeBytes === 'number' ? data.sizeBytes : undefined
      if (!url || !key) throw new Error('Invalid upload response')

      // Record in Convex
      if (props.userId) {
        try {
          await convexClient.mutation((convexApi as any).exports.create, {
            projectId: rid,
            name: fname,
            url,
            r2Key: key,
            format: 'wav',
            duration: enc.durationSec,
            sampleRate: enc.sampleRate,
            sizeBytes,
            userId: props.userId,
          })
        } catch {}
      }

      setResultUrl(url)
    } catch (err) {
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
            <select class="bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={mode()} onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as any)}>
              <option value="whole">Whole timeline</option>
              <option value="loop" disabled={!props.loopEnabled}>Loop region</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <Show when={mode() === 'custom'}>
            <div class="flex items-center gap-3">
              <label class="text-sm w-24 text-neutral-300">Start (s)</label>
              <input type="number" step="0.01" class="w-28 bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={startSec()} onInput={(e) => setStartSec(parseFloat((e.currentTarget as HTMLInputElement).value) || 0)} />
              <label class="text-sm text-neutral-300">End (s)</label>
              <input type="number" step="0.01" class="w-28 bg-neutral-900 text-neutral-100 border border-neutral-700 rounded px-2 py-1 text-sm" value={endSec()} onInput={(e) => setEndSec(parseFloat((e.currentTarget as HTMLInputElement).value) || 0)} />
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
