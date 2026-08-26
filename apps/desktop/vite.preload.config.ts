import { defineConfig } from "vite"

export default defineConfig({
  build: { target: "node22", lib: { entry: "preload.ts", formats: ["cjs"], fileName: () => "preload.js" }, rollupOptions: { external: ["electron"] } },
})
