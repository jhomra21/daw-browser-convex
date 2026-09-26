import { desktopReplySchemaV1, hostError } from "@daw-browser/desktop-protocol"
import type { PreloadHostResponse } from "./request-queue"

export const safePreloadReply = (response: PreloadHostResponse) => {
  const parsed = desktopReplySchemaV1.safeParse({
    version: "v1",
    type: "reply",
    id: response.id,
    ...(response.error === undefined ? { result: response.result } : { error: response.error }),
  })
  return parsed.success ? parsed.data : desktopReplySchemaV1.parse({
    version: "v1",
    type: "reply",
    id: response.id,
    error: hostError("internal", "The renderer returned an invalid response."),
  })
}
