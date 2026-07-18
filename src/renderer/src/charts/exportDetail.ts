// Builds the ChartDetailPayload embedded per chart/table tile by the
// standalone HTML export. The pure planning half (finer-grain shelf + alias
// mappings) lives in shared/exportInteractive.ts (planChartDetail); this
// module runs the resulting detail query through the app's query API.
import { api } from '../api'
import type {
  CalcField,
  DashFilterCard,
  FieldInfo,
  Filter,
  QueryColumn,
  ShelfState
} from '@shared/types'
import { buildQuery, type BuiltQuery } from '@shared/sqlBuilder'
import { planChartDetail, type ChartDetailPayload } from '@shared/exportInteractive'

/**
 * Detail rows beyond this cap would make filtering silently wrong (missing
 * groups), so such charts fall back to a static export instead.
 */
export const EXPORT_DETAIL_LIMIT = 50_000

export interface DetailInputs {
  shelf: ShelfState
  /** display-grain build + columns from the live result */
  built: BuiltQuery
  columns: QueryColumn[]
  calcFields: CalcField[]
  /** workbook-level source filters only — card filters are applied client-side */
  sourceFilters: Filter[]
  fieldKinds: Record<string, FieldInfo['kind']>
  cards: Array<{ cardId: string; card: DashFilterCard }>
}

/**
 * Returns the payload, or null when this chart cannot be re-filtered
 * client-side (non-decomposable aggregation, boxplot, or too much detail) —
 * the caller then exports it static.
 */
export async function buildChartDetailPayload(
  dsViewName: string,
  inp: DetailInputs
): Promise<ChartDetailPayload | null> {
  const plan = planChartDetail(inp.shelf, inp.built, inp.cards)
  if (!plan) return null

  const detailBuilt = buildQuery(plan.detailShelf, inp.calcFields, dsViewName, {
    defaultLimit: EXPORT_DETAIL_LIMIT,
    sourceFilters: inp.sourceFilters,
    fieldKinds: inp.fieldKinds
  })
  const result = await api.runQuery(detailBuilt.sql)
  if (result.truncated || result.rowCount >= EXPORT_DETAIL_LIMIT) return null

  return {
    shelf: inp.shelf,
    built: inp.built,
    columns: inp.columns,
    dimAliases: plan.dimAliases,
    rows: result.rows,
    reaggs: plan.reaggs,
    filters: plan.filters
  }
}
