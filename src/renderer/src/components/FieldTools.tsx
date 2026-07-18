import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { FieldInfo, FieldRole } from '@shared/types'
import {
  quoteIdent,
  quoteLiteral,
  validateExpression,
  calcFieldKind,
  resolveExprWith,
  resolvedCalcSql
} from '@shared/sqlBuilder'
import {
  emailUserExpr,
  emailDomainExpr,
  emailCategoryExpr,
  emailOrgExpr,
  emailOrgTypeExpr,
  emailLocationExpr,
  emailTLDExpr
} from '@shared/emailEnrichment'
import { SMART_ANALYSES } from '@shared/textIntelligence'

// ---------- shared helpers ----------

const q = quoteIdent
const lit = quoteLiteral
const asText = (f: string): string => `CAST(${q(f)} AS VARCHAR)`
const asNum = (f: string): string => `TRY_CAST(${q(f)} AS DOUBLE)`
const asTs = (f: string): string => `CAST(${q(f)} AS TIMESTAMP)`

async function validateAndSave(
  dsId: string,
  name: string,
  expr: string,
  role: FieldRole,
  setError: (e: string) => void,
  kind?: FieldInfo['kind']
): Promise<boolean> {
  const guard = validateExpression(expr)
  if (guard) {
    setError(guard)
    return false
  }
  try {
    // Resolve references to existing calc fields so the validation query
    // doesn't fail with "column not found" — the validation runs directly
    // against ds_<id> which only has raw columns, not calc field aliases
    const existing = useApp.getState().workbook.calculatedFields[dsId] ?? []
    const resolvedExpr = resolveExprWith(expr, existing)
    await api.runQuery(`SELECT (${resolvedExpr}) AS t FROM "ds_${dsId}" LIMIT 0`)
    useApp.getState().addCalcField(dsId, { name: name.trim(), expr, role, ...(kind ? { kind } : {}) })
    return true
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e))
    return false
  }
}

// ---------- document / identifier extraction patterns (Brazil-centric) ----------

export interface ExtractPattern {
  id: string
  label: string
  /** RE2-compatible regex (DuckDB) — no lookarounds, escaped for a JS string */
  pattern: string
  example: string
}

/**
 * Heuristic patterns for identifiers commonly found in Brazilian documents,
 * logs and exports. Extraction is textual (no check-digit validation) — pair
 * with a filter when precision matters.
 */
export const EXTRACT_PATTERNS: ExtractPattern[] = [
  { id: 'cpf', label: 'CPF', example: '123.456.789-09',
    pattern: '\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b|\\b\\d{11}\\b' },
  { id: 'cnpj', label: 'CNPJ', example: '12.345.678/0001-95',
    pattern: '\\b\\d{2}\\.\\d{3}\\.\\d{3}/\\d{4}-\\d{2}\\b|\\b\\d{14}\\b' },
  { id: 'cep', label: 'CEP', example: '01310-100',
    pattern: '\\b\\d{5}-\\d{3}\\b' },
  { id: 'placa', label: 'Placa veicular (BR/Mercosul)', example: 'ABC-1234 / ABC1D23',
    pattern: '\\b[A-Z]{3}-?\\d{4}\\b|\\b[A-Z]{3}\\d[A-Z]\\d{2}\\b' },
  { id: 'telefone', label: 'Telefone BR', example: '+55 (11) 98765-4321',
    pattern: '(?:\\+?55[\\s.-]?)?\\(?\\d{2}\\)?[\\s.-]?9?\\d{4}[-.\\s]?\\d{4}\\b' },
  { id: 'email', label: 'E-mail', example: 'nome@dominio.com.br',
    pattern: '(?i)\\b[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}\\b' },
  { id: 'url', label: 'URL', example: 'https://site.gov.br/pagina',
    pattern: '(?i)https?://[^\\s"\'<>]+' },
  { id: 'ipv4', label: 'Endereço IPv4', example: '192.168.0.1',
    pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b' },
  { id: 'passaporte', label: 'Passaporte BR', example: 'FD123456',
    pattern: '\\b[A-Z]{2}\\d{6}\\b' },
  { id: 'rg', label: 'RG (heurístico)', example: '12.345.678-9',
    pattern: '\\b\\d{1,2}\\.\\d{3}\\.\\d{3}-?[0-9Xx]\\b' },
  { id: 'pixUuid', label: 'Chave PIX aleatória (UUID)', example: '1f4e…-…',
    pattern: '(?i)\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b' },
  { id: 'btc', label: 'Endereço Bitcoin', example: 'bc1q… / 1A1zP…',
    pattern: '\\b(?:bc1[02-9ac-hj-np-z]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\\b' },
  { id: 'eth', label: 'Endereço Ethereum', example: '0xde0b…',
    pattern: '\\b0x[0-9a-fA-F]{40}\\b' },
  { id: 'cartao', label: 'Cartão (13-16 dígitos)', example: '4111 1111 1111 1111',
    pattern: '\\b(?:\\d{4}[ -]?){3}\\d{1,4}\\b' },
  { id: 'brl', label: 'Valor em R$', example: 'R$ 1.234,56',
    pattern: 'R\\$\\s?\\d{1,3}(?:\\.\\d{3})*(?:,\\d{2})?' },
  { id: 'dataBr', label: 'Data (dd/mm/aaaa)', example: '31/12/2024',
    pattern: '\\b\\d{2}/\\d{2}/\\d{4}\\b' },
  { id: 'md5', label: 'Hash MD5', example: 'd41d8cd9…',
    pattern: '(?i)\\b[a-f0-9]{32}\\b' },
  { id: 'sha256', label: 'Hash SHA-256', example: 'e3b0c442…',
    pattern: '(?i)\\b[a-f0-9]{64}\\b' },
  { id: 'iban', label: 'IBAN', example: 'BR15 0000 0000 …',
    pattern: '\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b' }
]

const patternByLabel = (label: string): ExtractPattern =>
  EXTRACT_PATTERNS.find((p) => p.label === label) ?? EXTRACT_PATTERNS[0]

/** SQL expression for one extraction mode over one column. */
export function extractionExpr(
  mode: 'extract' | 'extractAll' | 'flag' | 'count',
  field: string,
  pattern: string
): { expr: string; role: FieldRole; kind?: FieldInfo['kind'] } {
  const col = asText(field)
  const pat = lit(pattern)
  switch (mode) {
    case 'extract':
      return { expr: `nullif(regexp_extract(${col}, ${pat}), '')`, role: 'dimension' }
    case 'extractAll':
      return { expr: `array_to_string(regexp_extract_all(${col}, ${pat}), '; ')`, role: 'dimension' }
    case 'flag':
      return { expr: `coalesce(regexp_matches(${col}, ${pat}), false)`, role: 'dimension', kind: 'bool' }
    case 'count':
      return { expr: `len(regexp_extract_all(${col}, ${pat}))`, role: 'measure' }
  }
}

// ---------- template dialog ----------

interface TplParam {
  key: string
  label: string
  type: 'field' | 'field2' | 'text' | 'number' | 'choice'
  choices?: string[]
  def?: string
}

interface Template {
  id: string
  label: string
  group: 'Text' | 'Number' | 'Extraction' | 'Email' | 'Smart'
  role: FieldRole
  /** explicit output type when it differs from the role default (e.g. a dimension that is really a date) */
  kind?: FieldInfo['kind']
  params: TplParam[]
  build: (v: Record<string, string>) => string
}

const F: TplParam = { key: 'f', label: 'Field', type: 'field' }

const TEMPLATES: Template[] = [
  { id: 'copy', label: 'Copy of field', group: 'Text', role: 'dimension', params: [F],
    build: (v) => `${q(v.f)}` },
  { id: 'concat', label: 'Concatenate two fields', group: 'Text', role: 'dimension',
    params: [F, { key: 'g', label: 'Second field', type: 'field2' }, { key: 'sep', label: 'Separator', type: 'text', def: ' ' }],
    build: (v) => `concat(coalesce(${asText(v.f)}, ''), ${lit(v.sep)}, coalesce(${asText(v.g)}, ''))` },
  { id: 'left', label: 'Left (start of text)', group: 'Text', role: 'dimension',
    params: [F, { key: 'n', label: 'Characters', type: 'number', def: '3' }],
    build: (v) => `left(${asText(v.f)}, ${Number(v.n) || 1})` },
  { id: 'right', label: 'Right (end of text)', group: 'Text', role: 'dimension',
    params: [F, { key: 'n', label: 'Characters', type: 'number', def: '3' }],
    build: (v) => `right(${asText(v.f)}, ${Number(v.n) || 1})` },
  { id: 'substring', label: 'Substring', group: 'Text', role: 'dimension',
    params: [F, { key: 's', label: 'Start (1-based)', type: 'number', def: '1' }, { key: 'n', label: 'Length', type: 'number', def: '5' }],
    build: (v) => `substring(${asText(v.f)}, ${Number(v.s) || 1}, ${Number(v.n) || 1})` },
  { id: 'regexExtract', label: 'Regex extract', group: 'Text', role: 'dimension',
    params: [F, { key: 'p', label: 'Pattern', type: 'text', def: '(\\d+)' }, { key: 'g', label: 'Group', type: 'number', def: '1' }],
    build: (v) => `regexp_extract(${asText(v.f)}, ${lit(v.p)}, ${Number(v.g) || 0})` },
  { id: 'regexReplace', label: 'Regex replace', group: 'Text', role: 'dimension',
    params: [F, { key: 'p', label: 'Pattern', type: 'text' }, { key: 'r', label: 'Replacement', type: 'text', def: '' }],
    build: (v) => `regexp_replace(${asText(v.f)}, ${lit(v.p)}, ${lit(v.r)}, 'g')` },
  { id: 'upper', label: 'Uppercase', group: 'Text', role: 'dimension', params: [F],
    build: (v) => `upper(${asText(v.f)})` },
  { id: 'lower', label: 'Lowercase', group: 'Text', role: 'dimension', params: [F],
    build: (v) => `lower(${asText(v.f)})` },
  { id: 'trim', label: 'Trim spaces', group: 'Text', role: 'dimension', params: [F],
    build: (v) => `trim(${asText(v.f)})` },
  { id: 'clean', label: 'Remove special characters', group: 'Text', role: 'dimension', params: [F],
    build: (v) => `regexp_replace(${asText(v.f)}, '[^a-zA-Z0-9 ]', '', 'g')` },
  { id: 'replace', label: 'Replace text', group: 'Text', role: 'dimension',
    params: [F, { key: 'a', label: 'Find', type: 'text' }, { key: 'b', label: 'Replace with', type: 'text', def: '' }],
    build: (v) => `replace(${asText(v.f)}, ${lit(v.a)}, ${lit(v.b)})` },
  { id: 'length', label: 'Text length', group: 'Text', role: 'measure', params: [F],
    build: (v) => `length(${asText(v.f)})` },
  { id: 'split', label: 'Split by delimiter (take part)', group: 'Text', role: 'dimension',
    params: [F, { key: 'd', label: 'Delimiter', type: 'text', def: ',' }, { key: 'i', label: 'Part (1-based)', type: 'number', def: '1' }],
    build: (v) => `split_part(${asText(v.f)}, ${lit(v.d)}, ${Number(v.i) || 1})` },

  { id: 'arith', label: 'Arithmetic (field ∘ field)', group: 'Number', role: 'measure',
    params: [F, { key: 'op', label: 'Operation', type: 'choice', choices: ['+', '-', '*', '/'], def: '+' }, { key: 'g', label: 'Second field', type: 'field2' }],
    build: (v) => v.op === '/'
      ? `(${asNum(v.f)} / nullif(${asNum(v.g)}, 0))`
      : `(${asNum(v.f)} ${v.op} ${asNum(v.g)})` },
  { id: 'arithConst', label: 'Arithmetic (field ∘ constant)', group: 'Number', role: 'measure',
    params: [F, { key: 'op', label: 'Operation', type: 'choice', choices: ['+', '-', '*', '/'], def: '*' }, { key: 'n', label: 'Constant', type: 'number', def: '100' }],
    build: (v) => v.op === '/'
      ? `(${asNum(v.f)} / nullif(${Number(v.n) || 0}, 0))`
      : `(${asNum(v.f)} ${v.op} ${Number(v.n) || 0})` },
  { id: 'percentOf', label: 'Percent of (field / field × 100)', group: 'Number', role: 'measure',
    params: [F, { key: 'g', label: 'Denominator field', type: 'field2' }],
    build: (v) => `(${asNum(v.f)} / nullif(${asNum(v.g)}, 0) * 100)` },
  { id: 'round', label: 'Round', group: 'Number', role: 'measure',
    params: [F, { key: 'n', label: 'Decimals', type: 'number', def: '2' }],
    build: (v) => `round(${asNum(v.f)}, ${Number(v.n) || 0})` },
  { id: 'abs', label: 'Absolute value', group: 'Number', role: 'measure', params: [F],
    build: (v) => `abs(${asNum(v.f)})` },
  { id: 'floor', label: 'Floor', group: 'Number', role: 'measure', params: [F],
    build: (v) => `floor(${asNum(v.f)})` },
  { id: 'ceil', label: 'Ceiling', group: 'Number', role: 'measure', params: [F],
    build: (v) => `ceil(${asNum(v.f)})` },
  { id: 'ln', label: 'Natural log', group: 'Number', role: 'measure', params: [F],
    build: (v) => `ln(nullif(${asNum(v.f)}, 0))` },
  { id: 'log10', label: 'Log base 10', group: 'Number', role: 'measure', params: [F],
    build: (v) => `log10(nullif(${asNum(v.f)}, 0))` },
  { id: 'toNumber', label: 'Convert text → number', group: 'Number', role: 'measure', params: [F],
    build: (v) => `TRY_CAST(${q(v.f)} AS DOUBLE)` },
  { id: 'toText', label: 'Convert → text', group: 'Text', role: 'dimension', params: [F],
    build: (v) => `CAST(${q(v.f)} AS VARCHAR)` },
  { id: 'toDate', label: 'Convert text → date', group: 'Text', role: 'dimension', kind: 'date',
    params: [F, { key: 'fmt', label: 'Format (empty = auto)', type: 'text', def: '' }],
    build: (v) => v.fmt
      ? `try_strptime(${asText(v.f)}, ${lit(v.fmt)})`
      : `TRY_CAST(${q(v.f)} AS TIMESTAMP)` },

  // document/identifier extraction (CPF, placa, PIX, crypto, …)
  { id: 'brExtract', label: 'Extract identifier (first match)', group: 'Extraction', role: 'dimension',
    params: [F, { key: 'p', label: 'Identifier', type: 'choice', choices: EXTRACT_PATTERNS.map((p) => p.label) }],
    build: (v) => extractionExpr('extract', v.f, patternByLabel(v.p).pattern).expr },
  { id: 'brExtractAll', label: 'Extract identifier (all matches)', group: 'Extraction', role: 'dimension',
    params: [F, { key: 'p', label: 'Identifier', type: 'choice', choices: EXTRACT_PATTERNS.map((p) => p.label) }],
    build: (v) => extractionExpr('extractAll', v.f, patternByLabel(v.p).pattern).expr },
  { id: 'brFlag', label: 'Contains identifier (true/false)', group: 'Extraction', role: 'dimension', kind: 'bool',
    params: [F, { key: 'p', label: 'Identifier', type: 'choice', choices: EXTRACT_PATTERNS.map((p) => p.label) }],
    build: (v) => extractionExpr('flag', v.f, patternByLabel(v.p).pattern).expr },
  { id: 'brCount', label: 'Count identifier occurrences', group: 'Extraction', role: 'measure',
    params: [F, { key: 'p', label: 'Identifier', type: 'choice', choices: EXTRACT_PATTERNS.map((p) => p.label) }],
    build: (v) => extractionExpr('count', v.f, patternByLabel(v.p).pattern).expr },
  { id: 'customExtract', label: 'Extract by custom regex', group: 'Extraction', role: 'dimension',
    params: [F, { key: 'p', label: 'Pattern (RE2)', type: 'text', def: '(\\d+)' }],
    build: (v) => `nullif(regexp_extract(${asText(v.f)}, ${lit(v.p)}), '')` },

  // email enrichment (user, domain, category, org, org type, location)
  { id: 'emailUser', label: 'User name (from e-mail)', group: 'Email', role: 'dimension', params: [F],
    build: (v) => emailUserExpr(q(v.f)) },
  { id: 'emailDomain', label: 'Domain (from e-mail)', group: 'Email', role: 'dimension', params: [F],
    build: (v) => emailDomainExpr(q(v.f)) },
  { id: 'emailCategory', label: 'E-mail category', group: 'Email', role: 'dimension', params: [F],
    build: (v) => emailCategoryExpr(emailDomainExpr(q(v.f))) },
  { id: 'emailOrg', label: 'Organization (from e-mail)', group: 'Email', role: 'dimension', params: [F],
    build: (v) => emailOrgExpr(emailDomainExpr(q(v.f))) },
  { id: 'emailOrgType', label: 'Organization type (from e-mail)', group: 'Email', role: 'dimension', params: [F],
    build: (v) => emailOrgTypeExpr(emailDomainExpr(q(v.f))) },
  { id: 'emailLocation', label: 'Location (from e-mail)', group: 'Email', role: 'dimension', params: [F],
    build: (v) => emailLocationExpr(emailTLDExpr(q(v.f))) },

  // smart text analyses (lexicon heuristics: idioma, tom, sentimento, …)
  ...SMART_ANALYSES.map((a): Template => ({
    id: `smart_${a.id}`, label: a.label, group: 'Smart', role: a.role, params: [F],
    build: (v) => a.build(q(v.f))
  }))
]

export function TemplateFieldDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const rawFields = useApp((s) => s.fields[dsId])
  const calcFieldsFromStore = useApp((s) => s.workbook.calculatedFields[dsId])
  const fields = useMemo(() => {
    const raw = rawFields ?? []
    const calcInfo: FieldInfo[] = (calcFieldsFromStore ?? []).map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [rawFields, calcFieldsFromStore])
  const [tplId, setTplId] = useState(TEMPLATES[0].id)
  const tpl = TEMPLATES.find((t) => t.id === tplId)!
  const [name, setName] = useState('')
  const [vals, setVals] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const resolved: Record<string, string> = useMemo(() => {
    const out: Record<string, string> = {}
    for (const p of tpl.params) {
      out[p.key] =
        vals[p.key] ??
        p.def ??
        (p.type === 'field' || p.type === 'field2' ? (fields[0]?.name ?? '') : '')
    }
    return out
  }, [tpl, vals, fields])

  const expr = useMemo(() => {
    try {
      return tpl.build(resolved)
    } catch {
      return ''
    }
  }, [tpl, resolved])

  const save = async (): Promise<void> => {
    const finalName = name.trim() || `${tpl.label} (${resolved.f})`
    if (await validateAndSave(dsId, finalName, expr, tpl.role, setError, tpl.kind)) onClose()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 560 }}>
        <header>New Field from Template</header>
        <div className="body">
          <div className="form-row">
            <label>Template</label>
            <select
              value={tplId}
              onChange={(e) => {
                setTplId(e.target.value)
                setVals({})
                setError('')
              }}
            >
              <optgroup label="Text">
                {TEMPLATES.filter((t) => t.group === 'Text').map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </optgroup>
              <optgroup label="Number">
                {TEMPLATES.filter((t) => t.group === 'Number').map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </optgroup>
              <optgroup label="Extraction (CPF, placa, PIX, crypto…)">
                {TEMPLATES.filter((t) => t.group === 'Extraction').map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </optgroup>
              <optgroup label="Email enrichment">
                {TEMPLATES.filter((t) => t.group === 'Email').map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </optgroup>
              <optgroup label="Análises inteligentes (heurísticas)">
                {TEMPLATES.filter((t) => t.group === 'Smart').map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
          {tpl.params.map((p) => (
            <div className="form-row" key={p.key}>
              <label>{p.label}</label>
              {(p.type === 'field' || p.type === 'field2') && (
                <select
                  value={resolved[p.key]}
                  onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))}
                >
                  {fields.map((f) => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </select>
              )}
              {p.type === 'choice' && (
                <>
                  <select
                    value={resolved[p.key]}
                    onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))}
                  >
                    {(p.choices ?? []).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  {tpl.group === 'Extraction' && p.key === 'p' && (
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                      e.g. {patternByLabel(resolved[p.key]).example}
                    </span>
                  )}
                </>
              )}
              {(p.type === 'text' || p.type === 'number') && (
                <input
                  type={p.type === 'number' ? 'number' : 'text'}
                  value={resolved[p.key]}
                  onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div className="form-row">
            <label>Field name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${tpl.label} (${resolved.f})`}
            />
          </div>
          <div>
            <div className="drop-hint">Generated expression:</div>
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--text-dim)', margin: '4px 0' }}>{expr}</pre>
          </div>
          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!expr} onClick={() => void save()}>Create</button>
        </footer>
      </div>
    </div>
  )
}

// ---------- date-derived fields ----------

interface DateDerived {
  id: string
  label: string
  role: FieldRole
  /** explicit output type — these all declare role 'dimension' but the actual SQL result varies (number/text/real date) */
  kind?: FieldInfo['kind']
  common: boolean
  build: (f: string) => string
}

const DATE_DERIVED: DateDerived[] = [
  { id: 'year', label: 'Year', role: 'dimension', kind: 'number', common: true, build: (f) => `year(${asTs(f)})` },
  { id: 'semester', label: 'Semester', role: 'dimension', kind: 'number', common: false, build: (f) => `CASE WHEN month(${asTs(f)}) <= 6 THEN 1 ELSE 2 END` },
  { id: 'quarter', label: 'Quarter', role: 'dimension', kind: 'number', common: true, build: (f) => `quarter(${asTs(f)})` },
  { id: 'month', label: 'Month (number)', role: 'dimension', kind: 'number', common: true, build: (f) => `month(${asTs(f)})` },
  { id: 'monthName', label: 'Month name', role: 'dimension', common: true, build: (f) => `strftime(${asTs(f)}, '%B')` },
  { id: 'week', label: 'Week of year', role: 'dimension', kind: 'number', common: false, build: (f) => `weekofyear(${asTs(f)})` },
  { id: 'day', label: 'Day of month', role: 'dimension', kind: 'number', common: true, build: (f) => `day(${asTs(f)})` },
  { id: 'weekday', label: 'Day of week (1=Mon)', role: 'dimension', kind: 'number', common: false, build: (f) => `isodow(${asTs(f)})` },
  { id: 'dayName', label: 'Day name', role: 'dimension', common: true, build: (f) => `strftime(${asTs(f)}, '%A')` },
  { id: 'hour', label: 'Hour', role: 'dimension', kind: 'number', common: false, build: (f) => `hour(${asTs(f)})` },
  { id: 'minute', label: 'Minute', role: 'dimension', kind: 'number', common: false, build: (f) => `minute(${asTs(f)})` },
  { id: 'second', label: 'Second', role: 'dimension', kind: 'number', common: false, build: (f) => `second(${asTs(f)})` },
  { id: 'yearMonth', label: 'Year-Month', role: 'dimension', common: true, build: (f) => `strftime(${asTs(f)}, '%Y-%m')` },
  { id: 'yearMonthDay', label: 'Year-Month-Day', role: 'dimension', common: false, build: (f) => `strftime(${asTs(f)}, '%Y-%m-%d')` },
  { id: 'dateOnly', label: 'Date (no time)', role: 'dimension', kind: 'date', common: true, build: (f) => `CAST(${asTs(f)} AS DATE)` },
  { id: 'timeOnly', label: 'Time of day', role: 'dimension', common: false, build: (f) => `strftime(${asTs(f)}, '%H:%M:%S')` },
  { id: 'monthStart', label: 'Start of month', role: 'dimension', kind: 'date', common: false, build: (f) => `date_trunc('month', ${asTs(f)})` },
  { id: 'monthEnd', label: 'End of month', role: 'dimension', kind: 'date', common: false, build: (f) => `last_day(CAST(${asTs(f)} AS DATE))` },
  { id: 'quarterStart', label: 'Start of quarter', role: 'dimension', kind: 'date', common: false, build: (f) => `date_trunc('quarter', ${asTs(f)})` },
  { id: 'yearStart', label: 'Start of year', role: 'dimension', kind: 'date', common: false, build: (f) => `date_trunc('year', ${asTs(f)})` }
]

export function DateDerivedDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const rawFields = useApp((s) => s.fields[dsId])
  const calcFieldsFromStore = useApp((s) => s.workbook.calculatedFields[dsId])
  const fields = useMemo(() => {
    const raw = rawFields ?? []
    const calcInfo: FieldInfo[] = (calcFieldsFromStore ?? []).map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [rawFields, calcFieldsFromStore])
  const dateFields = fields.filter((f) => f.kind === 'date')
  const [field, setField] = useState(dateFields[0]?.name ?? '')
  const [checked, setChecked] = useState<Set<string>>(
    new Set(DATE_DERIVED.filter((d) => d.common).map((d) => d.id))
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    if (!field) return
    setBusy(true)
    setError('')
    let ok = 0
    for (const d of DATE_DERIVED) {
      if (!checked.has(d.id)) continue
      const saved = await validateAndSave(dsId, `${field} · ${d.label}`, d.build(field), d.role, setError, d.kind)
      if (saved) ok++
    }
    setBusy(false)
    useApp.getState().setStatus(`Created ${ok} derived field(s) from "${field}"`)
    if (ok) onClose()
  }

  if (!dateFields.length) {
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="dialog" style={{ width: 420 }}>
          <header>Derived Date Fields</header>
          <div className="body">
            <div className="drop-hint">This data source has no Date/Timestamp fields.</div>
          </div>
          <footer><button onClick={onClose}>Close</button></footer>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 480 }}>
        <header>Derived Date Fields</header>
        <div className="body">
          <div className="form-row">
            <label>Date field</label>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {dateFields.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setChecked(new Set(DATE_DERIVED.map((d) => d.id)))}>All</button>
            <button onClick={() => setChecked(new Set(DATE_DERIVED.filter((d) => d.common).map((d) => d.id)))}>Common</button>
            <button onClick={() => setChecked(new Set())}>None</button>
          </div>
          <div className="checklist" style={{ maxHeight: 280 }}>
            {DATE_DERIVED.map((d) => (
              <label key={d.id}>
                <input
                  type="checkbox"
                  checked={checked.has(d.id)}
                  onChange={(e) => {
                    const next = new Set(checked)
                    if (e.target.checked) next.add(d.id)
                    else next.delete(d.id)
                    setChecked(next)
                  }}
                />
                {d.label}
              </label>
            ))}
          </div>
          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || checked.size === 0} onClick={() => void create()}>
            {busy ? 'Creating…' : `Create ${checked.size} field(s)`}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------- smart text analyses (batch) ----------

/**
 * Batch counterpart of the "Análises inteligentes" template group: pick one
 * text field, check the analyses, create all calc fields in one click
 * (DateDerivedDialog precedent).
 */
export function SmartAnalysisDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const rawFields = useApp((s) => s.fields[dsId])
  const calcFieldsFromStore = useApp((s) => s.workbook.calculatedFields[dsId])
  const fields = useMemo(() => {
    const raw = rawFields ?? []
    const calcInfo: FieldInfo[] = (calcFieldsFromStore ?? []).map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [rawFields, calcFieldsFromStore])
  const textFields = fields.filter((f) => f.kind === 'string' || f.kind === 'other')
  const [field, setField] = useState(textFields[0]?.name ?? '')
  const [checked, setChecked] = useState<Set<string>>(
    new Set(SMART_ANALYSES.filter((a) => a.common).map((a) => a.id))
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    if (!field) return
    setBusy(true)
    setError('')
    let ok = 0
    for (const a of SMART_ANALYSES) {
      if (!checked.has(a.id)) continue
      const saved = await validateAndSave(dsId, `${field} · ${a.short}`, a.build(q(field)), a.role, setError)
      if (saved) ok++
    }
    setBusy(false)
    useApp.getState().setStatus(`Created ${ok} analysis field(s) from "${field}"`)
    if (ok) onClose()
  }

  if (!textFields.length) {
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="dialog" style={{ width: 420 }}>
          <header>Smart Text Analyses</header>
          <div className="body">
            <div className="drop-hint">This data source has no text fields.</div>
          </div>
          <footer><button onClick={onClose}>Close</button></footer>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 520 }}>
        <header>Smart Text Analyses</header>
        <div className="body">
          <div className="drop-hint">
            Heurísticas por léxico (contagem de palavras-chave PT-BR compilada para SQL) — sem IA,
            sem rede. Classifica cada linha; funciona melhor em textos com frases completas.
          </div>
          <div className="form-row">
            <label>Text field</label>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {textFields.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setChecked(new Set(SMART_ANALYSES.map((a) => a.id)))}>All</button>
            <button onClick={() => setChecked(new Set(SMART_ANALYSES.filter((a) => a.common).map((a) => a.id)))}>
              Common
            </button>
            <button onClick={() => setChecked(new Set())}>None</button>
          </div>
          <div className="checklist" style={{ maxHeight: 300 }}>
            {SMART_ANALYSES.map((a) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={checked.has(a.id)}
                  onChange={(e) => {
                    const next = new Set(checked)
                    if (e.target.checked) next.add(a.id)
                    else next.delete(a.id)
                    setChecked(next)
                  }}
                />
                {a.label}
                {a.role === 'measure' && <span className="badge" style={{ marginLeft: 6 }}>measure</span>}
              </label>
            ))}
          </div>
          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || checked.size === 0 || !field} onClick={() => void create()}>
            {busy ? 'Creating…' : `Create ${checked.size} field(s)`}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------- groups ----------

export function GroupDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const rawFields = useApp((s) => s.fields[dsId])
  const calcFieldsFromStore = useApp((s) => s.workbook.calculatedFields[dsId])
  const fields = useMemo(() => {
    const raw = rawFields ?? []
    const calcInfo: FieldInfo[] = (calcFieldsFromStore ?? []).map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [rawFields, calcFieldsFromStore])
  const groupable = fields.filter((f: FieldInfo) => f.kind === 'string' || f.kind === 'bool' || f.kind === 'number')
  const [field, setField] = useState(groupable.find((f) => f.kind === 'string')?.name ?? groupable[0]?.name ?? '')
  // calc fields aren't real columns on ds_<id>; distinctValues needs their SQL
  const fieldExpr = useMemo(
    () => resolvedCalcSql(calcFieldsFromStore ?? [], field),
    [calcFieldsFromStore, field]
  )
  const [values, setValues] = useState<string[] | null>(null)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [groups, setGroups] = useState<Array<{ name: string; members: string[] }>>([])
  const [groupName, setGroupName] = useState('')
  const [remainder, setRemainder] = useState<'keep' | 'other'>('keep')
  const [fieldName, setFieldName] = useState('')
  const [search, setSearch] = useState('')
  const [debSearch, setDebSearch] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const reqSeq = useRef(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebSearch(search), 300)
    return (): void => clearTimeout(t)
  }, [search])

  // switching field starts over; searching must NOT wipe selections/groups
  useEffect(() => {
    setSelected(new Set())
    setGroups([])
    setSearch('')
    setDebSearch('')
  }, [dsId, field])

  useEffect(() => {
    if (!field) return
    setValues(null)
    setLoadingMore(false)
    const seq = ++reqSeq.current
    api
      .distinctValues(dsId, field, { expr: fieldExpr, search: debSearch, limit: 500 })
      .then((r) => {
        if (reqSeq.current !== seq) return
        setValues(r.values.map((x) => x.v))
        setTotal(r.total)
      })
      .catch((e) => {
        if (reqSeq.current !== seq) return
        setError(String(e))
      })
  }, [dsId, field, debSearch])

  const loadMore = (): void => {
    if (!values || loadingMore) return
    setLoadingMore(true)
    const seq = ++reqSeq.current
    api
      .distinctValues(dsId, field, { expr: fieldExpr, search: debSearch, offset: values.length, limit: 500 })
      .then((r) => {
        if (reqSeq.current !== seq) return
        setValues([...values, ...r.values.map((x) => x.v)])
        setTotal(r.total)
        setLoadingMore(false)
      })
      .catch((e) => {
        if (reqSeq.current !== seq) return
        setLoadingMore(false)
        setError(String(e))
      })
  }

  const grouped = useMemo(() => new Set(groups.flatMap((g) => g.members)), [groups])

  const addGroup = (): void => {
    const name = groupName.trim()
    if (!name || selected.size === 0) return
    setGroups((gs) => [...gs, { name, members: [...selected] }])
    setSelected(new Set())
    setGroupName('')
  }

  const expr = useMemo(() => {
    if (!groups.length || !field) return ''
    const col = asText(field)
    const whens = groups
      .map((g) => `WHEN ${col} IN (${g.members.map(lit).join(', ')}) THEN ${lit(g.name)}`)
      .join(' ')
    const elseExpr = remainder === 'keep' ? col : lit('Other')
    return `CASE ${whens} ELSE ${elseExpr} END`
  }, [groups, field, remainder])

  const save = async (): Promise<void> => {
    const name = fieldName.trim() || `${field} (groups)`
    if (await validateAndSave(dsId, name, expr, 'dimension', setError)) onClose()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 620 }}>
        <header>Group Values</header>
        <div className="body">
          <div className="form-row">
            <label>Field</label>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {groupable.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
            <label style={{ width: 'auto' }}>New field</label>
            <input
              value={fieldName}
              onChange={(e) => setFieldName(e.target.value)}
              placeholder={`${field} (groups)`}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, minHeight: 240 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                placeholder="Search all values…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="checklist" style={{ flex: 1, maxHeight: 220 }}>
                {(values ?? [])
                  .filter((v) => !grouped.has(v))
                  .map((v) => (
                    <label key={v}>
                      <input
                        type="checkbox"
                        checked={selected.has(v)}
                        onChange={(e) => {
                          const next = new Set(selected)
                          if (e.target.checked) next.add(v)
                          else next.delete(v)
                          setSelected(next)
                        }}
                      />
                      <span className="vtext" title={v || '(blank)'}>{v || '(blank)'}</span>
                    </label>
                  ))}
                {!values && <div className="drop-hint">Loading values…</div>}
              </div>
              {values && values.length < total && (
                <button onClick={loadMore} disabled={loadingMore}>
                  {loadingMore
                    ? 'Loading…'
                    : `Load more (${(total - values.length).toLocaleString()} remaining)`}
                </button>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  placeholder="Group name (e.g. Sudeste)"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addGroup()}
                />
                <button disabled={!groupName.trim() || selected.size === 0} onClick={addGroup}>
                  Add group ({selected.size})
                </button>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="drop-hint">Groups:</div>
              <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4, padding: 6 }}>
                {groups.map((g, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <strong style={{ color: '#fff' }}>{g.name}</strong>
                    <span
                      className="x"
                      style={{ cursor: 'pointer', marginLeft: 6, color: 'var(--red)' }}
                      onClick={() => setGroups((gs) => gs.filter((_x, j) => j !== i))}
                    >
                      ×
                    </span>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{g.members.join(', ')}</div>
                  </div>
                ))}
                {!groups.length && <div className="drop-hint">Select values on the left and add a group.</div>}
              </div>
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                Ungrouped values:
                <select value={remainder} onChange={(e) => setRemainder(e.target.value as typeof remainder)}>
                  <option value="keep">keep original value</option>
                  <option value="other">label as "Other"</option>
                </select>
              </label>
            </div>
          </div>
          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!groups.length} onClick={() => void save()}>
            Create grouped field
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------- pattern detection scan ----------

interface PatternHit {
  field: string
  pattern: ExtractPattern
  pct: number
}

const SCAN_SAMPLE_ROWS = 2000
const SCAN_MIN_PCT = 3

/**
 * Sampled scan of the text columns against the extraction pattern library:
 * shows which identifiers (CPF, placa, PIX, …) each column contains and
 * creates the extraction fields in one click.
 */
export function DetectPatternsDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const rawFields = useApp((s) => s.fields[dsId])
  const calcFieldsFromStore = useApp((s) => s.workbook.calculatedFields[dsId])
  const fields = useMemo(() => {
    const raw = rawFields ?? []
    const calcInfo: FieldInfo[] = (calcFieldsFromStore ?? []).map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [rawFields, calcFieldsFromStore])
  const [hits, setHits] = useState<PatternHit[] | null>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [created, setCreated] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const scan = async (): Promise<void> => {
      const textCols = fields.filter((f) => f.kind === 'string' || f.kind === 'other')
      if (!textCols.length) {
        setHits([])
        return
      }
      const out: PatternHit[] = []
      try {
        for (let i = 0; i < textCols.length; i++) {
          const col = textCols[i]
          if (cancelled) return
          setProgress(`Scanning ${col.name} (${i + 1}/${textCols.length})…`)
          const aggs = EXTRACT_PATTERNS.map(
            (p, j) =>
              `sum(CASE WHEN regexp_matches(${asText(col.name)}, ${lit(p.pattern)}) THEN 1 ELSE 0 END) AS ${q(`p${j}`)}`
          )
          const res = await api.runQuery(
            `WITH s AS (SELECT ${q(col.name)} FROM ${q(`ds_${dsId}`)} WHERE ${q(col.name)} IS NOT NULL LIMIT ${SCAN_SAMPLE_ROWS})\n` +
              `SELECT count(*) AS n, ${aggs.join(', ')} FROM s`
          )
          const row = res.rows[0] ?? {}
          const n = Number(row.n ?? 0)
          if (!n) continue
          EXTRACT_PATTERNS.forEach((p, j) => {
            const pct = (Number(row[`p${j}`] ?? 0) / n) * 100
            if (pct >= SCAN_MIN_PCT) out.push({ field: col.name, pattern: p, pct })
          })
        }
        if (!cancelled) {
          out.sort((a, b) => b.pct - a.pct)
          setHits(out)
          setProgress('')
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setProgress('')
        }
      }
    }
    void scan()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId])

  const createField = async (hit: PatternHit, mode: 'extract' | 'flag' | 'count'): Promise<void> => {
    const { expr, role, kind } = extractionExpr(mode, hit.field, hit.pattern.pattern)
    const suffix = mode === 'extract' ? '' : mode === 'flag' ? ' (has)' : ' (count)'
    const name = `${hit.field} · ${hit.pattern.label}${suffix}`
    if (await validateAndSave(dsId, name, expr, role, setError, kind)) {
      setCreated((prev) => new Set(prev).add(`${hit.field}|${hit.pattern.id}|${mode}`))
      useApp.getState().setStatus(`Created field "${name}"`)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 640 }}>
        <header>Detect Document Patterns</header>
        <div className="body">
          <div className="drop-hint">
            Sampled scan ({SCAN_SAMPLE_ROWS.toLocaleString()} rows/column) of text columns against{' '}
            {EXTRACT_PATTERNS.length} identifier patterns — CPF, CNPJ, placa, telefone, PIX, crypto…
          </div>
          {progress && <div className="drop-hint"><span className="spinner" /> {progress}</div>}
          {hits && hits.length === 0 && !progress && (
            <div className="drop-hint">No known identifier patterns found in the text columns.</div>
          )}
          {hits && hits.length > 0 && (
            <div style={{ overflow: 'auto', maxHeight: 380, border: '1px solid var(--border)', borderRadius: 4 }}>
              <table className="grid" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Identifier</th>
                    <th style={{ textAlign: 'right' }}>Match</th>
                    <th>Create field</th>
                  </tr>
                </thead>
                <tbody>
                  {hits.map((h) => {
                    const key = (m: string): string => `${h.field}|${h.pattern.id}|${m}`
                    return (
                      <tr key={`${h.field}|${h.pattern.id}`}>
                        <td>{h.field}</td>
                        <td title={`e.g. ${h.pattern.example}`}>{h.pattern.label}</td>
                        <td className="num">{h.pct.toFixed(0)}%</td>
                        <td style={{ display: 'flex', gap: 4 }}>
                          <button
                            style={{ fontSize: 10, padding: '1px 7px' }}
                            disabled={created.has(key('extract'))}
                            title="New field with the first match per row"
                            onClick={() => void createField(h, 'extract')}
                          >
                            {created.has(key('extract')) ? '✓ Extracted' : '+ Extract'}
                          </button>
                          <button
                            style={{ fontSize: 10, padding: '1px 7px' }}
                            disabled={created.has(key('flag'))}
                            title="New true/false field"
                            onClick={() => void createField(h, 'flag')}
                          >
                            {created.has(key('flag')) ? '✓ Flag' : '+ Flag'}
                          </button>
                          <button
                            style={{ fontSize: 10, padding: '1px 7px' }}
                            disabled={created.has(key('count'))}
                            title="New measure counting matches per row"
                            onClick={() => void createField(h, 'count')}
                          >
                            {created.has(key('count')) ? '✓ Count' : '+ Count'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  )
}
