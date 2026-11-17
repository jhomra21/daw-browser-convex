import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import { SYNTH_KIND_ID } from "~/lib/processor-edit-semantics"
import type { ExecutionRetention } from "./native-processor-state-owner"

// The track node of every synth instance of a snapshot: owner targets for a
// synth are keyed by its instance id, like its edit identity and its requests.
export const synthNodes = (snapshot: LivePlaybackSnapshot | undefined) => new Map(
  Object.entries(snapshot?.mixer.fx.trackFx ?? {}).flatMap(([nodeId, fx]): [string, string][] =>
    fx.instrument?.kind === "synth" ? [[fx.instrument.instanceId, nodeId]] : []))

export const sampledKindId = (kind: "sampler" | "granular" | "drum-rack") =>
  kind === "sampler" ? 19 : kind === "granular" ? 20 : 21

// The owner's target kinds at a publication: processors by id and the synths
// whose track node carries an instrument.
export const targetKinds = (graph: AudioCoreGraphSnapshot, snapshot: LivePlaybackSnapshot | undefined) => {
  const instrumentNodes = new Set(graph.nodes.flatMap((node) => node.instrument ? [node.id] : []))
  return new Map<string, number>([
    ...graph.nodes.flatMap((node) => node.processorOrder.map((processor): [string, number] => [processor.id, processor.kindId])),
    ...[...synthNodes(snapshot)].flatMap(([instanceId, nodeId]): [string, number][] =>
      instrumentNodes.has(nodeId) ? [[instanceId, SYNTH_KIND_ID]] : []),
    ...graph.nodes.flatMap((node): [string, number][] => {
      const instrument = snapshot?.mixer.fx.trackFx?.[node.id]?.instrument
      return instrument && instrument.kind !== "synth" && node.instrument
        ? [[instrument.instanceId, sampledKindId(instrument.kind)]]
        : []
    }),
  ])
}

// The processors and instruments a snapshot places on each node: what a graph prepared from it holds.
export const processorMembership = (snapshot: LivePlaybackSnapshot | undefined) => [
  ...(snapshot?.mixer.fx.masterFxInstances ?? []).map((instance) => JSON.stringify(["master", instance.id, instance.kind])),
  ...Object.entries(snapshot?.mixer.fx.trackFx ?? {}).flatMap(([nodeId, fx]) => [
    ...fx.instances, ...(fx.instrument ? [{ id: fx.instrument.instanceId, kind: fx.instrument.kind }] : []),
  ].map((instance) => JSON.stringify([nodeId, instance.id, instance.kind]))),
].sort().join("\n")

// The nodes and routes a snapshot gives a graph, without their gains or timing: what only a publication can install.
export const graphStructure = (snapshot: LivePlaybackSnapshot | undefined) => JSON.stringify([
  snapshot?.mixer.graph.channels.map(({ channel, outputTargetId, inputLayout, outputLayout, sends }) =>
    [channel.id, channel.kind, outputTargetId, inputLayout, outputLayout, sends.map(({ targetId, tap }) => [targetId, tap])]),
  snapshot?.mixer.sidechainRoutes,
])

// The tracks whose sampled instrument regions a prepared graph holds native state for.
export const sampledInstrumentTrackIds = (snapshot: LivePlaybackSnapshot): readonly string[] =>
  Object.entries(snapshot.mixer.fx.trackFx ?? {}).flatMap(([trackId, entry]) =>
    entry.instrument && entry.instrument.kind !== "synth" ? [trackId] : [])

type GraphNode = AudioCoreGraphSnapshot["nodes"][number]
const processorIndex = (graph: AudioCoreGraphSnapshot) => new Map(graph.nodes.flatMap((node) =>
  node.processorOrder.map((processor): [string, { node: GraphNode; kindId: number; targets: ReadonlySet<string> }] =>
    [processor.id, { node, kindId: processor.kindId, targets: new Set(processor.parameterTargets.map(({ id }) => id)) }])))

// Which queued batches native keeps when `next` replaces `previous` (host.cpp
// ReconcileScheduledTargets, core RetainsScheduledTarget). A processor is kept
// on the same node, kind and parameter targets; a synth on the same track node
// and instrument kind. Neither is kept when this publication configures the
// node's instrument again (a synth also when it replaces the instance): the
// node then gets a fresh slot. Slots and generations are native-assigned and not
// visible here: they follow continuity and, for an instrument node, an unchanged
// configuration (core assign_prepared_node 7736-7772, re-run by
// refresh_prepared_node 7776-7784), which Prepare reports as accepted.
export const scheduledRetention = (
  previous: AudioCoreGraphSnapshot,
  next: AudioCoreGraphSnapshot,
  synths: { before: LivePlaybackSnapshot | undefined; after: LivePlaybackSnapshot | undefined },
  configuredNodes: ReadonlySet<string>,
): ExecutionRetention => {
  const before = new Map(previous.nodes.map((node) => [node.id, node]))
  const after = new Map(next.nodes.map((node) => [node.id, node]))
  const nodesBefore = synthNodes(synths.before)
  const nodesAfter = synthNodes(synths.after)
  let processors: { before: ReturnType<typeof processorIndex>; after: ReturnType<typeof processorIndex> } | undefined
  return (key, parameterIds) => {
    processors ??= { before: processorIndex(previous), after: processorIndex(next) }
    const was = processors.before.get(key)
    const now = processors.after.get(key)
    if (was || now) {
      return !!was && !!now && was.node.id === now.node.id && was.node.kind === now.node.kind
        && was.kindId === now.kindId && !configuredNodes.has(now.node.id) && [...parameterIds].every((id) => now.targets.has(id))
    }
    const nodeId = nodesBefore.get(key)
    const instrument = nodeId === undefined ? undefined : before.get(nodeId)?.instrument
    return nodeId !== undefined && !!instrument && nodesAfter.get(key) === nodeId
      && after.get(nodeId)?.instrument?.kind === instrument.kind && !configuredNodes.has(nodeId)
  }
}
