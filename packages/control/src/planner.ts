import {
  canonicalTrackCreation,
  getAutomationParameterDescriptor,
  hasValidReturnTrackPartition,
  normalizeAutomationPoints,
  normalizeArpeggiatorParams,
  normalizeAudioEffectParamsForUpdate,
  normalizeMasterVolume,
  normalizeTrackRouting,
  normalizeTrackInstrumentParams,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
  sidechainEligibilityError,
  sidechainTargetEligibilityError,
} from '@daw-browser/shared'
import { normalizeClipFades } from '@daw-browser/timeline-core/clip-fades'
import { collectDeletedTrackIdsV1 } from './trackDeletion'

type ContextualRefV1 = { source: 'persisted'; id: string } | { source: 'client'; clientRef: string }
type TrackRefV1 = ContextualRefV1
type ClipRefV1 = ContextualRefV1
type ProcessorRefV1 = ContextualRefV1
type ControlActionV1 = any
type ProjectSnapshotV1 = {
  project: any
  tracks: any[]
  clips: any[]
  processors: any[]
  automation: any[]
  sidechains: any[]
}
type PlannerRequest = { projectId: string; actions: ControlActionV1[] }
type Entity = 'track' | 'clip' | 'effect'

export type ControlPlanError = {
  code: 'validation' | 'not-found'
  message: string
  actionIndex: number
}

export type PlannedControlActionV1 = {
  actionIndex: number
  action: ControlActionV1
  changed: boolean
  generatedInstrumentInstanceId?: string
}

export type ControlPlanV1 = {
  snapshot: ProjectSnapshotV1
  actions: PlannedControlActionV1[]
  applied: boolean
  priorRevision: number
  revision: number
  resolvedRefs: Array<{ entity: Entity; clientRef: string; id: string; persisted: false }>
  warnings: Array<{ code: string; message: string; actionIndex?: number }>
  changeSummary: {
    actionCount: number
    changes: Array<{ actionIndex: number; kind: string; description: string }>
  }
}

const planError = (actionIndex: number, code: ControlPlanError['code'], message: string): never => {
  throw { code, message, actionIndex } satisfies ControlPlanError
}

const placeholderId = (entity: Entity, clientRef: string | undefined, actionIndex: number) => (
  `control:${entity}:${clientRef ?? actionIndex}`
)

const canonical = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value !== 'object') throw new Error('Unsupported planner value.')
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)

const referenceId = (
  ref: ContextualRefV1,
  entity: Entity,
  ids: Map<string, string>,
  actionIndex: number,
): string => {
  if (ref.source === 'persisted') return ref.id
  const id = ids.get(ref.clientRef)
  return id ?? planError(actionIndex, 'not-found', `Unknown client ${entity} reference "${ref.clientRef}".`)
}

const requireTrack = (
  ref: TrackRefV1,
  tracks: Map<string, ProjectSnapshotV1['tracks'][number]>,
  trackRefs: Map<string, string>,
  actionIndex: number,
): ProjectSnapshotV1['tracks'][number] => {
  const id = referenceId(ref, 'track', trackRefs, actionIndex)
  const track = tracks.get(id)
  return track ?? planError(actionIndex, 'not-found', `Track "${id}" was not found.`)
}

const requireClip = (
  ref: ClipRefV1,
  clips: Map<string, ProjectSnapshotV1['clips'][number]>,
  clipRefs: Map<string, string>,
  actionIndex: number,
): ProjectSnapshotV1['clips'][number] => {
  const id = referenceId(ref, 'clip', clipRefs, actionIndex)
  const clip = clips.get(id)
  return clip ?? planError(actionIndex, 'not-found', `Clip "${id}" was not found.`)
}

const requireEffect = (
  ref: ProcessorRefV1,
  processors: Map<string, ProjectSnapshotV1['processors'][number]>,
  effectRefs: Map<string, string>,
  actionIndex: number,
): ProjectSnapshotV1['processors'][number] => {
  const id = referenceId(ref, 'effect', effectRefs, actionIndex)
  const processor = processors.get(id)
  return processor ?? planError(actionIndex, 'not-found', `Effect "${id}" was not found.`)
}

const targetMatches = (
  processor: ProjectSnapshotV1['processors'][number],
  target: { kind: 'track'; track: ContextualRefV1 } | { kind: 'master' },
  tracks: Map<string, ProjectSnapshotV1['tracks'][number]>,
  trackRefs: Map<string, string>,
  actionIndex: number,
) => {
  if (target.kind === 'master') return 'master' in processor.target
  const track = requireTrack(target.track, tracks, trackRefs, actionIndex)
  return 'trackId' in processor.target && processor.target.trackId === track.id
}

const validateGroups = (
  tracks: Iterable<ProjectSnapshotV1['tracks'][number]>,
  actionIndex: number,
) => {
  const trackById = new Map(Array.from(tracks, (track) => [track.id, track]))
  for (const track of trackById.values()) {
    const seen = new Set<string>()
    let parentId = track.groupId
    while (parentId) {
      if (parentId === track.id || seen.has(parentId)) planError(actionIndex, 'validation', 'Track grouping creates a cycle.')
      seen.add(parentId)
      parentId = trackById.get(parentId)?.groupId
    }
  }
}

const describe = (action: ControlActionV1) => action.kind.replaceAll('.', ' ')

const isAudioEffectKind = (kind: string) => (
  kind === 'utility' || kind === 'eq' || kind === 'autofilter' || kind === 'gate'
  || kind === 'compressor' || kind === 'saturator' || kind === 'limiter' || kind === 'lofi'
  || kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo'
  || kind === 'autopan' || kind === 'ensemble' || kind === 'delay' || kind === 'reverb'
  || kind === 'spectral'
)

const validateAutomationTarget = (
  action: ControlActionV1,
  target: ProjectSnapshotV1['processors'][number]['target'],
  effect: ProjectSnapshotV1['processors'][number] | undefined,
  processors: Map<string, ProjectSnapshotV1['processors'][number]>,
  actionIndex: number,
) => {
  const descriptor = getAutomationParameterDescriptor(action.parameterId)
    ?? planError(actionIndex, 'validation', 'Unsupported automation parameter.')
  if (!descriptor.targetKinds.includes('master' in target ? 'master' : 'track')) {
    planError(actionIndex, 'validation', 'Unsupported automation parameter.')
  }
  if (descriptor.owner === 'mixer' && effect) {
    planError(actionIndex, 'validation', 'Mixer automation cannot reference an effect instance.')
  }
  const instrumentKey = parseInstrumentAutomationKey(action.parameterId)
  const granularKey = parseGranularAutomationKey(action.parameterId)
  const synthKey = parseSynthAutomationKey(action.parameterId)
  const instrumentAutomation = instrumentKey ?? granularKey ?? synthKey
  if (instrumentAutomation) {
    if ('master' in target || effect || instrumentAutomation.trackId !== target.trackId) {
      planError(actionIndex, 'validation', 'Instrument automation identity does not match its target.')
    }
    const instrument = Array.from(processors.values()).find((entry) => (
      'trackId' in entry.target
      && entry.target.trackId === target.trackId
      && entry.processor.kind === 'instrument'
    ))
    const params = instrument ? normalizeTrackInstrumentParams(instrument.processor.params) : undefined
    const kind = granularKey ? 'granular' : synthKey ? 'synth' : 'sampler'
    if (!params || params.instanceId !== instrumentAutomation.instanceId || params.kind !== kind) {
      planError(actionIndex, 'validation', 'Instrument automation instance does not belong to this track.')
    }
    return descriptor
  }
  if (descriptor.owner !== 'mixer') {
    if (!effect) planError(actionIndex, 'validation', 'Effect automation requires an effect instance.')
    if (effect.processor.kind !== descriptor.owner) {
      planError(actionIndex, 'validation', 'Automation effect instance does not belong to this target.')
    }
  }
  return descriptor
}

export const planControlRequestV1 = (
  base: ProjectSnapshotV1,
  request: PlannerRequest,
): ControlPlanV1 => {
  if (base.project.id !== request.projectId) {
    planError(0, 'not-found', 'Project snapshot does not match the request project.')
  }
  const snapshot = structuredClone(base)
  const tracks = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const clips = new Map(snapshot.clips.map((clip) => [clip.id, clip]))
  const processors = new Map(snapshot.processors.map((processor) => [processor.id, processor]))
  const trackRefs = new Map<string, string>()
  const clipRefs = new Map<string, string>()
  const effectRefs = new Map<string, string>()
  const resolvedRefs: ControlPlanV1['resolvedRefs'] = []
  const planned: PlannedControlActionV1[] = []

  const resolveTarget = (
    target: { kind: 'track'; track: ContextualRefV1 } | { kind: 'master' },
    actionIndex: number,
  ): ProjectSnapshotV1['processors'][number]['target'] => {
    if (target.kind === 'master') return { master: true }
    return { trackId: requireTrack(target.track, tracks, trackRefs, actionIndex).id }
  }

  for (const [actionIndex, action] of request.actions.entries()) {
    let changed = false
    switch (action.kind) {
      case 'project.rename': {
        const name = action.name.trim()
        changed = snapshot.project.name !== name
        snapshot.project.name = name
        break
      }
      case 'project.settings.set': {
        const project = snapshot.project
        const next = {
          tempoBpm: action.tempoBpm ?? project.tempoBpm,
          timeSignature: {
            numerator: action.timeSignatureNumerator ?? project.timeSignature.numerator,
            denominator: action.timeSignatureDenominator ?? project.timeSignature.denominator,
          },
          loop: {
            enabled: action.loopEnabled ?? project.loop.enabled,
            startSec: action.loopStartSec ?? project.loop.startSec,
            endSec: action.loopEndSec ?? project.loop.endSec,
          },
        }
        if (next.loop.endSec < next.loop.startSec + 0.05) planError(actionIndex, 'validation', 'Loop end must be at least 0.05 seconds after loop start.')
        changed = !same(
          { tempoBpm: project.tempoBpm, timeSignature: project.timeSignature, loop: project.loop },
          next,
        )
        project.tempoBpm = next.tempoBpm
        project.timeSignature = next.timeSignature
        project.loop = next.loop
        break
      }
      case 'track.create': {
        const id = placeholderId('track', action.clientRef, actionIndex)
        if (tracks.has(id)) planError(actionIndex, 'validation', `Track "${id}" already exists.`)
        const creation = canonicalTrackCreation(
          Array.from(tracks.values()),
          action.channelRole,
          action.index,
        )
        for (const existing of creation.existingTracks) {
          const current = tracks.get(existing.id)
          if (!current) continue
          current.index = existing.index
          current.groupId = existing.groupId
        }
        const index = creation.creationIndex
        const track = {
          id,
          name: action.name ?? `Track ${index + 1}`,
          index,
          kind: action.trackKind ?? 'audio',
          channelRole: action.channelRole ?? 'track',
          volume: 0.8,
          muted: false,
          soloed: false,
          sends: [],
        }
        tracks.set(id, track)
        snapshot.tracks.push(track)
        if (action.clientRef) {
          trackRefs.set(action.clientRef, id)
          resolvedRefs.push({ entity: 'track', clientRef: action.clientRef, id, persisted: false })
        }
        changed = true
        break
      }
      case 'track.rename': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        changed = track.name !== action.name.trim()
        track.name = action.name.trim()
        break
      }
      case 'track.mix.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const next = {
          volume: action.volume ?? track.volume,
          muted: action.muted ?? track.muted,
          soloed: action.soloed ?? track.soloed,
        }
        changed = !same({ volume: track.volume, muted: track.muted, soloed: track.soloed }, next)
        track.volume = next.volume
        track.muted = next.muted
        track.soloed = next.soloed
        break
      }
      case 'track.routing.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const outputTargetId = action.output === undefined
          ? track.outputTargetId
          : action.output === null ? undefined : requireTrack(action.output, tracks, trackRefs, actionIndex).id
        const sends = action.sends === undefined
          ? track.sends
          : action.sends.map((send: any) => ({
              targetTrackId: requireTrack(send.target, tracks, trackRefs, actionIndex).id,
              amount: send.amount,
              ...(send.tap === undefined ? {} : { tap: send.tap }),
            }))
        const normalized = normalizeTrackRouting({
          track: { id: track.id, channelRole: track.channelRole, groupId: track.groupId },
          outputTargetId,
          sends: sends.map((send: any) => ({ targetId: send.targetTrackId, amount: send.amount, tap: send.tap })),
          tracks: Array.from(tracks.values(), (value) => ({ id: value.id, channelRole: value.channelRole, groupId: value.groupId })),
        })
        const nextSends = normalized.sends.map((send) => ({
          targetTrackId: send.targetId,
          amount: send.amount,
          ...(send.tap === undefined ? {} : { tap: send.tap }),
        }))
        changed = !same(
          { outputTargetId: track.outputTargetId, sends: track.sends },
          { outputTargetId: normalized.outputTargetId, sends: nextSends },
        )
        track.outputTargetId = normalized.outputTargetId
        track.sends = nextSends
        break
      }
      case 'track.group.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const groupId = action.group === null ? undefined : requireTrack(action.group, tracks, trackRefs, actionIndex).id
        if (groupId && tracks.get(groupId)?.channelRole !== 'group') planError(actionIndex, 'validation', 'A track group must target a group track.')
        if (track.channelRole === 'return' && groupId) planError(actionIndex, 'validation', 'Return tracks cannot belong to a group.')
        changed = track.groupId !== groupId
        track.groupId = groupId
        validateGroups(tracks.values(), actionIndex)
        break
      }
      case 'track.reorder': {
        if (action.tracks.length !== tracks.size) planError(actionIndex, 'validation', 'Track reorder must include every project track.')
        const updates = action.tracks.map((update: any) => ({
          track: requireTrack(update.track, tracks, trackRefs, actionIndex),
          index: update.index,
          groupId: update.group === null ? undefined : requireTrack(update.group, tracks, trackRefs, actionIndex).id,
        }))
        if (new Set(updates.map((update: any) => update.track.id)).size !== tracks.size) planError(actionIndex, 'validation', 'Track reorder contains duplicate tracks.')
        if (!same(updates.map((update: any) => update.index).sort((left: number, right: number) => left - right), Array.from({ length: tracks.size }, (_, index) => index))) {
          planError(actionIndex, 'validation', 'Track reorder positions must be contiguous.')
        }
        changed = updates.some((update: any) => update.track.index !== update.index || update.track.groupId !== update.groupId)
        for (const update of updates) {
          update.track.index = update.index
          update.track.groupId = update.groupId
        }
        validateGroups(tracks.values(), actionIndex)
        if (!hasValidReturnTrackPartition(Array.from(tracks.values()))) {
          planError(actionIndex, 'validation', 'Return tracks must remain an ungrouped suffix.')
        }
        break
      }
      case 'track.delete': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const removeTrackIds = collectDeletedTrackIdsV1(Array.from(tracks.values()), track.id)
        for (const id of removeTrackIds) tracks.delete(id)
        snapshot.tracks = snapshot.tracks.filter((entry) => !removeTrackIds.has(entry.id))
        snapshot.clips = snapshot.clips.filter((entry) => !removeTrackIds.has(entry.trackId))
        for (const clip of clips.values()) if (removeTrackIds.has(clip.trackId)) clips.delete(clip.id)
        snapshot.processors = snapshot.processors.filter((entry) => !('trackId' in entry.target && removeTrackIds.has(entry.target.trackId)))
        for (const processor of processors.values()) if ('trackId' in processor.target && removeTrackIds.has(processor.target.trackId)) processors.delete(processor.id)
        snapshot.automation = snapshot.automation.filter((entry) => !('trackId' in entry.target && removeTrackIds.has(entry.target.trackId)))
        snapshot.sidechains = snapshot.sidechains.filter((entry) => !removeTrackIds.has(entry.sourceTrackId) && !removeTrackIds.has(entry.targetTrackId))
        for (const current of tracks.values()) {
          if (current.groupId && removeTrackIds.has(current.groupId)) current.groupId = undefined
          if (current.outputTargetId && removeTrackIds.has(current.outputTargetId)) current.outputTargetId = undefined
          current.sends = current.sends.filter((send: any) => !removeTrackIds.has(send.targetTrackId))
        }
        snapshot.tracks.sort((left, right) => left.index - right.index).forEach((entry, index) => { entry.index = index })
        changed = true
        break
      }
      case 'clip.midi.create': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        if (track.kind !== 'instrument' || track.channelRole !== 'track') planError(actionIndex, 'validation', 'MIDI clips require an instrument track.')
        const id = placeholderId('clip', action.clientRef, actionIndex)
        const clip = {
          id,
          trackId: track.id,
          name: action.name ?? 'MIDI Clip',
          startSec: action.startSec,
          duration: action.duration,
          gain: action.gain,
          leftPadSec: 0,
          bufferOffsetSec: 0,
          midiOffsetBeats: 0,
          midi: { wave: action.wave, gain: action.gain, notes: action.notes },
        }
        clips.set(id, clip)
        snapshot.clips.push(clip)
        if (action.clientRef) {
          clipRefs.set(action.clientRef, id)
          resolvedRefs.push({ entity: 'clip', clientRef: action.clientRef, id, persisted: false })
        }
        changed = true
        break
      }
      case 'clip.move': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        if (clip.midi && (track.kind !== 'instrument' || track.channelRole !== 'track')) planError(actionIndex, 'validation', 'MIDI clips require an instrument track.')
        if (!clip.midi && (track.kind !== 'audio' || track.channelRole !== 'track')) planError(actionIndex, 'validation', 'Audio clips require an audio track.')
        changed = clip.trackId !== track.id || clip.startSec !== action.startSec
        clip.trackId = track.id
        clip.startSec = action.startSec
        break
      }
      case 'clip.timing.set': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        if (clip.midi && (action.fadeInSec !== undefined || action.fadeOutSec !== undefined)) {
          planError(actionIndex, 'validation', 'MIDI clips do not support fades.')
        }
        const duration = action.duration ?? clip.duration
        const fades = action.fadeInSec === undefined && action.fadeOutSec === undefined
          ? (clip.fades === undefined ? undefined : normalizeClipFades(clip.fades, duration))
          : normalizeClipFades({
              ...clip.fades,
              ...(action.fadeInSec === undefined ? {} : { fadeInSec: action.fadeInSec }),
              ...(action.fadeOutSec === undefined ? {} : { fadeOutSec: action.fadeOutSec }),
            }, duration)
        const patch = {
          duration,
          gain: action.gain ?? clip.gain,
          leftPadSec: action.leftPadSec ?? clip.leftPadSec,
          bufferOffsetSec: action.bufferOffsetSec ?? clip.bufferOffsetSec,
          midiOffsetBeats: action.midiOffsetBeats ?? clip.midiOffsetBeats,
          ...(fades === undefined ? {} : { fades }),
        }
        changed = !same(
          {
            duration: clip.duration,
            gain: clip.gain,
            leftPadSec: clip.leftPadSec,
            bufferOffsetSec: clip.bufferOffsetSec,
            midiOffsetBeats: clip.midiOffsetBeats,
            fades: clip.fades,
          },
          patch,
        )
        Object.assign(clip, patch)
        break
      }
      case 'clip.rename': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        changed = clip.name !== action.name.trim()
        clip.name = action.name.trim()
        break
      }
      case 'clip.delete': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        clips.delete(clip.id)
        snapshot.clips = snapshot.clips.filter((entry) => entry.id !== clip.id)
        changed = true
        break
      }
      case 'master.volume.set': {
        const volume = normalizeMasterVolume(action.volume)
        changed = snapshot.project.masterVolume !== volume
        snapshot.project.masterVolume = volume
        break
      }
      case 'effect.upsert': {
        const target = resolveTarget(action.target, actionIndex)
        const existing = action.effect === undefined ? undefined : requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (existing && !targetMatches(existing, action.target, tracks, trackRefs, actionIndex)) planError(actionIndex, 'validation', 'Effect does not belong to the supplied target.')
        if (existing && existing.processor.kind !== action.effectKind) planError(actionIndex, 'validation', 'Effect kind cannot change.')
        const id = existing?.id ?? placeholderId('effect', action.clientRef, actionIndex)
        const next = {
          id,
          target,
          instanceId: existing?.instanceId ?? `control:audio-effect:${action.clientRef ?? actionIndex}`,
          index: existing?.index ?? snapshot.processors.filter((entry) => same(entry.target, target)).length,
          processor: {
            kind: action.effectKind,
            params: normalizeAudioEffectParamsForUpdate(
              action.effectKind,
              action.params ?? existing?.processor.params ?? {},
              existing?.processor.params,
            ),
          },
        }
        changed = !existing || !same(existing, next)
        if (existing) Object.assign(existing, next)
        else {
          processors.set(id, next)
          snapshot.processors.push(next)
        }
        if (action.clientRef) {
          effectRefs.set(action.clientRef, id)
          resolvedRefs.push({ entity: 'effect', clientRef: action.clientRef, id, persisted: false })
        }
        break
      }
      case 'effect.remove': {
        const effect = requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (!targetMatches(effect, action.target, tracks, trackRefs, actionIndex) || effect.processor.kind !== action.effectKind) planError(actionIndex, 'validation', 'Effect does not match the supplied target and kind.')
        processors.delete(effect.id)
        snapshot.processors = snapshot.processors.filter((entry) => entry.id !== effect.id)
        const removedTarget = effect.target
        snapshot.automation = snapshot.automation.filter((entry) => (
          entry.effectInstanceId !== effect.instanceId || !same(entry.target, removedTarget)
        ))
        snapshot.sidechains = snapshot.sidechains.filter((entry) => (
          entry.effectInstanceId !== effect.instanceId
          || !('trackId' in removedTarget && entry.targetTrackId === removedTarget.trackId)
        ))
        const remaining = snapshot.processors
          .filter((entry) => same(entry.target, removedTarget) && isAudioEffectKind(entry.processor.kind))
          .sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
        remaining.forEach((entry, index) => { entry.index = index })
        changed = true
        break
      }
      case 'effect.reorder': {
        resolveTarget(action.target, actionIndex)
        const ordered = action.order.map((item: any) => {
          const effect = requireEffect(item.effect, processors, effectRefs, actionIndex)
          if (!targetMatches(effect, action.target, tracks, trackRefs, actionIndex) || effect.processor.kind !== item.kind) planError(actionIndex, 'validation', 'Effect reorder includes an incompatible effect.')
          return effect
        })
        if (new Set(ordered.map((effect: any) => effect.id)).size !== ordered.length) planError(actionIndex, 'validation', 'Effect reorder contains duplicate effects.')
        const targetEffects = Array.from(processors.values()).filter((effect) => (
          isAudioEffectKind(effect.processor.kind)
          && targetMatches(effect, action.target, tracks, trackRefs, actionIndex)
        ))
        if (
          ordered.length !== targetEffects.length
          || ordered.some((effect: any) => !targetEffects.some((targetEffect) => targetEffect.id === effect.id))
        ) {
          planError(actionIndex, 'validation', 'Effect reorder must include every audio effect on its target exactly once.')
        }
        changed = ordered.some((effect: any, index: number) => effect.index !== index)
        ordered.forEach((effect: any, index: number) => { effect.index = index })
        break
      }
      case 'instrument.set':
      case 'arpeggiator.set': {
        const track = requireTrack(action.target.track, tracks, trackRefs, actionIndex)
        if (track.kind !== 'instrument') planError(actionIndex, 'validation', 'Instruments and arpeggiators require an instrument track.')
        const existing = Array.from(processors.values()).find((entry) => 'trackId' in entry.target && entry.target.trackId === track.id && entry.processor.kind === (action.kind === 'instrument.set' ? 'instrument' : 'arpeggiator'))
        const existingInstrument = action.kind === 'instrument.set'
          ? normalizeTrackInstrumentParams(existing?.processor.params)
          : undefined
        const generatedInstrumentInstanceId = action.kind === 'instrument.set' && !existingInstrument
          ? `control:instrument:${actionIndex}`
          : undefined
        const params = action.kind === 'instrument.set'
          ? {
              kind: action.instrumentKind,
              instanceId: existingInstrument?.instanceId ?? generatedInstrumentInstanceId,
              params: action.params ?? (existingInstrument && existingInstrument.kind === action.instrumentKind ? existingInstrument.params : {}),
            }
          : normalizeArpeggiatorParams(action.params)
        const processor = action.kind === 'instrument.set'
          ? { kind: 'instrument', params: normalizeTrackInstrumentParams(params) ?? planError(actionIndex, 'validation', 'Invalid instrument parameters.') }
          : { kind: 'arpeggiator', params }
        const next = {
          id: existing?.id ?? placeholderId('effect', undefined, actionIndex),
          target: { trackId: track.id },
          ...(action.kind === 'instrument.set' ? { instanceId: existingInstrument?.instanceId ?? generatedInstrumentInstanceId } : {}),
          index: existing?.index ?? snapshot.processors.filter((processor) => 'trackId' in processor.target && processor.target.trackId === track.id).length,
          processor,
        }
        changed = !existing || !same(existing.processor, next.processor)
        if (existing) Object.assign(existing, next)
        else {
          processors.set(next.id, next)
          snapshot.processors.push(next)
        }
        planned.push({ actionIndex, action, changed, ...(generatedInstrumentInstanceId === undefined ? {} : { generatedInstrumentInstanceId }) })
        continue
      }
      case 'automation.set': {
        const target = resolveTarget(action.target, actionIndex)
        const effect = action.effect === undefined ? undefined : requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (effect && !targetMatches(effect, action.target, tracks, trackRefs, actionIndex)) planError(actionIndex, 'validation', 'Automation effect does not belong to its target.')
        const descriptor = validateAutomationTarget(action, target, effect, processors, actionIndex)
        const effectInstanceId = effect?.instanceId
        if (action.effect && !effectInstanceId) planError(actionIndex, 'validation', 'Automation requires an effect with an instance ID.')
        const points = normalizeAutomationPoints(action.points, descriptor)
        const current = snapshot.automation.find((entry) => same(entry.target, target) && entry.effectInstanceId === effectInstanceId && entry.parameterId === action.parameterId)
        const next = { target, effectInstanceId, parameterId: action.parameterId, enabled: action.enabled, points }
        changed = !current || !same(current, next)
        if (current) Object.assign(current, next)
        else snapshot.automation.push(next)
        break
      }
      case 'automation.delete': {
        const target = resolveTarget(action.target, actionIndex)
        const effect = action.effect === undefined ? undefined : requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (effect && !targetMatches(effect, action.target, tracks, trackRefs, actionIndex)) planError(actionIndex, 'validation', 'Automation effect does not belong to its target.')
        validateAutomationTarget(action, target, effect, processors, actionIndex)
        const index = snapshot.automation.findIndex((entry) => same(entry.target, target) && entry.effectInstanceId === effect?.instanceId && entry.parameterId === action.parameterId)
        if (index < 0) planError(actionIndex, 'not-found', 'Automation envelope was not found.')
        snapshot.automation.splice(index, 1)
        changed = true
        break
      }
      case 'sidechain.set': {
        const source = requireTrack(action.source, tracks, trackRefs, actionIndex)
        const target = requireTrack(action.target, tracks, trackRefs, actionIndex)
        const effect = requireEffect(action.effect, processors, effectRefs, actionIndex)
        const effectInstanceId = effect.instanceId
        const eligibility = sidechainEligibilityError({
          sourceTrackId: source.id,
          targetTrackId: target.id,
          effectTargetTrackId: 'trackId' in effect.target ? effect.target.trackId : undefined,
          effectKind: effect.processor.kind,
          effectInstanceId,
        })
        if (eligibility) planError(actionIndex, 'validation', eligibility)
        const next = { sourceTrackId: source.id, targetTrackId: target.id, effectInstanceId: effectInstanceId ?? planError(actionIndex, 'validation', 'Sidechain effect requires an instance ID.') }
        const current = snapshot.sidechains.find((entry) => entry.targetTrackId === next.targetTrackId && entry.effectInstanceId === next.effectInstanceId)
        changed = !current || !same(current, next)
        if (current) Object.assign(current, next)
        else snapshot.sidechains.push(next)
        break
      }
      case 'sidechain.remove': {
        const target = requireTrack(action.target, tracks, trackRefs, actionIndex)
        const effect = requireEffect(action.effect, processors, effectRefs, actionIndex)
        const effectInstanceId = effect.instanceId ?? planError(actionIndex, 'validation', 'Sidechain effect requires an instance ID.')
        const eligibility = sidechainTargetEligibilityError({
          targetTrackId: target.id,
          effectTargetTrackId: 'trackId' in effect.target ? effect.target.trackId : undefined,
          effectKind: effect.processor.kind,
          effectInstanceId,
        })
        if (eligibility) planError(actionIndex, 'validation', eligibility)
        const index = snapshot.sidechains.findIndex((entry) => entry.targetTrackId === target.id && entry.effectInstanceId === effectInstanceId)
        if (index < 0) planError(actionIndex, 'not-found', 'Sidechain route was not found.')
        snapshot.sidechains.splice(index, 1)
        changed = true
        break
      }
    }
    planned.push({ actionIndex, action, changed })
  }

  snapshot.tracks.sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
  snapshot.clips.sort((left, right) => left.startSec - right.startSec || (left.id < right.id ? -1 : 1))
  snapshot.processors.sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
  const applied = planned.some((entry) => entry.changed)
  return {
    snapshot,
    actions: planned,
    applied,
    priorRevision: base.project.revision,
    revision: base.project.revision + (applied ? 1 : 0),
    resolvedRefs,
    warnings: [],
    changeSummary: {
      actionCount: request.actions.length,
      changes: planned.filter((entry) => entry.changed).map((entry) => ({
        actionIndex: entry.actionIndex,
        kind: entry.action.kind,
        description: describe(entry.action),
      })),
    },
  }
}
