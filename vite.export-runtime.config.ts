import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the export-runtime IIFE (window.OVR): the REAL buildChartOption +
// toLightOption + computeFilteredResult, inlined into standalone HTML
// dashboard exports by src/main/exports.ts so filter cards stay interactive.
// Output lands in resources/ (gitignored; rebuilt by the predev/prebuild
// hooks in package.json). Everything bundled here is pure TS — the echarts
// imports in optionBuilder/exportTheme are type-only and erase at build time.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/renderer/src/charts/exportRuntime.ts'),
      name: 'OVRBundle',
      formats: ['iife'],
      fileName: () => 'ov-export-runtime.js'
    },
    outDir: 'resources',
    emptyOutDir: false,
    sourcemap: false
  }
})
