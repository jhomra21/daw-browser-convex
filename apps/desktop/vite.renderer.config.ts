import path from "node:path"
import { defineConfig, loadEnv } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"

export const desktopRendererProductionApiBaseUrl = "https://daw-browser-convex.jhonra121.workers.dev"

export const resolveDesktopRendererApiBaseUrl = (
  configuredBaseUrl: string | undefined,
  mode: string,
) => {
  const trimmed = configuredBaseUrl?.trim()
  if (trimmed) return trimmed
  return mode === "production" ? desktopRendererProductionApiBaseUrl : undefined
}

export default defineConfig(({ mode }) => {
  const root = path.resolve(import.meta.dirname, "../..")
  const environment = loadEnv(mode, root, "VITE_")
  const apiBaseUrl = resolveDesktopRendererApiBaseUrl(
    environment.VITE_API_BASE_URL,
    mode,
  )
  return {
    root,
    plugins: [tanstackRouter({ target: "solid", autoCodeSplitting: false }), solidPlugin(), tailwindcss()],
    define: {
      "import.meta.env.VITE_DESKTOP": JSON.stringify("true"),
      "import.meta.env.VITE_API_BASE_URL": apiBaseUrl ? JSON.stringify(apiBaseUrl) : undefined,
    },
    build: {
      target: "esnext",
      outDir: path.resolve(import.meta.dirname, ".vite/renderer/main_window"),
      emptyOutDir: false,
    },
    resolve: {
      alias: {
        "virtual:pwa-register": path.resolve(import.meta.dirname, "no-pwa.ts"),
        "~": path.resolve(import.meta.dirname, "../../src"),
        "@": path.resolve(import.meta.dirname, "../../src"),
      },
    },
    worker: { format: "es" },
  }
})
