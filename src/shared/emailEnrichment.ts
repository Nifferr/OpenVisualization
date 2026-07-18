// Email enrichment knowledge bases and SQL generation for entity extraction.
// Pure TypeScript — no Electron, no Node imports.

// ---------- Public email providers ----------
export const PUBLIC_PROVIDERS: string[] = [
  'gmail.com', 'googlemail.com',
  'outlook.com', 'outlook.com.br',
  'hotmail.com', 'hotmail.com.br',
  'live.com', 'live.com.br',
  'msn.com',
  'yahoo.com', 'yahoo.com.br', 'ymail.com', 'rocketmail.com',
  'proton.me', 'protonmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'uol.com.br', 'bol.com.br',
  'terra.com.br',
  'ig.com.br', 'ig.com',
  'globo.com', 'globomail.com',
  'aol.com', 'aol.com.br',
  'mail.com',
  'zoho.com',
  'r7.com',
  'zipmail.com.br',
  'click21.com.br',
  'inbox.com',
  'fastmail.com', 'fastmail.fm',
  'tutanota.com', 'tutanota.de',
  'gmx.com', 'gmx.de',
  'yandex.com',
  'rediffmail.com',
  'mail.ru',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  't-online.de',
  'web.de',
  'freenet.de',
  'libero.it',
  'tin.it',
  'alice.it',
  'virgilio.it',
  'orange.fr', 'sfr.fr', 'free.fr',
  'laposte.net',
  'wanadoo.fr',
  'club-internet.fr',
  'telefonica.net',
  'ono.com',
  'ya.com',
  'bigpond.com',
  'optusnet.com.au',
  'xtra.co.nz',
  'vodamail.co.za',
  'mweb.co.za',
  'naver.com', 'daum.net', 'hanmail.net',
  'qq.com', '163.com', '126.com',
  'sohu.com', 'sina.com'
]

export interface OrgInfo {
  name: string
  type: string
}

// ---------- Domain → organization lookup ----------
export const KNOWN_ORGANIZATIONS: Record<string, OrgInfo> = {
  // Brasil — Bancos e finanças
  'itau.com.br': { name: 'Itaú', type: 'Banco' },
  'itau-personalite.com.br': { name: 'Itaú Personnalité', type: 'Banco' },
  'bradesco.com.br': { name: 'Bradesco', type: 'Banco' },
  'santander.com.br': { name: 'Santander', type: 'Banco' },
  'bb.com.br': { name: 'Banco do Brasil', type: 'Banco' },
  'nubank.com.br': { name: 'Nubank', type: 'Banco' },
  'inter.co': { name: 'Banco Inter', type: 'Banco' },
  'c6bank.com.br': { name: 'C6 Bank', type: 'Banco' },
  'original.com.br': { name: 'Banco Original', type: 'Banco' },
  'safra.com.br': { name: 'Banco Safra', type: 'Banco' },
  'sicredi.com.br': { name: 'Sicredi', type: 'Cooperativa de crédito' },
  'sicoob.com.br': { name: 'Sicoob', type: 'Cooperativa de crédito' },
  'banrisul.com.br': { name: 'Banrisul', type: 'Banco' },
  'bndes.gov.br': { name: 'BNDES', type: 'Banco de desenvolvimento' },

  // Brasil — Tecnologia
  'totvs.com.br': { name: 'TOTVS', type: 'Empresa de tecnologia' },
  'linx.com.br': { name: 'Linx', type: 'Empresa de tecnologia' },
  'mundiale.com.br': { name: 'Mundiale', type: 'Empresa de tecnologia' },

  // Brasil — Universidades
  'usp.br': { name: 'Universidade de São Paulo', type: 'Universidade' },
  'unicamp.br': { name: 'Universidade Estadual de Campinas', type: 'Universidade' },
  'unifesp.br': { name: 'Universidade Federal de São Paulo', type: 'Universidade' },
  'ufrj.br': { name: 'Universidade Federal do Rio de Janeiro', type: 'Universidade' },
  'ufmg.br': { name: 'Universidade Federal de Minas Gerais', type: 'Universidade' },
  'ufrgs.br': { name: 'Universidade Federal do Rio Grande do Sul', type: 'Universidade' },
  'ufsc.br': { name: 'Universidade Federal de Santa Catarina', type: 'Universidade' },
  'unb.br': { name: 'Universidade de Brasília', type: 'Universidade' },
  'fgv.br': { name: 'Fundação Getulio Vargas', type: 'Instituição de ensino' },
  'insper.edu.br': { name: 'Insper', type: 'Instituição de ensino' },
  'mackenzie.br': { name: 'Universidade Presbiteriana Mackenzie', type: 'Universidade' },
  'pucsp.br': { name: 'PUC-SP', type: 'Universidade' },
  'puc-rio.br': { name: 'PUC-Rio', type: 'Universidade' },
  'ufpe.br': { name: 'Universidade Federal de Pernambuco', type: 'Universidade' },
  'ufba.br': { name: 'Universidade Federal da Bahia', type: 'Universidade' },
  'ufc.br': { name: 'Universidade Federal do Ceará', type: 'Universidade' },
  'utfpr.edu.br': { name: 'Universidade Tecnológica Federal do Paraná', type: 'Universidade' },
  'fia.com.br': { name: 'FIA', type: 'Instituição de ensino' },
  'fiap.com.br': { name: 'FIAP', type: 'Instituição de ensino' },
  'uffs.edu.br': { name: 'Universidade Federal da Fronteira Sul', type: 'Universidade' },
  'ufv.br': { name: 'Universidade Federal de Viçosa', type: 'Universidade' },
  'ufes.br': { name: 'Universidade Federal do Espírito Santo', type: 'Universidade' },
  'ufrn.br': { name: 'Universidade Federal do Rio Grande do Norte', type: 'Universidade' },
  'ufpa.br': { name: 'Universidade Federal do Pará', type: 'Universidade' },
  'ufma.br': { name: 'Universidade Federal do Maranhão', type: 'Universidade' },
  'ufpb.br': { name: 'Universidade Federal da Paraíba', type: 'Universidade' },
  'ufs.br': { name: 'Universidade Federal de Sergipe', type: 'Universidade' },
  'ufal.br': { name: 'Universidade Federal de Alagoas', type: 'Universidade' },

  // Brasil — Governo
  'planalto.gov.br': { name: 'Governo Federal', type: 'Governo' },
  'senado.leg.br': { name: 'Senado Federal', type: 'Governo' },
  'camara.leg.br': { name: 'Câmara dos Deputados', type: 'Governo' },
  'stf.jus.br': { name: 'Supremo Tribunal Federal', type: 'Poder Judiciário' },
  'stj.jus.br': { name: 'Superior Tribunal de Justiça', type: 'Poder Judiciário' },
  'tse.jus.br': { name: 'Tribunal Superior Eleitoral', type: 'Poder Judiciário' },
  'receita.fazenda.gov.br': { name: 'Receita Federal', type: 'Governo' },
  'inss.gov.br': { name: 'INSS', type: 'Governo' },
  'gov.br': { name: 'Governo Federal', type: 'Governo' },

  // Global — Tecnologia
  'microsoft.com': { name: 'Microsoft', type: 'Empresa de tecnologia' },
  'apple.com': { name: 'Apple', type: 'Empresa de tecnologia' },
  'google.com': { name: 'Google', type: 'Empresa de tecnologia' },
  'amazon.com': { name: 'Amazon', type: 'Empresa de tecnologia' },
  'amazon.com.br': { name: 'Amazon Brasil', type: 'Empresa de tecnologia' },
  'meta.com': { name: 'Meta', type: 'Empresa de tecnologia' },
  'facebook.com': { name: 'Meta', type: 'Empresa de tecnologia' },
  'ibm.com': { name: 'IBM', type: 'Empresa de tecnologia' },
  'oracle.com': { name: 'Oracle', type: 'Empresa de tecnologia' },
  'sap.com': { name: 'SAP', type: 'Empresa de tecnologia' },
  'nvidia.com': { name: 'NVIDIA', type: 'Empresa de tecnologia' },
  'intel.com': { name: 'Intel', type: 'Empresa de tecnologia' },
  'amd.com': { name: 'AMD', type: 'Empresa de tecnologia' },
  'spotify.com': { name: 'Spotify', type: 'Empresa de tecnologia' },
  'netflix.com': { name: 'Netflix', type: 'Empresa de tecnologia' },
  'twitter.com': { name: 'X (Twitter)', type: 'Empresa de tecnologia' },
  'linkedin.com': { name: 'LinkedIn', type: 'Empresa de tecnologia' },
  'uber.com': { name: 'Uber', type: 'Empresa de tecnologia' },
  'airbnb.com': { name: 'Airbnb', type: 'Empresa de tecnologia' },
  'salesforce.com': { name: 'Salesforce', type: 'Empresa de tecnologia' },
  'adobe.com': { name: 'Adobe', type: 'Empresa de tecnologia' },
  'cloudflare.com': { name: 'Cloudflare', type: 'Empresa de tecnologia' },
  'github.com': { name: 'GitHub', type: 'Empresa de tecnologia' },

  // Global — Automotivo
  'tesla.com': { name: 'Tesla', type: 'Empresa automotiva' },
  'bmw.com': { name: 'BMW', type: 'Empresa automotiva' },
  'bmwgroup.com': { name: 'BMW Group', type: 'Empresa automotiva' },
  'mercedes-benz.com': { name: 'Mercedes-Benz', type: 'Empresa automotiva' },
  'volkswagen.com': { name: 'Volkswagen', type: 'Empresa automotiva' },
  'vw.com': { name: 'Volkswagen', type: 'Empresa automotiva' },
  'toyota.com': { name: 'Toyota', type: 'Empresa automotiva' },
  'ford.com': { name: 'Ford', type: 'Empresa automotiva' },
  'honda.com': { name: 'Honda', type: 'Empresa automotiva' },
  'hyundai.com': { name: 'Hyundai', type: 'Empresa automotiva' },
  'fiat.com': { name: 'Fiat', type: 'Empresa automotiva' },
  'stellantis.com': { name: 'Stellantis', type: 'Empresa automotiva' },
  'volvo.com': { name: 'Volvo', type: 'Empresa automotiva' },
  'renault.com': { name: 'Renault', type: 'Empresa automotiva' },
  'peugeot.com': { name: 'Peugeot', type: 'Empresa automotiva' },

  // Brasil — Varejo e e-commerce
  'magazineluiza.com.br': { name: 'Magazine Luiza', type: 'Varejo' },
  'americanas.com.br': { name: 'Americanas', type: 'Varejo' },
  'mercadolivre.com.br': { name: 'Mercado Livre', type: 'E-commerce' },
  'shopee.com.br': { name: 'Shopee', type: 'E-commerce' },
  'casasbahia.com.br': { name: 'Casas Bahia', type: 'Varejo' },
  'carrefour.com.br': { name: 'Carrefour Brasil', type: 'Varejo' },
  'pacheco.com.br': { name: 'Pacheco', type: 'Varejo' },
  'raiadrogasil.com.br': { name: 'Raia Drogasil', type: 'Farmácia' },
  'drogasil.com.br': { name: 'Drogasil', type: 'Farmácia' },
  'drogaraia.com.br': { name: 'Drogaraia', type: 'Farmácia' },
  'ifood.com.br': { name: 'iFood', type: 'E-commerce' },

  // Brasil — Saúde
  'einstein.br': { name: 'Hospital Israelita Albert Einstein', type: 'Hospital' },
  'hsl.org.br': { name: 'Hospital Sírio-Libanês', type: 'Hospital' },
  'hcor.com.br': { name: 'Hospital do Coração', type: 'Hospital' },
  'unimed.com.br': { name: 'Unimed', type: 'Operadora de saúde' },
  'bradescosaúde.com.br': { name: 'Bradesco Saúde', type: 'Operadora de saúde' },
  'amil.com.br': { name: 'Amil', type: 'Operadora de saúde' },
  'dasa.com.br': { name: 'Dasa', type: 'Rede de laboratórios' },
  'fleury.com.br': { name: 'Fleury', type: 'Rede de laboratórios' },
  'hermespardini.com.br': { name: 'Hermes Pardini', type: 'Rede de laboratórios' },

  // Brasil — Jurídico / Consultoria
  'pinheironeto.com.br': { name: 'Pinheiro Neto', type: 'Escritório de advocacia' },
  'mattosfilho.com.br': { name: 'Mattos Filho', type: 'Escritório de advocacia' },
  'machadomeyer.com.br': { name: 'Machado Meyer', type: 'Escritório de advocacia' },
  'tozzinifreire.com.br': { name: 'TozziniFreire', type: 'Escritório de advocacia' },
  'demarest.com.br': { name: 'Demarest', type: 'Escritório de advocacia' },
  'mckinsey.com': { name: 'McKinsey & Company', type: 'Consultoria' },
  'bcg.com': { name: 'Boston Consulting Group', type: 'Consultoria' },
  'bain.com': { name: 'Bain & Company', type: 'Consultoria' },
  'deloitte.com': { name: 'Deloitte', type: 'Consultoria' },
  'ey.com': { name: 'EY', type: 'Consultoria' },
  'pwc.com': { name: 'PwC', type: 'Consultoria' },
  'kpmg.com': { name: 'KPMG', type: 'Consultoria' },
  'accenture.com': { name: 'Accenture', type: 'Consultoria' },

  // Brasil — Energia e Indústria
  'petrobras.com.br': { name: 'Petrobras', type: 'Indústria de energia' },
  'br.com.br': { name: 'Vibra Energia (BR)', type: 'Indústria de energia' },
  'raizen.com': { name: 'Raízen', type: 'Indústria de energia' },
  'cosan.com': { name: 'Cosan', type: 'Indústria de energia' },
  'vale.com': { name: 'Vale', type: 'Mineradora' },
  'gerdau.com.br': { name: 'Gerdau', type: 'Indústria siderúrgica' },
  'embraer.com.br': { name: 'Embraer', type: 'Indústria aeroespacial' },
  'arcelormittal.com': { name: 'ArcelorMittal', type: 'Indústria siderúrgica' },
  'usiminas.com.br': { name: 'Usiminas', type: 'Indústria siderúrgica' },
  'csn.com.br': { name: 'CSN', type: 'Indústria siderúrgica' },

  // Brasil — Telecom
  'vivo.com.br': { name: 'Vivo', type: 'Telecomunicações' },
  'claro.com.br': { name: 'Claro', type: 'Telecomunicações' },
  'tim.com.br': { name: 'TIM', type: 'Telecomunicações' },
  'oi.com.br': { name: 'Oi', type: 'Telecomunicações' },
  'algar.com.br': { name: 'Algar Telecom', type: 'Telecomunicações' },

  // Global — Organizações internacionais e sem fins lucrativos
  'wikimedia.org': { name: 'Wikimedia Foundation', type: 'Organização sem fins lucrativos' },
  'eff.org': { name: 'Electronic Frontier Foundation', type: 'Organização sem fins lucrativos' },
  'msf.org': { name: 'Médicos Sem Fronteiras', type: 'Organização sem fins lucrativos' },
  'greenpeace.org': { name: 'Greenpeace', type: 'Organização sem fins lucrativos' },
  'worldbank.org': { name: 'Banco Mundial', type: 'Organização internacional' },
  'imf.org': { name: 'FMI', type: 'Organização internacional' },
  'who.int': { name: 'Organização Mundial da Saúde', type: 'Organização internacional' },
  'un.org': { name: 'Organização das Nações Unidas', type: 'Organização internacional' },
  'unesco.org': { name: 'UNESCO', type: 'Organização internacional' },
  'unicef.org': { name: 'UNICEF', type: 'Organização internacional' },
  'icrc.org': { name: 'Comitê Internacional da Cruz Vermelha', type: 'Organização internacional' },
  'soschildren.org': { name: 'Aldeias Infantis SOS', type: 'Organização sem fins lucrativos' },
  'tamar.org.br': { name: 'Projeto Tamar', type: 'Organização sem fins lucrativos' },
  'wwf.org.br': { name: 'WWF Brasil', type: 'Organização sem fins lucrativos' },
  'aacd.org.br': { name: 'AACD', type: 'Organização sem fins lucrativos' },

  // Global — Universidades estrangeiras conhecidas
  'mit.edu': { name: 'Massachusetts Institute of Technology', type: 'Universidade' },
  'stanford.edu': { name: 'Stanford University', type: 'Universidade' },
  'harvard.edu': { name: 'Harvard University', type: 'Universidade' },
  'ox.ac.uk': { name: 'University of Oxford', type: 'Universidade' },
  'cam.ac.uk': { name: 'University of Cambridge', type: 'Universidade' },
  'berkeley.edu': { name: 'UC Berkeley', type: 'Universidade' },
  'columbia.edu': { name: 'Columbia University', type: 'Universidade' }
}

// ---------- TLD → country ----------
export const TLD_COUNTRY: Record<string, string> = {
  br: 'Brasil',
  uk: 'Reino Unido',
  fr: 'França',
  de: 'Alemanha',
  jp: 'Japão',
  it: 'Itália',
  es: 'Espanha',
  pt: 'Portugal',
  ca: 'Canadá',
  au: 'Austrália',
  nl: 'Países Baixos',
  se: 'Suécia',
  no: 'Noruega',
  dk: 'Dinamarca',
  fi: 'Finlândia',
  ch: 'Suíça',
  at: 'Áustria',
  be: 'Bélgica',
  ie: 'Irlanda',
  nz: 'Nova Zelândia',
  za: 'África do Sul',
  in: 'Índia',
  cn: 'China',
  ru: 'Rússia',
  ar: 'Argentina',
  mx: 'México',
  cl: 'Chile',
  co: 'Colômbia',
  pe: 'Peru',
  uy: 'Uruguai',
  py: 'Paraguai',
  bo: 'Bolívia',
  ec: 'Equador',
  ve: 'Venezuela',
  cr: 'Costa Rica',
  pa: 'Panamá',
  cu: 'Cuba',
  do: 'República Dominicana',
  pr: 'Porto Rico',
  us: 'Estados Unidos',
  gr: 'Grécia',
  pl: 'Polônia',
  cz: 'República Tcheca',
  hu: 'Hungria',
  ro: 'Romênia',
  bg: 'Bulgária',
  hr: 'Croácia',
  sk: 'Eslováquia',
  si: 'Eslovênia',
  lt: 'Lituânia',
  lv: 'Letônia',
  ee: 'Estônia',
  rs: 'Sérvia',
  me: 'Montenegro',
  ba: 'Bósnia e Herzegovina',
  al: 'Albânia',
  mk: 'Macedônia do Norte',
  mt: 'Malta',
  cy: 'Chipre',
  is: 'Islândia',
  lu: 'Luxemburgo',
  mc: 'Mônaco',
  li: 'Liechtenstein',
  sm: 'San Marino',
  va: 'Vaticano',
  ae: 'Emirados Árabes Unidos',
  sa: 'Arábia Saudita',
  qa: 'Catar',
  kw: 'Kuwait',
  bh: 'Bahrein',
  om: 'Omã',
  il: 'Israel',
  jo: 'Jordânia',
  lb: 'Líbano',
  eg: 'Egito',
  ma: 'Marrocos',
  tn: 'Tunísia',
  dz: 'Argélia',
  ng: 'Nigéria',
  ke: 'Quênia',
  ao: 'Angola',
  mz: 'Moçambique',
  sg: 'Singapura',
  my: 'Malásia',
  id: 'Indonésia',
  ph: 'Filipinas',
  th: 'Tailândia',
  vn: 'Vietnã',
  kr: 'Coreia do Sul',
  tw: 'Taiwan',
  hk: 'Hong Kong',
  tr: 'Turquia',
  pk: 'Paquistão',
  bd: 'Bangladesh',
  np: 'Nepal',
  ua: 'Ucrânia',
  by: 'Bielorrússia',
  kz: 'Cazaquistão',
  az: 'Azerbaijão',
  ge: 'Geórgia',
  com: 'Global',
  org: 'Global',
  net: 'Global',
  info: 'Global',
  biz: 'Global',
  io: 'Indeterminado',
  ai: 'Indeterminado',
  app: 'Indeterminado',
  dev: 'Indeterminado',
  cloud: 'Indeterminado',
  tech: 'Indeterminado',
  online: 'Indeterminado',
  site: 'Indeterminado',
  digital: 'Indeterminado',
  xyz: 'Indeterminado',
  top: 'Indeterminado',
  work: 'Indeterminado',
  lives: 'Indeterminado',
  global: 'Global',
  int: 'Internacional',
  mil: 'Indeterminado',
  edu: 'Global',
  gov: 'Global'
}

/**
 * SQL for user name inference from email local part.
 * Splits local part on ._- separators, capitalizes each word, joins with space.
 * Returns empty string when the local part doesn't start with a letter.
 */
export function emailUserExpr(eRef: string): string {
  const local = `trim(split_part(trim(${eRef}), '@', 1))`
  const parts = `string_split(regexp_replace(${local}, '[._-]+', ' ', 'g'), ' ')`
  const capitalize = `array_to_string(list_transform(${parts}, w -> CASE WHEN length(w) > 0 THEN upper(substr(w,1,1))||lower(substr(w,2)) ELSE NULL END), ' ')`
  // regexp_matches = partial match; DuckDB's ~ operator is regexp_FULL_match
  // (unlike Postgres), which never matches a one-char prefix pattern
  return `CASE WHEN regexp_matches(${local}, '^[a-zA-Z]') THEN ${capitalize} ELSE '' END`
}

/**
 * SQL for extracting just the domain part (lowercased).
 */
export function emailDomainExpr(eRef: string): string {
  return `lower(trim(split_part(trim(${eRef}), '@', 2)))`
}

/**
 * SQL for the TLD (last label after the last dot) of an already-computed
 * domain reference (a column or expression).
 */
export function emailTLDOf(dRef: string): string {
  return `reverse(split_part(reverse(${dRef}), '.', 1))`
}

/**
 * SQL to extract the TLD (last label after the last dot) from an e-mail.
 */
export function emailTLDExpr(eRef: string): string {
  return emailTLDOf(emailDomainExpr(eRef))
}

/** Quote a string literal for safe SQL embedding. */
function q(v: string): string {
  return "'" + v.replace(/'/g, "''") + "'"
}

/**
 * SQL CASE expression for email category classification.
 * Uses the already-computed domain column reference.
 */
export function emailCategoryExpr(dRef: string): string {
  const providerLiterals = PUBLIC_PROVIDERS.map(p => q(p)).join(', ')
  const eduDomains = KNOWN_EDUCATIONAL_DOMAINS.map(d => `${dRef} = ${q(d)}`).join(' OR ')

  return `CASE
    WHEN ${dRef} LIKE '%.onion' THEN ${q('Rede oculta')}
    WHEN ${dRef} LIKE '%.gov.br' OR ${dRef} LIKE '%.gov' OR ${dRef} LIKE '%.gov.%' THEN ${q('Governamental')}
    WHEN ${dRef} LIKE '%.mil' THEN ${q('Militar')}
    WHEN ${dRef} IN (${providerLiterals}) THEN ${q('Particular')}
    WHEN ${dRef} LIKE '%.edu.br' OR ${dRef} LIKE '%.edu' THEN ${q('Educacional')}
    ${eduDomains ? `WHEN ${eduDomains} THEN ${q('Educacional')}` : ''}
    WHEN ${dRef} LIKE '%.org' THEN ${q('Organização sem fins lucrativos')}
    WHEN ${dRef} IN (${Object.keys(KNOWN_ORGANIZATIONS).map(d => q(d)).join(', ')}) THEN ${q('Corporativo')}
    WHEN ${dRef} LIKE '%.com.br' OR ${dRef} LIKE '%.com' OR ${dRef} LIKE '%.org.br' THEN ${q('Corporativo')}
    ELSE ${q('Indeterminado')}
  END`
}

/**
 * Fallback organization name derived from the domain itself, for domains not
 * in KNOWN_ORGANIZATIONS ("dot logic", per user spec): strip TLD suffixes and
 * keep the organization label — `teste.com` → teste, `empresa.com.br` →
 * empresa, `mail.empresa.com.br` → empresa, `smtp.empresa.corp.com.br` →
 * empresa. Unified rule: 4+ dot-separated segments take the 2nd label,
 * otherwise the 1st.
 */
export function emailOrgFallbackExpr(dRef: string): string {
  return (
    `CASE WHEN len(string_split(${dRef}, '.')) >= 4 ` +
    `THEN split_part(${dRef}, '.', 2) ELSE split_part(${dRef}, '.', 1) END`
  )
}

/**
 * SQL CASE expression for organization name.
 * Checks exact domain match against KNOWN_ORGANIZATIONS; unknown domains fall
 * back to the domain-derived name (emailOrgFallbackExpr) instead of ''.
 */
export function emailOrgExpr(dRef: string): string {
  const cases = Object.entries(KNOWN_ORGANIZATIONS).map(
    ([domain, info]) => `WHEN ${dRef} = ${q(domain)} THEN ${q(info.name)}`
  )
  if (!cases.length) return emailOrgFallbackExpr(dRef)
  return `CASE\n    ${cases.join('\n    ')}\n    ELSE ${emailOrgFallbackExpr(dRef)}\n  END`
}

/**
 * SQL CASE expression for organization type.
 * Checks exact domain match against KNOWN_ORGANIZATIONS.
 */
export function emailOrgTypeExpr(dRef: string): string {
  const cases = Object.entries(KNOWN_ORGANIZATIONS).map(
    ([domain, info]) => `WHEN ${dRef} = ${q(domain)} THEN ${q(info.type)}`
  )
  if (!cases.length) return q('Indeterminado')
  return `CASE\n    ${cases.join('\n    ')}\n    ELSE ${q('Indeterminado')}\n  END`
}

/**
 * SQL CASE expression for location (country) inference.
 * Checks by TLD (last label), falling back to "Indeterminado".
 */
export function emailLocationExpr(tldRef: string): string {
  // Group TLDs by country for a more compact CASE
  const cases = Object.entries(TLD_COUNTRY).map(
    ([tld, country]) => `WHEN ${tldRef} = ${q(tld)} THEN ${q(country)}`
  )
  return `CASE\n    ${cases.join('\n    ')}\n    ELSE ${q('Indeterminado')}\n  END`
}

/** Known educational domains for category classification. */
const KNOWN_EDUCATIONAL_DOMAINS: string[] = [
  'usp.br', 'unicamp.br', 'unifesp.br', 'ufrj.br', 'ufmg.br', 'ufrgs.br',
  'ufsc.br', 'unb.br', 'fgv.br', 'mackenzie.br', 'pucsp.br', 'puc-rio.br',
  'ufpe.br', 'ufba.br', 'ufc.br', 'insper.edu.br', 'utfpr.edu.br',
  'mit.edu', 'stanford.edu', 'harvard.edu', 'ox.ac.uk', 'cam.ac.uk',
  'berkeley.edu', 'columbia.edu', 'fia.com.br', 'fiap.com.br',
  'uffs.edu.br', 'ufv.br', 'ufes.br', 'ufrn.br', 'ufpa.br', 'ufma.br',
  'ufpb.br', 'ufs.br', 'ufal.br',
  'ee.usp.br', 'poli.usp.br', 'each.usp.br', 'fsp.usp.br', 'fm.usp.br',
  'icb.usp.br', 'ime.usp.br', 'iq.usp.br', 'fflch.usp.br'
]

/**
 * Rewrite the legacy "User name (from e-mail)" expression saved by v0.10.0
 * workbooks. That template generated a correlated-subquery form —
 * `(SELECT string_agg(...) FROM (SELECT unnest(string_split(regexp_replace(
 * trim(split_part(trim(<ref>), '@', 1)), ...` — which DuckDB rejects with
 * "UNNEST() for correlated expressions is not supported yet". The current
 * template uses scalar list functions instead; this detects the old shape in
 * a stored calc field, recovers the original e-mail reference and regenerates
 * the expression. Anything else passes through untouched.
 */
export function fixLegacyEmailUserExpr(expr: string): string {
  // intermediate v0.10.1 shape: scalar list ops but guarded with `local ~
  // '^[a-zA-Z]'` — DuckDB's ~ is regexp_FULL_match (unlike Postgres), so the
  // guard never matched and the field silently returned '' for every row
  expr = expr.replace(
    /(trim\(split_part\(trim\(.+?\), '@', 1\)\)) ~ '\^\[a-zA-Z\]'/g,
    `regexp_matches($1, '^[a-zA-Z]')`
  )
  if (!/FROM\s*\(SELECT\s+unnest\(string_split\(regexp_replace\(trim\(split_part\(trim\(/i.test(expr)) {
    return expr
  }
  const ref = expr.match(/trim\(split_part\(trim\((.+?)\), '@', 1\)\)/)
  if (!ref) return expr
  return emailUserExpr(ref[1])
}

export const ENRICHMENT_COLS = [
  'email_user',
  'email_domain',
  'email_category',
  'email_org',
  'email_org_type',
  'email_location'
] as const
