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
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
             .toLowerCase()
             .replace(/[^a-z0-9 ]/g, '')
             .replace(/\b(fc|clube|club|ec|sp)\b/g, '')
             .trim();
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
  'Polonia': ['poland', 'polska'],
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
  'suicia': ['switzerland'],
  'suissa': ['switzerland'],
  'suico': ['switzerland'],
};

/**
 * Retorna o nome canônico (normalizado) de um time, resolvendo aliases entre idiomas.
 */
function canonicalTeamName(name: string): string {
  const normalized = normalizeTeamName(name);
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    if (canonical === normalized || aliases.includes(normalized)) {
      return canonical;
    }
  }
  return normalized;
}

/**
 * Retorna true se os dois times são considerados o mesmo (similaridade >= 0.8)
 */
export function areTeamsSame(teamA: string, teamB: string, threshold = 0.75): boolean {
  // 1. Normalização básica
  const normA = normalizeTeamName(teamA);
  const normB = normalizeTeamName(teamB);
  
  if (normA === normB) return true;
  if (normA.includes(normB) && normB.length > 3) return true;
  if (normB.includes(normA) && normA.length > 3) return true;
  
  // 2. Tenta resolver via dicionário de aliases (cross-language)
  const canonA = canonicalTeamName(teamA);
  const canonB = canonicalTeamName(teamB);
  if (canonA === canonB) return true;
  
  // 3. Jaro-Winkler sobre os nomes normalizados
  if (jaroWinkler(normA, normB) >= threshold) return true;
  // 4. Jaro-Winkler sobre os nomes canônicos
  if (jaroWinkler(canonA, canonB) >= threshold) return true;

  return false;
}

/**
 * Retorna true se os dois eventos (Time A vs Time B) são o mesmo.
 */
export function areEventsSame(event1: string, event2: string): boolean {
  const [e1a, e1b] = event1.split(' vs ').map(t => t.trim());
  const [e2a, e2b] = event2.split(' vs ').map(t => t.trim());
  
  if (!e1a || !e1b || !e2a || !e2b) return false;
  
  // A vs B == A vs B
  if (areTeamsSame(e1a, e2a) && areTeamsSame(e1b, e2b)) return true;
  // A vs B == B vs A (casa inversas)
  if (areTeamsSame(e1a, e2b) && areTeamsSame(e1b, e2a)) return true;
  
  return false;
}
