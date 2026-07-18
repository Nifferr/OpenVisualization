import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Mirrors the aliases in electron.vite.config.ts so renderer modules
// (e.g. charts/optionBuilder) are testable outside Electron.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
