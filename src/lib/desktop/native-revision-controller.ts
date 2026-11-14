import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"

type Revision = Extract<NativeRevisionReply, { ok: true }> & { projectId: string }

// Explicit infrastructure only. The playback edit path does not use this until
// retained DSP, schedules, assets and VST staging are implemented.
export const createNativeRevisionController = (session: NativeRevisionSession, project: () => string) => {
  let latestPrepare = 0
  const check = (reply: NativeRevisionReply, projectId: string): Revision => {
    if (project() !== projectId) throw new Error("Native revision project ownership changed.")
    if (!reply.ok) throw new Error(reply.error)
    return { ...reply, projectId }
  }
  const request = (value: Revision) => {
    if (value.projectId !== project()) throw new Error("Native revision project ownership changed.")
    return {
      projectId: value.projectId,
      revision: value.revision.requestedRevision,
      hostGeneration: value.hostGeneration,
      requestedPublicationFrame: value.revision.requestedPublicationFrame ?? 0n,
    }
  }
  return {
    async prepare(bytes: Uint8Array, projectRevision: number, requestedPublicationFrame = 0n) {
      const sequence = ++latestPrepare, projectId = project()
      const value = check(await session.prepare({ projectId, bytes, projectRevision, requestedPublicationFrame }), projectId)
      if (sequence !== latestPrepare) throw new Error("Native revision prepare was superseded.")
      return value
    },
    async publish(value: Revision) {
      const input = request(value)
      const reply = await session.publish(input).catch(() => undefined)
      let result = reply?.ok ? check(reply, input.projectId) : check(await session.inspect(input), input.projectId)
      // One bounded reconciliation, never duplicate publish or rollback.
      if (result.revision.status === "publish-pending" || result.revision.status === "publish-failed")
        result = check(await session.inspect(input), input.projectId)
      if (result.hostGeneration !== value.hostGeneration
        || result.revision.activeRevision !== input.revision || result.revision.status !== "published")
        throw new Error("Native publication is unresolved; inspect status before further work.")
      return result
    },
    async rollback(value: Revision) {
      if (value.revision.activeRevision === value.revision.requestedRevision
        || value.revision.status !== "prepared") throw new Error("Only unpublished prepared revisions may roll back.")
      const input = request(value)
      return check(await session.rollback(input), input.projectId)
    },
    async retire(value: Revision) {
      const retiredRevision = value.revision.retiredRevision
      if (retiredRevision === 0) throw new Error("No retired native revision is pending.")
      const input = { ...request(value), revision: retiredRevision }
      return check(await session.retire(input), input.projectId)
    },
  }
}
