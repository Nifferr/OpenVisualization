import { CHART_TYPES, chartTypeApplicable } from '@shared/sqlBuilder'
import type { ChartType } from '@shared/types'

/** Extra usage notes beyond the dim/measure counts. */
const NOTES: Partial<Record<ChartType, string>> = {
  table: 'Always available. Shows the aggregated result grid — useful to inspect exactly what a chart will receive.',
  bar: 'Extra dimensions are concatenated on the axis ("Region / Category"). Drop a dimension on Color to split into series.',
  barh: 'Same as Bar with axes swapped — better when category labels are long.',
  stackedBar: 'Put the stacking dimension on Color. With several measures each measure forms its own stack side by side.',
  stackedBarH: 'Horizontal Stacked Bar — better for long category labels.',
  percentBar: 'Like Stacked Bar but each bar is normalized to 100% — compares composition, not size.',
  percentBarH: 'Horizontal 100% Stacked Bar.',
  line: 'Best with a date dimension: use the pill menu → Date part (Year/Month/Day) to control granularity.',
  smoothLine: 'Spline-smoothed line — nicer for trends, but interpolates between points.',
  stepLine: 'Line that changes in steps — good for statuses, prices, inventory levels.',
  area: 'Line with filled area. Same requirements as Line.',
  stackedArea: 'Composition over time: date on Columns, category on Color (or several measures).',
  lollipop: 'Thin stem + dot — a lighter bar chart for many categories.',
  pictorial: 'Bars drawn as stacks of segments — a playful bar variant.',
  rangeBar: 'Floating bar between two measures (e.g. MIN and MAX of a value per category).',
  bullet: 'Measure order matters: actual value, target (red tick), optional range background. KPI vs goal.',
  kpi: 'Big-number cards, one per measure — perfect for dashboard headline metrics. No dimensions.',
  polarBar: 'Bars sweep around circular arcs — an eye-catching ranking (best under ~12 categories).',
  halfDonut: 'Semicircle donut — gauge-style composition. Same requirements as Pie.',
  pyramid: 'Ascending funnel: smallest value on top. Same requirements as Funnel.',
  graphCircular: 'Network graph on a ring (chord-style). Same requirements as Network Graph.',
  treeRadial: 'Tree laid out in a circle — fits deep hierarchies in less space.',
  mapPoints: 'Plot points at coordinates: 1st measure = longitude, 2nd = latitude, optional 3rd = bubble size. Dimension = point label.',
  mapFlow: 'Animated origin→destination arcs: measures are from-lng, from-lat, to-lng, to-lat, optional width.',
  scatter: 'Drag TWO measures (X = first, Y = second). A dimension defines the points; Color splits into series.',
  effectScatter: 'Scatter with animated ripples — highlights points in presentations.',
  bubble: 'Like Scatter plus a third measure controlling bubble size.',
  pie: 'Keep it to ~8 slices: use the pill menu → Top N + "Others" on the dimension.',
  donut: 'Pie with a hole. Same requirements.',
  rose: 'Slice radius encodes the value — dramatic comparison of magnitudes.',
  heatmap: 'First dimension = X, second = Y, measure = cell color. Great for hour × weekday patterns.',
  treemap: 'Drag dimensions in hierarchy order (e.g. Category, then Product). Click a block to drill down.',
  sunburst: 'Radial treemap. Same requirements; inner ring = first dimension.',
  sankey: 'Each dimension is a column of nodes, flows sized by the measure — e.g. Region → Category → Product.',
  funnel: 'Stages sorted by value automatically — conversion/pipeline views.',
  gauge: '1-3 measures, NO dimensions — extra measures add pointers to the same dial.',
  radar: 'Dimension values become the axes; each measure draws a polygon.',
  boxplot: 'The aggregation on the pill is ignored: min, Q1, median, Q3 and max of the raw column are computed per dimension value.',
  calendar: 'Dimension must be a date with Date part = Day (pill menu). One year per calendar row.',
  candlestick: 'Measure order matters: Open, Close, Low, High.',
  waterfall: 'Shows how values accumulate; negative values fall in red, and a Total bar is appended.',
  pareto: 'Bars sorted descending + cumulative % line (80/20 analysis).',
  themeriver: 'Needs a date dimension (any Date part) plus a category dimension; the measure sets stream width.',
  parallel: 'Each measure becomes a vertical axis; each dimension value draws a line across them.',
  graph: 'First dimension = source node, second = target node, measure = link strength. Drag to rearrange, scroll to zoom.',
  tree: 'Expandable hierarchy: dimensions in order become the levels. Click nodes to expand/collapse.',
  wordcloud: 'Dimension values are the words, the measure sets their size. Use Top N (~100) for large vocabularies.',
  map: 'Dimension values must be country names in English matching the world map ("Brazil", "United States of America"). Color = measure.',
  combo: 'First measure renders as bars (left axis), remaining measures as lines (right axis) — compare scale-mismatched metrics.'
}

export function ChartGuide({
  nDims, nMeas, onClose
}: {
  nDims: number
  nMeas: number
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 820 }}>
        <header>
          Chart Guide — current view has {nDims} dimension(s) and {nMeas} measure(s)
        </header>
        <div className="body" style={{ maxHeight: '68vh' }}>
          <table className="grid" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Chart</th>
                <th>Dimensions</th>
                <th>Measures</th>
                <th>Status</th>
                <th style={{ whiteSpace: 'normal' }}>How to use</th>
              </tr>
            </thead>
            <tbody>
              {CHART_TYPES.map((ct) => {
                const ok = chartTypeApplicable(ct, nDims, nMeas)
                const needs: string[] = []
                if (!ok) {
                  if (nDims < ct.minDims) needs.push(`add ${ct.minDims - nDims} dimension(s)`)
                  if (nDims > ct.maxDims) needs.push(`remove ${nDims - ct.maxDims} dimension(s)`)
                  if (nMeas < ct.minMeas) needs.push(`add ${ct.minMeas - nMeas} measure(s)`)
                  if (nMeas > ct.maxMeas) needs.push(`remove ${nMeas - ct.maxMeas} measure(s)`)
                }
                return (
                  <tr key={ct.type}>
                    <td style={{ fontWeight: 600, color: '#fff' }}>{ct.label}</td>
                    <td className="num">
                      {ct.minDims === ct.maxDims ? ct.minDims : `${ct.minDims}–${ct.maxDims >= 99 ? '∞' : ct.maxDims}`}
                    </td>
                    <td className="num">
                      {ct.minMeas === ct.maxMeas ? ct.minMeas : `${ct.minMeas}–${ct.maxMeas >= 99 ? '∞' : ct.maxMeas}`}
                    </td>
                    <td style={{ color: ok ? 'var(--green)' : 'var(--accent2)', whiteSpace: 'normal' }}>
                      {ok ? '✓ ready' : needs.join(', ')}
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 340 }}>{NOTES[ct.type] ?? ct.hint}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="drop-hint">
            Dimensions (blue pills) group the data; measures (green pills) are aggregated numbers. Fields on
            Rows, Columns, Color, Size, Label and Tooltip all count toward the totals above.
          </div>
        </div>
        <footer>
          <button className="primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  )
}
