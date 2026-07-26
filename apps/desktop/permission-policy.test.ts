import { describe, expect, test } from "bun:test"
import {
  allowsTrustedAudioCapturePermission,
  allowsTrustedMidiPermission,
  isTrustedDesktopOrigin,
} from "./permission-policy"

describe("desktop MIDI permission policy", () => {
  test("allows MIDI only for the trusted renderer main frame", () => {
    expect(allowsTrustedMidiPermission({
      permission: "midi",
      trustedRendererId: 1,
      requestingRendererId: 1,
      requestingUrl: "daw://app/",
      isMainFrame: true,
    })).toBeTrue()
  })

  test("denies sysex, untrusted renderers and origins, and iframes", () => {
    expect(allowsTrustedMidiPermission({
      permission: "midiSysex",
      trustedRendererId: 1,
      requestingRendererId: 1,
      requestingUrl: "daw://app/",
      isMainFrame: true,
    })).toBeFalse()
    expect(allowsTrustedMidiPermission({
      permission: "midi",
      trustedRendererId: 1,
      requestingRendererId: 2,
      requestingUrl: "daw://app/",
      isMainFrame: true,
    })).toBeFalse()
    expect(allowsTrustedMidiPermission({
      permission: "midi",
      trustedRendererId: 1,
      requestingRendererId: 1,
      requestingUrl: "https://evil.example",
      isMainFrame: true,
    })).toBeFalse()
    expect(allowsTrustedMidiPermission({
      permission: "midi",
      trustedRendererId: 1,
      requestingRendererId: 1,
      requestingUrl: "daw://app/",
      isMainFrame: false,
    })).toBeFalse()
  })

  test("recognizes only the app origin", () => {
    expect(isTrustedDesktopOrigin("daw://app")).toBeTrue()
    expect(isTrustedDesktopOrigin("daw://app/route")).toBeTrue()
    expect(isTrustedDesktopOrigin("daw://app.evil/")).toBeFalse()
  })

  test("preserves trusted audio-only media permission", () => {
    expect(allowsTrustedAudioCapturePermission({
      permission: "media",
      requestingUrl: "daw://app/",
      mediaTypes: ["audio"],
    })).toBeTrue()
    expect(allowsTrustedAudioCapturePermission({
      permission: "media",
      requestingUrl: "daw://app/",
      mediaTypes: ["video"],
    })).toBeFalse()
  })
})
