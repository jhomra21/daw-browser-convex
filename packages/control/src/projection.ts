import {
  normalizeLegacyMidiClip,
  type LegacyMidiClip,
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
  normalizePersistedInstrumentParams,
  type MidiClip,
} from "@daw-browser/shared";

export type ControlProjectSnapshotInput = {
  omitUnavailableClipSources?: boolean;
  project: {
    projectId: string;
    name: string;
    revision: number;
    tempoBpm: number;
    timeSignatureNumerator: number;
    timeSignatureDenominator: number;
    loopEnabled: boolean;
    loopStartSec: number;
    loopEndSec: number;
    updatedAt: number;
  };
  tracks: Array<{
    _id: unknown;
    name: string;
    index: number;
    kind?: string;
    channelRole: string;
    groupId?: unknown;
    volume: number;
    muted?: boolean;
    soloed?: boolean;
    outputTargetId?: unknown;
    sends: Array<{ targetId: unknown; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }>;
    collapsed?: boolean;
    color?: string;
  }>;
  clips: Array<{
    _id: unknown;
    trackId: unknown;
    name?: string;
    sourceAssetKey?: string;
    startSec: number;
    duration: number;
    gain?: number;
    leftPadSec?: number;
    bufferOffsetSec?: number;
    midiOffsetBeats?: number;
    color?: string;
    audioWarp?: {
      enabled: boolean;
      sourceBpm?: number;
      sourceBeatOffset?: number;
      markers?: Array<{ id: string; sourceBeat: number; timelineBeat: number }>;
      mode: "repitch" | "stretch";
    };
    fades?: {
      fadeInStartSec?: number;
      fadeInSec: number;
      fadeOutSec: number;
      fadeOutEndSec?: number;
      fadeInCurve: number;
      fadeOutCurve: number;
      fadeInCurvePosition?: number;
      fadeOutCurvePosition?: number;
    };
    midi?: Omit<MidiClip, "wave"> & { wave: string };
  }>;
  masterVolume: number;
  effects: Array<{
    _id: unknown;
    targetType: string;
    trackId?: unknown;
    index: number;
    type: string;
    instanceId?: string;
    params: unknown;
  }>;
  externalProcessors?: Array<{
    instanceId: string;
    targetId: string;
    index: number;
    manifest: {
      identity: {
        name: string;
        vendor: string;
        classId: string;
      };
      role: "effect" | "instrument";
      parameters: Array<{ id: number; readOnly: boolean }>;
    };
    bypassed: boolean;
    parameterOverrides: Record<string, number>;
  }>;
  automationEnvelopes: Array<{
    _id: unknown;
    targetKind: "track" | "master";
    trackId?: unknown;
    effectInstanceId?: string;
    parameterId: string;
    enabled: boolean;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>;
  }>;
  sidechainRoutes: Array<{
    sourceTrackId: unknown;
    targetTrackId: unknown;
    effectInstanceId: string;
  }>;
  assets: Array<{
    assetKey: string;
    name: string;
    sourceKind: string;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    duration?: number;
    sampleRate?: number;
    channelCount?: number;
    folderId?: string;
    createdAt: number;
    updatedAt: number;
  }>;
  assetFolders: Array<{
    _id: unknown;
    name: string;
    createdAt: number;
    updatedAt: number;
  }>;
};

export const compareControlSnapshotText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const effectiveControlClipName = (name: string | undefined) => name?.trim() || "Clip";
const effectiveControlTimingOffset = (value: number | undefined) => value ?? 0;
const effectiveControlMixerBoolean = (value: boolean | undefined) => value ?? false;

const projectControlSnapshotCore = <Snapshot>(
  input: ControlProjectSnapshotInput,
  version: "v1" | "v2",
  projectMidi: (midi: LegacyMidiClip) => unknown,
  parseSnapshot: (snapshot: unknown) => Snapshot,
): Snapshot => {
  const assets = [...input.assets]
    .sort((left, right) => compareControlSnapshotText(left.assetKey, right.assetKey))
    .map((asset) => ({
      id: asset.assetKey,
      name: asset.name,
      sourceKind: asset.sourceKind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      contentSha256: asset.contentSha256,
      ...(asset.duration === undefined ? {} : { durationSec: asset.duration }),
      ...(asset.sampleRate === undefined ? {} : { sampleRate: asset.sampleRate }),
      ...(asset.channelCount === undefined ? {} : { channelCount: asset.channelCount }),
      ...(asset.folderId === undefined ? {} : { folderId: asset.folderId }),
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    }));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const assetFolders = [...input.assetFolders]
    .sort((left, right) => compareControlSnapshotText(String(left._id), String(right._id)))
    .map((folder) => ({
      id: String(folder._id),
      name: folder.name,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    }));
  const tracks = [...input.tracks]
    .sort((left, right) => left.index - right.index || compareControlSnapshotText(String(left._id), String(right._id)))
    .map((track) => ({
      id: String(track._id),
      name: track.name,
      index: track.index,
      kind: track.kind === "instrument" ? "instrument" : "audio",
      channelRole: track.channelRole === "group" || track.channelRole === "return" ? track.channelRole : "track",
      groupId: track.groupId ? String(track.groupId) : undefined,
      volume: track.volume,
      muted: effectiveControlMixerBoolean(track.muted),
      soloed: effectiveControlMixerBoolean(track.soloed),
      outputTargetId: track.outputTargetId ? String(track.outputTargetId) : undefined,
      sends: track.sends
        .map((send) => ({
          targetTrackId: String(send.targetId),
          amount: send.amount,
          tap: send.tap,
        }))
        .sort((left, right) => compareControlSnapshotText(left.targetTrackId, right.targetTrackId)),
      collapsed: track.collapsed === true,
      ...(track.color === undefined ? {} : { color: track.color }),
    }));
  const clips = [...input.clips]
    .sort((left, right) => left.startSec - right.startSec || compareControlSnapshotText(String(left._id), String(right._id)))
    .map((clip) => {
      const asset = clip.sourceAssetKey ? assetsById.get(clip.sourceAssetKey) : undefined;
      if (clip.sourceAssetKey && !asset && !input.omitUnavailableClipSources) throw new Error("Audio clip references an unavailable asset.");
      return {
      id: String(clip._id),
      trackId: String(clip.trackId),
      name: effectiveControlClipName(clip.name),
      startSec: clip.startSec,
      duration: clip.duration,
      gain: clip.gain,
      leftPadSec: effectiveControlTimingOffset(clip.leftPadSec),
      bufferOffsetSec: effectiveControlTimingOffset(clip.bufferOffsetSec),
      midiOffsetBeats: effectiveControlTimingOffset(clip.midiOffsetBeats),
      fades: clip.fades,
      ...(clip.color === undefined ? {} : { color: clip.color }),
      ...(clip.audioWarp === undefined ? {} : { audioWarp: clip.audioWarp }),
      midi: clip.midi ? projectMidi(normalizeLegacyMidiClip(clip.midi)) : undefined,
      ...(asset === undefined ? {} : {
        source: {
          assetId: asset.id,
          sourceKind: asset.sourceKind,
          ...(asset.durationSec === undefined ? {} : { durationSec: asset.durationSec }),
          ...(asset.sampleRate === undefined ? {} : { sampleRate: asset.sampleRate }),
          ...(asset.channelCount === undefined ? {} : { channelCount: asset.channelCount }),
        },
      }),
    };
    });
  const processors = input.effects.flatMap((effect) => {
    const target = effect.targetType === "master"
      ? { master: true }
      : effect.targetType === "track" && effect.trackId
        ? { trackId: String(effect.trackId) }
        : undefined;
    if (!target) return [];
    const instrument = normalizePersistedInstrumentParams(
      effect.type,
      effect.instanceId,
      effect.params,
    );
    const processor = instrument
      ? { kind: "instrument", params: instrument }
      : effect.type === "arpeggiator"
        ? { kind: "arpeggiator", params: effect.params }
        : { kind: effect.type, params: effect.params };
    return [{ id: String(effect._id), target, instanceId: effect.instanceId, index: effect.index, processor }];
  }).sort((left, right) => (
    compareControlSnapshotText(
      "master" in left.target ? "master" : `track:${left.target.trackId}`,
      "master" in right.target ? "master" : `track:${right.target.trackId}`,
    )
    || left.index - right.index
    || compareControlSnapshotText(left.processor.kind, right.processor.kind)
    || compareControlSnapshotText(left.instanceId ?? "", right.instanceId ?? "")
    || compareControlSnapshotText(String(left.id), String(right.id))
  ));
  const externalProcessors = (input.externalProcessors ?? []).map((external) => {
    const parameterIds = new Map(external.manifest.parameters.map((parameter) => [parameter.id, String(parameter.id)]));
    const parameterOverrides = new Map<string, number>();
    for (const [key, value] of Object.entries(external.parameterOverrides)) {
      const parameterId = Number(key);
      const canonicalKey = parameterIds.get(parameterId);
      if (canonicalKey === undefined || !Number.isFinite(value)) continue;
      parameterOverrides.set(canonicalKey, Math.min(1, Math.max(0, value)));
    }
    return {
      id: `external-plugin:${external.instanceId}`,
      target: external.targetId === "master"
        ? { master: true }
        : { trackId: external.targetId },
      instanceId: external.instanceId,
      index: external.index,
      processor: {
        kind: "external-vst3",
        params: {
          identity: {
            name: external.manifest.identity.name,
            vendor: external.manifest.identity.vendor,
            classId: external.manifest.identity.classId,
            role: external.manifest.role,
          },
          bypassed: external.bypassed,
          parameterOverrides: Object.fromEntries(parameterOverrides),
          parameters: external.manifest.parameters.map((parameter) => ({
            id: parameter.id,
            readOnly: parameter.readOnly,
          })),
        },
      },
    };
  }).sort((left, right) => (
    compareControlSnapshotText(
      "master" in left.target ? "master" : `track:${left.target.trackId}`,
      "master" in right.target ? "master" : `track:${right.target.trackId}`,
    )
    || left.index - right.index
    || compareControlSnapshotText(left.instanceId, right.instanceId)
    || compareControlSnapshotText(left.id, right.id)
  ));
  const automation = input.automationEnvelopes.flatMap((envelope) => {
    const descriptor = getAutomationParameterDescriptor(envelope.parameterId);
    const target = envelope.targetKind === "master"
      ? { master: true }
      : envelope.trackId
        ? { trackId: String(envelope.trackId) }
        : undefined;
    if (!target || !descriptor) return [];
    return [{
      id: String(envelope._id),
      target,
      effectInstanceId: envelope.effectInstanceId,
      parameterId: envelope.parameterId,
      enabled: envelope.enabled,
      points: normalizeAutomationPoints(envelope.points, descriptor),
    }];
  }).sort((left, right) => (
    compareControlSnapshotText(
      "master" in left.target ? "master" : `track:${left.target.trackId}`,
      "master" in right.target ? "master" : `track:${right.target.trackId}`,
    )
    || compareControlSnapshotText(left.parameterId, right.parameterId)
    || compareControlSnapshotText(left.effectInstanceId ?? "", right.effectInstanceId ?? "")
    || compareControlSnapshotText(left.id, right.id)
  )).map(({ id: _id, ...envelope }) => envelope);
  const sidechains = [...input.sidechainRoutes]
    .map((route) => ({
      sourceTrackId: String(route.sourceTrackId),
      targetTrackId: String(route.targetTrackId),
      effectInstanceId: route.effectInstanceId,
    }))
    .sort((left, right) => (
      compareControlSnapshotText(left.targetTrackId, right.targetTrackId)
      || compareControlSnapshotText(left.effectInstanceId, right.effectInstanceId)
      || compareControlSnapshotText(left.sourceTrackId, right.sourceTrackId)
    ));

  return parseSnapshot({
    version,
    project: {
      id: input.project.projectId,
      name: input.project.name,
      revision: input.project.revision,
      tempoBpm: input.project.tempoBpm,
      timeSignature: {
        numerator: input.project.timeSignatureNumerator,
        denominator: input.project.timeSignatureDenominator,
      },
      loop: {
        enabled: input.project.loopEnabled,
        startSec: input.project.loopStartSec,
        endSec: input.project.loopEndSec,
      },
      masterVolume: input.masterVolume,
      updatedAt: input.project.updatedAt,
    },
    tracks,
    clips,
    processors: [...processors, ...externalProcessors].sort((left, right) => (
      compareControlSnapshotText(
        "master" in left.target ? "master" : `track:${left.target.trackId}`,
        "master" in right.target ? "master" : `track:${right.target.trackId}`,
      )
      || left.index - right.index
      || compareControlSnapshotText(left.processor.kind, right.processor.kind)
      || compareControlSnapshotText(left.instanceId ?? "", right.instanceId ?? "")
      || compareControlSnapshotText(String(left.id), String(right.id))
    )),
    automation,
    sidechains,
    assets,
    assetFolders,
  });
};

export const projectControlSnapshotCoreV1 = <Snapshot>(
  input: ControlProjectSnapshotInput,
  parseSnapshot: (snapshot: unknown) => Snapshot,
) => projectControlSnapshotCore(
  input,
  "v1",
  (midi) => ({
    wave: midi.wave,
    ...(midi.gain === undefined ? {} : { gain: midi.gain }),
    notes: midi.notes.map(({ beat, length, pitch, velocity }) => ({
      beat,
      length,
      pitch,
      ...(velocity === undefined ? {} : { velocity }),
    })),
  }),
  parseSnapshot,
)

export const projectControlSnapshotCoreV2 = <Snapshot>(
  input: ControlProjectSnapshotInput,
  parseSnapshot: (snapshot: unknown) => Snapshot,
) => projectControlSnapshotCore(input, "v2", (midi) => midi, parseSnapshot)
