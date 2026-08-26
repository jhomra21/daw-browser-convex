import { expect, test } from "bun:test"
import {
  desktopRendererProductionApiBaseUrl,
  resolveDesktopRendererApiBaseUrl,
} from "./vite.renderer.config"

test("uses the checked-in production API for packaged desktop builds", () => {
  expect(resolveDesktopRendererApiBaseUrl(undefined, "production")).toBe(desktopRendererProductionApiBaseUrl)
})

test("keeps unconfigured development builds on their local API path", () => {
  expect(resolveDesktopRendererApiBaseUrl(undefined, "development")).toBeUndefined()
})

test("allows the desktop renderer API to be overridden by the build environment", () => {
  expect(resolveDesktopRendererApiBaseUrl("https://staging.example.test", "development")).toBe(
    "https://staging.example.test",
  )
  expect(resolveDesktopRendererApiBaseUrl("  ", "production")).toBe(desktopRendererProductionApiBaseUrl)
})
