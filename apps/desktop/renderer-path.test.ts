import { expect, test } from "bun:test"
import path from "node:path"
import { packagedRendererRoot, rendererAssetPath } from "./renderer-path"

test("resolves the packaged renderer from Electron's app path", () => {
  expect(packagedRendererRoot("/Applications/daw-browser.app/Contents/Resources/app.asar")).toBe(
    "/Applications/daw-browser.app/Contents/Resources/app.asar/.vite/renderer/main_window",
  )
})

test("resolves the packaged renderer root without a development server", () => {
  expect(packagedRendererRoot("/packaged/app.asar")).toBe(
    "/packaged/app.asar/.vite/renderer/main_window",
  )
})

test("maps the root daw URL to the renderer index", () => {
  expect(rendererAssetPath("/packaged/renderer", "daw://app/")).toBe(
    path.resolve("/packaged/renderer/index.html"),
  )
})

test("rejects traversal before reading renderer assets", () => {
  expect(rendererAssetPath("/packaged/renderer", "daw://app/%2e%2e%2fsecrets.txt")).toBeUndefined()
})

test("decodes asset URLs before resolving them", () => {
  expect(rendererAssetPath("/packaged/renderer", "daw://app/assets/hello%20world.js")).toBe(
    path.resolve("/packaged/renderer/assets/hello world.js"),
  )
})
