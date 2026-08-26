import { describe, expect, test } from "bun:test"
import {
  allowsTrustedAudioCapturePermission,
  allowsTrustedMidiPermission,
  createTrustedDesktopOriginPolicy,
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

  test("recognizes only the packaged app origin by default", () => {
    expect(isTrustedDesktopOrigin("daw://app")).toBeTrue()
    expect(isTrustedDesktopOrigin("daw://app/route")).toBeTrue()
    expect(isTrustedDesktopOrigin("http://localhost:5173/")).toBeFalse()
    expect(isTrustedDesktopOrigin("daw://app.evil/")).toBeFalse()
  })

  test("trusts paths and queries on the explicitly configured development origin", () => {
    const isTrustedOrigin = createTrustedDesktopOriginPolicy("http://localhost:5173/renderer/")
    expect(isTrustedOrigin("http://localhost:5173/other/path?query=value")).toBeTrue()
    expect(isTrustedOrigin("daw://app/route?query=value")).toBeTrue()
  })

  test("rejects exact-origin lookalikes and userinfo", () => {
    const isTrustedOrigin = createTrustedDesktopOriginPolicy("http://localhost:5173/renderer/")
    for (const url of [
      "http://localhost:5174/",
      "http://127.0.0.1:5173/",
      "https://localhost:5173/",
      "http://localhost:51730/",
      "http://sub.localhost:5173/",
      "http://localhost:5173.evil/",
      "http://test-user@localhost:5173/",
    ]) {
      expect(isTrustedOrigin(url)).toBeFalse()
    }
  })

  test("does not trust localhost without a configured development URL", () => {
    const isTrustedOrigin = createTrustedDesktopOriginPolicy(undefined)
    expect(isTrustedOrigin("http://localhost:5173/")).toBeFalse()
    expect(isTrustedOrigin("http://127.0.0.1:5173/")).toBeFalse()
  })

  test("fails closed for an invalid configured development URL", () => {
    const isTrustedOrigin = createTrustedDesktopOriginPolicy("not a URL")
    expect(isTrustedOrigin("daw://app/")).toBeTrue()
    expect(isTrustedOrigin("http://localhost:5173/")).toBeFalse()
  })

  test("configured origin restores the shared audio and MIDI gates", () => {
    const isTrustedOrigin = createTrustedDesktopOriginPolicy("http://localhost:5173/")
    expect(allowsTrustedAudioCapturePermission({
      permission: "media",
      requestingUrl: "http://localhost:5173/audio?source=editor",
      mediaTypes: ["audio"],
    }, isTrustedOrigin)).toBeTrue()
    expect(allowsTrustedMidiPermission({
      permission: "midi",
      trustedRendererId: 1,
      requestingRendererId: 1,
      requestingUrl: "http://localhost:5173/editor?track=1",
      isMainFrame: true,
    }, isTrustedOrigin)).toBeTrue()
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
