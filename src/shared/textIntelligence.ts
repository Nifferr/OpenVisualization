// Text intelligence: lexicon-based heuristic analyses compiled to DuckDB SQL.
// Pure TypeScript — no Electron, no Node imports.
//
// Every analysis is a keyword/phrase count over accent-stripped lowercase text,
// classified with a CASE — no ML, no network, cheap enough for calc fields.
// Both sides are normalized the same way: the text via DuckDB strip_accents(),
// the lexicons via deaccent() below, so "não" ≡ "NAO" and "ótimo" ≡ "otimo".

import { quoteLiteral } from './sqlBuilder'
import type { FieldRole } from './types'

// ---------- normalization helpers ----------

/** JS mirror of DuckDB strip_accents: NFD-decompose and drop combining marks. */
const deaccent = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '')

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Accent-stripped lowercase text of any column/expression. */
export function normTextExpr(col: string): string {
  return `strip_accents(lower(CAST(${col} AS VARCHAR)))`
}

/**
 * Per-row count of lexicon occurrences in a text column.
 * Single words match whole tokens (word-boundary tokenization, not substring —
 * "como" does not match inside "comodidade"); multi-word phrases are counted
 * with a \b-anchored regex alternation. Lexicon entries may carry accents.
 */
export function keywordCountExpr(col: string, words: string[]): string {
  const norm = normTextExpr(col)
  const clean = [...new Set(words.map((w) => deaccent(w.trim().toLowerCase())).filter(Boolean))]
  const singles = clean.filter((w) => !w.includes(' '))
  const phrases = clean.filter((w) => w.includes(' '))
  const parts: string[] = []
  // coalesce: a NULL text must count 0, not poison every CASE into its ELSE
  if (singles.length)
    parts.push(
      `coalesce(len(list_filter(string_split_regex(${norm}, '[^a-z0-9]+'), ` +
        `_w -> _w IN (${singles.map(quoteLiteral).join(', ')}))), 0)`
    )
  if (phrases.length)
    parts.push(
      `coalesce(len(regexp_extract_all(${norm}, ` +
        `${quoteLiteral(`\\b(?:${phrases.map(escapeRegex).join('|')})\\b`)})), 0)`
    )
  return parts.length ? parts.join(' + ') : '0'
}

/**
 * Bind N per-row counts once (as struct fields) and classify them with a scalar
 * body — avoids inlining each lexicon-count expression into every CASE branch.
 * The body refers to each bound count as `_x.<key>`.
 */
function bindCounts(counts: Array<[key: string, expr: string]>, body: string): string {
  const struct = `{${counts.map(([k, e]) => `'${k}': (${e})`).join(', ')}}`
  return `(list_transform([${struct}], _x -> ${body})[1])`
}

// ---------- 1. Idioma (stopword lists) ----------
// Words common to two languages appear in BOTH lists (they add equally to both
// counts, so they never tip the comparison); words that are frequent in one
// language but also ordinary in another supported one (a/as/no/do/me…) are
// excluded entirely. Post-deaccent collisions were checked (também→tambem vs
// también→tambien stay distinct; está/esta was dropped from both PT and ES).

export const STOPWORDS_PT: string[] = [
  'de', 'que', 'não', 'uma', 'um', 'para', 'com', 'os', 'em', 'são', 'ao',
  'também', 'você', 'já', 'isso', 'esse', 'essa', 'ele', 'ela', 'muito',
  'mais', 'quando', 'depois', 'até', 'tem', 'foi', 'seu', 'sua', 'pelo',
  'pela', 'estão', 'mas', 'como', 'se', 'por', 'e', 'o', 'na', 'nas',
  'das', 'dos'
]

export const STOPWORDS_EN: string[] = [
  'the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'with', 'was',
  'are', 'this', 'have', 'from', 'not', 'you', 'be', 'on', 'at', 'by',
  'but', 'they', 'we', 'his', 'her', 'or', 'an', 'which', 'been', 'their',
  'has', 'will', 'would', 'there', 'what', 'when', 'all', 'can'
]

export const STOPWORDS_ES: string[] = [
  'el', 'la', 'los', 'las', 'una', 'uno', 'es', 'en', 'con', 'del', 'se',
  'su', 'sus', 'y', 'pero', 'muy', 'más', 'para', 'que', 'como', 'por',
  'cuando', 'también', 'yo', 'usted', 'hay', 'donde', 'quien', 'le', 'lo',
  'al', 'sin', 'tiene', 'fue', 'son', 'están', 'o'
]

export function languageExpr(col: string): string {
  return bindCounts(
    [
      ['pt', keywordCountExpr(col, STOPWORDS_PT)],
      ['en', keywordCountExpr(col, STOPWORDS_EN)],
      ['es', keywordCountExpr(col, STOPWORDS_ES)]
    ],
    `CASE WHEN greatest(_x.pt, _x.en, _x.es) = 0 THEN 'Indeterminado' ` +
      `WHEN _x.pt >= _x.en AND _x.pt >= _x.es THEN 'Português' ` +
      `WHEN _x.en >= _x.es THEN 'Inglês' ELSE 'Espanhol' END`
  )
}

// ---------- 2. Tom ----------

export const TONE_FORMAL: string[] = [
  'prezado', 'prezada', 'prezados', 'prezadas', 'solicito', 'solicitamos',
  'atenciosamente', 'cordialmente', 'conforme', 'encaminho', 'encaminhamos',
  'referente', 'mediante', 'respeitosamente', 'vossa', 'senhoria',
  'cumprimentando', 'outrossim', 'destarte', 'supracitado', 'supracitada',
  'esclarecimentos', 'providências', 'gentileza', 'deferimento', 'protocolo',
  'segue anexo', 'em anexo', 'venho por meio'
]

export const TONE_INFORMAL: string[] = [
  'oi', 'olá', 'valeu', 'cara', 'blz', 'beleza', 'kkk', 'kkkk', 'kkkkk',
  'rs', 'rsrs', 'haha', 'hahaha', 'mano', 'véi', 'galera', 'massa',
  'tranquilo', 'falou', 'abraço', 'abs', 'vlw', 'pra', 'pro', 'né', 'tá',
  'obg', 'bjs', 'oie', 'eae', 'opa', 'tipo assim'
]

// ---------- 7. Nível técnico (also feeds the "Técnico" tone flag) ----------

export const TECH_TERMS: string[] = [
  'api', 'rest', 'sql', 'thread', 'docker', 'deploy', 'kubernetes', 'oauth',
  'jwt', 'grpc', 'backend', 'frontend', 'endpoint', 'microsserviço',
  'microserviço', 'cache', 'latência', 'framework', 'repositório', 'commit',
  'branch', 'merge', 'pipeline', 'devops', 'terraform', 'webhook', 'token',
  'criptografia', 'hash', 'servidor', 'cluster', 'kafka', 'redis', 'nginx',
  'linux', 'http', 'https', 'json', 'xml', 'yaml', 'regex', 'runtime',
  'algoritmo', 'refatoração', 'kernel', 'script', 'plugin', 'sdk', 'cli',
  'typescript', 'javascript', 'python', 'java', 'container', 'debug',
  'firewall', 'proxy', 'dns', 'tcp', 'udp', 'ssl', 'tls', 'vpn',
  'banco de dados', 'máquina virtual'
]

export function techTermCountExpr(col: string): string {
  return keywordCountExpr(col, TECH_TERMS)
}

export function techLevelExpr(col: string): string {
  return bindCounts(
    [['n', techTermCountExpr(col)]],
    `CASE WHEN _x.n >= 8 THEN 'Avançado' WHEN _x.n >= 3 THEN 'Intermediário' ELSE 'Básico' END`
  )
}

export function toneExpr(col: string): string {
  return bindCounts(
    [
      ['f', keywordCountExpr(col, TONE_FORMAL)],
      ['i', keywordCountExpr(col, TONE_INFORMAL)],
      ['t', techTermCountExpr(col)]
    ],
    `coalesce(nullif(concat_ws(' ', ` +
      `CASE WHEN _x.f > _x.i THEN 'Formal' WHEN _x.i > _x.f THEN 'Informal' END, ` +
      `CASE WHEN _x.t >= 2 THEN 'Técnico' END), ''), 'Neutro')`
  )
}

// ---------- 3. Sentimento ----------

export const SENTIMENT_POSITIVE: string[] = [
  'ótimo', 'ótima', 'ótimos', 'ótimas', 'excelente', 'excelentes', 'bom',
  'boa', 'bons', 'boas', 'feliz', 'felizes', 'perfeito', 'perfeita',
  'maravilhoso', 'maravilhosa', 'sucesso', 'parabéns', 'adorei', 'amei',
  'gostei', 'incrível', 'satisfeito', 'satisfeita', 'eficiente', 'rápido',
  'rápida', 'positivo', 'positiva', 'melhor', 'recomendo', 'sensacional',
  'fantástico', 'fantástica', 'agradável', 'excepcional', 'impecável',
  'nota 10'
]

export const SENTIMENT_NEGATIVE: string[] = [
  'ruim', 'ruins', 'péssimo', 'péssima', 'erro', 'erros', 'problema',
  'problemas', 'falha', 'falhas', 'falhou', 'horrível', 'terrível',
  'insatisfeito', 'insatisfeita', 'demora', 'demorado', 'demorada', 'lento',
  'lenta', 'atraso', 'atrasado', 'atrasada', 'reclamação', 'defeito',
  'quebrado', 'quebrada', 'prejuízo', 'dificuldade', 'pior', 'absurdo',
  'absurda', 'decepção', 'decepcionado', 'decepcionada', 'frustrado',
  'frustrada', 'frustrante', 'inaceitável', 'não funciona', 'não funcionou'
]

export function sentimentExpr(col: string): string {
  return bindCounts(
    [
      ['p', keywordCountExpr(col, SENTIMENT_POSITIVE)],
      ['n', keywordCountExpr(col, SENTIMENT_NEGATIVE)]
    ],
    `CASE WHEN _x.p > _x.n THEN 'Positivo' WHEN _x.n > _x.p THEN 'Negativo' ELSE 'Neutro' END`
  )
}

/** Signed score (positives − negatives) — a measure for charts. */
export function sentimentScoreExpr(col: string): string {
  return `(${keywordCountExpr(col, SENTIMENT_POSITIVE)}) - (${keywordCountExpr(col, SENTIMENT_NEGATIVE)})`
}

// ---------- 4. Emoção ----------

export const EMOTION_LEXICONS: Record<string, string[]> = {
  Raiva: [
    'absurdo', 'absurda', 'indignado', 'indignada', 'indignação', 'ridículo',
    'ridícula', 'revoltante', 'revoltado', 'revoltada', 'inaceitável',
    'raiva', 'ódio', 'furioso', 'furiosa', 'irritado', 'irritada',
    'palhaçada', 'vergonha', 'vergonhoso', 'vergonhosa', 'inadmissível'
  ],
  Medo: [
    'risco', 'riscos', 'ameaça', 'ameaças', 'perigo', 'perigoso', 'perigosa',
    'medo', 'receio', 'preocupado', 'preocupada', 'preocupante',
    'preocupação', 'alerta', 'inseguro', 'insegura', 'insegurança', 'temo',
    'tememos', 'assustado', 'assustada', 'assustador', 'pânico'
  ],
  Alegria: [
    'feliz', 'felicidade', 'alegria', 'alegre', 'comemorar', 'comemoração',
    'parabéns', 'animado', 'animada', 'empolgado', 'empolgada', 'festa',
    'conquista', 'vitória', 'sucesso', 'ótimo', 'maravilhoso', 'maravilhosa',
    'celebrar', 'contente'
  ],
  Tristeza: [
    'perda', 'infelizmente', 'lamento', 'lamentável', 'lamentamos', 'triste',
    'tristeza', 'luto', 'saudade', 'saudades', 'pesar', 'deprimido',
    'deprimida', 'desanimado', 'desanimada', 'decepção', 'decepcionado',
    'chateado', 'chateada', 'sofrimento', 'falecimento', 'faleceu'
  ]
}

export function emotionExpr(col: string): string {
  const g = `greatest(_x.r, _x.m, _x.a, _x.t)`
  return bindCounts(
    [
      ['r', keywordCountExpr(col, EMOTION_LEXICONS.Raiva)],
      ['m', keywordCountExpr(col, EMOTION_LEXICONS.Medo)],
      ['a', keywordCountExpr(col, EMOTION_LEXICONS.Alegria)],
      ['t', keywordCountExpr(col, EMOTION_LEXICONS.Tristeza)]
    ],
    `CASE WHEN ${g} = 0 THEN 'Neutra' ` +
      `WHEN _x.r = ${g} THEN 'Raiva' WHEN _x.m = ${g} THEN 'Medo' ` +
      `WHEN _x.a = ${g} THEN 'Alegria' ELSE 'Tristeza' END`
  )
}

// ---------- 5. Intenção ----------

export const INTENT_LEXICONS: Record<string, string[]> = {
  Pedido: [
    'gostaria', 'preciso', 'precisamos', 'poderia', 'poderiam', 'favor',
    'solicito', 'solicitamos', 'solicitação', 'necessito', 'necessitamos',
    'peço', 'pedimos', 'por favor', 'por gentileza', 'gentileza', 'requeiro',
    'aguardo'
  ],
  Reclamação: [
    'erro', 'erros', 'problema', 'problemas', 'falha', 'falhas', 'defeito',
    'reclamação', 'reclamar', 'insatisfeito', 'insatisfeita', 'absurdo',
    'demora', 'atraso', 'péssimo', 'péssima', 'ruim', 'indevido', 'indevida',
    'não funciona', 'não consigo', 'não foi resolvido'
  ],
  Dúvida: [
    'dúvida', 'dúvidas', 'como', 'qual', 'quais', 'quanto', 'quanta',
    'quando', 'onde', 'por que', 'será que', 'como faço'
  ],
  Elogio: [
    'parabéns', 'excelente', 'ótimo', 'ótima', 'adorei', 'amei', 'gostei',
    'maravilhoso', 'maravilhosa', 'incrível', 'sensacional', 'perfeito',
    'perfeita', 'recomendo', 'muito bom', 'muito boa', 'elogiar', 'elogio'
  ]
}

export function intentExpr(col: string): string {
  const g = `greatest(_x.p, _x.r, _x.d, _x.e)`
  // '?' is itself a strong question signal — punctuation survives the
  // tokenizer split, so count it directly on the raw text
  const questionMarks = `coalesce(len(regexp_extract_all(CAST(${col} AS VARCHAR), '\\?')), 0)`
  return bindCounts(
    [
      ['p', keywordCountExpr(col, INTENT_LEXICONS.Pedido)],
      ['r', keywordCountExpr(col, INTENT_LEXICONS['Reclamação'])],
      ['d', `${keywordCountExpr(col, INTENT_LEXICONS['Dúvida'])} + ${questionMarks}`],
      ['e', keywordCountExpr(col, INTENT_LEXICONS.Elogio)]
    ],
    `CASE WHEN ${g} = 0 THEN 'Outro' ` +
      `WHEN _x.p = ${g} THEN 'Pedido' WHEN _x.r = ${g} THEN 'Reclamação' ` +
      `WHEN _x.d = ${g} THEN 'Dúvida' ELSE 'Elogio' END`
  )
}

// ---------- 6. Área de conhecimento ----------

export const AREA_LEXICONS: Record<string, string[]> = {
  Tecnologia: [
    'api', 'docker', 'kubernetes', 'java', 'python', 'software', 'sistema',
    'sistemas', 'servidor', 'servidores', 'aplicativo', 'aplicativos', 'app',
    'nuvem', 'cloud', 'deploy', 'backend', 'frontend', 'site', 'sites',
    'tecnologia', 'digital', 'rede', 'redes', 'ti', 'computador',
    'computadores', 'internet', 'senha', 'login', 'hardware', 'programação',
    'desenvolvedor', 'código', 'banco de dados'
  ],
  Saúde: [
    'hospital', 'hospitais', 'paciente', 'pacientes', 'cirurgia', 'remédio',
    'remédios', 'médico', 'médica', 'médicos', 'enfermeiro', 'enfermeira',
    'consulta', 'consultas', 'exame', 'exames', 'tratamento', 'diagnóstico',
    'clínica', 'saúde', 'vacina', 'sintoma', 'sintomas', 'internação', 'sus',
    'ambulatório', 'enfermagem', 'plano de saúde'
  ],
  Jurídico: [
    'contrato', 'contratos', 'advogado', 'advogada', 'advogados', 'tribunal',
    'processo', 'processos', 'juiz', 'juíza', 'sentença', 'liminar',
    'petição', 'audiência', 'recurso', 'jurisprudência', 'lei', 'leis',
    'cláusula', 'comarca', 'réu', 'vara', 'oab', 'judicial', 'jurídico',
    'intimação', 'habeas'
  ],
  Financeiro: [
    'pix', 'banco', 'bancos', 'boleto', 'boletos', 'juros', 'pagamento',
    'pagamentos', 'fatura', 'faturas', 'crédito', 'débito', 'empréstimo',
    'financiamento', 'investimento', 'investimentos', 'parcela', 'parcelas',
    'cobrança', 'transferência', 'saldo', 'cartão', 'imposto', 'impostos',
    'taxa', 'taxas', 'reais', 'dinheiro', 'financeiro', 'financeira',
    'conta corrente'
  ],
  Educação: [
    'aula', 'aulas', 'professor', 'professora', 'professores', 'aluno',
    'aluna', 'alunos', 'escola', 'escolas', 'universidade', 'curso',
    'cursos', 'prova', 'provas', 'matrícula', 'ensino', 'educação',
    'faculdade', 'disciplina', 'disciplinas', 'semestre', 'formatura',
    'vestibular', 'enem', 'didático', 'pedagógico'
  ],
  Comercial: [
    'venda', 'vendas', 'cliente', 'clientes', 'desconto', 'descontos',
    'promoção', 'produto', 'produtos', 'estoque', 'loja', 'lojas',
    'orçamento', 'proposta', 'propostas', 'negociação', 'fornecedor',
    'fornecedores', 'entrega', 'entregas', 'frete', 'marketing', 'comercial',
    'pedido', 'revenda', 'atacado', 'varejo'
  ]
}

export function knowledgeAreaExpr(col: string): string {
  const g = `greatest(_x.tec, _x.sau, _x.jur, _x.fin, _x.edu, _x.com)`
  return bindCounts(
    [
      ['tec', keywordCountExpr(col, AREA_LEXICONS.Tecnologia)],
      ['sau', keywordCountExpr(col, AREA_LEXICONS['Saúde'])],
      ['jur', keywordCountExpr(col, AREA_LEXICONS['Jurídico'])],
      ['fin', keywordCountExpr(col, AREA_LEXICONS.Financeiro)],
      ['edu', keywordCountExpr(col, AREA_LEXICONS['Educação'])],
      ['com', keywordCountExpr(col, AREA_LEXICONS.Comercial)]
    ],
    `CASE WHEN ${g} = 0 THEN 'Geral' ` +
      `WHEN _x.tec = ${g} THEN 'Tecnologia' WHEN _x.sau = ${g} THEN 'Saúde' ` +
      `WHEN _x.jur = ${g} THEN 'Jurídico' WHEN _x.fin = ${g} THEN 'Financeiro' ` +
      `WHEN _x.edu = ${g} THEN 'Educação' ELSE 'Comercial' END`
  )
}

// ---------- 8. Urgência ----------
// Strong signals weigh 2 so a single "URGENTE" already classifies as Alta,
// while weak/contextual ones ("hoje", "prazo") need company.

export const URGENCY_STRONG: string[] = [
  'urgente', 'urgentíssimo', 'urgentíssima', 'urgência', 'imediatamente',
  'asap', 'emergência', 'emergencial', 'inadiável', 'improrrogável',
  'o quanto antes', 'com urgência', 'para ontem'
]

export const URGENCY_WEAK: string[] = [
  'agora', 'hoje', 'amanhã', 'prazo', 'imediato', 'imediata', 'crítico',
  'crítica', 'vence', 'vencimento', 'expira', 'até hoje', 'até amanhã',
  'ainda hoje'
]

/** Weighted urgency score (2×strong + weak) — a measure for charts. */
export function urgencyCountExpr(col: string): string {
  return `2 * (${keywordCountExpr(col, URGENCY_STRONG)}) + (${keywordCountExpr(col, URGENCY_WEAK)})`
}

export function urgencyExpr(col: string): string {
  return bindCounts(
    [['n', urgencyCountExpr(col)]],
    `CASE WHEN _x.n >= 2 THEN 'Alta' WHEN _x.n = 1 THEN 'Média' ELSE 'Baixa' END`
  )
}

// ---------- 9. Confiança da informação (certeza vs hedging) ----------

export const CONFIDENCE_HIGH: string[] = [
  'confirmado', 'confirmada', 'confirmamos', 'oficial', 'oficialmente',
  'comprovado', 'comprovada', 'comprovadamente', 'certeza', 'certamente',
  'garantido', 'garantida', 'garantimos', 'definitivamente', 'evidência',
  'evidências', 'documentado', 'documentada', 'verificado', 'verificada',
  'atestado', 'atestada', 'constatado', 'constatada', 'de acordo com',
  'sem dúvida', 'com certeza'
]

export const CONFIDENCE_LOW: string[] = [
  'acho', 'achamos', 'talvez', 'parece', 'aparentemente', 'provavelmente',
  'possivelmente', 'suponho', 'supomos', 'imagino', 'creio', 'presumo',
  'supostamente', 'acredito', 'acreditamos', 'pode ser', 'não sei',
  'não tenho certeza', 'se não me engano', 'ao que tudo indica'
]

export function confidenceExpr(col: string): string {
  return bindCounts(
    [
      ['h', keywordCountExpr(col, CONFIDENCE_HIGH)],
      ['l', keywordCountExpr(col, CONFIDENCE_LOW)]
    ],
    `CASE WHEN _x.l > _x.h THEN 'Baixa' WHEN _x.h > _x.l THEN 'Alta' ELSE 'Média' END`
  )
}

// ---------- 10. Relações entre entidades ----------
// Trigger-phrase patterns over the normalized text (accent-stripped lowercase,
// so "sócio"→"socio", "mãe"→"mae"). Partial-match via regexp_matches — never
// `~`, which is regexp_full_match in DuckDB.

export interface RelationPattern {
  id: string
  label: string
  /** RE2 regex, applied to accent-stripped lowercase text */
  pattern: string
}

export const RELATION_PATTERNS: RelationPattern[] = [
  { id: 'emprego', label: 'Emprego',
    pattern: '\\btrabalh\\w+ (n[ao]|em|para|pel[ao])\\b|\\bfuncionari[oa]s? d[aeo]\\b|\\bcontratad[oa]s? (pel[ao]|por)\\b' },
  { id: 'residencia', label: 'Residência',
    pattern: '\\b(mora|moram|morava|reside|residem|residente) (em|n[ao])\\b|\\bdomiciliad[oa] em\\b' },
  { id: 'localizacao', label: 'Localização',
    pattern: '\\b(localizad|sediad|situad)[oa]s? (em|n[ao])\\b|\\bcom sede (em|n[ao])\\b' },
  { id: 'sociedade', label: 'Sociedade',
    pattern: '\\bsoci[oa]s? d[aeo]\\b|\\bacionistas? d[aeo]\\b|\\bfundador\\w* d[aeo]\\b|\\bfundou [ao]\\b' },
  { id: 'parentesco', label: 'Parentesco',
    pattern: '\\bcasad[oa]s? com\\b|\\b(filh[oa]s?|irmaos?|irmas?|pai|mae|primo|prima|tio|tia) d[aeo]\\b' },
  { id: 'formacao', label: 'Formação',
    pattern: '\\b(estuda|estudam|estudou|formad[oa]s?|graduad[oa]s?|mestrado|doutorado) (em|n[ao]|pel[ao])\\b' },
  { id: 'propriedade', label: 'Propriedade',
    pattern: '\\b(don[oa]s?|proprietari[oa]s?) d[aeo]\\b|\\bpertence a\\b' }
]

/** Multi-label relation types ("Emprego; Residência"), NULL when none match. */
export function relationTypesExpr(col: string): string {
  const norm = normTextExpr(col)
  const cases = RELATION_PATTERNS.map(
    (r) =>
      `CASE WHEN regexp_matches(${norm}, ${quoteLiteral(r.pattern)}) THEN ${quoteLiteral(r.label)} END`
  )
  return `nullif(concat_ws('; ', ${cases.join(', ')}), '')`
}

// ---------- registry (drives the template group and the batch dialog) ----------

export interface SmartAnalysis {
  id: string
  /** full UI label for the template picker */
  label: string
  /** short suffix for batch-created field names, e.g. "notes · Idioma" */
  short: string
  role: FieldRole
  /** pre-checked in the batch dialog */
  common: boolean
  build: (col: string) => string
}

export const SMART_ANALYSES: SmartAnalysis[] = [
  { id: 'language', label: 'Idioma (Português/Inglês/Espanhol)', short: 'Idioma',
    role: 'dimension', common: true, build: languageExpr },
  { id: 'tone', label: 'Tom (Formal/Informal/Técnico)', short: 'Tom',
    role: 'dimension', common: true, build: toneExpr },
  { id: 'sentiment', label: 'Sentimento (Positivo/Negativo/Neutro)', short: 'Sentimento',
    role: 'dimension', common: true, build: sentimentExpr },
  { id: 'sentimentScore', label: 'Sentimento — score (positivas − negativas)', short: 'Sentimento score',
    role: 'measure', common: false, build: sentimentScoreExpr },
  { id: 'emotion', label: 'Emoção (Raiva/Medo/Alegria/Tristeza)', short: 'Emoção',
    role: 'dimension', common: false, build: emotionExpr },
  { id: 'intent', label: 'Intenção (Pedido/Reclamação/Dúvida/Elogio)', short: 'Intenção',
    role: 'dimension', common: true, build: intentExpr },
  { id: 'area', label: 'Área de conhecimento (Tecnologia/Saúde/Jurídico…)', short: 'Área',
    role: 'dimension', common: false, build: knowledgeAreaExpr },
  { id: 'techLevel', label: 'Nível técnico (Básico/Intermediário/Avançado)', short: 'Nível técnico',
    role: 'dimension', common: false, build: techLevelExpr },
  { id: 'techTerms', label: 'Termos técnicos (contagem)', short: 'Termos técnicos',
    role: 'measure', common: false, build: techTermCountExpr },
  { id: 'urgency', label: 'Urgência (Alta/Média/Baixa)', short: 'Urgência',
    role: 'dimension', common: true, build: urgencyExpr },
  { id: 'urgencyScore', label: 'Urgência — score', short: 'Urgência score',
    role: 'measure', common: false, build: urgencyCountExpr },
  { id: 'confidence', label: 'Confiança da informação (Alta/Média/Baixa)', short: 'Confiança',
    role: 'dimension', common: false, build: confidenceExpr },
  { id: 'relations', label: 'Relações entre entidades (Emprego, Residência…)', short: 'Relações',
    role: 'dimension', common: false, build: relationTypesExpr }
]
