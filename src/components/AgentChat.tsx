import { type Component, For, Show, createSignal, createEffect } from 'solid-js'
import { CommandsEnvelopeSchema, type CommandsEnvelope } from '~/lib/agent-commands'

// Minimal message type for local chat UI
type Msg = { role: 'user' | 'assistant'; content: string }

// Fallback: infer simple copy/move commands when model forgets JSON
function inferCommandsFromText(textRaw: string, opts?: { guessTrack?: number }): CommandsEnvelope | null {
  const text = textRaw.toLowerCase()
  // helper to collect track numbers from phrases like "track 2", "tracks 1, 3 and 5"
  const collectTrackNums = (): number[] => {
    const m = text.match(/tracks?[^0-9]*(\d+(?:[^0-9]+\d+)*)/)
    if (m) {
      const nums = (m[1].match(/\d+/g) || []).map(Number)
      if (nums.length) return nums
    }
    const singles = Array.from(text.matchAll(/track\s+(\d+)/g)).map(m => Number(m[1]))
    return singles
  }

  // mute / unmute
  if (/\b(unmute|mute)\b/.test(text) && /\btrack\b|\btracks\b/.test(text)) {
    const nums = collectTrackNums()
    const value = !/\bunmute\b/.test(text)
    const cmd: any = { type: 'setMute', value }
    if (nums.length > 1) cmd.trackIndices = nums
    else if (nums.length === 1) cmd.trackIndex = nums[0]
    const env = { commands: [cmd] }
    const ok = CommandsEnvelopeSchema.safeParse(env)
    if (ok.success) return ok.data
  }

  // solo / unsolo (allow exclusive with "solo only" or "solo just")
  if (/\b(unsolo|solo)\b/.test(text) && /\btrack\b|\btracks\b/.test(text)) {
    const nums = collectTrackNums()
    const value = !/\bunsolo\b/.test(text)
    const exclusive = /\bsolo\b\s+(only|just)\b/.test(text)
    const cmd: any = { type: 'setSolo', value }
    if (exclusive && value) cmd.exclusive = true
    if (nums.length > 1) cmd.trackIndices = nums
    else if (nums.length === 1) cmd.trackIndex = nums[0]
    const env = { commands: [cmd] }
    const ok = CommandsEnvelopeSchema.safeParse(env)
    if (ok.success) return ok.data
  }

  // add/place project samples to a track with optional pattern
  {
    const mentionsSample = /\b(samples?|kick|snare|hihat|hi-?hat|hat|clap|loop|vocal|bass)\b/.test(text)
    const wantsAdd = /\b(add|place|drop|insert)\b/.test(text)
    if (wantsAdd && mentionsSample) {
      // Track index (1-based)
      const nums = collectTrackNums()
      // Extract sample query
      let sampleQuery = (() => {
        // Quoted explicit sample name has highest priority
        const q = text.match(/\"([^\"]+)\"/)
        if (q) return q[1]
        // Prefer phrases like "with <sample>" or "using <sample>"
        const w = text.match(/\b(?:with|using)\b\s+(.+?)(?:\s+(?:in|to|onto|on)\s+track|\s+pattern|\s+at\s+|$)/)
        if (w) return w[1].replace(/\b(the|a|some|sample|samples)\b/g, '').trim()
        // Then common instrument tokens
        const common = text.match(/\b(kick|snare|hihat|hi-?hat|hat|clap|loop|vocal|bass)\b/)
        if (common) return common[1]
        // Last resort: capture after add/place/drop/insert but avoid grabbing pattern words
        const m = text.match(/\b(?:add|place|drop|insert)\b\s+(.+?)(?:\s+(?:to|onto|on)\s+track|\s+pattern|\s+at\s+|$)/)
        if (m) return m[1].replace(/\b(the|a|some|sample|samples|pattern|beat|four|floor|on|4x4|4)\b/g, '').trim()
        return ''
      })()
      if (!sampleQuery) sampleQuery = 'sample'

      // Pattern and timing
      let pattern: 'fourOnFloor'|'everyBeat'|'everyHalf'|undefined
      if (/four[\s-]*on[\s-]*the[\s-]*floor|\b4\s*on\s*(?:the\s*)?floor\b|\bfour\s*on\s*4\b|\b4\s*on\s*4\b|\bfour\s*on\s*four\b|\b4x4\b|\bfour-?on-?four\b/.test(text)) pattern = 'fourOnFloor'
      else if (/(simple\s+beat|every\s+beat|each\s+beat)/.test(text)) pattern = 'everyBeat'
      else if (/(every\s+half|half\s+beat)/.test(text)) pattern = 'everyHalf'

      const bpmMatch = text.match(/\b(\d{2,3})\s*bpm\b/)
      const bpm = bpmMatch ? Number(bpmMatch[1]) : undefined

      const startMatch = text.match(/(?:at|starting\s+at)\s*(\d+(?:\.\d+)?)\s*s\b/)
      const startSec = startMatch ? Number(startMatch[1]) : undefined

      const countMatch = text.match(/\b(repeat\s+)?(\d+)\s*(?:times|x)\b/) || text.match(/\brepeat\s+(\d+)\b/)
      const count = countMatch ? Number(countMatch[2] || countMatch[1]) : undefined

      const intervalMatch = text.match(/\bevery\s+(\d+(?:\.\d+)?)\s*(?:sec|second|seconds|s)\b|\bspac(?:ed|e)\s*(?:by\s*)?(\d+(?:\.\d+)?)\s*(?:sec|second|seconds|s)\b/)
      const intervalSec = intervalMatch ? Number(intervalMatch[1] || intervalMatch[2]) : undefined

      const cmd: any = { type: 'addSampleClips', sampleQuery }
      if (nums.length === 1) cmd.trackIndex = nums[0]
      if (typeof startSec === 'number') cmd.startSec = startSec
      if (typeof count === 'number') cmd.count = count
      if (typeof intervalSec === 'number') cmd.intervalSec = intervalSec
      if (pattern) cmd.pattern = pattern
      if (typeof bpm === 'number') cmd.bpm = bpm
      const env = { commands: [cmd] }
      const ok = CommandsEnvelopeSchema.safeParse(env)
      if (ok.success) return ok.data
    }
  }

  // create a new [audio|instrument] track [and copy clips from track X into it]
  {
    const createMatch = text.match(/\b(add|create)\b[\s\S]*?\b(new)?\b[\s\S]*?\b(audio|instrument)?\b[\s\S]*?\btrack\b/)
    if (createMatch) {
      // Determine kind if specified
      const kindMatch = text.match(/\b(audio|instrument)\b[\s\S]*?\btrack\b/)
      const kind = (kindMatch ? kindMatch[1] : undefined) as 'audio' | 'instrument' | undefined
      // If also asks to copy into it from a specific track
      const copyIntoIt = text.match(/\b(copy|duplicate)\b[\s\S]*?from\s+track\s+(\d+)[\s\S]*?(?:into|to)\s+it\b/)
      if (copyIntoIt) {
        const from = Number(copyIntoIt[2])
        const env = {
          commands: [
            { type: 'createTrack', kind },
            { type: 'copyClips', fromTrackIndex: from, keepRelativePositions: true }, // toTrackIndex omitted -> defaults to last
          ],
        } as any
        const ok = CommandsEnvelopeSchema.safeParse(env)
        return ok.success ? ok.data : null
      }
      // Only create track
      const env = { commands: [ { type: 'createTrack', kind } ] } as any
      const ok = CommandsEnvelopeSchema.safeParse(env)
      if (ok.success) return ok.data
    }
  }
  // copy clips from track X into it (use last track as target)
  {
    const copyIntoIt = text.match(/\b(copy|duplicate)\b[\s\S]*?from\s+track\s+(\d+)[\s\S]*?(?:into|to)\s+it\b/)
    if (copyIntoIt) {
      const from = Number(copyIntoIt[2])
      const env = { commands: [ { type: 'copyClips', fromTrackIndex: from, keepRelativePositions: true } ] } as any
      const ok = CommandsEnvelopeSchema.safeParse(env)
      return ok.success ? ok.data : null
    }
  }
  // copy/duplicate clips from track X to track Y [optional: N clips]
  let m = text.match(/\b(copy|duplicate)\b[\s\S]*?track\s+(\d+)\s*(?:to|onto|->)\s*track\s+(\d+)/)
  if (m) {
    const from = Number(m[2])
    const to = Number(m[3])
    const countMatch = text.match(/\b(\d+)\s+clips?\b/)
    const count = countMatch ? Number(countMatch[1]) : undefined
    const env = { commands: [ { type: 'copyClips', fromTrackIndex: from, toTrackIndex: to, count, keepRelativePositions: true } ] } as any
    const ok = CommandsEnvelopeSchema.safeParse(env)
    return ok.success ? ok.data : null
  }
  // move clips from track X to track Y [optional: N clips] [optional: starting at Ns]
  m = text.match(/\bmove\b[\s\S]*?track\s+(\d+)\s*(?:to|onto|->)\s*track\s+(\d+)/)
  if (m) {
    const from = Number(m[1])
    const to = Number(m[2])
    const countMatch = text.match(/\b(\d+)\s+clips?\b/)
    const count = countMatch ? Number(countMatch[1]) : undefined
    const startMatch = text.match(/(?:at|to|starting at)\s*(\d+(?:\.\d+)?)\s*s/)
    const newStartSec = startMatch ? Number(startMatch[1]) : undefined
    const env = { commands: [ { type: 'moveClips', fromTrackIndex: from, toTrackIndex: to, count, newStartSec, keepRelativePositions: true } ] } as any
    const ok = CommandsEnvelopeSchema.safeParse(env)
    return ok.success ? ok.data : null
  }
  // delete/remove/clear all clips in track X
  let m2 = text.match(/\b(delete|remove|clear)\b[\s\S]*?\b(all|every)?\b[\s\S]*?clips?[\s\S]*?track\s+(\d+)/)
  if (m2) {
    const t = Number(m2[3])
    const env = { commands: [ { type: 'removeMany', trackIndex: t, rangeStartSec: 0, rangeEndSec: 1e9 } ] } as any
    const ok = CommandsEnvelopeSchema.safeParse(env)
    return ok.success ? ok.data : null
  }
  // add/enable effects to track X: arp, eq, reverb
  const wantsAdd = /\b(add|enable|turn on)\b/.test(text)
  const trackMatch = text.match(/track\s+(\d+)/)
  if (wantsAdd && (trackMatch || typeof opts?.guessTrack === 'number')) {
    const t = Number(trackMatch ? trackMatch[1] : opts?.guessTrack)
    const wantsArp = /\b(arp|arpeggiator)\b/.test(text)
    const wantsEq = /\b(eq|equalizer)\b/.test(text)
    const wantsReverb = /\breverb\b/.test(text)
    const commands: any[] = []
    if (wantsArp) {
      commands.push({ type: 'setArpeggiatorParams', trackIndex: t, enabled: true, pattern: 'up', rate: '1/8', octaves: 1, gate: 0.8, hold: false })
    }
    if (wantsEq) {
      commands.push({
        type: 'setEqParams',
        target: t,
        enabled: true,
        bands: [
          { id: 'low', type: 'lowshelf', frequency: 120, gainDb: 0, q: 0.7, enabled: true },
          { id: 'mid', type: 'peaking', frequency: 1000, gainDb: 0, q: 1.0, enabled: true },
          { id: 'high', type: 'highshelf', frequency: 8000, gainDb: 0, q: 0.7, enabled: true },
        ],
      })
    }
    if (wantsReverb) {
      commands.push({ type: 'setReverbParams', target: t, enabled: true, wet: 0.2, decaySec: 2.0, preDelayMs: 20 })
    }
    if (commands.length) {
      const env = { commands }
      const ok = CommandsEnvelopeSchema.safeParse(env)
      return ok.success ? ok.data : null
    }
  }
  // update effect params: arp rate, synth wave, reverb wet on track X
  {
    // Try to find a track number in this text; if absent, caller may retry on previous user msg
    const tMatch = text.match(/track\s+(\d+)/)
    const t = tMatch ? Number(tMatch[1]) : (opts?.guessTrack)
    const commands: any[] = []
    // Arp rate like 1/16, 1/8, 1/4, 1/32
    const rateMatch = text.match(/\b(1\/(?:4|8|16|32))\b/)
    if (rateMatch && /\b(arp|arpeggiator)\b/.test(text) && t) {
      const rate = rateMatch[1] as '1/4'|'1/8'|'1/16'|'1/32'
      commands.push({ type: 'setArpeggiatorParams', trackIndex: t, enabled: true, pattern: 'up', rate, octaves: 1, gate: 0.8, hold: false })
    }
    // Synth wave
    const waveMatch = text.match(/\b(sine|square|triangle|tri|saw|sawtooth)\b\s*(?:wave)?/)
    if (waveMatch && /\b(synth)\b/.test(text) && t) {
      const raw = waveMatch[1]
      const wave = raw === 'tri' ? 'triangle' : (raw === 'saw' ? 'sawtooth' : raw)
      commands.push({ type: 'setSynthParams', trackIndex: t, wave })
    }
    // Reverb wet percent
    const wetMatch = text.match(/\b(\d{1,3})%\s*wet\b/)
    if (wetMatch && /\breverb\b/.test(text) && t) {
      const pct = Math.max(0, Math.min(100, Number(wetMatch[1])))
      const wet = Math.round((pct / 100) * 100) / 100
      commands.push({ type: 'setReverbParams', target: t, enabled: true, wet, decaySec: 2.0, preDelayMs: 20 })
    }
    if (commands.length) {
      const env = { commands }
      const ok = CommandsEnvelopeSchema.safeParse(env)
      return ok.success ? ok.data : null
    }
  }
  return null
}

// Remove obvious tool-call artifacts from some model replies
function stripArtifacts(text: string): string {
  let s = text
  // remove any <| ... |> control tokens
  s = s.replace(/<\|[^>]*\|>/g, '')
  // remove lines containing tool routing noise like to=repo_browser.*
  s = s.split('\n').filter(line => !/to=\w+|repo_browser|code<\|/i.test(line)).join('\n')
  return s.trim()
}

// Remove a trailing ```json ...``` or ``` ...``` block from assistant text
function stripCommandJSON(text: string): string {
  // Remove any trailing fenced code block (```json ...``` or ``` ...```), allowing inline or newline
  let cleaned = text.replace(/```(?:json)?[\s\S]*?```\s*$/i, '')
  return cleaned.trim()
}

type AgentChatProps = {
  isOpen: boolean
  onClose: () => void
  roomId?: string
  bottomOffsetPx?: number
  bpm?: number
}

const AgentChat: Component<AgentChatProps> = (props) => {
  const [messages, setMessages] = createSignal<Msg[]>([])
  const [input, setInput] = createSignal('')
  const [streaming, setStreaming] = createSignal(false)
  let textareaRef: HTMLTextAreaElement | undefined
  const [parsedCommands, setParsedCommands] = createSignal<CommandsEnvelope | null>(null)
  const [executing, setExecuting] = createSignal(false)
  const [executeError, setExecuteError] = createSignal<string | null>(null)
  const [autoApply, setAutoApply] = createSignal(false)

  createEffect(() => {
    if (props.isOpen) {
      queueMicrotask(() => {
        try { textareaRef?.focus() } catch {}
      })
    }
  })

  // Load/save auto-apply preference
  createEffect(() => {
    try {
      const v = localStorage.getItem('agent_auto_apply')
      if (v) setAutoApply(v === '1')
    } catch {}
  })
  createEffect(() => {
    try { localStorage.setItem('agent_auto_apply', autoApply() ? '1' : '0') } catch {}
  })

  function tryExtractCommands() {
    const last = messages()[messages().length - 1]
    if (!last || last.role !== 'assistant') return
    // Determine if the latest USER message indicates an edit request
    const lastUserText = (() => {
      for (let i = messages().length - 1; i >= 0; i--) {
        const m = messages()[i]
        if (m?.role === 'user') return (m.content || '').toLowerCase()
      }
      return ''
    })()
    const editIntent = /\b(add|create|move|copy|delete|remove|set|insert|enable|mute|solo|place|drop)\b/.test(lastUserText)
    // Heuristic: find last mentioned track number in recent messages
    const guessTrack = (() => {
      for (let i = messages().length - 1; i >= 0 && i >= messages().length - 8; i--) {
        const m = messages()[i]
        const mm = m?.content?.toLowerCase().match(/track\s+(\d+)/)
        if (mm) return Number(mm[1])
      }
      return undefined
    })()
    // Only parse JSON commands from assistant when the user asked for changes
    let parsed = editIntent ? tryExtractJSONCommands(last.content) : null
    if (!parsed) {
      // Only infer commands from the latest USER message (never from assistant text)
      const prev = messages()[messages().length - 2]
      if (prev && prev.role === 'user' && editIntent) {
        parsed = inferCommandsFromText(prev.content, { guessTrack })
      }
    }
    setParsedCommands(parsed)
    // Strip JSON code block from the visible assistant message
    const cleaned = stripArtifacts(stripCommandJSON(last.content))
    setMessages(prev => {
      const arr = prev.slice()
      const idx = arr.length - 1
      if (idx >= 0 && arr[idx]?.role === 'assistant') {
        arr[idx] = { role: 'assistant', content: cleaned }
      }
      return arr
    })
    // Auto-apply if enabled and we have valid commands
    if (parsed && autoApply()) {
      // Replace with a short, non-instructional confirmation
      setMessages(prev => {
        const arr = prev.slice()
        const idx = arr.length - 1
        if (idx >= 0 && arr[idx]?.role === 'assistant') {
          arr[idx] = { role: 'assistant', content: 'Okay, applying changes…' }
        }
        return arr
      })
      void applyCommands()
    }
  }

  async function applyCommands() {
    const payload = parsedCommands()
    if (!payload || !props.roomId || executing()) return
    setExecuting(true)
    setExecuteError(null)
    try {
      // Determine intent from the most recent user message.
      const lastUserText = (() => {
        for (let i = messages().length - 1; i >= 0; i--) {
          const m = messages()[i]
          if (m?.role === 'user') return (m.content || '').toLowerCase()
        }
        return ''
      })()
      const wantsSolo = /\bsolo\b/.test(lastUserText)
      const mentionsMute = /\bmute\b/.test(lastUserText) || /\bunmute\b/.test(lastUserText)
      // If it's a solo request (and not a mute/unmute one), never send setMute to the executor.
      let effectiveCommands: any[] = payload.commands
      if (wantsSolo && !mentionsMute) {
        const extractNums = (): number[] => {
          const m = lastUserText.match(/tracks?[^0-9]*(\d+(?:[^0-9]+\d+)*)/)
          if (m) {
            const ns = (m[1].match(/\d+/g) || []).map(Number)
            if (ns.length) return ns
          }
          const singles = Array.from(lastUserText.matchAll(/track\s+(\d+)/g)).map(mm => Number(mm[1]))
          return singles
        }
        const nums = extractNums()
        const filtered = (payload.commands as any[]).filter(c => c?.type !== 'setMute')
        const hasSolo = filtered.some(c => c?.type === 'setSolo')
        if (!hasSolo) {
          if (nums.length > 1) filtered.push({ type: 'setSolo', trackIndices: nums, value: true })
          else if (nums.length === 1) filtered.push({ type: 'setSolo', trackIndex: nums[0], value: true, exclusive: true })
        }
        effectiveCommands = filtered
      }

      // Safety: whenever a setSolo command is present, remove any setMute commands to avoid unintended mutes.
      if (effectiveCommands.some((c: any) => c?.type === 'setSolo')) {
        effectiveCommands = effectiveCommands.filter((c: any) => c?.type !== 'setMute')
      }

      const res = await fetch('/api/agent/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: props.roomId, commands: effectiveCommands }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any)?.error || 'Execution failed')
      }
      const out = await res.json().catch(() => null) as any
      setParsedCommands(null)
      // Inline confirmation summary
      try {
        // Apply local mix changes to UI immediately (works even when Sync Mix is off)
        try {
          const cmds = effectiveCommands as any[]
          const mixOps: Array<{ type: 'setMute' | 'setSolo'; indices: number[]; value: boolean; exclusive?: boolean }> = []
          for (const c of cmds) {
            if (c?.type === 'setMute') {
              const indices = Array.isArray(c.trackIndices) && c.trackIndices.length
                ? c.trackIndices
                : (typeof c.trackIndex === 'number' ? [c.trackIndex] : [])
              mixOps.push({ type: 'setMute', indices, value: !!c.value })
            } else if (c?.type === 'setSolo') {
              const indices = Array.isArray(c.trackIndices) && c.trackIndices.length
                ? c.trackIndices
                : (typeof c.trackIndex === 'number' ? [c.trackIndex] : [])
              mixOps.push({ type: 'setSolo', indices, value: !!c.value, exclusive: !!c.exclusive })
            }
          }
          if (mixOps.length) {
            try { (window as any).__mbAgentApplyMix?.(props.roomId, mixOps) } catch {}
          }
        } catch {}
        const results = Array.isArray(out?.results) ? out.results as any[] : []
        const first = effectiveCommands[0] as any
        let summary = ''
        if (results.length === 1 && !results[0]?.error) {
          switch (first?.type) {
            case 'removeMany': {
              const n = results[0]?.removed ?? 0
              const t = first?.trackIndex
              summary = `Removed ${n} clip${n === 1 ? '' : 's'} from track ${t ?? ''}`.trim()
              break
            }
            case 'copyClips': {
              const n = results[0]?.created ?? 0
              const t = first?.toTrackIndex
              summary = `Copied ${n} clip${n === 1 ? '' : 's'} to track ${t}`
              break
            }
            case 'moveClips': {
              const n = results[0]?.moved ?? 0
              const t = first?.toTrackIndex ?? first?.fromTrackIndex
              summary = `Moved ${n} clip${n === 1 ? '' : 's'} ${first?.toTrackIndex ? `to track ${t}` : ''}`.trim()
              break
            }
            case 'deleteTrack': {
              const t = first?.trackIndex
              summary = `Deleted track ${t}`
              break
            }
            default:
              summary = ''
          }
        }
        if (!summary) {
          // Fallback generic summary
          const parts = results.map((r: any) => {
            if (!r) return ''
            if (r.error) return `${r.type}: ${r.error}`
            if (r.ok && (typeof r.removed === 'number')) return `${r.type}: removed ${r.removed}`
            if (r.ok && (typeof r.created === 'number')) return `${r.type}: created ${r.created}`
            if (r.ok && (typeof r.moved === 'number')) return `${r.type}: moved ${r.moved}`
            if (r.ok && (typeof r.updated === 'number')) return `${r.type}: updated ${r.updated}`
            if (r.ok) return `${r.type}: ok`
            return `${r.type}: done`
          }).filter(Boolean)
          summary = parts.length ? `Applied: ${parts.join(', ')}` : 'Done.'
        }
        setMessages(prev => [...prev, { role: 'assistant', content: summary }])
      } catch {}
    } catch (e: any) {
      setExecuteError(String(e?.message || e) )
    } finally {
      setExecuting(false)
    }
  }

  async function sendMessage() {
    const content = input().trim()
    if (!content || streaming()) return

    const userMsg: Msg = { role: 'user', content }
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)
    setParsedCommands(null)
    setExecuteError(null)
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: props.roomId,
          bpm: typeof props.bpm === 'number' ? props.bpm : undefined,
          // Use current messages but exclude the trailing placeholder assistant
          messages: [{
            role: 'system',
            content: 'You are a helpful DAW assistant.'
          }, ...messages().filter((m, i, arr) => !(i === arr.length - 1 && m.role === 'assistant' && m.content === ''))],
        }),
      })
      if (!res.ok || !res.body) {
        throw new Error('Request failed')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let done = false
      while (!done) {
        const chunk = await reader.read()
        done = chunk.done || false
        const text = decoder.decode(chunk.value || new Uint8Array(), { stream: !done })
        if (text) {
          // Append streamed text to last assistant message
          setMessages(prev => {
            const arr = prev.slice()
            const last = arr[arr.length - 1]
            if (last && last.role === 'assistant') {
              arr[arr.length - 1] = { role: 'assistant', content: last.content + text }
            }
            return arr
          })
        }
      }
      // Try to parse commands from the last assistant message
      tryExtractCommands()
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong.' }])
    } finally {
      setStreaming(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  return (
    <Show when={props.isOpen}>
      <div
        class="fixed left-0 bottom-0 w-[380px] h-[460px] bg-neutral-900 border-t border-r border-neutral-800 flex flex-col z-50 pointer-events-auto"
        style={{ bottom: `${props.bottomOffsetPx ?? 0}px` }}
      >
        <div class="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
          <div class="text-sm font-semibold text-neutral-200">AI Agent</div>
          <div class="flex items-center gap-2">
            <button
              class={`text-xs px-2 py-1 rounded border ${autoApply() ? 'border-green-500 text-green-400' : 'border-neutral-600 text-neutral-300'} hover:bg-neutral-800`}
              aria-pressed={autoApply()}
              onClick={() => setAutoApply(v => !v)}
              title="Auto-apply detected commands"
            >Auto: {autoApply() ? 'On' : 'Off'}</button>
            <button class="text-neutral-400 hover:text-white" onClick={props.onClose}>✕</button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          <For each={messages()}>{(m) => (
            <div class={m.role === 'user' ? 'text-right' : 'text-left'}>
              <div class={
                'inline-block max-w-[90%] rounded-md px-2 py-1 text-sm ' +
                (m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-100')
              }>
                {m.content}
              </div>
            </div>
          )}</For>
          <Show when={!autoApply() && parsedCommands()}>
            <div class="mt-2 p-2 bg-neutral-800 border border-neutral-700 rounded">
              <div class="text-xs text-neutral-300 mb-1">Proposed changes (JSON):</div>
              <pre class="text-[11px] leading-snug text-neutral-200 overflow-x-auto max-h-32"><code>{JSON.stringify(parsedCommands(), null, 2)}</code></pre>
              <div class="flex gap-2 mt-2 justify-end">
                <button
                  class="px-2 py-1 text-xs rounded border border-neutral-600 text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
                  disabled={executing()}
                  onClick={() => void applyCommands()}
                >{executing() ? 'Applying…' : 'Apply changes'}</button>
                <button
                  class="px-2 py-1 text-xs rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200"
                  onClick={() => setParsedCommands(null)}
                >Dismiss</button>
              </div>
              <Show when={executeError()}>
                <div class="text-xs text-red-400 mt-2">{executeError()}</div>
              </Show>
            </div>
          </Show>
        </div>
        <div class="border-t border-neutral-800 p-2">
          <textarea
            class="w-full h-[72px] resize-none rounded bg-neutral-800 text-neutral-100 p-2 text-sm outline-none"
            placeholder="Ask to add tracks, effects, synths, or clips..."
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            ref={el => (textareaRef = el)}
          />
          <div class="flex justify-end pt-2">
            <button
              disabled={streaming()}
              class="bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-white text-sm px-3 py-1 rounded border border-neutral-600"
              onClick={() => void sendMessage()}
            >
              {streaming() ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}

// Extract a JSON code block with { commands: [...] }
function tryExtractJSONCommands(text: string): CommandsEnvelope | null {
  // Look for ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```json\n([\s\S]*?)```/i) || text.match(/```\n([\s\S]*?)```/i)
  const candidate = codeBlockMatch ? codeBlockMatch[1] : (() => {
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1)
    return null
  })()
  if (!candidate) return null
  try {
    const obj = JSON.parse(candidate)
    const parsed = CommandsEnvelopeSchema.safeParse(obj)
    return parsed.success ? parsed.data : null
  } catch { return null }
}
export default AgentChat
