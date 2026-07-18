// Entry point for the export-runtime IIFE bundle (vite.export-runtime.config.ts).
// Exposes the REAL option builder + the client-side re-aggregation engine to
// the standalone HTML export as window.OVR, so exported dashboards rebuild
// charts through the exact same code path the app uses. Everything imported
// here must stay pure (no Electron, no Node, no DOM beyond what echarts uses).
import { buildChartOption } from './optionBuilder'
import { toLightOption } from './exportTheme'
import { computeFilteredResult } from '@shared/exportInteractive'

;(globalThis as unknown as Record<string, unknown>).OVR = {
  buildChartOption,
  toLightOption,
  computeFilteredResult
}

export {}
