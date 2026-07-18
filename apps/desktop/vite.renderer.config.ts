import path from "node:path"
import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"

export default defineConfig({
  root: path.resolve(import.meta.dirname, "../.."),
  plugins: [tanstackRouter({ target: "solid", autoCodeSplitting: false }), solidPlugin(), tailwindcss()],
  define: { "import.meta.env.VITE_DESKTOP": JSON.stringify("true") },
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
})
