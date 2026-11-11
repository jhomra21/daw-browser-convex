import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"

// Sole renderer adapter for the internal session lifecycle. No public RPC.
export const createNativeRevisionSession = (
  invoke: (operation: keyof NativeRevisionSession, input: Parameters<NativeRevisionSession["prepare"]>[0]
    | Parameters<NativeRevisionSession["publish"]>[0]) => Promise<NativeRevisionReply>,
): NativeRevisionSession => ({
  prepare: (input) => invoke("prepare", input),
  publish: (input) => invoke("publish", input),
  inspect: (input) => invoke("inspect", input),
  rollback: (input) => invoke("rollback", input),
  retire: (input) => invoke("retire", input),
})
