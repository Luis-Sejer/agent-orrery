/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER = 'http://127.0.0.1:4777'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 800 },
  test: { include: ['src/**/*.test.ts'] },
  server: {
    // The agent-orrery server rejects foreign Host headers, so the proxy must rewrite it.
    proxy: {
      '/events': { target: SERVER, changeOrigin: true },
      '/api': { target: SERVER, changeOrigin: true },
    },
  },
})
