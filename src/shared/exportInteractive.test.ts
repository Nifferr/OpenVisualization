import { describe, expect, it } from 'vitest'
import { computeFilteredResult, type ChartDetailPayload } from './exportInteractive'
import type { ShelfState } from './types'

function shelf(partial: Partial<ShelfState> = {}): ShelfState {
  return {
    dataSourceId: '1',
    rows: [{ field: 'region', role: 'dimension' }],
    columns: [{ field: 'sales', role: 'measure', agg: 'sum' }],
    tooltip: [],
    filters: [],
    chartType: 'bar',
    ...partial
  }
}

/** detail grain: region (display dim d0) × channel (filter col d1) */
function payload(partial: Partial<ChartDetailPayload> = {}): ChartDetailPayload {
  return {
    shelf: shelf(),
    built: {
      sql: '',
      dimAliases: ['d0'],
      measureAliases: ['m0'],
      dimLabels: ['region'],
      measureLabels: ['SUM(sales)']
    },
    columns: [
      { name: 'd0', kind: 'string' },
      { name: 'm0', kind: 'number' }
    ],
    dimAliases: ['d0'],
    rows: [
      { d0: 'North', d1: 'web', m0: 10 },
      { d0: 'North', d1: 'store', m0: 5 },
      { d0: 'South', d1: 'web', m0: 7 },
      { d0: 'South', d1: 'store', m0: 3 }
    ],
    reaggs: [{ how: 'sum', alias: 'm0', src: 'm0' }],
    filters: [{ cardId: 'c1', alias: 'd1', mode: 'in' }],
    ...partial
  }
}

describe('computeFilteredResult', () => {
  it('no active cards reproduces the full aggregation', () => {
    const res = computeFilteredResult(payload(), { c1: { mode: 'in', values: [] } })
    expect(res.rows).toEqual([
      { d0: 'North', m0: 15 },
      { d0: 'South', m0: 10 }
    ])
    expect(res.rowCount).toBe(2)
  })

  it('in filter keeps only matching detail rows and re-sums', () => {
    const res = computeFilteredResult(payload(), { c1: { mode: 'in', values: ['web'] } })
    expect(res.rows).toEqual([
      { d0: 'North', m0: 10 },
      { d0: 'South', m0: 7 }
    ])
  })

  it("blank '' in an in-filter matches null detail values", () => {
    const p = payload({
      rows: [
        { d0: 'North', d1: null, m0: 4 },
        { d0: 'North', d1: 'web', m0: 6 }
      ]
    })
    const res = computeFilteredResult(p, { c1: { mode: 'in', values: [''] } })
    expect(res.rows).toEqual([{ d0: 'North', m0: 4 }])
  })

  it('range filter drops out-of-bound and null rows once a bound is set', () => {
    const p = payload({
      filters: [{ cardId: 'c1', alias: 'd1', mode: 'range' }],
      rows: [
        { d0: 'North', d1: 5, m0: 1 },
        { d0: 'North', d1: 50, m0: 2 },
        { d0: 'North', d1: null, m0: 4 }
      ]
    })
    const res = computeFilteredResult(p, { c1: { mode: 'range', min: 0, max: 10 } })
    expect(res.rows).toEqual([{ d0: 'North', m0: 1 }])
  })

  it('dateRange filter compares at day precision on ISO strings', () => {
    const p = payload({
      filters: [{ cardId: 'c1', alias: 'd1', mode: 'dateRange' }],
      rows: [
        { d0: 'N', d1: '2024-01-05 10:00:00', m0: 1 },
        { d0: 'N', d1: '2024-03-01 00:00:00', m0: 2 }
      ]
    })
    const res = computeFilteredResult(p, {
      c1: { mode: 'dateRange', from: '2024-01-01', to: '2024-01-31' }
    })
    expect(res.rows).toEqual([{ d0: 'N', m0: 1 }])
  })

  it('avg re-aggregates from the hidden sum+count pair', () => {
    const p = payload({
      reaggs: [{ how: 'avg', alias: 'm0', sumSrc: 'm1', cntSrc: 'm2' }],
      rows: [
        { d0: 'North', d1: 'web', m1: 10, m2: 2 }, // partial avg 5
        { d0: 'North', d1: 'store', m1: 30, m2: 3 } // partial avg 10
      ]
    })
    // unfiltered: (10+30)/(2+3) = 8 — NOT the average of averages (7.5)
    expect(computeFilteredResult(p, {}).rows).toEqual([{ d0: 'North', m0: 8 }])
    expect(
      computeFilteredResult(p, { c1: { mode: 'in', values: ['store'] } }).rows
    ).toEqual([{ d0: 'North', m0: 10 }])
  })

  it('min/max re-aggregate across partials', () => {
    const p = payload({
      reaggs: [
        { how: 'min', alias: 'm0', src: 'm0' },
        { how: 'max', alias: 'm1', src: 'm0' }
      ],
      built: {
        sql: '',
        dimAliases: ['d0'],
        measureAliases: ['m0', 'm1'],
        dimLabels: ['region'],
        measureLabels: ['MIN(sales)', 'MAX(sales)']
      }
    })
    expect(computeFilteredResult(p, {}).rows).toEqual([
      { d0: 'North', m0: 5, m1: 10 },
      { d0: 'South', m0: 3, m1: 7 }
    ])
  })

  it('groups with no surviving values yield null (SQL aggregate-of-nothing)', () => {
    const p = payload({
      rows: [
        { d0: 'North', d1: 'web', m0: null },
        { d0: 'North', d1: 'web', m0: 3 }
      ]
    })
    const res = computeFilteredResult(p, {})
    expect(res.rows).toEqual([{ d0: 'North', m0: 3 }])
    const allNull = payload({ rows: [{ d0: 'X', d1: 'web', m0: null }] })
    expect(computeFilteredResult(allNull, {}).rows).toEqual([{ d0: 'X', m0: null }])
  })

  it('null dims stay distinct from empty-string dims', () => {
    const p = payload({
      rows: [
        { d0: null, d1: 'web', m0: 1 },
        { d0: '', d1: 'web', m0: 2 }
      ]
    })
    const res = computeFilteredResult(p, {})
    expect(res.rows).toEqual([
      { d0: null, m0: 1 },
      { d0: '', m0: 2 }
    ])
  })

  it('valueDesc sort re-sorts by the first measure after re-aggregation', () => {
    const p = payload({
      shelf: shelf({ rows: [{ field: 'region', role: 'dimension', sort: 'valueDesc' }] })
    })
    const res = computeFilteredResult(p, { c1: { mode: 'in', values: ['store'] } })
    // store partials: North 5, South 3 -> descending
    expect(res.rows).toEqual([
      { d0: 'North', m0: 5 },
      { d0: 'South', m0: 3 }
    ])
    const asc = payload({
      shelf: shelf({ rows: [{ field: 'region', role: 'dimension', sort: 'valueAsc' }] })
    })
    expect(computeFilteredResult(asc, { c1: { mode: 'in', values: ['store'] } }).rows).toEqual([
      { d0: 'South', m0: 3 },
      { d0: 'North', m0: 5 }
    ])
  })

  it('respects shelf.limit after filtering', () => {
    const p = payload({ shelf: shelf({ limit: 1 }) })
    const res = computeFilteredResult(p, {})
    expect(res.rows).toHaveLength(1)
  })

  it('unknown cards in state are ignored (chart on another data source)', () => {
    const res = computeFilteredResult(payload(), {
      other: { mode: 'in', values: ['nope'] }
    })
    expect(res.rowCount).toBe(2)
  })
})
