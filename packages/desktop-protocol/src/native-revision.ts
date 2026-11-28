export type NativeGraphRevisionStatus = {
  status: "prepared" | "published" | "publish-pending" | "retired" | "rolled-back" | "stale-revision"
    | "invalid-revision" | "prepare-failed" | "publish-failed" | "retirement-not-safe"
    | "retirement-capacity-exceeded" | "rebase-required" | "capture-target-locked"
  continuity: "not-evaluated" | "accepted" | "fallback" | "rejected"
  requestedRevision: number
  activeRevision: number
  preparedRevision: number
  retiredRevision: number
  publicationFrame: bigint
  renderEpoch: bigint
  requestedPublicationFrame?: bigint
  progressFrame?: bigint
  transportEpoch?: number
  diagnosticCode?: number
}

export type NativeRevisionBinding = { projectId: string }
export type NativeRevisionRequest = NativeRevisionBinding & {
  revision: number
  hostGeneration: number
  requestedPublicationFrame?: bigint
}
// The same three-way status as every other native command: `refused` (native answered and said no), `unavailable`
// (nothing was delivered) and `unconfirmed` (the request may have been taken and no answer came).
export type NativeRevisionFailureKind = "refused" | "unavailable" | "unconfirmed"
export type NativeRevisionReply = {
  ok: true
  hostGeneration: number
  hostPid: number
  revision: NativeGraphRevisionStatus
} | { ok: false; error: string; kind: NativeRevisionFailureKind }

export type NativeRevisionSession = {
  prepare(input: NativeRevisionBinding & {
    bytes: Uint8Array
    projectRevision: number
    requestedPublicationFrame?: bigint
  }): Promise<NativeRevisionReply>
  publish(input: NativeRevisionRequest): Promise<NativeRevisionReply>
  inspect(input: NativeRevisionRequest): Promise<NativeRevisionReply>
  rollback(input: NativeRevisionRequest): Promise<NativeRevisionReply>
  retire(input: NativeRevisionRequest): Promise<NativeRevisionReply>
}
