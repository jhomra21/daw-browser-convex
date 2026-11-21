import { app, net as electronNet, protocol, session } from "electron"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createContentSecurityPolicy } from "./content-security-policy"
import { allowsTrustedAudioCapturePermission, allowsTrustedMidiPermission } from "./permission-policy"
import { packagedRendererRoot, rendererAssetPath } from "./renderer-path"
import { desktopEnv } from "./env"
import { benchmarkSabHeaders } from "./benchmark-sab-headers"
import type { RendererSession } from "./renderer-session"

/** How the renderer's own content is served and what it may use: the daw:// protocol, its CSP, and trusted media and MIDI permissions. */
export const installRendererContent = (rendererSession: RendererSession, sameAppOrigin: (url: string) => boolean) => {
  protocol.handle("daw", (request) => {
    const rendererRoot = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? path.join(import.meta.dirname, "../renderer/main_window")
      : packagedRendererRoot(app.getAppPath())

    const safePath = rendererAssetPath(rendererRoot, request.url)

    if (!safePath || !existsSync(safePath)) return new Response("Not found", { status: 404 })

    return electronNet.fetch(pathToFileURL(safePath).toString())
  })
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: {
      ...details.responseHeaders,
      "Content-Security-Policy": [createContentSecurityPolicy(Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL))],
      ...benchmarkSabHeaders(details.url, desktopEnv.benchmarkSabRecording()),
    },
  }))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(
    (
      allowsTrustedAudioCapturePermission({
        permission,
        requestingUrl: details.requestingUrl,
        mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
      }, sameAppOrigin)
    )
    || allowsTrustedMidiPermission({
      permission,
      trustedRendererId: rendererSession.window()?.webContents.id,
      requestingRendererId: webContents.id,
      requestingUrl: details.requestingUrl,
      isMainFrame: details.isMainFrame,
    }, sameAppOrigin),
  ))
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    (
      webContents !== null
      && allowsTrustedAudioCapturePermission({
        permission,
        requestingUrl: requestingOrigin,
        mediaTypes: details.mediaType === "audio" ? ["audio"] : undefined,
      }, sameAppOrigin)
    )
    || allowsTrustedMidiPermission({
      permission,
      trustedRendererId: rendererSession.window()?.webContents.id,
      requestingRendererId: webContents?.id,
      requestingUrl: requestingOrigin,
      isMainFrame: details.isMainFrame,
    }, sameAppOrigin))
}
