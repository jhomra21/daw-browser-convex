import { collectDeletedTrackIdsV1, type ControlPlanV1 } from "@daw-browser/control";
import {
  createAudioEffectInstanceId,
  createDefaultSynthParams,
  normalizeAudioWarp,
  normalizeClipColor,
  normalizeAudioEffectParamsForUpdate,
  normalizeTrackInstrumentParams,
} from "@daw-browser/shared";
import { normalizeClipFades } from "@daw-browser/timeline-core/clip-fades";
import {
  createMidiClipRow,
  createAudioClipRow,
  deleteClipRow,
  moveClipRow,
  setClipGainRow,
  setClipNameRow,
  setClipTimingRow,
  setClipMidiRow,
  setClipFadesRow,
  setClipAudioWarpRow,
  setClipColorRow,
  setClipSourceRow,
} from "./clips";
import {
  removeAudioEffectRow,
  reorderAudioEffectRows,
  setArpeggiatorRow,
  setTrackInstrumentRow,
  removeTrackInstrumentRow,
  removeArpeggiatorRow,
  upsertMasterEffectRow,
  upsertTrackEffectRow,
} from "./effects";
import { setAutomationEnvelopeRow, deleteAutomationEnvelopeRow } from "./automation";
import { setProjectMasterVolumeRow } from "./projectMixerSettings";
import { setProjectNameRow, setProjectTimelineSettingsRow } from "./projects";
import {
  createTrackRow,
  deleteTrackRows,
  removeSidechainRouteRow,
  reorderAndGroupTrackRows,
  setSidechainRouteRow,
  setTrackGroupRow,
  setTrackMixRow,
  setTrackNameRow,
  setTrackRoutingRow,
  setTrackVolumeRow,
  setTrackCollapsedRow,
  setTrackColorRow,
  setTrackColorCascadeRow,
  ungroupTrackRow,
} from "./tracks";
import { deleteSampleRow, findSampleRow } from "./sampleRows";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";
import { requireProjectRow } from "./projectRows";
import { enqueueR2DeleteRows } from "./r2Deletes";
import { captureRecoveryPayload, createRecovery, isRecoverableAction, restoreRecovery } from "./controlRecovery";

const requiredId = (ctx: any, table: string, id: string) => {
  const normalized = ctx.db.normalizeId(table, id)
  if (!normalized) throw new Error(`Invalid ${table} ID.`)
  return normalized
}

const resolveRef = (ctx: any, table: string, refs: Map<string, unknown>, ref: { source: "persisted"; id: string } | { source: "client"; clientRef: string }) => {
  if (ref.source === "client") {
    const id = refs.get(ref.clientRef)
    if (!id) throw new Error(`Unknown ${table} client reference.`)
    return id
  }
  return requiredId(ctx, table, ref.id)
}

const requireCompleteAsset = async (
  ctx: any,
  projectId: string,
  assetKey: string,
): Promise<{ assetKey: string; sourceKind: "upload" | "url" | "recording"; name: string; duration: number; sampleRate: number; channelCount: number }> => {
  const asset = await findSampleRow(ctx, { projectId, assetKey })
  const duration = asset?.duration
  const sampleRate = asset?.sampleRate
  const channelCount = asset?.channelCount
  if (
    !asset || duration === undefined || sampleRate === undefined || channelCount === undefined
    || (asset.sourceKind !== "upload" && asset.sourceKind !== "url" && asset.sourceKind !== "recording")
  ) {
    throw new Error("Audio clips require an asset with complete source metadata.")
  }
  return {
    assetKey: asset.assetKey,
    sourceKind: asset.sourceKind,
    name: asset.name,
    duration,
    sampleRate,
    channelCount,
  }
}

export async function executeControlPlanV1(
  ctx: any,
  input: { projectId: string; actorId: string; plan: ControlPlanV1; recoveries?: Map<string, any> },
) {
  const trackRefs = new Map<string, unknown>()
  const clipRefs = new Map<string, unknown>()
  const effectRefs = new Map<string, unknown>()
  const resolvedRefs: Array<{ entity: "track" | "clip" | "effect"; clientRef: string; id: string; persisted: true }> = []
  const recoveries: Array<{ actionIndex: number; id: string; kind: string; expiresAt: number }> = []
  const restored: Array<{ actionIndex: number; recoveryId: string; entities: any[] }> = []
  const recoveryExpiryByAction = new Map<number, number>()
  let changed = false
  for (const entry of input.plan.actions) {
    const action = entry.action
    let result: { changed: boolean } = { changed: false }
    if (isRecoverableAction(action)) {
      const payload = await captureRecoveryPayload(ctx, {
        projectId: input.projectId,
        action,
        resolveRef: (table, ref) => resolveRef(ctx, table, table === "tracks" ? trackRefs : table === "clips" ? clipRefs : effectRefs, ref),
      })
      if (payload) {
        const recovery = await createRecovery(ctx, {
          projectId: input.projectId,
          actorSubject: input.actorId,
          sourceActionIndex: entry.actionIndex,
          kind: action.kind,
          data: payload,
        })
        if (recovery) {
          recoveries.push({ actionIndex: entry.actionIndex, ...recovery })
          recoveryExpiryByAction.set(entry.actionIndex, recovery.expiresAt)
        }
      }
    }
    switch (action.kind) {
      case "project.rename":
        result = await setProjectNameRow(ctx, input.projectId, action.name)
        break
      case "project.settings.set":
        result = await setProjectTimelineSettingsRow(ctx, input.projectId, action)
        break
      case "track.create": {
        const created = await createTrackRow(ctx, {
          projectId: input.projectId,
          ownerUserId: input.actorId,
          index: action.index,
          kind: action.trackKind,
          channelRole: action.channelRole,
          color: action.color,
          name: action.name,
        })
        result = created
        if (entry.generatedInstrumentInstanceId && created.trackId) {
          const instrument = await setTrackInstrumentRow(ctx, {
            projectId: input.projectId,
            trackId: created.trackId,
            instrument: {
              kind: "synth",
              instanceId: entry.generatedInstrumentInstanceId,
              params: createDefaultSynthParams(),
            },
          })
          result = { changed: created.changed || instrument.changed }
        }
        if (action.clientRef) {
          trackRefs.set(action.clientRef, created.trackId)
          resolvedRefs.push({ entity: "track", clientRef: action.clientRef, id: String(created.trackId), persisted: true })
        }
        break
      }
      case "track.rename":
        result = await setTrackNameRow(ctx, {
          projectId: input.projectId,
          trackId: resolveRef(ctx, "tracks", trackRefs, action.track),
          name: action.name,
        })
        break
      case "track.mix.set": {
        const trackId = resolveRef(ctx, "tracks", trackRefs, action.track)
        const volume = action.volume === undefined
          ? { changed: false }
          : await setTrackVolumeRow(ctx, { projectId: input.projectId, trackId, volume: action.volume })
        const mix = await setTrackMixRow(ctx, { projectId: input.projectId, trackId, muted: action.muted, soloed: action.soloed })
        result = { changed: volume.changed || mix.changed }
        break
      }
      case "track.routing.set":
        result = await setTrackRoutingRow(ctx, {
          projectId: input.projectId,
          trackId: resolveRef(ctx, "tracks", trackRefs, action.track),
          outputTargetId: action.output === undefined ? undefined : action.output === null ? null : resolveRef(ctx, "tracks", trackRefs, action.output),
          sends: action.sends?.map((send: any) => ({ targetId: resolveRef(ctx, "tracks", trackRefs, send.target), amount: send.amount, tap: send.tap })),
        })
        break
      case "track.group.set":
        result = await setTrackGroupRow(ctx, {
          projectId: input.projectId,
          trackId: resolveRef(ctx, "tracks", trackRefs, action.track),
          groupId: action.group === null ? null : resolveRef(ctx, "tracks", trackRefs, action.group),
        })
        break
      case "track.reorder":
        {
          const currentTracks = await listProjectTracksWithMixerChannels(ctx, input.projectId)
          const outputTargetIdByTrackId = new Map(currentTracks.map((track: any) => [String(track._id), track.outputTargetId]))
        result = await reorderAndGroupTrackRows(ctx, {
          projectId: input.projectId,
          updates: action.tracks.map((update: any) => ({
            trackId: resolveRef(ctx, "tracks", trackRefs, update.track),
            index: update.index,
            groupId: update.group === null ? null : resolveRef(ctx, "tracks", trackRefs, update.group),
            outputTargetId: outputTargetIdByTrackId.get(String(resolveRef(ctx, "tracks", trackRefs, update.track))),
          })),
        })
        }
        break
      case "track.delete":
        {
          const rootTrackId = resolveRef(ctx, "tracks", trackRefs, action.track)
          const tracks = await ctx.db.query("tracks").withIndex("by_room", (query: any) => query.eq("projectId", input.projectId)).collect()
          const tracksById = new Map<string, any>(tracks.map((track: any) => [String(track._id), track]))
          const trackIds = Array.from(
            collectDeletedTrackIdsV1(
              tracks.map((track: any) => ({
                id: String(track._id),
                index: track.index,
                ...(track.groupId ? { groupId: String(track.groupId) } : {}),
                outputTargetId: undefined,
                sends: [],
              })),
              String(rootTrackId),
            ),
            (id) => tracksById.get(id)?._id,
          ).filter((trackId) => trackId !== undefined)
          result = await deleteTrackRows(ctx, { projectId: input.projectId, trackIds })
        }
        break
      case "track.collapsed.set":
        result = await setTrackCollapsedRow(ctx, { projectId: input.projectId, trackId: resolveRef(ctx, "tracks", trackRefs, action.track), collapsed: action.collapsed })
        break
      case "track.color.set":
        result = await setTrackColorRow(ctx, { projectId: input.projectId, trackId: resolveRef(ctx, "tracks", trackRefs, action.track), color: action.color ?? undefined })
        break
      case "track.color.cascade":
        result = await setTrackColorCascadeRow(ctx, { projectId: input.projectId, rootTrackId: resolveRef(ctx, "tracks", trackRefs, action.root), color: action.color ?? undefined, cascadeClipColors: action.cascadeClipColors })
        break
      case "track.ungroup":
        result = await ungroupTrackRow(ctx, { projectId: input.projectId, groupId: resolveRef(ctx, "tracks", trackRefs, action.group), userId: input.actorId })
        break
      case "clip.midi.create": {
        const created = await createMidiClipRow(ctx, {
          projectId: input.projectId,
          ownerUserId: input.actorId,
          trackId: resolveRef(ctx, "tracks", trackRefs, action.track),
          name: action.name,
          startSec: action.startSec,
          duration: action.duration,
          gain: action.gain,
          midi: { wave: action.wave, gain: action.gain, notes: action.notes },
        })
        result = { changed: created.changed }
        if (action.clientRef && created.value) {
          clipRefs.set(action.clientRef, created.value)
          resolvedRefs.push({ entity: "clip", clientRef: action.clientRef, id: String(created.value), persisted: true })
        }
        break
      }
      case "clip.audio.create": {
        const asset = await requireCompleteAsset(ctx, input.projectId, action.asset.id)
        const created = await createAudioClipRow(ctx, {
          projectId: input.projectId, ownerUserId: input.actorId,
          trackId: resolveRef(ctx, "tracks", trackRefs, action.track),
          name: action.name ?? asset.name, startSec: action.startSec ?? 0, duration: action.duration ?? asset.duration,
          gain: action.gain, color: action.color === undefined ? undefined : normalizeClipColor(action.color), leftPadSec: action.leftPadSec, bufferOffsetSec: action.bufferOffsetSec,
          midiOffsetBeats: action.midiOffsetBeats, fades: action.fades ? normalizeClipFades(action.fades, action.duration ?? asset.duration) : undefined,
          audioWarp: normalizeAudioWarp(action.audioWarp),
          sourceAssetKey: asset.assetKey, sourceKind: asset.sourceKind, sourceDurationSec: asset.duration,
          sourceSampleRate: asset.sampleRate, sourceChannelCount: asset.channelCount,
          sampleUrl: `/api/samples/${encodeURIComponent(input.projectId)}/${encodeURIComponent(asset.assetKey)}`,
        })
        result = { changed: created.changed }
        if (action.clientRef && created.value) {
          clipRefs.set(action.clientRef, created.value)
          resolvedRefs.push({ entity: "clip", clientRef: action.clientRef, id: String(created.value), persisted: true })
        }
        break
      }
      case "clip.source.set": {
        const asset = await requireCompleteAsset(ctx, input.projectId, action.asset.id)
        result = await setClipSourceRow(ctx, { projectId: input.projectId, clipId: resolveRef(ctx, "clips", clipRefs, action.clip), assetKey: asset.assetKey, sourceKind: asset.sourceKind, durationSec: asset.duration, sampleRate: asset.sampleRate, channelCount: asset.channelCount })
        break
      }
      case "clip.midi.set":
        result = await setClipMidiRow(ctx, { projectId: input.projectId, clipId: resolveRef(ctx, "clips", clipRefs, action.clip), midi: { wave: action.wave, gain: action.gain, notes: action.notes } })
        break
      case "clip.fades.set": {
        const clipId = resolveRef(ctx, "clips", clipRefs, action.clip)
        const clip = await ctx.db.get(clipId)
        result = !clip ? { changed: false } : await setClipFadesRow(ctx, { projectId: input.projectId, clipId, fades: normalizeClipFades(action.fades, clip.duration) })
        break
      }
      case "clip.audioWarp.set":
        result = await setClipAudioWarpRow(ctx, { projectId: input.projectId, clipId: resolveRef(ctx, "clips", clipRefs, action.clip), audioWarp: normalizeAudioWarp(action.audioWarp) })
        break
      case "clip.color.set":
        result = await setClipColorRow(ctx, { projectId: input.projectId, clipId: resolveRef(ctx, "clips", clipRefs, action.clip), color: action.color ?? undefined })
        break
      case "clip.move":
        result = await moveClipRow(ctx, { projectId: input.projectId, clipId: resolveRef(ctx, "clips", clipRefs, action.clip), trackId: resolveRef(ctx, "tracks", trackRefs, action.track), startSec: action.startSec })
        break
      case "clip.timing.set": {
        const clipId = resolveRef(ctx, "clips", clipRefs, action.clip)
        const clip = await ctx.db.get(clipId)
        if (!clip || clip.projectId !== input.projectId) throw new Error("Clip was not found.")
        const nextDuration = action.duration ?? clip.duration
        const patch = {
          startSec: clip.startSec,
          duration: nextDuration,
          ...(action.leftPadSec === undefined ? {} : { leftPadSec: action.leftPadSec }),
          ...(action.bufferOffsetSec === undefined ? {} : { bufferOffsetSec: action.bufferOffsetSec }),
          ...(action.midiOffsetBeats === undefined ? {} : { midiOffsetBeats: action.midiOffsetBeats }),
          ...(
            clip.midi || action.fadeInSec === undefined && action.fadeOutSec === undefined && clip.fades === undefined
              ? {}
              : {
                  fades: normalizeClipFades({
                    ...clip.fades,
                    ...(action.fadeInSec === undefined ? {} : { fadeInSec: action.fadeInSec }),
                    ...(action.fadeOutSec === undefined ? {} : { fadeOutSec: action.fadeOutSec }),
                  }, nextDuration),
                }
          ),
        }
        const timing = await setClipTimingRow(ctx, {
          projectId: input.projectId,
          clipId,
          patch,
        })
        const gain = action.gain === undefined ? { changed: false } : await setClipGainRow(ctx, { projectId: input.projectId, clipId, gain: action.gain })
        result = { changed: timing.changed || gain.changed }
        break
      }
      case "clip.rename":
        result = await setClipNameRow(ctx, { projectId: input.projectId, clipId: resolveRef(ctx, "clips", clipRefs, action.clip), name: action.name })
        break
      case "clip.delete": {
        const clipId = resolveRef(ctx, "clips", clipRefs, action.clip)
        const ownership = await ctx.db.query("ownerships").withIndex("by_clip", (query: any) => query.eq("clipId", clipId)).unique()
        if (!ownership) throw new Error("Clip ownership was not found.")
        result = await deleteClipRow(ctx, { projectId: input.projectId, clipId, ownershipId: ownership._id })
        break
      }
      case "asset.delete": {
        const deleted = await deleteSampleRow(ctx, { projectId: input.projectId, assetKey: action.asset.id })
        if (!deleted.asset) {
          result = { changed: false }
          break
        }
        const project = await requireProjectRow(ctx, input.projectId)
        await enqueueR2DeleteRows(ctx, {
          projectId: input.projectId,
          storageNamespace: project.storageNamespace,
          keys: [deleted.asset.r2Key],
          kind: "sample",
          notBefore: recoveryExpiryByAction.get(entry.actionIndex),
        })
        result = { changed: true }
        break
      }
      case "recovery.restore": {
        const recovery = input.recoveries?.get(action.recovery.id)
        if (!recovery) throw new Error("Recovery is unavailable.")
        const restoredResult = await restoreRecovery(ctx, {
          projectId: input.projectId,
          recovery,
          actionIndex: entry.actionIndex,
        })
        restored.push(restoredResult)
        result = { changed: true }
        break
      }
      case "master.volume.set":
        result = await setProjectMasterVolumeRow(ctx, input.projectId, action.volume)
        break
      case "effect.upsert": {
        const target = action.target.kind === "master"
          ? { targetType: "master" }
          : { targetType: "track", trackId: resolveRef(ctx, "tracks", trackRefs, action.target.track) }
        const existingId = action.effect === undefined
          ? undefined
          : resolveRef(ctx, "effects", effectRefs, action.effect)
        const existing = existingId === undefined ? undefined : await ctx.db.get(existingId)
        if (
          existing
          && (
            existing.projectId !== input.projectId
            || existing.type !== action.effectKind
            || existing.targetType !== target.targetType
            || target.targetType === "track" && String(existing.trackId) !== String(target.trackId)
            || !existing.instanceId
          )
        ) throw new Error("Effect does not match the requested target and kind.")
        const instanceId = existing?.instanceId ?? createAudioEffectInstanceId()
        const write = target.targetType === "master"
          ? await upsertMasterEffectRow(ctx, {
              projectId: input.projectId,
              type: action.effectKind,
              params: action.params ?? existing?.params ?? normalizeAudioEffectParamsForUpdate(action.effectKind, {}),
              instanceId,
            })
          : await upsertTrackEffectRow(ctx, {
              projectId: input.projectId,
              trackId: target.trackId,
              type: action.effectKind,
              params: action.params ?? existing?.params ?? normalizeAudioEffectParamsForUpdate(action.effectKind, {}),
              instanceId,
            })
        result = write
        if (action.clientRef && write.effectId) {
          effectRefs.set(action.clientRef, write.effectId)
          resolvedRefs.push({ entity: "effect", clientRef: action.clientRef, id: String(write.effectId), persisted: true })
        }
        break
      }
      case "effect.remove": {
        const effectId = resolveRef(ctx, "effects", effectRefs, action.effect)
        const row = await ctx.db.get(effectId)
        result = action.target.kind === "master"
          ? await removeAudioEffectRow(ctx, { projectId: input.projectId, targetType: "master", effect: action.effectKind, instanceId: row?.instanceId })
          : await removeAudioEffectRow(ctx, { projectId: input.projectId, targetType: "track", trackId: resolveRef(ctx, "tracks", trackRefs, action.target.track), effect: action.effectKind, instanceId: row?.instanceId })
        break
      }
      case "effect.reorder": {
        const order = await Promise.all(action.order.map(async (item: any) => {
          const effectId = resolveRef(ctx, "effects", effectRefs, item.effect)
          const effect = await ctx.db.get(effectId)
          if (!effect?.instanceId || effect.projectId !== input.projectId || effect.type !== item.kind) {
            throw new Error("Effect reorder includes an incompatible effect.")
          }
          return { id: effect.instanceId, kind: item.kind }
        }))
        result = await reorderAudioEffectRows(ctx, {
          projectId: input.projectId,
          targetType: action.target.kind,
          trackId: action.target.kind === "track" ? resolveRef(ctx, "tracks", trackRefs, action.target.track) : undefined,
          order,
        })
        break
      }
      case "instrument.set": {
        const trackId = resolveRef(ctx, "tracks", trackRefs, action.target.track)
        const rows = await ctx.db.query("effects").withIndex("by_track", (query: any) => query.eq("trackId", trackId)).collect()
        const existing = rows.find((row: any) => row.targetType === "track" && (row.type === "instrument" || row.type === "synth"))
        const current = existing ? normalizeTrackInstrumentParams(existing.params) : undefined
        result = await setTrackInstrumentRow(ctx, {
          projectId: input.projectId,
          trackId,
          instrument: {
            kind: action.instrumentKind,
            instanceId: current?.instanceId ?? entry.generatedInstrumentInstanceId,
            params: action.params ?? (current && current.kind === action.instrumentKind ? current.params : {}),
          },
        })
        break
      }
      case "arpeggiator.set":
        result = await setArpeggiatorRow(ctx, { projectId: input.projectId, trackId: resolveRef(ctx, "tracks", trackRefs, action.target.track), params: action.params })
        break
      case "instrument.remove":
        result = await removeTrackInstrumentRow(ctx, { projectId: input.projectId, trackId: resolveRef(ctx, "tracks", trackRefs, action.target.track) })
        break
      case "arpeggiator.remove":
        result = await removeArpeggiatorRow(ctx, { projectId: input.projectId, trackId: resolveRef(ctx, "tracks", trackRefs, action.target.track) })
        break
      case "automation.set": {
        const effect = action.effect === undefined ? undefined : await ctx.db.get(resolveRef(ctx, "effects", effectRefs, action.effect))
        result = action.target.kind === "master"
          ? await setAutomationEnvelopeRow(ctx, { projectId: input.projectId, targetKind: "master", effectInstanceId: effect?.instanceId, parameterId: action.parameterId, enabled: action.enabled, points: action.points })
          : await setAutomationEnvelopeRow(ctx, { projectId: input.projectId, targetKind: "track", trackId: resolveRef(ctx, "tracks", trackRefs, action.target.track), effectInstanceId: effect?.instanceId, parameterId: action.parameterId, enabled: action.enabled, points: action.points })
        break
      }
      case "automation.delete": {
        const effect = action.effect === undefined ? undefined : await ctx.db.get(resolveRef(ctx, "effects", effectRefs, action.effect))
        result = action.target.kind === "master"
          ? await deleteAutomationEnvelopeRow(ctx, { projectId: input.projectId, targetKind: "master", effectInstanceId: effect?.instanceId, parameterId: action.parameterId })
          : await deleteAutomationEnvelopeRow(ctx, { projectId: input.projectId, targetKind: "track", trackId: resolveRef(ctx, "tracks", trackRefs, action.target.track), effectInstanceId: effect?.instanceId, parameterId: action.parameterId })
        break
      }
      case "sidechain.set": {
        const effect = await ctx.db.get(resolveRef(ctx, "effects", effectRefs, action.effect))
        if (!effect?.instanceId) throw new Error("Sidechain effect was not found.")
        result = await setSidechainRouteRow(ctx, { projectId: input.projectId, sourceTrackId: resolveRef(ctx, "tracks", trackRefs, action.source), targetTrackId: resolveRef(ctx, "tracks", trackRefs, action.target), effectInstanceId: effect.instanceId })
        break
      }
      case "sidechain.remove": {
        const effect = await ctx.db.get(resolveRef(ctx, "effects", effectRefs, action.effect))
        if (!effect?.instanceId) throw new Error("Sidechain effect was not found.")
        result = await removeSidechainRouteRow(ctx, { projectId: input.projectId, targetTrackId: resolveRef(ctx, "tracks", trackRefs, action.target), effectInstanceId: effect.instanceId })
        break
      }
    }
    if (result.changed !== entry.changed) throw new Error(`Planner and executor disagree for action ${entry.actionIndex}.`)
    changed = changed || result.changed
  }
  const persistedRefs = []
  for (const ref of resolvedRefs) {
    const table = ref.entity === "track" ? "tracks" : ref.entity === "clip" ? "clips" : "effects"
    const row = await ctx.db.get(requiredId(ctx, table, ref.id))
    if (row) persistedRefs.push(ref)
  }
  return { changed, resolvedRefs: persistedRefs, recoveries, restored }
}
