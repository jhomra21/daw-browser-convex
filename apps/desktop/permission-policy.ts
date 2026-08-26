const packagedDesktopRendererOrigin = "daw://app"

export type DesktopOriginPolicy = (url: string) => boolean

const parsedTrustedOrigin = (value: string): string | undefined => {
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password) return undefined
    if (parsed.protocol === "daw:") {
      return parsed.hostname === "app" && parsed.port === ""
        ? packagedDesktopRendererOrigin
        : undefined
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined
  } catch {
    return undefined
  }
}

export const createTrustedDesktopOriginPolicy = (
  configuredRendererUrl: string | undefined,
): DesktopOriginPolicy => {
  const configuredRendererOrigin = configuredRendererUrl === undefined
    ? undefined
    : parsedTrustedOrigin(configuredRendererUrl)
  return (url) => {
    const origin = parsedTrustedOrigin(url)
    return origin === packagedDesktopRendererOrigin
      || configuredRendererOrigin !== undefined && origin === configuredRendererOrigin
  }
}

export const isTrustedDesktopOrigin = createTrustedDesktopOriginPolicy(undefined)

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

export const allowsTrustedAudioCapturePermission = (
  input: AudioCapturePermissionInput,
  isTrustedOrigin: DesktopOriginPolicy = isTrustedDesktopOrigin,
): boolean =>
  input.permission === "media"
  && isTrustedOrigin(input.requestingUrl)
  && input.mediaTypes?.length === 1
  && input.mediaTypes[0] === "audio"

export const allowsTrustedMidiPermission = (
  input: MidiPermissionInput,
  isTrustedOrigin: DesktopOriginPolicy = isTrustedDesktopOrigin,
): boolean =>
  input.permission === "midi"
  && input.trustedRendererId !== undefined
  && input.requestingRendererId === input.trustedRendererId
  && input.isMainFrame
  && isTrustedOrigin(input.requestingUrl)
