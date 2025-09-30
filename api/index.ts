import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuth, type Session } from '../auth'
import { streamText } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { z } from 'zod'
import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../convex/_generated/api'
import { CommandsEnvelopeSchema } from '../src/lib/agent-commands'
import { asPositiveIndex, trackAtIndex as trackAtIndexImpl, clipAtIndex, clipsFromIndices, normalizeTrackIndices } from './indexing'

type Variables = {
  user: Session['user'] | null;
  session: Session['session'] | null;
}

const app = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>()

// CORS middleware must be registered before routes
app.use('/api/auth/*', cors({
  origin: (origin) => origin || '*', // Allow all origins for now, restrict in production
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// Session middleware - adds user and session to context
app.use('*', async (c, next) => {
  // Skip auth middleware for auth routes to avoid circular calls
  if (c.req.path.startsWith('/api/auth/')) {
    return next();
  }

  try {
    const auth = createAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      c.set('user', null);
      c.set('session', null);
    } else {
      c.set('user', session.user);
      c.set('session', session.session);
    }
  } catch (error) {
    console.error('Session middleware error:', error);
    c.set('user', null);
    c.set('session', null);
  }

  return next();
});

// Better Auth routes - use on() method as recommended
app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

app.get('/api/test', (c) => c.text('Hono!'))

// Session endpoint to check current user
app.get('/api/session', (c) => {
  const session = c.get('session');
  const user = c.get('user');

  if (!user) {
    return c.json({ user: null, session: null }, 200);
  }

  return c.json({ session, user });
})

// Execute JSON commands (no tool-calls path)
app.post('/api/agent/execute', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const body = await c.req.json().catch(() => null) as any
    if (!body || typeof body.roomId !== 'string' || !body.commands) {
      return c.json({ error: 'Invalid body' }, 400)
    }
    const roomId: string = body.roomId
    const parsed = CommandsEnvelopeSchema.safeParse({ commands: body.commands })
    if (!parsed.success) {
      return c.json({ error: 'Invalid commands', issues: parsed.error.issues }, 400)
    }
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)

    // Shared index helpers
    const trackAtIndex = (value: any): any | undefined => trackAtIndexImpl(trackList, value)

    const results: any[] = []
    for (const cmd of parsed.data.commands) {
      try {
        switch (cmd.type) {
          case 'createTrack': {
            const id = await convex.mutation(convexApi.tracks.create as any, {
              roomId,
              userId: (user as any).id,
              kind: cmd.kind,
            } as any)
            results.push({ type: cmd.type, trackId: id })
            // Refresh track list for subsequent commands using indices
            const updated: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            trackList.splice(0, trackList.length, ...updated)
            break
          }
          case 'addSampleClips': {
            const query = String((cmd as any).sampleQuery || '').trim().toLowerCase()
            if (!query) { results.push({ type: cmd.type, error: 'Missing sampleQuery' }); break }
            // Resolve or create destination track
            let targetIdx = asPositiveIndex((cmd as any).trackIndex) ?? -1
            if (targetIdx < 0) {
              const tid = await convex.mutation(convexApi.tracks.create as any, { roomId, userId: (user as any).id, kind: 'audio' } as any)
              const updated: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
              trackList.splice(0, trackList.length, ...updated)
              targetIdx = trackList.findIndex(t => String(t._id) === String(tid))
            }
            const targetTrack = targetIdx >= 0 ? trackList?.[targetIdx] : undefined
            if (!targetTrack) { results.push({ type: cmd.type, error: 'Target track not found' }); break }

            // Find a sample in this room
            const allSamples: any[] = await convex.query(convexApi.samples.listByRoom as any, { roomId } as any)
            const norm = (s: string | undefined) => (s || '').toLowerCase()
            const stop = new Set(['sample','samples','the','a','some','beat','pattern','with','using','in','on','of'])
            const tokens = query.split(/[^a-z0-9]+/g).map(t => t.trim()).filter(t => t && !stop.has(t))
            const pick = (() => {
              if (!allSamples.length) return null
              // Score by token overlap across name+url
              let best: any = null
              let bestScore = -1
              for (const s of allSamples) {
                const hay = `${norm(s.name)} ${norm(s.url)}`
                const score = tokens.length ? tokens.filter(t => hay.includes(t)).length : (hay.includes(query) ? 1 : 0)
                if (score > bestScore) { best = s; bestScore = score }
              }
              return bestScore > 0 ? best : null
            })()
            if (!pick) { results.push({ type: cmd.type, error: 'Sample not found in project' }); break }

            // Placement calculation
            const startSec = (typeof (cmd as any).startSec === 'number') ? Math.max(0, Number((cmd as any).startSec)) : 0
            const bpm = (typeof (cmd as any).bpm === 'number') ? Math.max(20, Math.min(300, Number((cmd as any).bpm))) : 120
            const beatSec = 60 / bpm
            const pattern = (cmd as any).pattern as 'fourOnFloor'|'everyBeat'|'everyHalf'|undefined
            let count = (typeof (cmd as any).count === 'number') ? Math.max(1, Math.floor(Number((cmd as any).count))) : undefined
            const baseDur = (typeof pick.duration === 'number' && isFinite(pick.duration) && pick.duration > 0) ? pick.duration : beatSec // reasonable default if unknown
            let intervalSec: number | undefined = (typeof (cmd as any).intervalSec === 'number') ? Math.max(0, Number((cmd as any).intervalSec)) : undefined
            if (!intervalSec && pattern) {
              switch (pattern) {
                case 'fourOnFloor': intervalSec = beatSec; if (!count) count = 4; break
                case 'everyBeat': intervalSec = beatSec; break
                case 'everyHalf': intervalSec = beatSec / 2; break
              }
            }
            if (!intervalSec) {
              // Place back-to-back if multiple
              intervalSec = baseDur
            }
            if (!count) count = 1

            const items = Array.from({ length: count }).map((_, i) => ({
              roomId,
              trackId: targetTrack._id,
              startSec: startSec + i * (intervalSec as number),
              duration: baseDur,
              userId: (user as any).id,
              name: pick.name ?? 'Sample',
              sampleUrl: pick.url,
            }))
            const created: any[] = await convex.mutation(convexApi.clips.createMany as any, { items } as any)
            results.push({ type: cmd.type, ok: true, created: (created?.length ?? 0) })
            break
          }
          case 'setTrackVolume': {
            const provided = (cmd as any).trackIndex
            const fallbackTrack = (provided === undefined || provided === null) && trackList && trackList.length
              ? trackList[trackList.length - 1]
              : undefined
            const t = trackAtIndex(provided) ?? fallbackTrack
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            await convex.mutation(convexApi.tracks.setVolume as any, { trackId: t._id, volume: cmd.volume } as any)
            results.push({ type: cmd.type, ok: true })
            break
          }
          case 'addMidiClip': {
            const t = trackAtIndex((cmd as any).trackIndex)
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            if ((t.kind ?? 'audio') !== 'instrument') { results.push({ type: cmd.type, error: 'Not an instrument track' }); break }
            const clipId = await convex.mutation(convexApi.clips.create as any, {
              roomId,
              trackId: t._id,
              startSec: cmd.startSec,
              duration: cmd.duration,
              userId: (user as any).id,
              name: 'MIDI Clip',
            } as any)
            await convex.mutation(convexApi.clips.setMidi as any, {
              clipId,
              midi: { wave: cmd.wave ?? 'sawtooth', gain: cmd.gain, notes: cmd.notes ?? [] },
              userId: (user as any).id,
            } as any)
            results.push({ type: cmd.type, clipId })
            break
          }
          case 'setEqParams': {
            if (cmd.target === 'master') {
              await convex.mutation(convexApi.effects.setMasterEqParams as any, { roomId, userId: (user as any).id, params: { enabled: cmd.enabled, bands: cmd.bands } } as any)
              results.push({ type: cmd.type, ok: true })
            } else {
              const t = trackAtIndex((cmd as any).target)
              if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
              await convex.mutation(convexApi.effects.setEqParams as any, { roomId, trackId: t._id, userId: (user as any).id, params: { enabled: cmd.enabled, bands: cmd.bands } } as any)
              results.push({ type: cmd.type, ok: true })
            }
            break
          }
          case 'setReverbParams': {
            const params = { enabled: cmd.enabled, wet: cmd.wet, decaySec: cmd.decaySec, preDelayMs: cmd.preDelayMs }
            if (cmd.target === 'master') {
              await convex.mutation(convexApi.effects.setMasterReverbParams as any, { roomId, userId: (user as any).id, params } as any)
              results.push({ type: cmd.type, ok: true })
            } else {
              const t = trackAtIndex((cmd as any).target)
              if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
              await convex.mutation(convexApi.effects.setReverbParams as any, { roomId, trackId: t._id, userId: (user as any).id, params } as any)
              results.push({ type: cmd.type, ok: true })
            }
            break
          }
          case 'setSynthParams': {
            const t = trackAtIndex((cmd as any).trackIndex)
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            if ((t.kind ?? 'audio') !== 'instrument') { results.push({ type: cmd.type, error: 'Not an instrument track' }); break }
            await convex.mutation(convexApi.effects.setSynthParams as any, { roomId, trackId: t._id, userId: (user as any).id, params: { wave: cmd.wave, gain: cmd.gain, attackMs: cmd.attackMs, releaseMs: cmd.releaseMs } } as any)
            results.push({ type: cmd.type, ok: true })
            break
          }
          case 'deleteTrack': {
            const t = trackAtIndex((cmd as any).trackIndex)
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            await convex.mutation(convexApi.tracks.remove as any, { trackId: t._id, userId: (user as any).id } as any)
            const updated: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            const stillExists = updated.some(u => String(u._id) === String(t._id))
            trackList.splice(0, trackList.length, ...updated)
            results.push(stillExists ? { type: cmd.type, error: 'Not owner or failed to delete' } : { type: cmd.type, ok: true })
            break
          }
          case 'moveClip': {
            const fromTrack = trackAtIndex((cmd as any).fromTrackIndex)
            if (!fromTrack) { results.push({ type: cmd.type, error: 'Source track not found' }); break }
            // Find a clip
            const allClips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const clipsOnSource = allClips.filter(c => String(c.trackId) === String(fromTrack._id))
            clipsOnSource.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0))
            const clip = (() => {
              const direct = clipAtIndex(clipsOnSource, (cmd as any).clipIndex)
              if (direct) return direct
              const afterSec = (cmd as any).clipAtOrAfterSec as number | undefined
              if (typeof afterSec === 'number') return clipsOnSource.find(c => c.startSec >= afterSec)
              return clipsOnSource[0]
            })()
            if (!clip) { results.push({ type: cmd.type, error: 'No clip found on source track' }); break }
            const toTrack = trackAtIndex((cmd as any).toTrackIndex)
            // Compatibility check when moving across tracks
            if (toTrack) {
              const targetIsInstr = (toTrack.kind ?? 'audio') === 'instrument'
              const isMidi = !!(clip as any).midi
              if (isMidi && !targetIsInstr) { results.push({ type: cmd.type, error: 'Cannot move MIDI to audio track' }); break }
              if (!isMidi && targetIsInstr) { results.push({ type: cmd.type, error: 'Cannot move audio clip to instrument track' }); break }
            }
            await convex.mutation(convexApi.clips.move as any, { clipId: clip._id, startSec: cmd.newStartSec, toTrackId: toTrack?._id } as any)
            // Basic verification: re-read clip list and ensure clip is at expected destination/time
            const afterClips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const updatedClip = afterClips.find(c => String(c._id) === String(clip._id))
            const ok = !!updatedClip && (
              (typeof (cmd as any).newStartSec !== 'number' || Math.abs((updatedClip.startSec ?? 0) - (cmd as any).newStartSec) < 1e-6) &&
              (!toTrack || String(updatedClip.trackId) === String(toTrack._id))
            )
            results.push(ok ? { type: cmd.type, ok: true, clipId: clip._id } : { type: cmd.type, error: 'Move did not apply' })
            break
          }
          case 'removeClip': {
            const t = trackAtIndex((cmd as any).trackIndex)
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            const allClips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const clipsOnTrack = allClips.filter(c => String(c.trackId) === String(t._id))
            clipsOnTrack.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0))
            const clip = (() => {
              const direct = clipAtIndex(clipsOnTrack, (cmd as any).clipIndex)
              if (direct) return direct
              const afterSec = (cmd as any).clipAtOrAfterSec as number | undefined
              if (typeof afterSec === 'number') return clipsOnTrack.find(c => c.startSec >= afterSec)
              return clipsOnTrack[0]
            })()
            if (!clip) { results.push({ type: cmd.type, error: 'Clip not found' }); break }
            await convex.mutation(convexApi.clips.remove as any, { clipId: clip._id, userId: (user as any).id } as any)
            // Verify removal
            const after: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const still = after.some(c => String(c._id) === String(clip._id))
            results.push(still ? { type: cmd.type, error: 'Not owner or failed to delete' } : { type: cmd.type, ok: true })
            break
          }
          case 'setArpeggiatorParams': {
            const t = trackAtIndex((cmd as any).trackIndex)
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            if ((t.kind ?? 'audio') !== 'instrument') { results.push({ type: cmd.type, error: 'Not an instrument track' }); break }
            await convex.mutation(convexApi.effects.setArpeggiatorParams as any, { roomId, trackId: t._id, userId: (user as any).id, params: { enabled: cmd.enabled, pattern: cmd.pattern, rate: cmd.rate, octaves: cmd.octaves, gate: cmd.gate, hold: cmd.hold } } as any)
            results.push({ type: cmd.type, ok: true })
            break
          }
          case 'setTiming': {
            const t = trackAtIndex((cmd as any).trackIndex)
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            const allClips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const clipsOnTrack = allClips.filter(c => String(c.trackId) === String(t._id))
            clipsOnTrack.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0))
            const clip = (() => {
              const direct = clipAtIndex(clipsOnTrack, (cmd as any).clipIndex)
              if (direct) return direct
              const afterSec = (cmd as any).clipAtOrAfterSec as number | undefined
              if (typeof afterSec === 'number') return clipsOnTrack.find(c => c.startSec >= afterSec)
              return clipsOnTrack[0]
            })()
            if (!clip) { results.push({ type: cmd.type, error: 'Clip not found' }); break }
            await convex.mutation(convexApi.clips.setTiming as any, { clipId: clip._id, startSec: cmd.startSec, duration: cmd.duration, leftPadSec: cmd.leftPadSec } as any)
            results.push({ type: cmd.type, ok: true })
            break
          }
          case 'moveClips': {
            const fromTrack = trackAtIndex((cmd as any).fromTrackIndex)
            if (!fromTrack) { results.push({ type: cmd.type, error: 'Source track not found' }); break }
            const explicitTo = trackAtIndex((cmd as any).toTrackIndex)
            const fallbackTo = (cmd as any).toTrackIndex == null && trackList && trackList.length ? trackList[trackList.length - 1] : undefined
            const toTrack = explicitTo ?? fallbackTo
            const allClips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const sourceClips = allClips.filter(c => String(c.trackId) === String(fromTrack._id)).sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0))
            const sel = (() => {
              const idxs = (cmd as any).clipIndices as number[] | undefined
              const fromIndices = clipsFromIndices(sourceClips, idxs)
              if (fromIndices.length) return fromIndices
              const rs = (cmd as any).rangeStartSec as number | undefined
              const re = (cmd as any).rangeEndSec as number | undefined
              if (typeof rs === 'number' && typeof re === 'number') return sourceClips.filter(c => c.startSec >= rs && c.startSec < re)
              const after = (cmd as any).clipAtOrAfterSec as number | undefined
              const count = (cmd as any).count as number | undefined
              if (typeof after === 'number') {
                const arr = sourceClips.filter(c => c.startSec >= after)
                return typeof count === 'number' ? arr.slice(0, count) : arr
              }
              return typeof count === 'number' ? sourceClips.slice(0, count) : sourceClips
            })()
            if (!sel.length) { results.push({ type: cmd.type, error: 'No clips selected' }); break }

            // Compatibility check for cross-track moves
            const targetTrack = toTrack ?? fromTrack
            const targetIsInstr = (targetTrack.kind ?? 'audio') === 'instrument'
            let incompatibleReason: string | null = null
            for (const c of sel) {
              const isMidi = !!(c as any).midi
              if (isMidi && !targetIsInstr) { incompatibleReason = 'Cannot move MIDI to audio track'; break }
              if (!isMidi && targetIsInstr) { incompatibleReason = 'Cannot move audio clip to instrument track'; break }
            }
            if (incompatibleReason) { results.push({ type: cmd.type, error: incompatibleReason }); break }
            const base = sel[0].startSec
            const baseStart = (cmd as any).newStartSec as number | undefined
            const keepRel = (cmd as any).keepRelativePositions as boolean | undefined
            for (const c of sel) {
              const newStart = (typeof baseStart === 'number')
                ? ((keepRel !== false) ? (baseStart + (c.startSec - base)) : baseStart)
                : c.startSec
              await convex.mutation(convexApi.clips.move as any, { clipId: c._id, startSec: newStart, toTrackId: toTrack?._id } as any)
            }
            results.push({ type: cmd.type, ok: true, moved: sel.length })
            break
          }
          case 'copyClips': {
            const fromTrack = trackAtIndex((cmd as any).fromTrackIndex)
            // Allow omitting toTrackIndex: default to most recently created track
            const explicitTo = trackAtIndex((cmd as any).toTrackIndex)
            const fallbackTo = (cmd as any).toTrackIndex == null && trackList && trackList.length ? trackList[trackList.length - 1] : undefined
            const toTrack = explicitTo ?? fallbackTo
            if (!fromTrack || !toTrack) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            const allClips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const sourceClips = allClips.filter(c => String(c.trackId) === String(fromTrack._id)).sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0))
            const sel = (() => {
              const idxs = (cmd as any).clipIndices as number[] | undefined
              const fromIndices = clipsFromIndices(sourceClips, idxs)
              if (fromIndices.length) return fromIndices
              const rs = (cmd as any).rangeStartSec as number | undefined
              const re = (cmd as any).rangeEndSec as number | undefined
              if (typeof rs === 'number' && typeof re === 'number') return sourceClips.filter(c => c.startSec >= rs && c.startSec < re)
              const after = (cmd as any).clipAtOrAfterSec as number | undefined
              const count = (cmd as any).count as number | undefined
              if (typeof after === 'number') {
                const arr = sourceClips.filter(c => c.startSec >= after)
                return typeof count === 'number' ? arr.slice(0, count) : arr
              }
              return typeof count === 'number' ? sourceClips.slice(0, count) : sourceClips
            })()
            if (!sel.length) { results.push({ type: cmd.type, error: 'No clips selected' }); break }
            const targetIsInstr = (toTrack.kind ?? 'audio') === 'instrument'
            const base = sel[0].startSec
            const startAt = (cmd as any).startAtSec as number | undefined
            const keepRel = (cmd as any).keepRelativePositions as boolean | undefined
            const items = sel.flatMap(c => {
              const isMidi = !!(c as any).midi
              if (isMidi && !targetIsInstr) return [] as any[]
              if (!isMidi && targetIsInstr) return [] as any[]
              const newStart = (typeof startAt === 'number') ? ((keepRel !== false) ? (startAt + (c.startSec - base)) : startAt) : c.startSec
              const item: any = {
                roomId,
                trackId: toTrack._id,
                startSec: newStart,
                duration: c.duration,
                userId: (user as any).id,
                name: c.name,
                sampleUrl: (c as any).sampleUrl,
                leftPadSec: (c as any).leftPadSec,
              }
              if ((c as any).midi) item.midi = (c as any).midi
              return [item]
            })
            if (!items.length) { results.push({ type: cmd.type, error: 'No compatible clips to copy' }); break }
            const ids = await convex.mutation(convexApi.clips.createMany as any, { items } as any)
            results.push({ type: cmd.type, ok: true, created: Array.isArray(ids) ? ids.length : items.length })
            break
          }
          case 'removeMany': {
            const t = trackAtIndex((cmd as any).trackIndex)
            if (!t) { results.push({ type: cmd.type, error: 'Track not found' }); break }
            const allClips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const clipsOnTrack = allClips.filter(c => String(c.trackId) === String(t._id))
            const targets = clipsOnTrack.filter(c => c.startSec >= cmd.rangeStartSec && c.startSec < cmd.rangeEndSec)
            const targetIds = targets.map(c => c._id)
            if (targetIds.length === 0) { results.push({ type: cmd.type, ok: true, removed: 0 }); break }
            await convex.mutation(convexApi.clips.removeMany as any, { clipIds: targetIds, userId: (user as any).id } as any)
            // Verify which were removed
            const after: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const remainingSet = new Set(after.map(c => String(c._id)))
            const removedCount = targetIds.filter(id => !remainingSet.has(String(id))).length
            results.push(removedCount > 0 ? { type: cmd.type, ok: true, removed: removedCount } : { type: cmd.type, error: 'No owned clips removed' })
            break
          }
          case 'setMute': {
            const collectIndices = () => {
              const explicit = normalizeTrackIndices((cmd as any).trackIndices)
              if (explicit.length) return explicit
              const single = asPositiveIndex((cmd as any).trackIndex)
              if (typeof single === 'number') return [single]
              if (trackList && trackList.length) return Array.from({ length: trackList.length }, (_, i) => i)
              return []
            }
            const idxs = collectIndices()
            if (!idxs.length) { results.push({ type: cmd.type, error: 'No track specified' }); break }
            let updated = 0
            for (const i of idxs) {
              const t = trackList?.[i]
              if (!t) continue
              await convex.mutation(convexApi.tracks.setMix as any, { trackId: t._id, muted: (cmd as any).value, userId: (user as any).id } as any)
              updated++
            }
            results.push({ type: cmd.type, ok: true, updated })
            break
          }
          case 'setSolo': {
            const collectIndices = () => {
              const explicit = normalizeTrackIndices((cmd as any).trackIndices)
              if (explicit.length) return explicit
              const single = asPositiveIndex((cmd as any).trackIndex)
              if (typeof single === 'number') return [single]
              if (trackList && trackList.length) return [trackList.length - 1]
              return []
            }
            const idxs = collectIndices()
            if (!idxs.length) { results.push({ type: cmd.type, error: 'No track specified' }); break }
            const exclusive = !!(cmd as any).exclusive
            const value = !!(cmd as any).value
            if (exclusive && value && idxs.length === 1) {
              // Clear solo on others first (best-effort; may fail for non-owned tracks)
              const keep = idxs[0]
              for (let i = 0; i < (trackList?.length ?? 0); i++) {
                if (i === keep) continue
                const ot = trackList?.[i]
                if (!ot) continue
                await convex.mutation(convexApi.tracks.setMix as any, { trackId: ot._id, soloed: false, userId: (user as any).id } as any)
              }
            }
            let updated = 0
            for (const i of idxs) {
              const t = trackList?.[i]
              if (!t) continue
              await convex.mutation(convexApi.tracks.setMix as any, { trackId: t._id, soloed: value, userId: (user as any).id } as any)
              updated++
            }
            results.push({ type: cmd.type, ok: true, updated })
            break
          }
          default:
            results.push({ type: (cmd as any).type, error: 'Unsupported' })
        }
      } catch (e) {
        results.push({ type: (cmd as any).type, error: 'Execution failed' })
      }
    }

    return c.json({ ok: true, results })
  } catch (err) {
    console.error('Agent execute error', err)
    return c.json({ error: 'Failed to execute commands' }, 500)
  }
})

// Protected route example
app.get('/api/protected', (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return c.json({ message: 'This is a protected route', user });
})

// Upload a sample to R2 (protected route)
app.post('/api/samples', async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const form = await c.req.formData()
    const roomId = form.get('roomId')?.toString()
    const clipId = form.get('clipId')?.toString()
    const file = form.get('file')
    const durationStr = form.get('duration')?.toString()

    if (!roomId || !clipId || !(file instanceof File)) {
      return c.json({ error: 'Missing roomId, clipId or file' }, 400)
    }

    // Sanitize filename for use as a key segment
    const baseName = file.name?.toString() || 'audio'
    const sanitized = baseName
      .replace(/\\/g, '/')              // normalize separators
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9._-]/g, '_')  // safe chars
      .slice(0, 180)                      // keep key short-ish
    // Primary layout: rooms/<roomId>/clips/<filename>
    // Handle collisions by appending " (n)" or timestamp.
    const clipsPrefix = `rooms/${roomId}/clips/`
    const splitIdx = sanitized.lastIndexOf('.')
    const base = splitIdx > 0 ? sanitized.slice(0, splitIdx) : sanitized
    const ext = splitIdx > 0 ? sanitized.slice(splitIdx) : ''
    let chosenName = sanitized
    let attempts = 0
    while (attempts < 5) {
      const probeKey = clipsPrefix + chosenName
      const existing = await c.env.daw_audio_samples.get(probeKey)
      if (!existing) {
        break
      }
      // If existing belongs to this clip, reuse the same name, otherwise try next suffix
      const existingClip = existing.customMetadata?.clipId
      if (existingClip === clipId) {
        break
      }
      attempts++
      chosenName = `${base} (${attempts})${ext}`
    }
    if (attempts >= 5) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      chosenName = `${base}_${ts}${ext}`
    }
    const key = clipsPrefix + chosenName
    await c.env.daw_audio_samples.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
        contentDisposition: `inline; filename="${file.name}"`,
      },
      customMetadata: {
        roomId,
        clipId,
        filename: chosenName,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        durationSec: durationStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
      },
    })

    // Return a URL that includes the exact key so the GET route can fetch without indirection
    const url = `/api/samples/${roomId}/${clipId}?key=${encodeURIComponent(key)}`
    return c.json({ key, url })
  } catch (err) {
    console.error('Upload error', err)
    return c.json({ error: 'Failed to upload sample' }, 500)
  }
})

// Stream a sample from R2
app.get('/api/samples/:roomId/:clipId', async (c) => {
  try {
    // Require exact key so we don't list buckets or rely on pointers
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Credentials', 'true')
    if (obj.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', obj.httpMetadata.contentDisposition)
    }
    headers.set('X-R2-Key', key)

    return new Response(obj.body, { headers })
  } catch (err) {
    console.error('Fetch error', err)
    return c.json({ error: 'Failed to fetch sample' }, 500)
  }
})

// AI Agent chat endpoint (streams SSE)
app.post('/api/agent/chat', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json().catch(() => null) as any
    if (!body || !Array.isArray(body.messages)) {
      return c.json({ error: 'Invalid body' }, 400)
    }

    const roomId = (body.roomId as string | undefined) ?? undefined
    const clientBpm = (typeof body.bpm === 'number') ? Math.max(20, Math.min(300, Number(body.bpm))) : undefined

    const openrouter = createOpenRouter({ apiKey: c.env.OPENROUTER_API_KEY })
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)

    const modelName = 'openai/gpt-oss-20b:free'
    const supportsTools = !/gpt-oss/i.test(modelName) && !/:free(\b|$)/i.test(modelName)

    let system = `You are a DAW assistant for MediaBunny. Date: 2025-09-30.${roomId ? ` Room: ${roomId}.` : ''}`
    if (!supportsTools) {
      // Optional context: include current BPM and sample names to improve sample matching
      let contextNote = ''
      try {
        // Basic sample context
        const list: any[] = roomId ? (await convex.query(convexApi.samples.listByRoom as any, { roomId } as any)) : []
        const sampleNames = Array.isArray(list) && list.length ? list.map(s => (s.name || s.url || '')).filter(Boolean).slice(0, 20) : []

        // Lightweight project snapshot
        let tracksLine = ''
        let clipsLine = ''
        let effectsLine = ''
        if (roomId) {
          try {
            const tracks: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            const clips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
            const audioCount = tracks.filter(t => (t.kind ?? 'audio') === 'audio').length
            const instrCount = tracks.filter(t => (t.kind ?? 'audio') === 'instrument').length
            const perTrackCounts = (() => {
              const map = new Map<string, number>()
              for (const c of clips) {
                const k = String(c.trackId)
                map.set(k, (map.get(k) || 0) + 1)
              }
              return tracks.map(t => map.get(String(t._id)) || 0)
            })()

            // Effect counts (cap to first 24 tracks to keep it light)
            let synthCount = 0, eqCount = 0, revCount = 0, arpCount = 0
            for (const t of tracks.slice(0, 24)) {
              try {
                const [synth, eq, rev, arp] = await Promise.all([
                  convex.query(convexApi.effects.getSynthForTrack as any, { trackId: t._id } as any).catch(() => null),
                  convex.query(convexApi.effects.getEqForTrack as any, { trackId: t._id } as any).catch(() => null),
                  convex.query(convexApi.effects.getReverbForTrack as any, { trackId: t._id } as any).catch(() => null),
                  convex.query(convexApi.effects.getArpeggiatorForTrack as any, { trackId: t._id } as any).catch(() => null),
                ])
                if (synth) synthCount++
                if (eq) eqCount++
                if (rev) revCount++
                if (arp) arpCount++
              } catch {}
            }
            const masterEq = await convex.query(convexApi.effects.getEqForMaster as any, { roomId } as any).catch(() => null)
            const masterRev = await convex.query(convexApi.effects.getReverbForMaster as any, { roomId } as any).catch(() => null)

            tracksLine = tracks.length ? `Tracks: ${tracks.length} (audio ${audioCount}, instrument ${instrCount}).` : ''
            clipsLine = (clips.length || tracks.length) ? `Clips: ${clips.length} total; per track: [${perTrackCounts.join(', ')}].` : ''
            effectsLine = tracks.length ? `Effects: synth ${synthCount}, eq ${eqCount}, reverb ${revCount}, arp ${arpCount}; master eq: ${masterEq ? 'yes' : 'no'}, master reverb: ${masterRev ? 'yes' : 'no'}.` : ''
          } catch {}
        }

        const bpmLine = clientBpm ? `Current timeline BPM: ${clientBpm}.` : ''
        const samplesLine = sampleNames.length ? `Samples in project: ${sampleNames.join(', ')}.` : ''
        const snapshot = [tracksLine, clipsLine, effectsLine].filter(Boolean).join(' ')
        const pieces = [bpmLine, snapshot, samplesLine].filter(Boolean)
        if (pieces.length) contextNote = `\n${pieces.join(' ')}`
      } catch {}
      system += `
When tools are unavailable, decide between two modes based on USER intent:

1) Explain mode (default): If the USER asks informational/descriptive questions (e.g., "what can you tell me about this project", "explain", "how does X work"), respond with natural language ONLY. Do NOT include any JSON or code blocks.

2) Edit mode: If the USER explicitly asks to make changes (verbs like add, create, move, copy, delete, remove, set, insert, enable, mute, solo), append a single JSON code block at the END of your reply with ONLY commands, like:
\`\`\`json
{
  "commands": [
    { "type": "createTrack", "kind": "instrument" }
  ]
}
\`\`\`
Supported commands: createTrack, setTrackVolume, addMidiClip, setEqParams, setReverbParams, setSynthParams, deleteTrack, moveClip, moveClips, copyClips, removeClip, setArpeggiatorParams, setTiming, removeMany, setMute, setSolo, addSampleClips.
Rules (apply only in Edit mode):
- Use one-based indices for trackIndex (first track is 1). We will convert internally.
- Use one-based indices for clipIndices as well (first clip is 1 on its track, sorted by start time). We will convert internally.
- For deleteTrack/moveClip/removeClip/setTiming/removeMany you MUST include a trackIndex.
- Prefer specifying clipIndex for clip operations; otherwise use clipAtOrAfterSec.
- For setTrackVolume, if trackIndex is omitted, it applies to the most recently created track.
- For setMute/setSolo, you may specify trackIndex or trackIndices; if omitted, it applies to the most recently created track. For exclusive soloing, include exclusive: true.
- For solo requests, never use setMute. Use setSolo exclusively (and include exclusive: true when the user says "solo track N" meaning only that track should be audible).
- For addSampleClips: Prefer exact sample names from the project list when available.${contextNote}

Output policy:
- If the user didn't ask for changes, output ONLY text (no JSON).
- If the user asked for changes, output text THEN exactly one JSON commands block, and nothing after it.`
    }

    const options: any = {
      model: openrouter(modelName as any),
      messages: body.messages,
      temperature: 0.4,
      system,
    }

    if (supportsTools) {
      options.tools = {
        createTrack: {
          description: 'Create a new track in the current room. Kind can be audio or instrument.',
          parameters: z.object({
            kind: z.enum(['audio','instrument']).optional(),
          }),
          execute: async (input: any) => {
            const kind = input?.kind as 'audio' | 'instrument' | undefined
            if (!roomId) return { error: 'Missing roomId' }
            const trackId = await convex.mutation(convexApi.tracks.create as any, {
              roomId,
              userId: (user as any).id,
              kind,
            } as any)
            return { trackId }
          }
        },
        setTrackVolume: {
          description: 'Set a track volume (0..1) by track index.',
          parameters: z.object({
            trackIndex: z.number().int().min(0),
            volume: z.number().min(0).max(1),
          }),
          execute: async (input: any) => {
            const trackIndex = Number(input?.trackIndex)
            const volume = Number(input?.volume)
            if (!roomId) return { error: 'Missing roomId' }
            const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            const track = trackList?.[trackIndex]
            if (!track) return { error: `No track at index ${trackIndex}` }
            await convex.mutation(convexApi.tracks.setVolume as any, { trackId: track._id, volume } as any)
            return { ok: true }
          }
        },
        setEqParams: {
          description: 'Set EQ for master or a track. Use target="master" or trackIndex.',
          parameters: z.object({
            target: z.union([z.literal('master'), z.number().int().min(0)]),
            enabled: z.boolean(),
            bands: z.array(z.object({
              id: z.string(),
              type: z.string(),
              frequency: z.number(),
              gainDb: z.number(),
              q: z.number(),
              enabled: z.boolean(),
            }))
          }),
          execute: async (input: any) => {
            const target = input?.target as 'master' | number
            const params = { enabled: !!input?.enabled, bands: Array.isArray(input?.bands) ? input.bands : [] }
            if (!roomId) return { error: 'Missing roomId' }
            if (target === 'master') {
              await convex.mutation(convexApi.effects.setMasterEqParams as any, { roomId, userId: (user as any).id, params } as any)
              return { ok: true }
            } else {
              const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
              const track = trackList?.[target]
              if (!track) return { error: `No track at index ${target}` }
              await convex.mutation(convexApi.effects.setEqParams as any, { roomId, trackId: track._id, userId: (user as any).id, params } as any)
              return { ok: true }
            }
          }
        },
        setReverbParams: {
          description: 'Set Reverb for master or a track. Use target="master" or trackIndex.',
          parameters: z.object({
            target: z.union([z.literal('master'), z.number().int().min(0)]),
            enabled: z.boolean(),
            wet: z.number().min(0).max(1),
            decaySec: z.number().min(0.05).max(12),
            preDelayMs: z.number().min(0).max(250),
          }),
          execute: async (input: any) => {
            const target = input?.target as 'master' | number
            const params = {
              enabled: !!input?.enabled,
              wet: Number(input?.wet ?? 0.5),
              decaySec: Number(input?.decaySec ?? 1.5),
              preDelayMs: Number(input?.preDelayMs ?? 0),
            }
            if (!roomId) return { error: 'Missing roomId' }
            if (target === 'master') {
              await convex.mutation(convexApi.effects.setMasterReverbParams as any, { roomId, userId: (user as any).id, params } as any)
              return { ok: true }
            } else {
              const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
              const track = trackList?.[target]
              if (!track) return { error: `No track at index ${target}` }
              await convex.mutation(convexApi.effects.setReverbParams as any, { roomId, trackId: track._id, userId: (user as any).id, params } as any)
              return { ok: true }
            }
          }
        },
        setSynthParams: {
          description: 'Set Synth params for an instrument track by index.',
          parameters: z.object({
            trackIndex: z.number().int().min(0),
            wave: z.enum(['sine','square','sawtooth','triangle']),
            gain: z.number().min(0).max(1.5).optional(),
            attackMs: z.number().min(0).max(500).optional(),
            releaseMs: z.number().min(0).max(500).optional(),
          }),
          execute: async (input: any) => {
            const trackIndex = Number(input?.trackIndex)
            const wave = input?.wave as 'sine'|'square'|'sawtooth'|'triangle'
            const gain = typeof input?.gain === 'number' ? input.gain : undefined
            const attackMs = typeof input?.attackMs === 'number' ? input.attackMs : undefined
            const releaseMs = typeof input?.releaseMs === 'number' ? input.releaseMs : undefined
            if (!roomId) return { error: 'Missing roomId' }
            const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            const track = trackList?.[trackIndex]
            if (!track) return { error: `No track at index ${trackIndex}` }
            if ((track.kind ?? 'audio') !== 'instrument') return { error: 'Target track is not an instrument track' }
            await convex.mutation(convexApi.effects.setSynthParams as any, { roomId, trackId: track._id, userId: (user as any).id, params: { wave, gain, attackMs, releaseMs } } as any)
            return { ok: true }
          }
        },
        addMidiClip: {
          description: 'Add a MIDI clip to an instrument track by index with optional notes.',
          parameters: z.object({
            trackIndex: z.number().int().min(0),
            startSec: z.number().min(0),
            duration: z.number().min(0.05).default(1),
            wave: z.enum(['sine','square','sawtooth','triangle']).default('sawtooth').optional(),
            gain: z.number().min(0).max(1.5).optional(),
            notes: z.array(z.object({
              beat: z.number(),
              length: z.number(),
              pitch: z.number(),
              velocity: z.number().optional(),
            })).optional(),
          }),
          execute: async (input: any) => {
            const trackIndex = Number(input?.trackIndex)
            const startSec = Number(input?.startSec)
            const duration = Number(input?.duration ?? 1)
            const wave = (input?.wave ?? 'sawtooth') as 'sine'|'square'|'sawtooth'|'triangle'
            const gain = typeof input?.gain === 'number' ? input.gain : 0.8
            const notes = Array.isArray(input?.notes) ? input.notes : []
            if (!roomId) return { error: 'Missing roomId' }
            const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            const track = trackList?.[trackIndex]
            if (!track) return { error: `No track at index ${trackIndex}` }
            if ((track.kind ?? 'audio') !== 'instrument') return { error: 'Target track is not an instrument track' }

            const clipId = await convex.mutation(convexApi.clips.create as any, {
              roomId,
              trackId: track._id,
              startSec,
              duration,
              userId: (user as any).id,
              name: 'MIDI Clip',
            } as any)
            if (!clipId) return { error: 'Failed to create clip' }
            await convex.mutation(convexApi.clips.setMidi as any, {
              clipId,
              midi: { wave, gain, notes },
              userId: (user as any).id,
            } as any)
            return { clipId }
          }
        },
        setMute: {
          description: 'Mute or unmute one or more tracks. Provide trackIndex or trackIndices (zero-based for tools).',
          parameters: z.object({
            trackIndex: z.number().int().min(0).optional(),
            trackIndices: z.array(z.number().int().min(0)).optional(),
            value: z.boolean(),
          }),
          execute: async (input: any) => {
            if (!roomId) return { error: 'Missing roomId' }
            const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            const indices: number[] = Array.isArray(input?.trackIndices) && input.trackIndices.length
              ? input.trackIndices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n) && n >= 0)
              : (typeof input?.trackIndex === 'number' ? [Number(input.trackIndex)] : (trackList.length ? [trackList.length - 1] : []))
            let updated = 0
            for (const i of indices) {
              const t = trackList[i]
              if (!t) continue
              await convex.mutation(convexApi.tracks.setMix as any, { trackId: t._id, muted: !!input.value, userId: (user as any).id } as any)
              updated++
            }
            return { ok: true, updated }
          }
        },
        setSolo: {
          description: 'Solo or unsolo one or more tracks. Provide trackIndex or trackIndices (zero-based for tools). Use exclusive to clear solo on others when soloing one track.',
          parameters: z.object({
            trackIndex: z.number().int().min(0).optional(),
            trackIndices: z.array(z.number().int().min(0)).optional(),
            value: z.boolean(),
            exclusive: z.boolean().optional(),
          }),
          execute: async (input: any) => {
            if (!roomId) return { error: 'Missing roomId' }
            const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            const indices: number[] = Array.isArray(input?.trackIndices) && input.trackIndices.length
              ? input.trackIndices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n) && n >= 0)
              : (typeof input?.trackIndex === 'number' ? [Number(input.trackIndex)] : (trackList.length ? [trackList.length - 1] : []))
            let updated = 0
            if (input?.exclusive && input?.value === true && indices.length === 1) {
              // Clear others first
              for (let i = 0; i < trackList.length; i++) {
                if (i === indices[0]) continue
                const t = trackList[i]
                await convex.mutation(convexApi.tracks.setMix as any, { trackId: t._id, soloed: false, userId: (user as any).id } as any)
              }
            }
            for (const i of indices) {
              const t = trackList[i]
              if (!t) continue
              await convex.mutation(convexApi.tracks.setMix as any, { trackId: t._id, soloed: !!input.value, userId: (user as any).id } as any)
              updated++
            }
            return { ok: true, updated }
          }
        },
        addSampleClips: {
          description: 'Place a project sample on a track, optionally repeated with spacing or patterns.',
          parameters: z.object({
            sampleQuery: z.string(),
            trackIndex: z.number().int().min(0).optional(),
            startSec: z.number().min(0).optional(),
            count: z.number().int().min(1).optional(),
            intervalSec: z.number().min(0).optional(),
            pattern: z.enum(['fourOnFloor','everyBeat','everyHalf']).optional(),
            bpm: z.number().min(20).max(300).optional(),
          }),
          execute: async (input: any) => {
            if (!roomId) return { error: 'Missing roomId' }
            const q = String(input?.sampleQuery || '').trim().toLowerCase()
            if (!q) return { error: 'Missing sampleQuery' }
            const trackList: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
            let target = (typeof input?.trackIndex === 'number') ? trackList[input.trackIndex] : undefined
            if (!target) {
              const tid = await convex.mutation(convexApi.tracks.create as any, { roomId, userId: (user as any).id, kind: 'audio' } as any)
              const updated: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
              const idx = updated.findIndex(t => String(t._id) === String(tid))
              target = idx >= 0 ? updated[idx] : undefined
              if (!target) return { error: 'Failed to create track' }
            }
            const all: any[] = await convex.query(convexApi.samples.listByRoom as any, { roomId } as any)
            const norm = (s: string | undefined) => (s || '').toLowerCase()
            const stop = new Set(['sample','samples','the','a','some','beat','pattern','with','using','in','on','of'])
            const tokens = q.split(/[^a-z0-9]+/g).map((t: string) => t.trim()).filter((t: string) => t && !stop.has(t))
            const pick = (() => {
              if (!all.length) return null
              let best: any = null
              let bestScore = -1
              for (const s of all) {
                const hay = `${norm(s.name)} ${norm(s.url)}`
                const score = tokens.length ? tokens.filter((t: string) => hay.includes(t)).length : (hay.includes(q) ? 1 : 0)
                if (score > bestScore) { best = s; bestScore = score }
              }
              return bestScore > 0 ? best : null
            })()
            if (!pick) return { error: 'Sample not found in project' }
            const startSec = typeof input?.startSec === 'number' ? Math.max(0, Number(input.startSec)) : 0
            const bpm = typeof input?.bpm === 'number' ? Math.max(20, Math.min(300, Number(input.bpm))) : 120
            const beatSec = 60 / bpm
            const pattern = input?.pattern as 'fourOnFloor'|'everyBeat'|'everyHalf'|undefined
            let count = typeof input?.count === 'number' ? Math.max(1, Math.floor(Number(input.count))) : undefined
            const baseDur = (typeof pick.duration === 'number' && isFinite(pick.duration) && pick.duration > 0) ? pick.duration : beatSec
            let intervalSec: number | undefined = typeof input?.intervalSec === 'number' ? Math.max(0, Number(input.intervalSec)) : undefined
            if (!intervalSec && pattern) {
              switch (pattern) {
                case 'fourOnFloor': intervalSec = beatSec; if (!count) count = 4; break
                case 'everyBeat': intervalSec = beatSec; break
                case 'everyHalf': intervalSec = beatSec / 2; break
              }
            }
            if (!intervalSec) intervalSec = baseDur
            if (!count) count = 1
            const items = Array.from({ length: count }).map((_, i) => ({
              roomId,
              trackId: target._id,
              startSec: startSec + i * (intervalSec as number),
              duration: baseDur,
              userId: (user as any).id,
              name: pick.name ?? 'Sample',
              sampleUrl: pick.url,
            }))
            const created = await convex.mutation(convexApi.clips.createMany as any, { items } as any)
            return { ok: true, created: (created as any[])?.length ?? 0 }
          }
        },
      } as any
    }

    const result = await streamText(options)

    // AI SDK v5: stream text response helper
    return result.toTextStreamResponse()
  } catch (err) {
    console.error('Agent chat error', err)
    return c.json({ error: 'Failed to process agent chat' }, 500)
  }
})

export default app