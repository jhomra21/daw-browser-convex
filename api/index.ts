import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuth, type Session } from './auth'
import { streamText } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../convex/_generated/api'
import { CommandsEnvelopeSchema } from '../src/lib/agent-commands'
import { createAgentActions } from './agent-actions'

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
    const agentActions = createAgentActions({
      convex,
      convexApi,
      roomId,
      userId: (user as any).id,
      getTracks: async () => trackList,
      refreshTracks: async () => {
        const updated: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
        trackList.splice(0, trackList.length, ...updated)
        return trackList
      },
    })

    const results: any[] = []
    for (const cmd of parsed.data.commands) {
      try {
        switch (cmd.type) {
          case 'createTrack': {
            results.push({ type: cmd.type, ...(await agentActions.createTrack(cmd)) })
            break
          }
          case 'setTrackRouting': {
            results.push({ type: cmd.type, ...(await agentActions.setTrackRouting(cmd)) })
            break
          }
          case 'addSampleClips': {
            results.push({ type: cmd.type, ...(await agentActions.addSampleClips(cmd)) })
            break
          }
          case 'setTrackVolume': {
            results.push({ type: cmd.type, ...(await agentActions.setTrackVolume(cmd)) })
            break
          }
          case 'addMidiClip': {
            results.push({ type: cmd.type, ...(await agentActions.addMidiClip(cmd)) })
            break
          }
          case 'setEqParams': {
            results.push({ type: cmd.type, ...(await agentActions.setEqParams(cmd)) })
            break
          }
          case 'setReverbParams': {
            results.push({ type: cmd.type, ...(await agentActions.setReverbParams(cmd)) })
            break
          }
          case 'setSynthParams': {
            results.push({ type: cmd.type, ...(await agentActions.setSynthParams(cmd)) })
            break
          }
          case 'deleteTrack': {
            results.push({ type: cmd.type, ...(await agentActions.deleteTrack(cmd)) })
            break
          }
          case 'moveClip': {
            results.push({ type: cmd.type, ...(await agentActions.moveClip(cmd)) })
            break
          }
          case 'removeClip': {
            results.push({ type: cmd.type, ...(await agentActions.removeClip(cmd)) })
            break
          }
          case 'setArpeggiatorParams': {
            results.push({ type: cmd.type, ...(await agentActions.setArpeggiatorParams(cmd)) })
            break
          }
          case 'setTiming': {
            results.push({ type: cmd.type, ...(await agentActions.setTiming(cmd)) })
            break
          }
          case 'moveClips': {
            results.push({ type: cmd.type, ...(await agentActions.moveClips(cmd)) })
            break
          }
          case 'copyClips': {
            results.push({ type: cmd.type, ...(await agentActions.copyClips(cmd)) })
            break
          }
          case 'removeMany': {
            results.push({ type: cmd.type, ...(await agentActions.removeMany(cmd)) })
            break
          }
          case 'setMute': {
            results.push({ type: cmd.type, ...(await agentActions.setMute(cmd)) })
            break
          }
          case 'setSolo': {
            results.push({ type: cmd.type, ...(await agentActions.setSolo(cmd)) })
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
    const assetKey = form.get('assetKey')?.toString()
    const file = form.get('file')
    const durationStr = form.get('duration')?.toString()

    if (!roomId || !assetKey || !(file instanceof File)) {
      return c.json({ error: 'Missing roomId, assetKey or file' }, 400)
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
      const existingAssetKey = existing.customMetadata?.assetKey
      if (existingAssetKey === assetKey) {
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
        assetKey,
        filename: chosenName,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        durationSec: durationStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
      },
    })

    // Return a URL that includes the exact key so the GET route can fetch without indirection
    const url = `/api/samples/${roomId}/${encodeURIComponent(assetKey)}?key=${encodeURIComponent(key)}`
    return c.json({ key, url })
  } catch (err) {
    console.error('Upload error', err)
    return c.json({ error: 'Failed to upload sample' }, 500)
  }
})

// Stream a sample from R2
app.get('/api/samples/:roomId/:sourceId', async (c) => {
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

app.get('/api/default-samples', async (c) => {
  try {
    const bucket = c.env.daw_audio_samples
    if (!bucket) {
      return c.json({ samples: [] })
    }
    const prefix = 'default/'
    let cursor: string | undefined
    const objects: any[] = []

    do {
      const page: any = await bucket.list({
        prefix,
        cursor,
        limit: 1000,
      })
      if (Array.isArray(page?.objects)) {
        objects.push(...page.objects)
      }
      cursor = page?.truncated ? page?.cursor : undefined
    } while (cursor)

    const samples: any[] = []
    for (const obj of objects) {
      if (!obj || typeof obj.key !== 'string' || !obj.key.startsWith(prefix)) continue
      if (obj.key === prefix || obj.key.endsWith('/')) continue
      const key: string = obj.key
      const metadata = obj.customMetadata
      const duration = Number(metadata?.durationSec)
      const sampleRate = Number(metadata?.sampleRate)
      const channelCount = Number(metadata?.channelCount)
      if (!Number.isFinite(duration) || duration <= 0) continue
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) continue
      if (!Number.isFinite(channelCount) || channelCount <= 0) continue
      const rawName = key.slice(prefix.length)
      let decodedName = rawName || key
      try {
        decodedName = decodeURIComponent(decodedName)
      } catch {}
      const url = `/api/default-sample?key=${encodeURIComponent(key)}`
      samples.push({
        key,
        assetKey: `asset:default:${key}`,
        sourceKind: 'url',
        name: decodedName,
        url,
        duration,
        source: {
          durationSec: duration,
          sampleRate,
          channelCount,
        },
        sizeBytes: typeof obj.size === 'number' ? obj.size : undefined,
      })
    }

    samples.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    return c.json({ samples })
  } catch (err) {
    console.error('Default samples list error', err)
    return c.json({ error: 'Failed to list default samples' }, 500)
  }
})

app.get('/api/default-sample', async (c) => {
  try {
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    if (!key.startsWith('default/')) return c.json({ error: 'Invalid key' }, 400)

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
    console.error('Default sample fetch error', err)
    return c.json({ error: 'Failed to fetch default sample' }, 500)
  }
})

// Upload an export to R2 (protected route)
app.post('/api/exports', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const form = await c.req.formData()
    const roomId = form.get('roomId')?.toString()
    const format = 'wav'
    const durationStr = form.get('duration')?.toString()
    const sampleRateStr = form.get('sampleRate')?.toString()
    const file = form.get('file')
    let name = form.get('name')?.toString()

    if (!roomId || !(file instanceof File)) {
      return c.json({ error: 'Missing roomId or file' }, 400)
    }

    // Sanitize filename or generate one
    if (!name) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      name = `export_${ts}.wav`
    }
    const sanitized = name
      .replace(/\\/g, '/')
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 180)

    const exportsPrefix = `rooms/${roomId}/exports/`
    const splitIdx = sanitized.lastIndexOf('.')
    const base = splitIdx > 0 ? sanitized.slice(0, splitIdx) : sanitized
    const ext = splitIdx > 0 ? sanitized.slice(splitIdx) : ''
    let chosenName = sanitized
    let attempts = 0
    while (attempts < 5) {
      const probeKey = exportsPrefix + chosenName
      const existing = await c.env.daw_audio_samples.get(probeKey)
      if (!existing) break
      attempts++
      chosenName = `${base} (${attempts})${ext}`
    }
    if (attempts >= 5) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      chosenName = `${base}_${ts}${ext}`
    }
    const key = exportsPrefix + chosenName

    const putRes = await c.env.daw_audio_samples.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'audio/wav',
        contentDisposition: `inline; filename="${chosenName}"`,
      },
      customMetadata: {
        roomId,
        format,
        durationSec: durationStr || '',
        sampleRate: sampleRateStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
      },
    })

    const url = `/api/export?key=${encodeURIComponent(key)}`
    return c.json({ key, url, sizeBytes: (putRes as any)?.size })
  } catch (err) {
    console.error('Export upload error', err)
    return c.json({ error: 'Failed to upload export' }, 500)
  }
})

// Stream an export from R2 by key
app.get('/api/export', async (c) => {
  try {
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    if (!key.startsWith('rooms/')) return c.json({ error: 'Invalid key' }, 400)

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
    console.error('Export fetch error', err)
    return c.json({ error: 'Failed to fetch export' }, 500)
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
    const today = new Date().toISOString().slice(0, 10)

    let system = `You are a DAW assistant for MediaBunny. Date: ${today}.${roomId ? ` Room: ${roomId}.` : ''}`
    // Optional context: include current BPM and sample names to improve sample matching
    let contextNote = ''
    try {
      const list: any[] = roomId ? (await convex.query(convexApi.samples.listByRoom as any, { roomId } as any)) : []
      const sampleNames = Array.isArray(list) && list.length ? list.map((sample) => (sample.name || sample.url || '')).filter(Boolean).slice(0, 20) : []

      let tracksLine = ''
      let clipsLine = ''
      let effectsLine = ''
      if (roomId) {
        try {
          const tracks: any[] = await convex.query(convexApi.tracks.listByRoom as any, { roomId } as any)
          const clips: any[] = await convex.query(convexApi.clips.listByRoom as any, { roomId } as any)
          const audioCount = tracks.filter((track) => (track.kind ?? 'audio') === 'audio').length
          const instrumentCount = tracks.filter((track) => (track.kind ?? 'audio') === 'instrument').length
          const perTrackCounts = (() => {
            const counts = new Map<string, number>()
            for (const clip of clips) {
              const key = String(clip.trackId)
              counts.set(key, (counts.get(key) || 0) + 1)
            }
            return tracks.map((track) => counts.get(String(track._id)) || 0)
          })()

          let synthCount = 0
          let eqCount = 0
          let reverbCount = 0
          let arpCount = 0
          for (const track of tracks.slice(0, 24)) {
            try {
              const [synth, eq, reverb, arp] = await Promise.all([
                convex.query(convexApi.effects.getSynthForTrack as any, { trackId: track._id } as any).catch(() => null),
                convex.query(convexApi.effects.getEqForTrack as any, { trackId: track._id } as any).catch(() => null),
                convex.query(convexApi.effects.getReverbForTrack as any, { trackId: track._id } as any).catch(() => null),
                convex.query(convexApi.effects.getArpeggiatorForTrack as any, { trackId: track._id } as any).catch(() => null),
              ])
              if (synth) synthCount += 1
              if (eq) eqCount += 1
              if (reverb) reverbCount += 1
              if (arp) arpCount += 1
            } catch {}
          }
          const masterEq = await convex.query(convexApi.effects.getEqForMaster as any, { roomId } as any).catch(() => null)
          const masterReverb = await convex.query(convexApi.effects.getReverbForMaster as any, { roomId } as any).catch(() => null)

          tracksLine = tracks.length ? `Tracks: ${tracks.length} (audio ${audioCount}, instrument ${instrumentCount}).` : ''
          clipsLine = (clips.length || tracks.length) ? `Clips: ${clips.length} total; per track: [${perTrackCounts.join(', ')}].` : ''
          effectsLine = tracks.length ? `Effects: synth ${synthCount}, eq ${eqCount}, reverb ${reverbCount}, arp ${arpCount}; master eq: ${masterEq ? 'yes' : 'no'}, master reverb: ${masterReverb ? 'yes' : 'no'}.` : ''
        } catch {}
      }

      const bpmLine = clientBpm ? `Current timeline BPM: ${clientBpm}.` : ''
      const samplesLine = sampleNames.length ? `Samples in project: ${sampleNames.join(', ')}.` : ''
      const snapshot = [tracksLine, clipsLine, effectsLine].filter(Boolean).join(' ')
      const pieces = [bpmLine, snapshot, samplesLine].filter(Boolean)
      if (pieces.length) contextNote = `\n${pieces.join(' ')}`
    } catch {}
    system += `
Decide between two modes based on USER intent:

1) Explain mode (default): If the USER asks informational/descriptive questions (e.g., "what can you tell me about this project", "explain", "how does X work"), respond with natural language ONLY. Do NOT include any JSON or code blocks.

2) Edit mode: If the USER explicitly asks to make changes (verbs like add, create, move, copy, delete, remove, set, insert, enable, mute, solo), append a single JSON code block at the END of your reply with ONLY commands, like:
\`\`\`json
{
  "commands": [
    { "type": "createTrack", "kind": "instrument" }
  ]
}
\`\`\`
Supported commands: createTrack, setTrackRouting, setTrackVolume, addMidiClip, setEqParams, setReverbParams, setSynthParams, deleteTrack, moveClip, moveClips, copyClips, removeClip, setArpeggiatorParams, setTiming, removeMany, setMute, setSolo, addSampleClips.
Rules (apply only in Edit mode):
- Use one-based indices for trackIndex (first track is 1). We will convert internally.
- Use one-based indices for clipIndices as well (first clip is 1 on its track, sorted by start time). We will convert internally.
- For setTrackRouting, omit a field to preserve it. Use outputTrackIndex: null to route to master, and sends: [] to clear sends.
- For setSynthParams, use wave1 and wave2 for oscillator waves. If the user asks for a single synth waveform, set both to the same value.
- For deleteTrack/moveClip/removeClip/setTiming/removeMany you MUST include a trackIndex.
- Prefer specifying clipIndex for clip operations; otherwise use clipAtOrAfterSec.
- For setTrackVolume, if trackIndex is omitted, it applies to the most recently created track.
- For setMute/setSolo, you may specify trackIndex or trackIndices; if omitted, it applies to the most recently created track. For exclusive soloing, include exclusive: true.
- For solo requests, never use setMute. Use setSolo exclusively (and include exclusive: true when the user says "solo track N" meaning only that track should be audible).
- For addSampleClips: Prefer exact sample names from the project list when available.${contextNote}

Output policy:
- If the user didn't ask for changes, output ONLY text (no JSON).
- If the user asked for changes, output text THEN exactly one JSON commands block, and nothing after it.`

    const options: any = {
      model: openrouter(modelName as any),
      messages: body.messages,
      temperature: 0.4,
      system,
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
