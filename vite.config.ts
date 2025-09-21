import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import devtools from 'solid-devtools/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';
import { tanstackRouter } from '@tanstack/router-plugin/vite'

export default defineConfig({
  plugins: [tanstackRouter({
    target: 'solid',
    autoCodeSplitting: true,
  }),devtools(), solidPlugin(), tailwindcss(), cloudflare()], //{experimental: { remoteBindings: true }}
  server: {
    port: 3000,
  },
  build: {
    target: 'esnext',
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@": path.resolve(__dirname, "./src"),
    }
  }
});
