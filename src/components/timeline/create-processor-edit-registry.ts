import type { ExportFx } from "@daw-browser/audio-engine/export-mixdown";
import { createSignal } from "solid-js";
import { normalizeTrackInstrumentParams, parseJsonValue } from "@daw-browser/shared";
import {
  captureNativeBuiltInParameterValues,
  encodeNativeBuiltInStateCommit,
  nativeBuiltInPatchTiming,
  isLiveParameterChange,
  type NativeBuiltInParameterPayload,
} from "~/lib/desktop/native-built-in-parameter-mapper";
import { SYNTH_KIND_ID, type LiveProcessorEditIdentity } from "~/lib/live-processor-control";
import { createAudioEffectParameterPayload } from "~/components/timeline/audio-effect-parameter-payload";

const processorKindId = (effect: NativeBuiltInParameterPayload["effect"]) => {
  switch (effect.replace(/^master-/, "")) {
    case "utility": return 1;
    case "saturator": return 2;
    case "eq": return 3;
    case "chorus": return 4;
    case "flanger": return 5;
    case "phaser": return 6;
    case "tremolo": return 7;
    case "autopan": return 8;
    case "ensemble": return 9;
    case "gate": return 10;
    case "compressor": return 11;
    case "limiter": return 12;
    case "delay": return 13;
    case "reverb": return 14;
    case "spectral": return 15;
    case "autofilter": return 16;
    case "lofi": return 17;
    case "instrument": return SYNTH_KIND_ID;
    default: return undefined;
  }
};

type Member = {
  kindId: number;
  incarnation: number;
  latest?: { signature: string; edit: LiveProcessorEditIdentity };
  // An edit identified at initiation whose value is not yet written. The first
  // write of exactly that content (replay or projection echo) adopts it.
  pending?: { signature: string; edit: LiveProcessorEditIdentity };
};

const targetOf = (payload: NativeBuiltInParameterPayload) => {
  if (payload.effect === "instrument") {
    return payload.to.kind === "synth" ? { instanceId: payload.to.instanceId, kindId: SYNTH_KIND_ID } : undefined;
  }
  const kindId = processorKindId(payload.effect);
  return payload.instanceId && kindId !== undefined ? { instanceId: payload.instanceId, kindId } : undefined;
};

// The renderer's single authority for processor edit identity: it owns the edit
// order, the live target membership with its creation tokens, and the content
// captured when an edit is allocated. Every desired-value boundary (local
// writes, history replay, the effective projection) allocates through it
// before any async work, so the order is complete when a compile reads it.
export const createProcessorEditRegistry = (readBpm: () => number) => {
  const members = new Map<string, Member>();
  const [structure, setStructure] = createSignal(0);
  let signature: string | undefined;
  let observing = false;
  let changed = false;
  const advanceStructure = () => {
    if (observing) changed = true;
    else setStructure(value => value + 1);
  };
  const isLiveChange = (previous: Member["latest"], payload: NativeBuiltInParameterPayload) => {
    if (!previous) return false;
    const from = parseJsonValue(previous.edit.content.params);
    if (payload.effect === "instrument") {
      const instrument = normalizeTrackInstrumentParams(from ?? null);
      return instrument !== undefined && isLiveParameterChange({ ...payload, from: instrument }, readBpm());
    }
    const timing = nativeBuiltInPatchTiming(payload);
    return timing !== undefined && isLiveParameterChange(createAudioEffectParameterPayload({
      targetId: payload.targetId, instanceId: payload.instanceId ?? "", kind: timing.input.kind,
    }, from, parseJsonValue(payload.to)), readBpm());
  };
  let order = 0;
  let creations = 0;
  const keyOf = (nodeId: string, instanceId: string) => `${nodeId}:${instanceId}`;

  const issue = (payload: NativeBuiltInParameterPayload, target: { instanceId: string; kindId: number }, rollback = false) => {
    const key = keyOf(payload.targetId, target.instanceId);
    let member = members.get(key);
    if (member?.kindId !== target.kindId) {
      member = { kindId: target.kindId, incarnation: ++creations };
      members.set(key, member);
    }
    const bpm = readBpm();
    const state = encodeNativeBuiltInStateCommit(payload, bpm)?.state;
    const values = captureNativeBuiltInParameterValues(payload, bpm);
    const edit: LiveProcessorEditIdentity = {
      id: crypto.randomUUID(),
      order: ++order,
      ...(rollback && { rollback }),
      target: { nodeId: payload.targetId, instanceId: target.instanceId, kindId: target.kindId, incarnation: member.incarnation },
      content: { params: payload.to, timing: nativeBuiltInPatchTiming(payload), ...(state && { state }), ...(values && { values }) },
    };
    return { member, edit };
  };
  // A newer allocation supersedes any reservation made before it. A history
  // replay that completes after it is a later arrival and takes a new order;
  // keeping the reserved, older order would let native drop the replay.
  const supersede = (payload: NativeBuiltInParameterPayload, target: { instanceId: string; kindId: number }, rollback = false) => {
    const { member, edit } = issue(payload, target, rollback);
    const structural = !isLiveChange(member.latest, payload);
    member.pending = undefined;
    member.latest = { signature: JSON.stringify(payload.to), edit };
    if (structural) advanceStructure();
    return edit;
  };
  // Equal content on a member is the same write: its identity is reused, so a
  // write, its history replay and its projection echo share one edit.
  const allocate = (payload: NativeBuiltInParameterPayload) => {
    const target = targetOf(payload);
    if (!target) return undefined;
    const signature = JSON.stringify(payload.to);
    const current = members.get(keyOf(payload.targetId, target.instanceId));
    if (current?.kindId === target.kindId) {
      // The reservation is matched first and consumed, so an equal current
      // value cannot leave it behind to identify a later, distinct write.
      if (current.pending?.signature === signature) {
        const structural = !isLiveChange(current.latest, payload);
        current.latest = current.pending;
        current.pending = undefined;
        if (structural) advanceStructure();
        return current.latest.edit;
      }
      if (current.latest?.signature === signature) return current.latest.edit;
    }
    return supersede(payload, target);
  };

  const observeInstance = (payload: NativeBuiltInParameterPayload, live: Set<string>) => {
    const target = targetOf(payload);
    if (!target) return;
    live.add(keyOf(payload.targetId, target.instanceId));
    allocate(payload);
  };

  return {
    sequence: () => order,
    structure,
    allocate,
    // Identifies an edit at initiation, before its value is written; `allocate`
    // adopts it when that write happens. One reservation per member.
    reserve: (payload: NativeBuiltInParameterPayload) => {
      const target = targetOf(payload);
      if (!target) return undefined;
      const { member, edit } = issue(payload, target);
      member.pending = { signature: JSON.stringify(payload.to), edit };
      return edit;
    },
    // A reservation whose write will not happen (failed persistence) is retired.
    release: (edit: LiveProcessorEditIdentity) => {
      const member = members.get(keyOf(edit.target.nodeId, edit.target.instanceId));
      if (member?.pending?.edit === edit) member.pending = undefined;
    },
    // Conditional rollback (save failure or explicit gesture cancel of `failed`):
    // the replacement takes a fresh edit only while `failed` is still the latest
    // edit of the same incarnation. A newer write or an external winner keeps
    // its identity, and the caller then leaves desired state untouched.
    replace: (failed: LiveProcessorEditIdentity, payload: NativeBuiltInParameterPayload) => {
      const target = targetOf(payload);
      const member = target && members.get(keyOf(payload.targetId, target.instanceId));
      if (!target || member?.incarnation !== failed.target.incarnation || member.latest?.edit.id !== failed.id) return undefined;
      return supersede(payload, target, true);
    },
    // A new mounted project or generation starts with no membership. Creation
    // tokens and the order keep counting, so no earlier token becomes valid again.
    reset: () => {
      const populated = members.size > 0 || signature !== undefined;
      members.clear();
      signature = undefined;
      if (populated) advanceStructure();
    },
    target: (nodeId: string, instanceId: string) => {
      const member = members.get(keyOf(nodeId, instanceId));
      return member && { kindId: member.kindId, incarnation: member.incarnation, latest: member.latest?.edit };
    },
    // Ingests the effective projection (own writes echoed back, collaborators,
    // other local writers, history). A value no write here produced takes a
    // new edit; membership follows the projection, so a removed target is
    // retired and a re-added one takes a fresh creation token.
    observe: (fx: ExportFx) => {
      observing = true;
      changed = false;
      // Only resolved scheduling structure belongs here. Member parameters use
      // the mapper above; decoded buffers and mapper-live values never do.
      const instances = (entries: ExportFx["masterFxInstances"]) => entries.map(entry => [entry.id, entry.kind]);
      const nextSignature = JSON.stringify([instances(fx.masterFxInstances),
        Object.entries(fx.trackFx ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([id, entry]) => [
          id, instances(entry.instances), entry.instrument?.kind === "synth"
            ? [entry.instrument.kind, entry.instrument.instanceId] : entry.instrument, entry.arp, entry.synth,
        ])]);
      if (signature !== nextSignature) {
        signature = nextSignature;
        changed = true;
      }
      const live = new Set<string>();
      const effectsOf = (nodeId: string, instances: ExportFx["masterFxInstances"]) => {
        for (const instance of instances) {
          observeInstance(
            createAudioEffectParameterPayload({ targetId: nodeId, instanceId: instance.id, kind: instance.kind }, instance.params, instance.params),
            live,
          );
        }
      };
      effectsOf("master", fx.masterFxInstances);
      for (const [trackId, entry] of Object.entries(fx.trackFx ?? {})) {
        effectsOf(trackId, entry.instances);
        const instrument = entry.instrument;
        if (instrument?.kind === "synth") {
          observeInstance({ targetId: trackId, effect: "instrument", from: instrument, to: instrument }, live);
        }
      }
      for (const key of members.keys()) if (!live.has(key)) members.delete(key);
      observing = false;
      if (changed) advanceStructure();
    },
  };
};
