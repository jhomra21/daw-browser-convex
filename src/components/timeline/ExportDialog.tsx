import { type Component, createSignal, Show } from 'solid-js'
import type { Track } from '~/types/timeline'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { renderMixdown, encodeAudioBuffer, type ExportRange } from '~/lib/export-mixdown'
import { convexClient, convexApi } from '~/lib/convex'

type Props = {
  isOpen: boolean
  onClose: () => void
  tracks: Track[]
  bpm: number
  loopEnabled: boolean
  loopStartSec: number
  loopEndSec: number
  roomId?: string
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
    setBusy(true)
    try {
      const range = computeRange()
      await ensureBuffersForRange(range)
      // Fetch effects (master + per-track) from Convex
      const fx: any = { trackFx: {} as Record<string, { eq?: any; reverb?: any }> }
      try {
        if (props.roomId) {
          const [mEq, mRv] = await Promise.all([
            convexClient.query((convexApi as any).effects.getEqForMaster, { roomId: props.roomId } as any).catch(() => null),
            convexClient.query((convexApi as any).effects.getReverbForMaster, { roomId: props.roomId } as any).catch(() => null),
          ])
          if (mEq?.params) fx.masterEq = mEq.params
          if (mRv?.params) fx.masterReverb = mRv.params
        }
        const perTrack = await Promise.all(props.tracks.map(async (t) => {
          const [eqRow, rvRow, arpRow, synthRow] = await Promise.all([
            convexClient.query((convexApi as any).effects.getEqForTrack, { trackId: t.id as any } as any).catch(() => null),
            convexClient.query((convexApi as any).effects.getReverbForTrack, { trackId: t.id as any } as any).catch(() => null),
            convexClient.query((convexApi as any).effects.getArpeggiatorForTrack, { trackId: t.id as any } as any).catch(() => null),
            convexClient.query((convexApi as any).effects.getSynthForTrack, { trackId: t.id as any } as any).catch(() => null),
          ])
          return [t.id, { eq: eqRow?.params, reverb: rvRow?.params, arp: arpRow?.params, synth: synthRow?.params }] as const
        }))
        for (const [id, vals] of perTrack) fx.trackFx[id] = vals
      } catch {}

      const rendered = await renderMixdown({ tracks: props.tracks, bpm: props.bpm, range, fx })
      const enc = await encodeAudioBuffer(rendered)
      // Upload to R2 via worker
      const rid = props.roomId
      if (!rid) throw new Error('Missing room')
      const fd = new FormData()
      fd.append('roomId', rid)
      fd.append('duration', String(enc.durationSec))
      fd.append('sampleRate', String(enc.sampleRate))
      const fname = `mixdown_${new Date().toISOString().replace(/[-:TZ.]/g, '')}${enc.fileExtension}`
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
            roomId: rid,
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
