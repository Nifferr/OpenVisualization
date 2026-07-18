// Convert a chart option built for the dark in-app theme into a light-themed
// copy suitable for exports (HTML/PDF/print on white backgrounds). The option
// builder hardcodes dark-theme colors deep inside axes, tooltips, visualMaps
// etc., so a top-level override is not enough — this walks the whole option
// and remaps every known dark color to its light counterpart.
import type { EChartsOption } from 'echarts'

/** dark-theme color → light-theme replacement (keys lowercase) */
const LIGHT_MAP: Record<string, string> = {
  '#c9cdd6': '#3c4450', // TEXT: dim light gray → dark slate
  '#eee': '#333333', // tooltip text
  '#3a3d46': '#d9dce1', // AXIS_LINE / map borders
  '#444': '#d4d7dc', // tooltip border
  '#2a2c33': '#ffffff', // tooltip background / map no-data area
  '#1e1f24': '#ffffff', // mark borders drawn against the dark app bg
  '#26282f': '#eef1f5', // calendar cell
  '#22303f': '#dce7f3', // visualMap low end
  '#274b6d': '#c0d4e8', // heatmap low end
  '#5a5d68': '#9aa0ab', // graph/tree link lines
  '#31445c': '#cfe0f0' // boxplot fill
}

function remap(value: unknown): unknown {
  if (typeof value === 'string') return LIGHT_MAP[value.toLowerCase()] ?? value
  if (Array.isArray(value)) return value.map(remap)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = remap(v)
    return out
  }
  return value
}

/** Deep copy of `option` with all dark-theme colors remapped and a white background. */
export function toLightOption(option: EChartsOption): EChartsOption {
  const light = remap(option) as EChartsOption
  return {
    ...light,
    backgroundColor: '#ffffff',
    textStyle: { ...(light.textStyle as object), color: '#3c4450' }
  }
}
