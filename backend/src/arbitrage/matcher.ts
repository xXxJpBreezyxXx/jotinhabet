/**
 * Calcula a similaridade de Jaro-Winkler entre duas strings.
 * Retorna um valor entre 0.0 (completamente diferente) e 1.0 (idêntico).
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  
  const m = getMatchCount(s1, s2);
  if (m === 0) return 0.0;
  
  const t = getTranspositions(s1, s2);
  const jaro = (m / s1.length + m / s2.length + (m - t) / m) / 3.0;
  
  const p = 0.1;
  let l = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
    if (s1[i] === s2[i]) l++;
    else break;
  }
  
  return jaro + l * p * (1.0 - jaro);
}

function getMatchCount(s1: string, s2: string): number {
  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  return matches;
}

function getTranspositions(s1: string, s2: string): number {
  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      break;
    }
  }
  
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  
  return Math.floor(transpositions / 2);
}

/**
 * Normaliza o nome do time para facilitar o matching.
 * Remove acentos, pontuações, converte para minúsculas.
 */
export function normalizeTeamName(name: string): string {
  const p = analisarTime(name);
  return `${p.nome}${p.sub ? ' sub' + p.sub : ''}${p.fem ? ' fem' : ''}`;
}

/**
 * Perfil estrutural do nome do time/jogador, extra\u00eddo ANTES do fuzzy matching:
 *  - "Sobrenome, Nome" \u2192 "Nome Sobrenome" (Kambi/Altenar listam t\u00eanis/mesa com v\u00edrgula);
 *  - remove c\u00f3digo de pa\u00eds "(BRA)" e demais par\u00eanteses;
 *  - detecta marcadores de FEMININO ("(W)"/"(F)"/"Feminino"), de BASE ("Sub-20"/"U19")
 *    e de time RESERVA ("B"/"II") \u2014 viram FLAGS usadas como GUARDA DURA no matching:
 *    um lado com marcador e o outro sem NUNCA casam. Sem a guarda, o substring rule
 *    cruzava "Barcelona" com "Barcelona Feminino" (times diferentes, dinheiro real).
 */
interface PerfilTime {
  nome: string;       // nome normalizado SEM os marcadores
  fem: boolean;       // time/torneio feminino
  sub: string | null; // categoria de base ("20" de Sub-20/U20)
  reserva: boolean;   // time B / II / reservas
}

const RE_FEM_TEST = /\((?:w|f|fem)\)|\b(?:feminino|feminina|femenino|femenina|women'?s?|woman|ladies)\b/i;
const RE_FEM_STRIP = /\((?:w|f|fem)\)|\b(?:feminino|feminina|femenino|femenina|women'?s?|woman|ladies)\b/gi;

const cacheAnalise = new Map<string, PerfilTime>();

function analisarTime(name: string): PerfilTime {
  const key = name || '';
  const hit = cacheAnalise.get(key);
  if (hit) return hit;

  let s = key.trim();
  // "Sobrenome, Nome" \u2192 "Nome Sobrenome"
  const partes = s.split(',');
  if (partes.length === 2 && partes[0].trim() && partes[1].trim()) {
    s = `${partes[1].trim()} ${partes[0].trim()}`;
  }
  const fem = RE_FEM_TEST.test(s);
  s = s.replace(RE_FEM_STRIP, ' ');
  s = s.replace(/\([^)]*\)/g, ' '); // c\u00f3digo de pa\u00eds "(BRA)" e afins
  s = s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(fc|clube|club|ec|sp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const mSub = s.match(/\b(?:sub|u)\s?(\d{2})\b/);
  const sub = mSub ? mSub[1] : null;
  if (mSub) s = s.replace(/\b(?:sub|u)\s?\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  const reserva = /\b(?:b|ii|iii|reservas?|reserves?)$/.test(s);
  s = s.replace(/\bii$/, 'b'); // "Sporting II" e "Sporting B" s\u00e3o o mesmo time reserva

  const p: PerfilTime = { nome: s, fem, sub, reserva };
  if (cacheAnalise.size > 5000) cacheAnalise.clear();
  cacheAnalise.set(key, p);
  return p;
}

/**
 * Dicionário de aliases para times com nomes em idiomas diferentes.
 * Mapeamento: chave = nome normalizado PT → array de aliases normalizados (EN, ES, outros)
 */
const TEAM_ALIASES: Record<string, string[]> = {
  // Seleções internacionais
  'argentina': ['argentina'],
  'suica': ['switzerland', 'suiza', 'schweiz', 'svizzera'],
  'brasil': ['brazil'],
  'alemanha': ['germany', 'deutschland'],
  'franca': ['france'],
  'espanha': ['spain', 'espana'],
  'italia': ['italy', 'italia'],
  'holanda': ['netherlands', 'holland', 'pays bas'],
  'belgica': ['belgium', 'belgique'],
  'portugal': ['portugal'],
  'noruega': ['norway', 'norge'],
  'dinamarca': ['denmark', 'danmark'],
  'suecia': ['sweden', 'sverige'],
  'coreia do sul': ['south korea', 'korea republic', 'rep da coreia'],
  'estados unidos': ['usa', 'united states', 'estados unidos'],
  'mexico': ['mexico'],
  'japao': ['japan', 'japon'],
  'australia': ['australia'],
  'marrocos': ['morocco', 'maroc'],
  'nigeria': ['nigeria'],
  'egito': ['egypt'],
  'canada': ['canada'],
  'colombia': ['colombia'],
  'chile': ['chile'],
  'uruguai': ['uruguay'],
  'peru': ['peru'],
  'equador': ['ecuador'],
  'paraguai': ['paraguay'],
  'bolivia': ['bolivia'],
  'venezuela': ['venezuela'],
  'costa rica': ['costa rica'],
  'panama': ['panama'],
  'honduras': ['honduras'],
  'jamaica': ['jamaica'],
  'ghana': ['ghana'],
  'senegal': ['senegal'],
  'costa do marfim': ['ivory coast', 'cote divoire'],
  'inglaterra': ['england'],
  'escocia': ['scotland'],
  'gales': ['wales'],
  'russia': ['russia'],
  'ucrania': ['ukraine'],
  'turquia': ['turkey', 'turkiye'],
  'croacia': ['croatia'],
  'servia': ['serbia'],
  'republica checa': ['czech republic', 'czechia'],
  'eslovaquia': ['slovakia'],
  'hungria': ['hungary'],
  'austria': ['austria'],
  'polonia': ['poland', 'polska'],
  'ira': ['iran'],
  'eslovenia': ['slovenia'],
  'grecia': ['greece'],
  'letonia': ['latvia'],
  'lituania': ['lithuania'],
  'finlandia': ['finland'],
  'irlanda': ['ireland'],
  'nova zelandia': ['new zealand'],
  'tailandia': ['thailand'],
  'republica dominicana': ['dominican republic'],
  'porto rico': ['puerto rico'],
  // MLB — abreviações de cidade divergem entre casas (Altenar usa "LA Dodgers")
  'los angeles dodgers': ['la dodgers'],
  'los angeles angels': ['la angels'],
  'new york yankees': ['ny yankees'],
  'new york mets': ['ny mets'],
  'san francisco giants': ['sf giants'],
  'san diego padres': ['sd padres'],
  'tampa bay rays': ['tb rays'],
};

/**
 * Resolve o nome JÁ normalizado (sem marcadores) para o canônico do dicionário de aliases.
 */
function canonicalDoNome(nomeNormalizado: string): string {
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    if (canonical === nomeNormalizado || aliases.includes(nomeNormalizado)) {
      return canonical;
    }
  }
  return nomeNormalizado;
}

/** Tokens iguais em qualquer ordem ("Zuzanek Jiri" × "Jiri Zuzanek") — casas listam sobrenome primeiro sem vírgula. */
function mesmosTokens(a: string, b: string): boolean {
  const ta = a.split(' ').filter(Boolean).sort().join(' ');
  const tb = b.split(' ').filter(Boolean).sort().join(' ');
  return ta.length > 0 && ta === tb;
}

/**
 * Casamento por SOBRENOME + INICIAL ("alcaraz c" × "carlos alcaraz") — formato comum
 * em tênis/tênis de mesa. Exige que TODOS os tokens completos do lado abreviado
 * existam no outro nome, e que cada inicial seja compatível com uma palavra restante.
 * ("Zverev A." × "Mischa Zverev" NÃO casa: a inicial não bate.)
 */
function casaPorIniciais(na: string, nb: string): boolean {
  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const inicA = ta.filter((t) => t.length === 1);
  const inicB = tb.filter((t) => t.length === 1);
  if (inicA.length === 0 && inicB.length === 0) return false;
  if (inicA.length > 0 && inicB.length > 0) return false; // ambos abreviados → decide o exato/JW
  const [curto, longo] = inicA.length > 0 ? [ta, tb] : [tb, ta];
  const completos = curto.filter((t) => t.length > 1);
  if (completos.length === 0) return false;
  if (!completos.every((c) => longo.includes(c))) return false;
  const restantes = longo.filter((t) => !completos.includes(t));
  const iniciais = curto.filter((t) => t.length === 1);
  return iniciais.every((i) => restantes.some((r) => r.startsWith(i)));
}

/**
 * Retorna true se os dois times são considerados o mesmo (similaridade Jaro-Winkler >= 0.75)
 */
export function areTeamsSame(teamA: string, teamB: string, threshold = 0.75): boolean {
  const a = analisarTime(teamA);
  const b = analisarTime(teamB);
  // GUARDAS DURAS: feminino×masculino, categoria de base (Sub-20) e time reserva (B/II)
  // nunca casam com o time principal — mesmo com o resto do nome idêntico.
  if (a.fem !== b.fem || a.sub !== b.sub || a.reserva !== b.reserva) return false;

  const normA = a.nome;
  const normB = b.nome;
  if (!normA || !normB) return false;

  if (normA === normB) return true;
  if (normA.includes(normB) && normB.length > 3) return true;
  if (normB.includes(normA) && normA.length > 3) return true;
  // Mesmos tokens em ordem diferente (sobrenome-primeiro sem vírgula)
  if (mesmosTokens(normA, normB)) return true;

  // Dicionário de aliases (cross-language)
  const canonA = canonicalDoNome(normA);
  const canonB = canonicalDoNome(normB);
  if (canonA === canonB) return true;

  // Sobrenome + inicial ("alcaraz c" × "carlos alcaraz")
  if (casaPorIniciais(normA, normB)) return true;

  // Jaro-Winkler sobre os nomes normalizados e canônicos
  if (jaroWinkler(normA, normB) >= threshold) return true;
  if (jaroWinkler(canonA, canonB) >= threshold) return true;

  return false;
}

/**
 * Separadores de "Time A <sep> Time B" aceitos, do mais seguro para o mais ambíguo.
 * O hífen com espaços vem por último (nomes como "Pen-y-Bont" têm hífen sem espaços).
 */
const SEPARADORES_EVENTO = [' vs. ', ' vs ', ' x ', ' v ', ' @ ', ' – ', ' — ', ' - '];

/** Divide "Time A vs Time B" no primeiro separador reconhecido; remove sufixo "(data)". */
export function splitEvento(evento: string): [string, string] | null {
  const semSufixo = (evento || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const lower = semSufixo.toLowerCase();
  for (const sep of SEPARADORES_EVENTO) {
    const idx = lower.indexOf(sep);
    if (idx > 0) {
      const a = semSufixo.slice(0, idx).trim();
      const b = semSufixo.slice(idx + sep.length).trim();
      if (a && b) return [a, b];
    }
  }
  return null;
}

/**
 * Retorna true se os dois eventos (Time A vs Time B) são o mesmo.
 * Aceita separadores variados ( vs / x / - / – ) e ignora o sufixo de data "(...)".
 */
export function areEventsSame(event1: string, event2: string): boolean {
  const p1 = splitEvento(event1);
  const p2 = splitEvento(event2);
  if (!p1 || !p2) return false;
  const [e1a, e1b] = p1;
  const [e2a, e2b] = p2;

  // A vs B == A vs B
  if (areTeamsSame(e1a, e2a) && areTeamsSame(e1b, e2b)) return true;
  // A vs B == B vs A (casas inverteram a ordem)
  if (areTeamsSame(e1a, e2b) && areTeamsSame(e1b, e2a)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Hardening de precisão: horário de início e força do match (para confiança)
// ---------------------------------------------------------------------------

/**
 * Converte a dataHora de um ScrapedOdd em epoch ms.
 * Aceita ISO ("2026-07-15T10:00:00Z") e formato "AAAA-MM-DD HH:MM:SS" (tratado como UTC,
 * consistente com o que as casas retornam). Retorna null para "Hoje"/"Amanhã"/inválido.
 */
const memoKickoff = new Map<string, number | null>();

export function parseKickoff(dataHora?: string): number | null {
  if (!dataHora || typeof dataHora !== 'string') return null;
  // Memoizado: chamado milhões de vezes por varredura via mesmoHorario (hot path do motor).
  const hit = memoKickoff.get(dataHora);
  if (hit !== undefined) return hit;
  let iso = dataHora.includes('T') ? dataHora.trim() : dataHora.trim().replace(' ', 'T');
  if (!/[Zz]$|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z';
  const t = Date.parse(iso);
  const r = isNaN(t) ? null : t;
  if (memoKickoff.size > 20000) memoKickoff.clear();
  memoKickoff.set(dataHora, r);
  return r;
}

/**
 * True se dois eventos podem ser o mesmo jogo pelo horário.
 * Se algum horário não for parseável ("Hoje"), NÃO bloqueia (retorna true) — a
 * verificação de time decide, e a confiança fica menor. Se ambos são conhecidos,
 * exige início dentro de `tolMin` minutos (defesa contra parear jogos diferentes).
 */
export function mesmoHorario(dh1?: string, dh2?: string, tolMin = 10): boolean {
  const t1 = parseKickoff(dh1);
  const t2 = parseKickoff(dh2);
  if (t1 === null || t2 === null) return true;
  return Math.abs(t1 - t2) <= tolMin * 60000;
}

/** Similaridade [0..1] de um par de times (exato/substring/alias fortes; senão Jaro-Winkler). */
function simTime(a: string, b: string): number {
  const pa = analisarTime(a);
  const pb = analisarTime(b);
  // Guardas duras (mesmas do areTeamsSame): categorias diferentes têm força 0.
  if (pa.fem !== pb.fem || pa.sub !== pb.sub || pa.reserva !== pb.reserva) return 0;
  const na = pa.nome;
  const nb = pb.nome;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if ((na.includes(nb) && nb.length > 3) || (nb.includes(na) && na.length > 3)) return 0.95;
  if (mesmosTokens(na, nb)) return 0.95;
  if (canonicalDoNome(na) === canonicalDoNome(nb)) return 0.9;
  if (casaPorIniciais(na, nb)) return 0.9;
  return jaroWinkler(na, nb);
}

/**
 * Força do casamento de um evento [0..1]: a MENOR similaridade entre os dois times
 * (na melhor orientação). Usado para a confiança — um match onde um dos lados é fraco
 * fica com confiança baixa mesmo que o areEventsSame tenha passado no limiar.
 */
export function forcaMatchEvento(event1: string, event2: string): number {
  const p1 = splitEvento(event1);
  const p2 = splitEvento(event2);
  if (!p1 || !p2) return 0;
  const direta = Math.min(simTime(p1[0], p2[0]), simTime(p1[1], p2[1]));
  const invertida = Math.min(simTime(p1[0], p2[1]), simTime(p1[1], p2[0]));
  return Math.max(direta, invertida);
}
