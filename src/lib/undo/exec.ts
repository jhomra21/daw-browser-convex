import type { HistoryEntry, ClipSnapshot, ClipTiming } from './types'

type Deps = {
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  setTracks: (updater: any) => void
  audioBufferCache: Map<string, AudioBuffer>
  roomId: string
  userId: string
  audioEngine?: any
}

function applyLocalDeleteClip(setTracks: Deps['setTracks'], trackId: string, clipId: string) {
  setTracks((ts: any[]) => ts.map(t => t.id !== trackId ? t : ({ ...t, clips: t.clips.filter((c: any) => c.id !== clipId) })))
}

function applyLocalAddClip(setTracks: Deps['setTracks'], trackId: string, clip: any) {
  setTracks((ts: any[]) => ts.map(t => t.id !== trackId ? t : ({ ...t, clips: [...t.clips, clip] })))
}

function applyLocalMoveClip(setTracks: Deps['setTracks'], clipId: string, toTrackId: string, startSec: number) {
  setTracks((ts: any[]) => {
    let moving: any | null = null
    const pruned = ts.map(t => {
      if (t.clips.some((c: any) => c.id === clipId)) {
        const found = t.clips.find((c: any) => c.id === clipId)
        moving = found ? { ...found } : null
        return { ...t, clips: t.clips.filter((c: any) => c.id !== clipId) }
      }
      return t
    })
    if (!moving) return ts
    moving.startSec = startSec
    return pruned.map(t => t.id !== toTrackId ? t : ({ ...t, clips: [...t.clips, moving] }))
  })
}

function applyLocalSetTiming(setTracks: Deps['setTracks'], clipId: string, timing: ClipTiming) {
  setTracks((ts: any[]) => ts.map(t => ({
    ...t,
    clips: t.clips.map((c: any) => c.id !== clipId ? c : ({ ...c, startSec: timing.startSec, duration: timing.duration, leftPadSec: timing.leftPadSec ?? c.leftPadSec, bufferOffsetSec: (timing as any).bufferOffsetSec ?? (c as any).bufferOffsetSec, midiOffsetBeats: (timing as any).midiOffsetBeats ?? (c as any).midiOffsetBeats }))
  })))
}

export async function execUndo(entry: HistoryEntry, deps: Deps) {
  const { convexClient, convexApi, setTracks, audioBufferCache, roomId, userId, audioEngine } = deps
  switch (entry.type) {
    case 'clip-create': { // inverse: delete the created/current clip
      const idToDelete = entry.data.clip.currentId || entry.data.clip.originalId
      try { await convexClient.mutation((convexApi as any).clips.removeMany, { clipIds: [idToDelete] as any, userId: userId as any }) } catch {}
      applyLocalDeleteClip(setTracks, entry.data.trackId, idToDelete)
      entry.data.clip.currentId = undefined
      break
    }
    case 'clip-delete': { // inverse: recreate clips per original track
      const sourceItems = (() => {
        if (entry.data.items && entry.data.items.length) return entry.data.items
        const legacyClips: ClipSnapshot[] | undefined = (entry.data as any).clips
        const legacyTrackId: string | undefined = (entry.data as any).trackId
        if (legacyClips && legacyTrackId) {
          return legacyClips.map(clip => ({ trackId: legacyTrackId, clip }))
        }
        return [] as Array<{ trackId: string; clip: ClipSnapshot }>
      })()
      if (sourceItems.length === 0) break
      // Upgrade legacy entries so subsequent redo/undo use new schema
      entry.data.items = sourceItems
      // Bulk create for atomic UI update and correct redo tracking
      const items = sourceItems.map(({ trackId, clip: c }) => ({
        roomId,
        trackId: trackId as any,
        startSec: c.startSec,
        duration: c.duration,
        userId,
        name: c.name,
        ...(c.midi ? { midi: c.midi } : {}),
        leftPadSec: c.timing?.leftPadSec,
        bufferOffsetSec: c.timing?.bufferOffsetSec,
        midiOffsetBeats: c.timing?.midiOffsetBeats,
      }))
      let newIds: string[] = []
      try {
        newIds = await convexClient.mutation((convexApi as any).clips.createMany, { items }) as any as string[]
      } catch {}
      // Best-effort follow-ups for sampleUrl and timing to mirror original state
      for (let i = 0; i < sourceItems.length; i++) {
        const { clip: c } = sourceItems[i]
        const id = newIds[i]
        if (!id) continue
        if (c.sampleUrl) { try { await convexClient.mutation((convexApi as any).clips.setSampleUrl, { clipId: id as any, sampleUrl: c.sampleUrl }) } catch {} }
        if (c.timing && (typeof c.timing.leftPadSec === 'number' || typeof c.timing.bufferOffsetSec === 'number' || typeof c.timing.midiOffsetBeats === 'number')) {
          const t = c.timing
          try { await convexClient.mutation((convexApi as any).clips.setTiming, { clipId: id as any, startSec: c.startSec, duration: c.duration, leftPadSec: t.leftPadSec ?? 0, bufferOffsetSec: t.bufferOffsetSec ?? 0, midiOffsetBeats: t.midiOffsetBeats ?? 0 }) } catch {}
        }
      }
      // Local add in a single batch per track to avoid one-by-one flicker
      const perTrackAdds = new Map<string, any[]>()
      for (let i = 0; i < sourceItems.length; i++) {
        const it = sourceItems[i]
        const c = it.clip
        const tid = it.trackId as string
        const id = newIds[i] || crypto.randomUUID()
        if (!id) continue
        const arr = perTrackAdds.get(tid) ?? []
        arr.push({
          id,
          name: c.name || 'Clip',
          buffer: null,
          startSec: c.startSec,
          duration: c.duration,
          color: '#22c55e',
          sampleUrl: c.sampleUrl,
          midi: c.midi,
          leftPadSec: c.timing?.leftPadSec,
          bufferOffsetSec: c.timing?.bufferOffsetSec,
          midiOffsetBeats: c.timing?.midiOffsetBeats,
        })
        perTrackAdds.set(tid, arr)
      }
      setTracks((ts: any[]) => ts.map(t => {
        const adds = perTrackAdds.get(t.id)
        if (!adds || adds.length === 0) return t
        const merged = [...t.clips, ...adds].sort((a: any, b: any) => (a.startSec ?? 0) - (b.startSec ?? 0))
        return { ...t, clips: merged }
      }))
      entry.data.recreatedClipIds = newIds.filter(Boolean)
      break
    }
    case 'clips-move': { // inverse: move back to from
      for (const m of entry.data.moves) {
        try { await convexClient.mutation((convexApi as any).clips.move, { clipId: m.clipId as any, startSec: m.from.startSec, toTrackId: m.from.trackId as any }) } catch {}
        applyLocalMoveClip(setTracks, m.clipId, m.from.trackId, m.from.startSec)
      }
      if (audioEngine) {
        try { audioEngine.rescheduleClipsAtPlayhead?.(undefined, undefined, entry.data.moves.map(m => m.clipId)) } catch {}
      }
      break
    }
    case 'clip-timing': {
      const t = entry.data.from
      try { await convexClient.mutation((convexApi as any).clips.setTiming, { clipId: entry.data.clipId as any, startSec: t.startSec, duration: t.duration, leftPadSec: t.leftPadSec ?? 0, bufferOffsetSec: t.bufferOffsetSec ?? 0, midiOffsetBeats: t.midiOffsetBeats ?? 0 }) } catch {}
      applyLocalSetTiming(setTracks, entry.data.clipId, t)
      if (audioEngine) {
        try { audioEngine.rescheduleClipsAtPlayhead?.(undefined, undefined, [entry.data.clipId]) } catch {}
      }
      break
    }
    case 'track-create': { // inverse: remove the track
      try { await convexClient.mutation((convexApi as any).tracks.remove, { trackId: entry.data.trackId as any, userId }) } catch {}
      setTracks((ts: any[]) => ts.filter(t => t.id !== entry.data.trackId))
      break
    }
    case 'track-delete': { // inverse: recreate track + clips + effects
      let newTrackId: string = ''
      try { newTrackId = await convexClient.mutation((convexApi as any).tracks.create, { roomId, userId, kind: entry.data.track.kind } as any) as any as string } catch {}
      if (!newTrackId) break
      entry.data.recreatedTrackId = newTrackId
      // Set volume; mute/solo best-effort via setMix if owned server supports it
      try { await convexClient.mutation((convexApi as any).tracks.setVolume, { trackId: newTrackId as any, volume: entry.data.track.volume }) } catch {}
      try {
        const payload: any = { trackId: newTrackId as any }
        if (typeof entry.data.track.muted === 'boolean') payload.muted = entry.data.track.muted
        if (typeof entry.data.track.soloed === 'boolean') payload.soloed = entry.data.track.soloed
        if ('muted' in payload || 'soloed' in payload) await convexClient.mutation((convexApi as any).tracks.setMix, payload)
      } catch {}
      // Local insertion (name locally only)
      setTracks((ts: any[]) => ts.some(t => t.id === newTrackId) ? ts : [...ts, { id: newTrackId, name: entry.data.track.name, volume: entry.data.track.volume, clips: [], muted: entry.data.track.muted ?? false, soloed: entry.data.track.soloed ?? false, kind: entry.data.track.kind ?? 'audio' }])
      // Effects
      try {
        if (entry.data.effects?.eq) await convexClient.mutation((convexApi as any).effects.setEqParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.eq })
      } catch {}
      try {
        if (entry.data.effects?.reverb) await convexClient.mutation((convexApi as any).effects.setReverbParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.reverb })
      } catch {}
      try {
        if (entry.data.effects?.synth) await convexClient.mutation((convexApi as any).effects.setSynthParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.synth })
      } catch {}
      try {
        if (entry.data.effects?.arp) await convexClient.mutation((convexApi as any).effects.setArpeggiatorParams, { roomId, trackId: newTrackId as any, userId, params: entry.data.effects.arp })
      } catch {}
      // Recreate clips
      const created: string[] = []
      for (const c of entry.data.clips) {
        let newId: string = ''
        try {
          newId = await convexClient.mutation((convexApi as any).clips.create, { roomId, trackId: newTrackId as any, startSec: c.startSec, duration: c.duration, userId, name: c.name } as any) as any as string
        } catch {}
        if (!newId) continue
        if (c.sampleUrl) { try { await convexClient.mutation((convexApi as any).clips.setSampleUrl, { clipId: newId as any, sampleUrl: c.sampleUrl }) } catch {} }
        if (c.midi) { try { await convexClient.mutation((convexApi as any).clips.setMidi, { clipId: newId as any, midi: c.midi, userId }) } catch {} }
        if (c.timing) {
          const t = c.timing
          try { await convexClient.mutation((convexApi as any).clips.setTiming, { clipId: newId as any, startSec: c.startSec, duration: c.duration, leftPadSec: t.leftPadSec ?? 0, bufferOffsetSec: t.bufferOffsetSec ?? 0, midiOffsetBeats: t.midiOffsetBeats ?? 0 }) } catch {}
        }
        applyLocalAddClip(setTracks, newTrackId, {
          id: newId, name: c.name || 'Clip', buffer: null, startSec: c.startSec, duration: c.duration, color: '#22c55e', sampleUrl: c.sampleUrl, midi: c.midi,
          leftPadSec: c.timing?.leftPadSec, bufferOffsetSec: c.timing?.bufferOffsetSec, midiOffsetBeats: c.timing?.midiOffsetBeats,
        })
        created.push(newId)
      }
      entry.data.recreatedClipIds = created
      break
    }
    case 'track-volume': {
      try { await convexClient.mutation((convexApi as any).tracks.setVolume, { trackId: entry.data.trackId as any, volume: entry.data.from }) } catch {}
      setTracks((ts: any[]) => ts.map(t => t.id !== entry.data.trackId ? t : ({ ...t, volume: entry.data.from })))
      break
    }
    case 'track-mute': {
      try { await convexClient.mutation((convexApi as any).tracks.setMix, { trackId: entry.data.trackId as any, muted: entry.data.from }) } catch {}
      setTracks((ts: any[]) => ts.map(t => t.id !== entry.data.trackId ? t : ({ ...t, muted: entry.data.from })))
      break
    }
    case 'track-solo': {
      try { await convexClient.mutation((convexApi as any).tracks.setMix, { trackId: entry.data.trackId as any, soloed: entry.data.from }) } catch {}
      setTracks((ts: any[]) => ts.map(t => t.id !== entry.data.trackId ? t : ({ ...t, soloed: entry.data.from })))
      break
    }
    case 'effect-params': {
      const { effect, targetId, from } = entry.data
      try {
        if (effect === 'master-eq') await convexClient.mutation((convexApi as any).effects.setMasterEqParams, { roomId, userId, params: from })
        else if (effect === 'master-reverb') await convexClient.mutation((convexApi as any).effects.setMasterReverbParams, { roomId, userId, params: from })
        else if (effect === 'eq') await convexClient.mutation((convexApi as any).effects.setEqParams, { roomId, trackId: targetId as any, userId, params: from })
        else if (effect === 'reverb') await convexClient.mutation((convexApi as any).effects.setReverbParams, { roomId, trackId: targetId as any, userId, params: from })
        else if (effect === 'synth') await convexClient.mutation((convexApi as any).effects.setSynthParams, { roomId, trackId: targetId as any, userId, params: from })
        else if (effect === 'arp') await convexClient.mutation((convexApi as any).effects.setArpeggiatorParams, { roomId, trackId: targetId as any, userId, params: from })
      } catch {}
      try {
        if (effect === 'master-eq') audioEngine?.setMasterEq?.(from)
        else if (effect === 'master-reverb') audioEngine?.setMasterReverb?.(from)
        else if (effect === 'eq') audioEngine?.setTrackEq?.(targetId, from)
        else if (effect === 'reverb') audioEngine?.setTrackReverb?.(targetId, from)
        else if (effect === 'synth') audioEngine?.setTrackSynth?.(targetId, from)
        else if (effect === 'arp') audioEngine?.setTrackArpeggiator?.(targetId, from)
      } catch {}
      break
    }
  }
}

export async function execRedo(entry: HistoryEntry, deps: Deps) {
  const { convexClient, convexApi, setTracks, audioBufferCache, roomId, userId, audioEngine } = deps
  switch (entry.type) {
    case 'clip-create': { // redo: create again
      let newId = ''
      const c = entry.data.clip
      try {
        newId = await convexClient.mutation((convexApi as any).clips.create, { roomId, trackId: entry.data.trackId as any, startSec: c.startSec, duration: c.duration, userId, name: c.name } as any) as any as string
      } catch {}
      if (!newId) break
      if (c.sampleUrl) { try { await convexClient.mutation((convexApi as any).clips.setSampleUrl, { clipId: newId as any, sampleUrl: c.sampleUrl }) } catch {} }
      if (c.midi) { try { await convexClient.mutation((convexApi as any).clips.setMidi, { clipId: newId as any, midi: c.midi, userId }) } catch {} }
      if (c.timing) {
        const t = c.timing
        try { await convexClient.mutation((convexApi as any).clips.setTiming, { clipId: newId as any, startSec: c.startSec, duration: c.duration, leftPadSec: t.leftPadSec ?? 0, bufferOffsetSec: t.bufferOffsetSec ?? 0, midiOffsetBeats: t.midiOffsetBeats ?? 0 }) } catch {}
      }
      entry.data.clip.currentId = newId
      applyLocalAddClip(setTracks, entry.data.trackId, {
        id: newId, name: c.name || 'Clip', buffer: null, startSec: c.startSec, duration: c.duration, color: '#22c55e', sampleUrl: c.sampleUrl, midi: c.midi,
        leftPadSec: c.timing?.leftPadSec, bufferOffsetSec: c.timing?.bufferOffsetSec, midiOffsetBeats: c.timing?.midiOffsetBeats,
      })
      break
    }
    case 'clip-delete': { // redo: delete recreated clips
      const ids = entry.data.recreatedClipIds || []
      if (ids.length === 0) break
      try { await convexClient.mutation((convexApi as any).clips.removeMany, { clipIds: ids as any, userId: userId as any }) } catch {}
      // Remove locally across all tracks to be robust
      setTracks((ts: any[]) => ts.map(t => ({ ...t, clips: t.clips.filter((c: any) => !ids.includes(c.id)) })))
      break
    }
    case 'clips-move': { // redo: move to "to"
      for (const m of entry.data.moves) {
        try { await convexClient.mutation((convexApi as any).clips.move, { clipId: m.clipId as any, startSec: m.to.startSec, toTrackId: m.to.trackId as any }) } catch {}
        applyLocalMoveClip(setTracks, m.clipId, m.to.trackId, m.to.startSec)
      }
      if (audioEngine) {
        try { audioEngine.rescheduleClipsAtPlayhead?.(undefined, undefined, entry.data.moves.map(m => m.clipId)) } catch {}
      }
      break
    }
    case 'clip-timing': {
      const t = entry.data.to
      try { await convexClient.mutation((convexApi as any).clips.setTiming, { clipId: entry.data.clipId as any, startSec: t.startSec, duration: t.duration, leftPadSec: t.leftPadSec ?? 0, bufferOffsetSec: t.bufferOffsetSec ?? 0, midiOffsetBeats: t.midiOffsetBeats ?? 0 }) } catch {}
      applyLocalSetTiming(setTracks, entry.data.clipId, t)
      if (audioEngine) {
        try { audioEngine.rescheduleClipsAtPlayhead?.(undefined, undefined, [entry.data.clipId]) } catch {}
      }
      break
    }
    case 'track-create': { // redo: create again (new id)
      let newId = ''
      try { newId = await convexClient.mutation((convexApi as any).tracks.create, { roomId, userId, kind: entry.data.kind } as any) as any as string } catch {}
      if (!newId) break
      // local add (minimal)
      setTracks((ts: any[]) => ts.some(t => t.id === newId) ? ts : [...ts, { id: newId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [], muted: false, soloed: false }])
      // Note: we don't overwrite entry.data.trackId; this entry remains id-agnostic on redo
      break
    }
    case 'track-delete': { // redo: remove recreated track
      const tid = entry.data.recreatedTrackId
      if (!tid) break
      try { await convexClient.mutation((convexApi as any).tracks.remove, { trackId: tid as any, userId }) } catch {}
      setTracks((ts: any[]) => ts.filter(t => t.id !== tid))
      break
    }
    case 'track-volume': {
      try { await convexClient.mutation((convexApi as any).tracks.setVolume, { trackId: entry.data.trackId as any, volume: entry.data.to }) } catch {}
      setTracks((ts: any[]) => ts.map(t => t.id !== entry.data.trackId ? t : ({ ...t, volume: entry.data.to })))
      break
    }
    case 'track-mute': {
      try { await convexClient.mutation((convexApi as any).tracks.setMix, { trackId: entry.data.trackId as any, muted: entry.data.to }) } catch {}
      setTracks((ts: any[]) => ts.map(t => t.id !== entry.data.trackId ? t : ({ ...t, muted: entry.data.to })))
      break
    }
    case 'track-solo': {
      try { await convexClient.mutation((convexApi as any).tracks.setMix, { trackId: entry.data.trackId as any, soloed: entry.data.to }) } catch {}
      setTracks((ts: any[]) => ts.map(t => t.id !== entry.data.trackId ? t : ({ ...t, soloed: entry.data.to })))
      break
    }
    case 'effect-params': {
      const { effect, targetId, to } = entry.data
      try {
        if (effect === 'master-eq') await convexClient.mutation((convexApi as any).effects.setMasterEqParams, { roomId, userId, params: to })
        else if (effect === 'master-reverb') await convexClient.mutation((convexApi as any).effects.setMasterReverbParams, { roomId, userId, params: to })
        else if (effect === 'eq') await convexClient.mutation((convexApi as any).effects.setEqParams, { roomId, trackId: targetId as any, userId, params: to })
        else if (effect === 'reverb') await convexClient.mutation((convexApi as any).effects.setReverbParams, { roomId, trackId: targetId as any, userId, params: to })
        else if (effect === 'synth') await convexClient.mutation((convexApi as any).effects.setSynthParams, { roomId, trackId: targetId as any, userId, params: to })
        else if (effect === 'arp') await convexClient.mutation((convexApi as any).effects.setArpeggiatorParams, { roomId, trackId: targetId as any, userId, params: to })
      } catch {}
      try {
        if (effect === 'master-eq') audioEngine?.setMasterEq?.(to)
        else if (effect === 'master-reverb') audioEngine?.setMasterReverb?.(to)
        else if (effect === 'eq') audioEngine?.setTrackEq?.(targetId, to)
        else if (effect === 'reverb') audioEngine?.setTrackReverb?.(targetId, to)
        else if (effect === 'synth') audioEngine?.setTrackSynth?.(targetId, to)
        else if (effect === 'arp') audioEngine?.setTrackArpeggiator?.(targetId, to)
      } catch {}
      break
    }
  }
}
