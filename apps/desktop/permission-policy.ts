const desktopRendererOrigin = "daw://app"

export const isTrustedDesktopOrigin = (url: string): boolean =>
  url === desktopRendererOrigin || url.startsWith(`${desktopRendererOrigin}/`)

type MidiPermissionInput = {
  permission: string
  trustedRendererId: number | undefined
  requestingRendererId: number | undefined
  requestingUrl: string
  isMainFrame: boolean
}

type AudioCapturePermissionInput = {
  permission: string
  requestingUrl: string
  mediaTypes: readonly string[] | undefined
}

export const allowsTrustedAudioCapturePermission = (input: AudioCapturePermissionInput): boolean =>
  input.permission === "media"
  && isTrustedDesktopOrigin(input.requestingUrl)
  && input.mediaTypes?.length === 1
  && input.mediaTypes[0] === "audio"

export const allowsTrustedMidiPermission = (input: MidiPermissionInput): boolean =>
  input.permission === "midi"
  && input.trustedRendererId !== undefined
  && input.requestingRendererId === input.trustedRendererId
  && input.isMainFrame
  && isTrustedDesktopOrigin(input.requestingUrl)
