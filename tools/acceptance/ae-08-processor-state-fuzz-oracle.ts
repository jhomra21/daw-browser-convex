export type Defect = "stale-overwrite" | "false-receipt" | "early-release" | "noop-churn" | "drop-batch" | "false-rejection" | "lost-edit" | "swallow-waiter" | "never-wake-latency" | "underfill" | "force-rebuild" | "false-urgent-receipt" | "cancel-retained" | "post-recovery-overwrite"
export type Failure = { invariant: string; detail: string; domain: string; class?: string; reason?: string | null; error?: string | null; transition?: string | null }
export type Content = { gain: number; fft: 512 | 1024 | 2048 | 4096; sequence: number; sample: boolean; utilityPresent?: boolean; incarnation: number }
export const initialContent: Content = { gain: 0, fft: 512, sequence: 1, sample: false, incarnation: 1 }
export const reduceDesired = (previous: Content, change: Partial<Content>): Content =>
  change.sequence !== undefined && change.sequence < previous.sequence ? previous : { ...previous, ...change }
export type Processor = { instance: number; node: bigint; kind: number; targets: Set<number>; state: Uint8Array; latency: number }
export type Graph = { revision: number; processors: Map<number, Processor>; nodes: Map<bigint, number>; nodeLatencies: number[]; pdc: number[]; masterGain?: number }
export const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// Deliberately decode the wire rather than importing graph merge/winner code.
export const decodeGraph = (bytes: Uint8Array): Graph => {
  const view = viewOf(bytes)
  const version = view.getUint32(12, true)
  const nodes = view.getUint32(20, true)
  const edges = view.getUint32(24, true)
  const count = view.getUint32(28, true)
  const nodeBytes = version === 5 ? 140 : version === 4 ? 136 : 132
  const graphNodes = new Map(Array.from({ length: nodes }, (_, index) => {
    const offset = 36 + index * nodeBytes
    return [view.getBigUint64(offset, true), view.getUint32(offset + 8, true)]
  }))
  // The mixer state closes a node record, 16 bytes from its end (native-host-wire.ts: mixerOffset + 8).
  const masterOffset = Array.from({ length: nodes }, (_, index) => 36 + index * nodeBytes).find((offset) => view.getUint32(offset + 8, true) === 6)
  const masterGain = masterOffset === undefined ? undefined : view.getFloat32(masterOffset + nodeBytes - 16, true)
  const nodeLatencies = Array.from({ length: nodes }, (_, index) => view.getUint32(36 + index * nodeBytes + 24, true))
  const pdc = Array.from({ length: edges }, (_, index) => view.getUint32(36 + nodes * nodeBytes + index * 48 + 44, true))
  let offset = 36 + nodes * nodeBytes + edges * 48
  const processors = new Map<number, Processor>()
  for (let index = 0; index < count; index++) {
    const size = view.getUint32(offset + 16, true)
    const parameters = view.getUint32(offset + 36, true)
    const instance = view.getUint32(offset + 20, true)
    processors.set(instance, { instance, node: view.getBigUint64(offset, true), kind: view.getUint32(offset + 8, true),
      targets: new Set(Array.from({ length: parameters }, (_, index) => view.getUint32(offset + 48 + size + index * 4, true))),
      state: bytes.slice(offset + 48, offset + 48 + size), latency: view.getUint32(offset + 40, true) })
    offset += 48 + size + parameters * 4
  }
  return { revision: Number(view.getBigUint64(0)), processors, nodes: graphNodes, nodeLatencies, pdc, masterGain }
}
// The master node's mixer gain: where a compile context that changes the master volume lands in the wire.
export const masterGainOf = (graph: Graph | undefined) => graph?.masterGain ?? null
export const fields = (graph: Graph | undefined) => {
  const utility = graph && [...graph.processors.values()].find((processor) => processor.kind === 1)
  const spectral = graph && [...graph.processors.values()].find((processor) => processor.kind === 15)
  return {
    gain: utility ? viewOf(utility.state).getFloat32(4, true) : null,
    fft: spectral ? viewOf(spectral.state).getUint32(4, true) : null,
    latency: spectral?.latency ?? null,
    nodeLatencies: graph?.nodeLatencies ?? [],
    pdc: graph?.pdc ?? [],
  }
}


// Fixed fixture: track (Utility -> spectral) and zero-latency parallel -> master.
// This does not call the product compensation planner or winner/merge helpers.
export const expectedTopology = (fft: Content["fft"]) => ({
  nodeLatencies: [fft, 0, 0],
  pdc: [0, fft],
})
export const coverageFailure = (running: boolean, through: bigint, rendered: bigint) =>
  running && through < rendered + 512n
    ? "Running active coverage is below renderedThroughFrame plus one block" : undefined
export const rebuildFailure = (before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>) =>
  ["stop", "configure", "initial-graph"].some((name) => (after.get(name) ?? 0) > (before.get(name) ?? 0))
    ? "Supported live edit triggered stop, configure or cold install" : undefined
export const staleFailure = (actualGain: number | null, desired: Content, confirmedGain: number, confirmedOrder: number) =>
  actualGain !== confirmedGain && desired.gain === confirmedGain && desired.sequence <= confirmedOrder
    ? "Native content regressed below newer confirmed edit" : undefined
export const receiptFailure = (appliedGain: number | null | undefined, submittedGain: number) =>
  appliedGain !== submittedGain ? "Applied receipt names gain never applied by callback" : undefined
// A waiter owns the batches dispatched for its record, whoever sent them: a refused batch is sent again from an adoption
// or a frame, and a flush that joins the record sends nothing itself.
export const recordBatches = (dispatches: readonly { editId: string; sequence: bigint }[], editId: string | undefined) =>
  dispatches.filter((dispatch) => dispatch.editId === editId).map((dispatch) => dispatch.sequence)
// The controller's 1 s proof deadline answered the caller before the frame naming a batch of its record as applied was
// delivered. B3b removes that timer; every other rejection of an applied record keeps its own class.
export const proofDeadlineError = "Native processor update was not applied before timeout."
export const proofDeadlineFailure = (error: string | undefined, credited: readonly (number | undefined)[], deliveredApplied: bigint) =>
  error === proofDeadlineError && credited.some((sequence) => sequence !== undefined && BigInt(sequence) > deliveredApplied)
export const rejectionClassification = (applied: boolean, superseded: boolean) =>
  applied ? "applied-but-rejected" : superseded ? "rejected-then-superseded" : "lost-edit"
// Ending transport is not a live-domain false rejection. Keep its own red
// witness until B3b supplies a cancelled receipt that callers can preserve.
export const endingRejectionClass = (domain: string, reason: string | undefined) =>
  domain === "ending-transport-domain" && reason === "stale" ? "pause-seek-stale" : undefined
export const convergenceFailure = (actual: ReturnType<typeof fields>, desired: Content) =>
  actual.gain !== desired.gain || actual.fft !== desired.fft || actual.latency !== desired.fft
export const topologyFailure = (actual: ReturnType<typeof fields>, desired: Content) => {
  const expected = expectedTopology(desired.fft)
  return JSON.stringify(actual.pdc) !== JSON.stringify(expected.pdc)
    || JSON.stringify(actual.nodeLatencies) !== JSON.stringify(expected.nodeLatencies)
}


export type OwnershipBank = { sources: ReadonlyMap<number, bigint> }
export const ownershipFailures = <Bank extends OwnershipBank>(
  leases: ReadonlyMap<number, { acquisitions: number; releases: number; owners: ReadonlySet<Bank>; reclaimed: boolean }>,
  assets: ReadonlyMap<number, { released: boolean }>,
  banks: readonly (Bank | undefined)[],
) => {
  const failures: string[] = []
  for (const [id, lease] of leases) {
    if (lease.acquisitions !== lease.releases + (assets.get(id)?.released === false ? 1 : 0))
      failures.push(`Acquisition/release conservation failed for ${id}`)
    if (lease.owners.size && (!assets.has(id) || lease.reclaimed))
      failures.push(`Active graph lease ${id} erased before retirement`)
    for (const owner of lease.owners)
      if (!banks.includes(owner)) failures.push(`Reader owner ${id} survived bank disposal`)
  }
  for (const bank of banks) {
    if (!bank) continue
    for (const id of bank.sources.keys())
      if (!leases.get(id)?.owners.has(bank) || !assets.has(id)) failures.push(`Unowned graph lease ${id}`)
  }
  return failures
}
export const settlementFailure = (pending: boolean) =>
  pending ? "Unsettled controller request at logical drain bound" : undefined
export const quiescenceFailure = (before: string | undefined, after: string) =>
  before !== after ? "Frozen identical input produced additional bridge work" : undefined
export const endingDomainFailure = (waiters: readonly { settled: boolean; domain: number }[], domain: number) =>
  waiters.some((waiter) => !waiter.settled && waiter.domain < domain)
export const rebuildResultFailure = (status: string) => status === "rebuild"
