import { describe, expect, it } from 'vitest'
import {
  buildDetailQuery,
  buildQuery,
  calcFieldKind,
  calcFieldSql,
  collectRefs,
  fieldLabel,
  filtersToWhere,
  getAdaptiveLimit,
  quoteIdent,
  quoteLiteral,
  validateExpression
} from './sqlBuilder'
import type { Agg, CalcField, FieldRef, ShelfState } from './types'

const VIEW = 'ds_1'

function shelf(partial: Partial<ShelfState> = {}): ShelfState {
  return {
    dataSourceId: '1',
    rows: [],
    columns: [],
    tooltip: [],
    filters: [],
    chartType: 'bar',
    ...partial
  }
}

const dim = (field: string, extra: Partial<FieldRef> = {}): FieldRef => ({
  field,
  role: 'dimension',
  ...extra
})
const mea = (field: string, agg: Agg = 'sum', extra: Partial<FieldRef> = {}): FieldRef => ({
  field,
  role: 'measure',
  agg,
  ...extra
})

const calc = (extra: Partial<CalcField> = {}): CalcField => ({
  name: 'c',
  expr: 'x',
  role: 'dimension',
  ...extra
})

describe('quoteIdent / quoteLiteral', () => {
  it('doubles embedded quotes', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"')
    expect(quoteIdent('order by')).toBe('"order by"')
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'")
  })

  it('leaves backslashes alone (DuckDB standard strings)', () => {
    expect(quoteLiteral('a\\b')).toBe("'a\\b'")
  })
})

describe('validateExpression', () => {
  it('rejects statement separators and DDL/DML keywords', () => {
    expect(validateExpression('x; y')).toMatch(/";"/)
    expect(validateExpression('drop table t')).toMatch(/DROP/)
    expect(validateExpression('Attach db')).toMatch(/ATTACH/)
  })

  it('accepts ordinary expressions', () => {
    expect(validateExpression('upper(name)')).toBeNull()
    expect(validateExpression('sum(x) / count(*)')).toBeNull()
  })

  it('ignores ";" and denylisted words inside string literals', () => {
    // real bug: the "Extract identifier (all matches)" template joins matches
    // with '; ' — a literal semicolon that used to false-positive
    expect(
      validateExpression(`array_to_string(regexp_extract_all(x, 'a'), '; ')`)
    ).toBeNull()
    expect(validateExpression("status = 'load average'")).toBeNull()
    // doubled '' (escaped quote) inside the literal doesn't confuse the scanner
    expect(validateExpression("x = 'it''s; a load'")).toBeNull()
  })

  it('still rejects a real statement separator or keyword outside any literal', () => {
    expect(validateExpression("'a' ; drop table t")).not.toBeNull()
    expect(validateExpression("'safe' + load(x)")).not.toBeNull()
  })

  it('fails closed on an unterminated string literal', () => {
    // no closing quote to match, so the ';'/'drop' after it stay visible
    expect(validateExpression("x' ; drop table t")).not.toBeNull()
  })
})

describe('getAdaptiveLimit', () => {
  it('steps down as sources grow', () => {
    expect(getAdaptiveLimit(999_999)).toBe(50000)
    expect(getAdaptiveLimit(1_000_000)).toBe(10000)
    expect(getAdaptiveLimit(10_000_000)).toBe(5000)
    expect(getAdaptiveLimit(100_000_000)).toBe(1000)
  })
})

describe('fieldLabel', () => {
  it('labels measures, bins and plain dims', () => {
    expect(fieldLabel(mea('*', 'count'))).toBe('Count of Records')
    expect(fieldLabel(mea('sales'))).toBe('SUM(sales)')
    expect(fieldLabel(dim('ts', { dateBin: 'month' }))).toBe('MONTH(ts)')
    expect(fieldLabel(dim('age', { numBin: { size: 10 } }))).toBe('age (bin 10)')
    expect(fieldLabel(dim('region'))).toBe('region')
  })
})

describe('collectRefs', () => {
  it('walks shelves in stable order and dedups by field+bin / field+agg', () => {
    const s = shelf({
      columns: [dim('a')],
      rows: [mea('v', 'sum')],
      color: dim('a'), // duplicate dim
      tooltip: [mea('v', 'sum'), mea('v', 'avg')] // dup measure + distinct agg
    })
    const { dims, meas } = collectRefs(s)
    expect(dims.map((d) => d.field)).toEqual(['a'])
    expect(meas.map((m) => `${m.field}|${m.agg}`)).toEqual(['v|sum', 'v|avg'])
  })

  it('keeps same field with different bins as separate dims', () => {
    const s = shelf({ columns: [dim('ts', { dateBin: 'year' }), dim('ts', { dateBin: 'month' })] })
    expect(collectRefs(s).dims).toHaveLength(2)
  })
})

describe('buildQuery — core', () => {
  it('builds a minimal dim + measure aggregation', () => {
    const q = buildQuery(shelf({ columns: [dim('category')], rows: [mea('sales')] }), [], VIEW)
    expect(q.sql).toContain('WITH src AS (SELECT * FROM "ds_1")')
    expect(q.sql).toContain('"category" AS "d0"')
    expect(q.sql).toContain('sum("sales") AS "m0"')
    expect(q.sql).toContain(' GROUP BY 1')
    expect(q.sql).toContain(' ORDER BY "d0"')
    expect(q.sql).toContain(' LIMIT 50000')
    expect(q.dimAliases).toEqual(['d0'])
    expect(q.measureAliases).toEqual(['m0'])
    expect(q.measureLabels).toEqual(['SUM(sales)'])
  })

  it('Number of Records (*) always compiles to count(*)', () => {
    const q = buildQuery(shelf({ rows: [mea('*', 'sum')] }), [], VIEW)
    expect(q.sql).toContain('count(*) AS "m0"')
    expect(q.sql).not.toContain('sum(')
    expect(q.measureLabels).toEqual(['Count of Records'])
  })

  it('dims-only views get a count(*) fallback measure', () => {
    const q = buildQuery(shelf({ columns: [dim('category')] }), [], VIEW)
    expect(q.sql).toContain('count(*) AS "m0"')
    expect(q.measureLabels).toEqual(['Count of Records'])
  })

  it('wraps numeric aggs over non-number columns in TRY_CAST', () => {
    const opts = { fieldKinds: { amount: 'string' as const } }
    expect(buildQuery(shelf({ rows: [mea('amount')] }), [], VIEW, opts).sql).toContain(
      'sum(TRY_CAST("amount" AS DOUBLE)) AS "m0"'
    )
    // number kind, unknown kind and non-numeric aggs stay bare
    expect(
      buildQuery(shelf({ rows: [mea('amount')] }), [], VIEW, {
        fieldKinds: { amount: 'number' }
      }).sql
    ).toContain('sum("amount")')
    expect(buildQuery(shelf({ rows: [mea('amount')] }), [], VIEW).sql).toContain('sum("amount")')
    expect(
      buildQuery(shelf({ rows: [mea('amount', 'count')] }), [], VIEW, opts).sql
    ).toContain('count("amount")')
  })

  it('date bins TRY_CAST to timestamp so bad values become a NULL group', () => {
    const q = buildQuery(shelf({ columns: [dim('ts', { dateBin: 'month' })] }), [], VIEW)
    expect(q.sql).toContain(`date_trunc('month', TRY_CAST("ts" AS TIMESTAMP)) AS "d0"`)
  })

  it('numeric bins floor to the bin size and TRY_CAST text columns', () => {
    const q = buildQuery(shelf({ columns: [dim('age', { numBin: { size: 10 } })] }), [], VIEW)
    expect(q.sql).toContain('floor("age" / 10) * 10 AS "d0"')
    const qText = buildQuery(
      shelf({ columns: [dim('age', { numBin: { size: 10 } })] }),
      [],
      VIEW,
      { fieldKinds: { age: 'string' } }
    )
    expect(qText.sql).toContain('floor(TRY_CAST("age" AS DOUBLE) / 10) * 10 AS "d0"')
    // size 0 disables binning
    const q0 = buildQuery(shelf({ columns: [dim('age', { numBin: { size: 0 } })] }), [], VIEW)
    expect(q0.sql).toContain('"age" AS "d0"')
    expect(q0.sql).not.toContain('floor')
  })
})

describe('buildQuery — top-N', () => {
  const topShelf = (topN: FieldRef['topN']): ShelfState =>
    shelf({ columns: [dim('category', { topN })], rows: [mea('sales')] })

  it('top-2 with Others: CTE ranks by count(*) for byField "*" and CASE-buckets the rest', () => {
    const q = buildQuery(
      topShelf({ n: 2, byField: '*', byAgg: 'sum', others: true }),
      [],
      VIEW
    )
    expect(q.sql).toContain(
      'top_0 AS (SELECT "category" AS v FROM src GROUP BY 1 ORDER BY count(*) DESC LIMIT 2)'
    )
    expect(q.sql).toContain(`ELSE 'Others' END AS "d0"`)
    // with Others there is no restriction WHERE on the outer query
    expect(q.sql).not.toContain('\nFROM src WHERE')
  })

  it('top-N without Others restricts via WHERE ... IN (SELECT v FROM top_0)', () => {
    const q = buildQuery(
      topShelf({ n: 3, byField: 'sales', byAgg: 'sum', others: false }),
      [],
      VIEW
    )
    expect(q.sql).toContain('ORDER BY sum("sales") DESC LIMIT 3')
    expect(q.sql).toContain('\nFROM src WHERE "category" IN (SELECT v FROM top_0)')
    expect(q.sql).not.toContain("'Others'")
  })

  it('bottom direction ranks ascending', () => {
    const q = buildQuery(
      topShelf({ n: 2, byField: '*', byAgg: 'count', others: false, direction: 'bottom' }),
      [],
      VIEW
    )
    expect(q.sql).toContain('ORDER BY count(*) ASC LIMIT 2')
  })

  it('percent mode uses a window-ranked CTE with a clamped percentage', () => {
    const q = buildQuery(
      topShelf({ n: 25, byField: 'sales', byAgg: 'sum', others: false, mode: 'percent' }),
      [],
      VIEW
    )
    expect(q.sql).toContain('row_number() OVER (ORDER BY sum("sales") DESC) AS rn')
    expect(q.sql).toContain('count(*) OVER () AS tot')
    expect(q.sql).toContain('WHERE rn <= greatest(1, CAST(ceil(tot * 25 / 100.0) AS BIGINT))')
    // clamps: 0 -> 0.01, 500 -> 100
    expect(
      buildQuery(topShelf({ n: 0, byField: '*', byAgg: 'count', others: false, mode: 'percent' }), [], VIEW).sql
    ).toContain('tot * 0.01 / 100.0')
    expect(
      buildQuery(topShelf({ n: 500, byField: '*', byAgg: 'count', others: false, mode: 'percent' }), [], VIEW).sql
    ).toContain('tot * 100 / 100.0')
  })

  it('count mode floors fractional n and never goes below 1', () => {
    expect(
      buildQuery(topShelf({ n: 2.9, byField: '*', byAgg: 'count', others: false }), [], VIEW).sql
    ).toContain('LIMIT 2)')
    expect(
      buildQuery(topShelf({ n: 0, byField: '*', byAgg: 'count', others: false }), [], VIEW).sql
    ).toContain('LIMIT 1)')
  })
})

describe('buildQuery — filters and calc fields', () => {
  it('source filters and calc fields live inside the src CTE', () => {
    const q = buildQuery(
      shelf({ columns: [dim('region')] }),
      [{ name: 'rev', expr: 'price*qty', role: 'measure' }],
      VIEW,
      { sourceFilters: [{ kind: 'in', field: 'region', values: ['US', 'EU'] }] }
    )
    expect(q.sql).toContain(
      `src AS (SELECT *, (price*qty) AS "rev" FROM "ds_1" WHERE CAST("region" AS VARCHAR) IN ('US', 'EU'))`
    )
  })

  it('shelf filters land in the outer WHERE, not the CTE', () => {
    const q = buildQuery(
      shelf({
        columns: [dim('region')],
        filters: [{ kind: 'range', field: 'price', min: 10, max: 100 }]
      }),
      [],
      VIEW
    )
    expect(q.sql).toContain('src AS (SELECT * FROM "ds_1")')
    expect(q.sql).toContain('\nFROM src WHERE "price" >= 10 AND "price" <= 100')
  })

  it('filtersToWhere covers every filter kind', () => {
    // excluding without the blank entry must not drop NULL rows (NOT IN alone would)
    expect(filtersToWhere([{ kind: 'in', field: 'r', values: ['a'], exclude: true }])).toEqual([
      `(CAST("r" AS VARCHAR) NOT IN ('a') OR "r" IS NULL)`
    ])
    expect(filtersToWhere([{ kind: 'in', field: 'r', values: [] }])).toEqual([])
    expect(
      filtersToWhere([{ kind: 'dateRange', field: 'ts', from: '2020-01-01', to: '2020-12-31' }])
    ).toEqual([
      `TRY_CAST("ts" AS TIMESTAMP) >= TIMESTAMP '2020-01-01 00:00:00' AND TRY_CAST("ts" AS TIMESTAMP) <= TIMESTAMP '2020-12-31 23:59:59'`
    ])
    expect(filtersToWhere([{ kind: 'expr', expr: 'x > 1' }])).toEqual(['(x > 1)'])
    expect(filtersToWhere([{ kind: 'expr', expr: '  ' }])).toEqual([])
  })

  it("'in' filter treats '' as blank: NULL rows follow the blank entry", () => {
    // include without blank: plain IN, NULL rows drop out (unchanged behavior)
    expect(filtersToWhere([{ kind: 'in', field: 'r', values: ['a'] }])).toEqual([
      `CAST("r" AS VARCHAR) IN ('a')`
    ])
    // include with blank selected: keep NULL rows too
    expect(filtersToWhere([{ kind: 'in', field: 'r', values: ['a', ''] }])).toEqual([
      `(CAST("r" AS VARCHAR) IN ('a', '') OR "r" IS NULL)`
    ])
    // exclude with blank selected: NOT IN already drops NULL rows (SQL semantics)
    expect(filtersToWhere([{ kind: 'in', field: 'r', values: [''], exclude: true }])).toEqual([
      `CAST("r" AS VARCHAR) NOT IN ('')`
    ])
  })

  it('a calc field with an explicit kind override is TRY_CAST in the src CTE', () => {
    const q = buildQuery(
      shelf({ columns: [dim('signup')] }),
      [calc({ name: 'signup', expr: '"signup_raw"', kind: 'date' })],
      VIEW
    )
    expect(q.sql).toContain(
      `src AS (SELECT *, TRY_CAST(("signup_raw") AS TIMESTAMP) AS "signup" FROM "ds_1")`
    )
  })

  it('calc fields referencing other calc fields inline the dependency to avoid same-SELECT alias error', () => {
    // A: extract email from "text" (no dependency)
    const email = { name: 'email', expr: `nullif(regexp_extract("text", '(\\\\w+@\\\\w+\\\\.\\\\w+)'), '')`, role: 'dimension' as const }
    // B: domain from email (references calc field A by quoted name "email")
    const domain = { name: 'domain', expr: `lower(split_part(trim("email"), '@', 2))`, role: 'dimension' as const }
    const q = buildQuery(
      shelf({ columns: [dim('c')] }),
      [email, domain],
      VIEW
    )
    // domain's expression must inline email's full expression, not reference "email" standalone
    expect(q.sql).not.toContain(`split_part(trim("email"), '@', 2)`)
    expect(q.sql).toContain(`split_part(trim((nullif(regexp_extract("text", '(\\\\w+@\\\\w+\\\\.\\\\w+)'), ''))), '@', 2)`)
  })

  it('dependency resolution is order-independent (dependency listed AFTER its dependent)', async () => {
    const { resolveCalcExprs } = await import('./sqlBuilder')
    // delete + recreate moves a field to the END of the array — the fields
    // referencing it come first and must still resolve
    const domain = { name: 'domain', expr: `lower(split_part("email", '@', 2))`, role: 'dimension' as const }
    const email = { name: 'email', expr: `regexp_extract("text", 'x')`, role: 'dimension' as const }
    const resolved = resolveCalcExprs([domain, email])
    expect(resolved.get('domain')).toBe(`lower(split_part((regexp_extract("text", 'x')), '@', 2))`)
    expect(resolved.get('email')).toBe(`regexp_extract("text", 'x')`)
  })

  it('resolves transitive chains regardless of order and survives cycles', async () => {
    const { resolveCalcExprs } = await import('./sqlBuilder')
    const c = { name: 'c', expr: `"b" * 2`, role: 'measure' as const }
    const b = { name: 'b', expr: `"a" + 1`, role: 'measure' as const }
    const a = { name: 'a', expr: `"raw"`, role: 'measure' as const }
    expect(resolveCalcExprs([c, b, a]).get('c')).toBe(`(("raw") + 1) * 2`)
    // a cycle terminates (no infinite recursion); the leftover self-reference
    // fails later with a DuckDB binder error, which is the correct outcome
    const x = { name: 'x', expr: `"y" + 1`, role: 'measure' as const }
    const y = { name: 'y', expr: `"x" + 1`, role: 'measure' as const }
    const cyc = resolveCalcExprs([x, y])
    expect(cyc.get('x')).toBeDefined()
    expect(cyc.get('y')).toBeDefined()
  })

  it('resolveExprWith inlines calc references into an arbitrary expression', async () => {
    const { resolveExprWith } = await import('./sqlBuilder')
    const email = { name: 'email', expr: `regexp_extract("text", 'x')`, role: 'dimension' as const }
    expect(resolveExprWith(`lower(trim("email"))`, [email]))
      .toBe(`lower(trim((regexp_extract("text", 'x'))))`)
    expect(resolveExprWith(`"other"`, [email])).toBe(`"other"`)
  })

  it('resolvedCalcSql returns dep-inlined SQL with the kind cast; undefined for raw columns', async () => {
    const { resolvedCalcSql } = await import('./sqlBuilder')
    const a = { name: 'a', expr: `"raw"`, role: 'measure' as const }
    const b = { name: 'b', expr: `"a" + 1`, role: 'measure' as const, kind: 'number' as const }
    expect(resolvedCalcSql([a, b], 'b')).toBe(`TRY_CAST((("raw") + 1) AS DOUBLE)`)
    expect(resolvedCalcSql([a, b], 'not_a_calc')).toBeUndefined()
  })

  it('a calc field with no kind override compiles the bare expression, same as before this feature', () => {
    const q = buildQuery(
      shelf({ columns: [dim('c')] }),
      [calc({ name: 'c', expr: '"raw"' })],
      VIEW
    )
    expect(q.sql).toContain(`src AS (SELECT *, ("raw") AS "c" FROM "ds_1")`)
  })
})

describe('calcFieldKind / calcFieldSql', () => {
  it('defaults kind from role when no override is set', () => {
    expect(calcFieldKind(calc({ role: 'measure' }))).toBe('number')
    expect(calcFieldKind(calc({ role: 'dimension' }))).toBe('string')
  })

  it('an explicit kind overrides the role default', () => {
    expect(calcFieldKind(calc({ role: 'dimension', kind: 'date' }))).toBe('date')
    expect(calcFieldKind(calc({ role: 'measure', kind: 'string' }))).toBe('string')
  })

  it('no override compiles the bare parenthesized expression', () => {
    expect(calcFieldSql(calc({ expr: 'x + 1' }))).toBe('(x + 1)')
  })

  it('an explicit kind wraps the expression in a TRY_CAST to the matching DuckDB type', () => {
    expect(calcFieldSql(calc({ expr: 'x', kind: 'date' }))).toBe('TRY_CAST((x) AS TIMESTAMP)')
    expect(calcFieldSql(calc({ expr: 'x', kind: 'number' }))).toBe('TRY_CAST((x) AS DOUBLE)')
    expect(calcFieldSql(calc({ expr: 'x', kind: 'bool' }))).toBe('TRY_CAST((x) AS BOOLEAN)')
    expect(calcFieldSql(calc({ expr: 'x', kind: 'string' }))).toBe('TRY_CAST((x) AS VARCHAR)')
  })

  it('date kind with a dateFormat uses try_strptime instead of a plain TRY_CAST (dd/mm/yyyy etc.)', () => {
    expect(calcFieldSql(calc({ expr: 'x', kind: 'date', dateFormat: '%d/%m/%Y' }))).toBe(
      `CAST(try_strptime(CAST((x) AS VARCHAR), '%d/%m/%Y') AS TIMESTAMP)`
    )
  })

  it('an empty dateFormat falls back to the plain TRY_CAST path, same as no format at all', () => {
    expect(calcFieldSql(calc({ expr: 'x', kind: 'date', dateFormat: '' }))).toBe(
      calcFieldSql(calc({ expr: 'x', kind: 'date' }))
    )
  })

  it('dateFormat is ignored for every kind except date', () => {
    expect(calcFieldSql(calc({ expr: 'x', kind: 'string', dateFormat: '%d/%m/%Y' }))).toBe(
      'TRY_CAST((x) AS VARCHAR)'
    )
  })
})

describe('buildQuery — output shaping', () => {
  it('boxplot expands the first measure into five stats', () => {
    const q = buildQuery(
      shelf({ chartType: 'boxplot', columns: [dim('cat')], rows: [mea('v')] }),
      [],
      VIEW
    )
    expect(q.measureAliases).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(q.measureLabels).toEqual(['Min', 'Q1', 'Median', 'Q3', 'Max'])
    expect(q.sql).toContain('min("v") AS "m0"')
    expect(q.sql).toContain('quantile_cont("v", 0.25) AS "m1"')
    expect(q.sql).toContain('median("v") AS "m2"')
    expect(q.sql).toContain('quantile_cont("v", 0.75) AS "m3"')
    expect(q.sql).toContain('max("v") AS "m4"')
  })

  it('value sorts order by the first measure; desc sorts the dim; limit overrides win', () => {
    const base = { columns: [dim('c', { sort: 'valueDesc' as const })], rows: [mea('v')] }
    expect(buildQuery(shelf(base), [], VIEW).sql).toContain(' ORDER BY "m0" DESC')
    expect(
      buildQuery(shelf({ columns: [dim('c', { sort: 'desc' })], rows: [mea('v')] }), [], VIEW).sql
    ).toContain(' ORDER BY "d0" DESC')
    expect(buildQuery(shelf({ ...base, limit: 100 }), [], VIEW).sql).toContain(' LIMIT 100')
    expect(buildQuery(shelf(base), [], VIEW, { defaultLimit: 9999 }).sql).toContain(' LIMIT 9999')
  })
})

describe('buildDetailQuery', () => {
  const baseOpts = { limit: 100, offset: 0 }

  it('types drill predicates by value: null, number, string', () => {
    const s = shelf({ columns: [dim('cat')], rows: [mea('v')] })
    const nullQ = buildDetailQuery(s, [], VIEW, [{ ref: dim('cat'), value: null }], baseOpts)
    expect(nullQ.sql).toContain('("cat") IS NULL')
    const numQ = buildDetailQuery(s, [], VIEW, [{ ref: dim('n'), value: 5 }], baseOpts)
    expect(numQ.sql).toContain('"n" = 5')
    const strQ = buildDetailQuery(s, [], VIEW, [{ ref: dim('cat'), value: 'x' }], baseOpts)
    expect(strQ.sql).toContain(`CAST("cat" AS VARCHAR) = 'x'`)
  })

  it('drilling the Others bucket compares against the same CASE expression', () => {
    const s = shelf({
      columns: [dim('cat', { topN: { n: 2, byField: '*', byAgg: 'count', others: true } })],
      rows: [mea('v')]
    })
    const q = buildDetailQuery(
      s,
      [],
      VIEW,
      [{ ref: s.columns[0], value: 'Others' }],
      baseOpts
    )
    expect(q.sql).toContain(`ELSE 'Others' END AS VARCHAR) = 'Others'`)
  })

  it('escapes ILIKE wildcards in search text', () => {
    const s = shelf({ columns: [dim('cat')] })
    const q = buildDetailQuery(s, [], VIEW, [], {
      ...baseOpts,
      search: { columns: ['name'], text: 'a%b_c' }
    })
    expect(q.sql).toContain(`CAST("name" AS VARCHAR) ILIKE '%a\\%b\\_c%' ESCAPE '\\'`)
  })

  it('paginates sql, counts without pagination, exports without LIMIT', () => {
    const s = shelf({ columns: [dim('cat')] })
    const q = buildDetailQuery(s, [], VIEW, [], { limit: 100, offset: 200 })
    expect(q.sql).toMatch(/ LIMIT 100 OFFSET 200$/)
    expect(q.countSql).toContain('SELECT count(*) AS n FROM src')
    expect(q.exportSql).not.toContain('LIMIT')
  })
})

describe('multi-measure queries', () => {
  it('emits one aggregate column per distinct measure, in shelf order', () => {
    const s = shelf({
      columns: [dim('region')],
      rows: [mea('sales'), mea('profit'), mea('qty', 'avg')]
    })
    const q = buildQuery(s, [], VIEW)
    expect(q.measureAliases).toEqual(['m0', 'm1', 'm2'])
    expect(q.sql).toContain('sum("sales") AS "m0"')
    expect(q.sql).toContain('sum("profit") AS "m1"')
    expect(q.sql).toContain('avg("qty") AS "m2"')
    expect(q.measureLabels).toEqual(['SUM(sales)', 'SUM(profit)', 'AVG(qty)'])
  })

  it('same field with different aggregations counts as two measures', () => {
    const s = shelf({ columns: [dim('region')], rows: [mea('sales', 'sum'), mea('sales', 'avg')] })
    const { meas } = collectRefs(s)
    expect(meas).toHaveLength(2)
    const q = buildQuery(s, [], VIEW)
    expect(q.sql).toContain('sum("sales") AS "m0"')
    expect(q.sql).toContain('avg("sales") AS "m1"')
  })
})

describe('CHART_TYPES table', () => {
  it('has 49 unique, well-formed entries', async () => {
    const { CHART_TYPES } = await import('./sqlBuilder')
    expect(CHART_TYPES).toHaveLength(49)
    const types = CHART_TYPES.map((c) => c.type)
    expect(new Set(types).size).toBe(types.length)
    for (const c of CHART_TYPES) {
      expect(c.minDims).toBeLessThanOrEqual(c.maxDims)
      expect(c.minMeas).toBeLessThanOrEqual(c.maxMeas)
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.hint.length).toBeGreaterThan(0)
    }
  })

  it('keeps multi-measure charts open to at least 8 measures', async () => {
    const { CHART_TYPES } = await import('./sqlBuilder')
    for (const t of ['bar', 'barh', 'line', 'area', 'stackedBar', 'percentBar', 'stackedArea', 'combo', 'radar', 'kpi']) {
      const info = CHART_TYPES.find((c) => c.type === t)!
      expect(info.maxMeas, `${t} maxMeas`).toBeGreaterThanOrEqual(8)
    }
  })
})


describe('entityTokenSql', () => {
  const spec = (over = {}) => ({
    fields: ['notes'],
    patterns: [{ id: 'email', label: 'E-mail', pattern: '(?i)\\b[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}\\b' }],
    normalize: true,
    ...over
  })

  it('unnests regexp_extract_all per field x pattern with type and source columns', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const sql = entityTokenSql('"ds_x"', spec())
    expect(sql).toContain('UNNEST(regexp_extract_all(CAST("notes" AS VARCHAR)')
    expect(sql).toContain(`'E-mail' AS entity_type`)
    expect(sql).toContain(`'notes' AS source_field`)
    expect(sql).toContain(`WHERE entity <> ''`)
  })

  it('UNION ALLs every field x pattern combination', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const sql = entityTokenSql('"ds_x"', spec({
      fields: ['a', 'b'],
      patterns: [
        { id: 'email', label: 'E-mail', pattern: 'x' },
        { id: 'cpf', label: 'CPF', pattern: 'y' }
      ]
    }))
    expect(sql.match(/UNION ALL/g)).toHaveLength(3) // 2 fields x 2 patterns = 4 selects
  })

  it('normalizes per pattern type: digits for CPF, lower for e-mail, upper for placa, none for URL', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const mk = (id: string) => entityTokenSql('"v"', spec({ patterns: [{ id, label: id, pattern: 'p' }] }))
    expect(mk('cpf')).toContain(`regexp_replace(trim(e), '[^0-9]', '', 'g') AS entity`)
    expect(mk('email')).toContain('lower(trim(e)) AS entity')
    expect(mk('placa')).toContain('upper(trim(e)) AS entity')
    expect(mk('url')).toContain('trim(e) AS entity,')
    // unknown/custom pattern ids default to lowercase
    expect(mk('custom')).toContain('lower(trim(e)) AS entity')
  })

  it('normalize=false keeps the raw match as the entity', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const sql = entityTokenSql('"v"', spec({ normalize: false, patterns: [{ id: 'cpf', label: 'CPF', pattern: 'p' }] }))
    expect(sql).toContain('trim(e) AS entity,')
    expect(sql).not.toContain('regexp_replace')
  })

  it('empty fields or patterns produce a valid empty result instead of broken SQL', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    for (const s of [spec({ fields: [] }), spec({ patterns: [] })]) {
      const sql = entityTokenSql('"v"', s)
      expect(sql).toContain('WHERE 1 = 0')
      expect(sql).not.toContain('UNION')
    }
  })

  it('quotes labels and patterns as literals (injection-safe)', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const sql = entityTokenSql('"v"', spec({ patterns: [{ id: 'x', label: "O'Brien", pattern: "a'b" }] }))
    expect(sql).toContain(`'O''Brien' AS entity_type`)
    expect(sql).toContain(`'a''b'`)
  })

  it('adds e-mail enrichment columns only when an email pattern is in the spec', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const withEmail = entityTokenSql('"v"', spec())
    for (const col of ['email_user', 'email_domain', 'email_category', 'email_org', 'email_org_type', 'email_location']) {
      expect(withEmail).toContain(`AS ${col}`)
    }
    // enrichment is gated on the e-mail rows via the pattern's label
    expect(withEmail).toContain(`entity_type = 'E-mail'`)
    const noEmail = entityTokenSql('"v"', spec({ patterns: [{ id: 'cpf', label: 'CPF', pattern: 'p' }] }))
    expect(noEmail).not.toContain('email_user')
    expect(noEmail).not.toContain('email_category')
  })

  it('scans calculated fields through their resolved SQL from fieldExprs', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const sql = entityTokenSql('"v"', spec({
      fields: ['notes', 'MyCalc'],
      fieldExprs: { MyCalc: `upper("raw_col")` }
    }))
    expect(sql).toContain(`UNNEST(regexp_extract_all(CAST((upper("raw_col")) AS VARCHAR)`)
    expect(sql).toContain(`'MyCalc' AS source_field`)
    // raw columns still reference the column directly
    expect(sql).toContain(`UNNEST(regexp_extract_all(CAST("notes" AS VARCHAR)`)
  })

  it('adds entity_id, source_id and source_table to every shape', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    for (const s of [spec(), spec({ patterns: [{ id: 'cpf', label: 'CPF', pattern: 'p' }] })]) {
      const sql = entityTokenSql('"v"', { ...s, sourceTable: 'Vendas' })
      expect(sql).toContain('row_number() OVER () AS entity_id')
      expect(sql).toContain('AS source_id')
      expect(sql).toContain(`'Vendas' AS source_table`)
    }
    // empty guard keeps the same columns
    const empty = entityTokenSql('"v"', spec({ fields: [] }))
    for (const col of ['entity_id', 'source_id', 'source_table']) {
      expect(empty).toContain(`AS ${col}`)
    }
  })

  it('source_id: idField reads the origin column, absent falls back to a synthetic row number', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const withId = entityTokenSql('"v"', spec({ idField: 'msg_id' }))
    expect(withId).toContain(`"msg_id" AS source_id`)
    expect(withId).not.toContain('__row_id')
    const synthetic = entityTokenSql('"v"', spec())
    expect(synthetic).toContain('row_number() OVER () AS __row_id, * FROM "v"')
    expect(synthetic).toContain('__row_id AS source_id')
  })

  it('quotes sourceTable as a literal (injection-safe)', async () => {
    const { entityTokenSql } = await import('./sqlBuilder')
    const sql = entityTokenSql('"v"', spec({ sourceTable: "Ta'bela" }))
    expect(sql).toContain(`'Ta''bela' AS source_table`)
  })
})

describe('dashFilterToFilter', () => {
  it('in mode: selected values compile, empty selection means inactive', async () => {
    const { dashFilterToFilter } = await import('./sqlBuilder')
    expect(dashFilterToFilter({ dsId: 'd', field: 'region', mode: 'in', values: ['a', ''] }))
      .toEqual({ kind: 'in', field: 'region', values: ['a', ''] })
    expect(dashFilterToFilter({ dsId: 'd', field: 'region', mode: 'in', values: [] })).toBeNull()
    expect(dashFilterToFilter({ dsId: 'd', field: 'region', mode: 'in' })).toBeNull()
  })

  it('range and dateRange modes activate on any bound', async () => {
    const { dashFilterToFilter } = await import('./sqlBuilder')
    expect(dashFilterToFilter({ dsId: 'd', field: 'v', mode: 'range', min: 3 }))
      .toEqual({ kind: 'range', field: 'v', min: 3, max: undefined })
    expect(dashFilterToFilter({ dsId: 'd', field: 'v', mode: 'range' })).toBeNull()
    expect(dashFilterToFilter({ dsId: 'd', field: 't', mode: 'dateRange', to: '2024-12-31' }))
      .toEqual({ kind: 'dateRange', field: 't', from: undefined, to: '2024-12-31' })
    expect(dashFilterToFilter({ dsId: 'd', field: 't', mode: 'dateRange' })).toBeNull()
  })

  it('dashFiltersFor collects only active cards for the matching source', async () => {
    const { dashFiltersFor } = await import('./sqlBuilder')
    const tiles = [
      { filter: { dsId: 'a', field: 'x', mode: 'in' as const, values: ['1'] } },
      { filter: { dsId: 'a', field: 'y', mode: 'in' as const, values: [] } },
      { filter: { dsId: 'b', field: 'z', mode: 'range' as const, min: 0 } },
      {}
    ]
    expect(dashFiltersFor(tiles, 'a')).toEqual([{ kind: 'in', field: 'x', values: ['1'] }])
    expect(dashFiltersFor(tiles, 'b')).toEqual([{ kind: 'range', field: 'z', min: 0, max: undefined }])
  })
})
