type NativePlaybackAbortKind = "ownership-invalidated" | "coordinator-disposed" | "page-manager-disposed"

const messages = {
  "ownership-invalidated": "Native playback ownership was invalidated.",
  "coordinator-disposed": "Native schedule coordinator was disposed.",
  "page-manager-disposed": "Native timeline page manager was disposed.",
} satisfies Record<NativePlaybackAbortKind, string>

export class NativePlaybackAbortError extends Error {
  constructor(readonly kind: NativePlaybackAbortKind) {
    super(messages[kind])
    this.name = "AbortError"
  }
}
