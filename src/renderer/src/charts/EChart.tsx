import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import 'echarts-wordcloud'
import worldGeoJson from '../assets/world.geo.json?raw'

echarts.registerMap('world', JSON.parse(worldGeoJson))

/** raw GeoJSON string, re-exported for the standalone HTML export */
export { worldGeoJson }

/**
 * Render an option into a detached offscreen chart and return a PNG data URL.
 * Used by exports so PDFs/images get a purpose-built (light-themed) render
 * instead of a screenshot of the live dark-themed chart.
 */
export async function renderChartPng(
  option: echarts.EChartsOption,
  width = 1280,
  height = 720,
  pixelRatio = 2
): Promise<string> {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;`
  document.body.appendChild(el)
  const chart = echarts.init(el, undefined, { renderer: 'canvas' })
  try {
    // dataZoom is an interactive control: exports render the full data instead
    chart.setOption({ ...option, animation: false, dataZoom: [] }, { notMerge: true })
    // wordcloud/force layouts settle asynchronously — give them a beat
    await new Promise((r) => setTimeout(r, 350))
    return chart.getDataURL({ type: 'png', pixelRatio, backgroundColor: '#ffffff' })
  } finally {
    chart.dispose()
    el.remove()
  }
}

interface Props {
  option: echarts.EChartsOption
  onReady?: (chart: echarts.ECharts) => void
  /**
   * When this key changes (e.g. the chart type), the option is applied with
   * notMerge so no stale components survive; otherwise replaceMerge keeps the
   * scene graph and only swaps series/axes — much cheaper for large data.
   */
  resetKey?: string
}

export function EChart({ option, onReady, resetKey }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const lastResetKey = useRef<string | undefined>(undefined)
  const initialized = useRef(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    initialized.current = false
    const ro = new ResizeObserver(() => {
      // a chart left mid-crash can throw on resize too — never propagate
      try {
        chartRef.current?.resize()
      } catch {
        /* ignored */
      }
    })
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!chartRef.current) return
    const fullReset =
      !initialized.current || resetKey === undefined || resetKey !== lastResetKey.current
    initialized.current = true
    lastResetKey.current = resetKey
    // A bad option (unexpected data shapes deep in an ECharts layout) must
    // degrade to an inline error, not an uncaught exception that kills the UI.
    try {
      chartRef.current.setOption(
        option,
        fullReset
          ? { notMerge: true }
          : { replaceMerge: ['series', 'xAxis', 'yAxis', 'visualMap', 'calendar'] }
      )
      setRenderError(null)
      onReady?.(chartRef.current)
    } catch (e) {
      console.error('[chart] render failed:', e)
      // the instance may hold half-applied state — rebuild it clean
      try {
        chartRef.current.dispose()
      } catch {
        /* ignored */
      }
      if (ref.current) {
        chartRef.current = echarts.init(ref.current, undefined, { renderer: 'canvas' })
      }
      initialized.current = false
      setRenderError(e instanceof Error ? e.message : String(e))
    }
  }, [option, onReady, resetKey])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={ref} style={{ width: '100%', height: '100%' }} />
      {renderError && (
        <div className="chart-error" title={renderError}>
          This chart could not be rendered with the current fields. Try another chart type or
          adjust the shelves.
          {'\n'}
          <span style={{ opacity: 0.75, fontSize: 11 }}>{renderError}</span>
        </div>
      )}
    </div>
  )
}
