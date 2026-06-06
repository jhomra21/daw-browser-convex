import { streamText } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { api as convexApi } from '../../convex/_generated/api'
import { CommandsEnvelopeSchema } from '@daw-browser/shared'
import { createAgentActions, executeAgentCommands } from '../agent-actions'
import type { App } from '../app-types'
import { parseJsonBody } from '../json-body'
import { requireAuthenticatedConvexForApi, requireProjectRoleContextForApi } from '../project-access'
import { z } from 'zod'

type AgentChatMessages = NonNullable<Parameters<typeof streamText>[0]['messages']>

const agentExecuteBodySchema = CommandsEnvelopeSchema.extend({
  projectId: z.string(),
})

const agentChatBodySchema = z.object({
  messages: z.custom<AgentChatMessages>(Array.isArray),
  projectId: z.string().optional(),
  bpm: z.number().optional(),
})

export function registerAgentRoutes(app: App) {
// Execute JSON commands (no tool-calls path)
  app.post('/api/agent/execute', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const body = await parseJsonBody(c, agentExecuteBodySchema)
    if (!body) {
      return c.json({ error: 'Invalid body' }, 400)
    }
    const projectId = body.projectId
    const access = await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor'])
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    const convex = access.convex
    const trackList = await convex.query(convexApi.tracks.listByRoom, { projectId })
    const agentActions = createAgentActions({
      convex,
      convexApi,
      projectId,
      userId: access.user.id,
      getTracks: async () => trackList,
      refreshTracks: async () => {
        const updated = await convex.query(convexApi.tracks.listByRoom, { projectId })
        trackList.splice(0, trackList.length, ...updated)
        return trackList
      },
    })

    const results = await executeAgentCommands(agentActions, body.commands)

    return c.json({ ok: true, results })
  } catch (err) {
    console.error('Agent execute error', err)
    return c.json({ error: 'Failed to execute commands' }, 500)
  }
})
// AI Agent chat endpoint (streams SSE)
  app.post('/api/agent/chat', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c, agentChatBodySchema)
    if (!body) {
      return c.json({ error: 'Invalid body' }, 400)
    }

    const projectId = body.projectId
    const clientBpm = (typeof body.bpm === 'number') ? Math.max(20, Math.min(300, Number(body.bpm))) : undefined

    const openrouter = createOpenRouter({ apiKey: c.env.OPENROUTER_API_KEY })
    const access = projectId
      ? await requireProjectRoleContextForApi(c, projectId, ['owner', 'editor', 'viewer'])
      : await requireAuthenticatedConvexForApi(c)
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    const convex = access.convex

    const modelName = 'openai/gpt-oss-20b:free'
    const today = new Date().toISOString().slice(0, 10)

    let system = `You are a DAW assistant for MediaBunny. Date: ${today}.${projectId ? ` Room: ${projectId}.` : ''}`
    // Optional context: include current BPM and sample names to improve sample matching
    let contextNote = ''
    try {
      let tracksLine = ''
      let clipsLine = ''
      let effectsLine = ''
      let sampleNames: string[] = []
      if (projectId) {
        try {
          const [samples, tracks, clips, effects] = await Promise.all([
            convex.query(convexApi.samples.listByRoom, { projectId }),
            convex.query(convexApi.tracks.listByRoom, { projectId }),
            convex.query(convexApi.clips.listByRoom, { projectId }),
            convex.query(convexApi.effects.listByRoom, { projectId }).catch(() => []),
          ])
          sampleNames = Array.isArray(samples) && samples.length
            ? samples.map((sample) => (sample.name || sample.url || '')).filter(Boolean).slice(0, 20)
            : []
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
          let hasMasterEq = false
          let hasMasterReverb = false
          for (const row of effects) {
            if (row?.targetType === 'master') {
              if (row.type === 'eq') hasMasterEq = true
              if (row.type === 'reverb') hasMasterReverb = true
              continue
            }
            if (row?.type === 'synth') synthCount += 1
            if (row?.type === 'eq') eqCount += 1
            if (row?.type === 'reverb') reverbCount += 1
            if (row?.type === 'arpeggiator') arpCount += 1
          }

          tracksLine = tracks.length ? `Tracks: ${tracks.length} (audio ${audioCount}, instrument ${instrumentCount}).` : ''
          clipsLine = (clips.length || tracks.length) ? `Clips: ${clips.length} total; per track: [${perTrackCounts.join(', ')}].` : ''
          effectsLine = tracks.length ? `Effects: synth ${synthCount}, eq ${eqCount}, reverb ${reverbCount}, arp ${arpCount}; master eq: ${hasMasterEq ? 'yes' : 'no'}, master reverb: ${hasMasterReverb ? 'yes' : 'no'}.` : ''
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

    const options = {
      model: openrouter(modelName),
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
}
