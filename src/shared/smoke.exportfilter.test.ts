// THROWAWAY smoke test (deleted after run, per project convention):
// end-to-end verification of the interactive-export pipeline against a real
// DuckDB — plan the detail grain, run the REAL generated SQL, re-aggregate
// client-side, and compare with what SQL itself says the filtered result is.
import { describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { buildQuery } from './sqlBuilder'
import { computeFilteredResult, planChartDetail } from './exportInteractive'
import type { ShelfState } from './types'

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

describe('interactive export pipeline against real DuckDB', () => {
  it('client-side re-aggregation matches SQL truth (sum, avg, count(*), blank/NULL)', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('North', 'web',   10.0, 2.0),
      ('North', 'web',   20.0, 4.0),
      ('North', 'store',  5.0, 1.0),
      ('South', 'web',    7.0, 7.0),
      ('South', 'store',  3.0, NULL),
      ('South', NULL,     9.0, 5.0),
      ('East',  'store',  1.0, 3.0)
    ) AS v(region, channel, sales, qty)`)
    await conn.run(`CREATE VIEW ds_t AS SELECT * FROM t`)
    const run = async (sql: string): Promise<Array<Record<string, unknown>>> =>
      (await conn.runAndReadAll(sql)).getRowObjects()

    const shelf: ShelfState = {
      dataSourceId: 't',
      rows: [{ field: 'region', role: 'dimension' }],
      columns: [
        { field: 'sales', role: 'measure', agg: 'sum' },
        { field: 'qty', role: 'measure', agg: 'avg' },
        { field: '*', role: 'measure', agg: 'count' }
      ],
      tooltip: [],
      filters: [],
      chartType: 'bar'
    }
    const cards = [
      { cardId: 'c1', card: { dsId: 't', field: 'channel', mode: 'in' as const } }
    ]

    const built = buildQuery(shelf, [], 'ds_t')
    const columns = [
      { name: 'd0', kind: 'string' as const },
      { name: 'm0', kind: 'number' as const },
      { name: 'm1', kind: 'number' as const },
      { name: 'm2', kind: 'number' as const }
    ]
    const plan = planChartDetail(shelf, built, cards)
    expect(plan).not.toBeNull()
    const detailBuilt = buildQuery(plan!.detailShelf, [], 'ds_t', { defaultLimit: 50000 })
    const detailRows = await run(detailBuilt.sql)
    const payload = {
      shelf,
      built,
      columns,
      dimAliases: plan!.dimAliases,
      rows: detailRows,
      reaggs: plan!.reaggs,
      filters: plan!.filters
    }

    const norm = (rows: Array<Record<string, unknown>>): unknown[] =>
      rows.map((r) => [
        r.d0 === null ? null : String(r.d0),
        num(r.m0),
        num(r.m1) === null ? null : Math.round(Number(r.m1) * 1e9) / 1e9,
        num(r.m2)
      ])

    const scenarios: Array<{ values: string[]; label: string }> = [
      { values: [], label: 'inactive card = unfiltered' },
      { values: ['web'], label: 'single value' },
      { values: ['web', 'store'], label: 'two values' },
      { values: [''], label: 'blank matches NULL channel' },
      { values: ['', 'store'], label: 'blank + value' },
      { values: ['nope'], label: 'no matches' }
    ]
    for (const sc of scenarios) {
      const clientRows = computeFilteredResult(payload, {
        c1: { mode: 'in', values: sc.values }
      }).rows
      const truthBuilt = buildQuery(shelf, [], 'ds_t', {
        sourceFilters: sc.values.length
          ? [{ kind: 'in', field: 'channel', values: sc.values }]
          : []
      })
      const truthRows = await run(truthBuilt.sql)
      expect(norm(clientRows), sc.label).toEqual(norm(truthRows))
    }
  })

  it('range card matches SQL truth including NULL drop', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('a', 1.0, 10.0), ('a', 5.0, 20.0), ('b', 9.0, 30.0), ('b', NULL, 40.0)
    ) AS v(g, score, sales)`)
    await conn.run(`CREATE VIEW ds_t AS SELECT * FROM t`)
    const run = async (sql: string): Promise<Array<Record<string, unknown>>> =>
      (await conn.runAndReadAll(sql)).getRowObjects()

    const shelf: ShelfState = {
      dataSourceId: 't',
      rows: [{ field: 'g', role: 'dimension' }],
      columns: [{ field: 'sales', role: 'measure', agg: 'sum' }],
      tooltip: [],
      filters: [],
      chartType: 'bar'
    }
    const cards = [{ cardId: 'r1', card: { dsId: 't', field: 'score', mode: 'range' as const } }]
    const built = buildQuery(shelf, [], 'ds_t')
    const plan = planChartDetail(shelf, built, cards)!
    const detailRows = await run(buildQuery(plan.detailShelf, [], 'ds_t').sql)
    const payload = {
      shelf,
      built,
      columns: [
        { name: 'd0', kind: 'string' as const },
        { name: 'm0', kind: 'number' as const }
      ],
      dimAliases: plan.dimAliases,
      rows: detailRows,
      reaggs: plan.reaggs,
      filters: plan.filters
    }
    const norm = (rows: Array<Record<string, unknown>>): unknown[] =>
      rows.map((r) => [String(r.d0), num(r.m0)])

    const client = computeFilteredResult(payload, { r1: { mode: 'range', min: 2, max: 9 } }).rows
    const truth = await run(
      buildQuery(shelf, [], 'ds_t', {
        sourceFilters: [{ kind: 'range', field: 'score', min: 2, max: 9 }]
      }).sql
    )
    expect(norm(client)).toEqual(norm(truth))
  })
})
