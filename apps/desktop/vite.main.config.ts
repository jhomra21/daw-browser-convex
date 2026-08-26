import { defineConfig } from "vite"

export default defineConfig({
  build: { target: "node22", lib: { entry: "main.ts", formats: ["es"], fileName: () => "main.js" }, rollupOptions: { external: ["electron"] } },
})
