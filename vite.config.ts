import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import devtools from 'solid-devtools/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';

export default defineConfig({
  plugins: [devtools(), solidPlugin(), tailwindcss(), cloudflare()],
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
