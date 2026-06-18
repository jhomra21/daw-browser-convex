import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import devtools from 'solid-devtools/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [tanstackRouter({
    target: 'solid',
    autoCodeSplitting: false,
  }),devtools(), solidPlugin(), tailwindcss(), VitePWA({
    registerType: 'autoUpdate',
    manifest: {
      name: 'Browser DAW',
      short_name: 'Browser DAW',
      description: 'A local-first browser DAW.',
      theme_color: '#bfbfbf',
      background_color: '#0a0a0a',
      display: 'standalone',
      icons: [
        { src: '/logo192.png', sizes: '192x192', type: 'image/png' },
        { src: '/logo512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    workbox: {
      navigateFallback: '/index.html',
      globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
      maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
    },
  }), cloudflare()], //{experimental: { remoteBindings: true }}
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
