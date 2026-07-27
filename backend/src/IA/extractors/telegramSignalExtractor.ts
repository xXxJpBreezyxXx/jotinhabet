import { generateFromImageWithFallback } from '../aiProvider';
import { extrairJsonDeLLM } from '../jsonUtils';

/**
 * Extrator de sinais de surebet de IMAGENS do grupo do Telegram.
 *
 * UMA chamada de visão classifica (eh_sinal) E extrai os campos — o template
 * do grupo é fixo, então a classificação é trivial para o mesmo modelo que
 * extrai, e uma chamada única corta custo/latência e elimina inconsistência
 * entre etapas. Toda validação pós-parse é determinística (validarSinal),
 * testável sem IA.
 */

export interface SinalExtraido {
  eh_sinal: boolean;
  /** 0-100: legibilidade da imagem / certeza da extração. */
  confianca: number;
  evento: string;   // "Time A x Time B"
  esporte: string;  // "Futebol" | "Tênis" | ...
  mercado: string;  // rótulo como impresso no template (normalizarMercado resolve o canônico depois)
  linha: number | null;
  opcaoA: string;
  opcaoB: string;
  oddA: number;
  oddB: number;
  casaA: string;
  casaB: string;
  /** "DD/MM/AAAA HH:MM" (Brasília) ou null se ilegível/ausente. */
  dataHora: string | null;
}

/** Contexto extraído de um PRINT DE CASA DE APOSTAS (mensagem que segue o
 *  sinal no grupo): é dele que saem data/horário da partida e a confirmação
 *  da casa — o print da calculadora não traz horário. */
export interface ContextoCasa {
  casa: string | null;
  evento: string | null;
  /** "DD/MM/AAAA HH:MM" (Brasília) ou null. */
  dataHora: string | null;
}

export interface ResultadoExtracao {
  sinal: SinalExtraido | null;
  /** Preenchido quando a imagem é um print de casa (tipo='print_casa'). */
  contexto?: ContextoCasa | null;
  provider?: 'gemini' | 'openai';
  motivoDescarte?: string; // 'nao_e_sinal' | 'print_casa' | 'mock_mode' | 'json_invalido' | 'validacao: ...'
}

export const SYSTEM_EXTRACAO = `Você é um extrator de dados de imagens publicadas num grupo brasileiro de sinais de SUREBET (arbitragem esportiva).
O grupo publica DOIS tipos de imagem úteis: (1) o print da CALCULADORA de surebet (o sinal em si, com as duas pernas e odds) e (2) prints das CASAS DE APOSTAS mostrando a aposta/evento em cada casa (enviados logo após o sinal, com o horário da partida).
Responda ESTRITAMENTE com um único objeto JSON, sem texto antes ou depois, no schema:
{
  "tipo": "sinal" | "print_casa" | "outro",
  "eh_sinal": boolean,     // true SOMENTE se tipo="sinal" (print da calculadora com duas apostas opostas em casas diferentes)
  "confianca": number,     // 0-100: quão legível está a imagem e quão certo você está da extração
  "evento": string,        // "Time A x Time B" (nomes como impressos, separador " x ") — também para tipo="print_casa"
  "esporte": string,       // "Futebol", "Tênis", "Basquete", "E-sports", ...
  "mercado": string,       // ex.: "Total de Gols", "Handicap Asiático", "Vencedor"
  "linha": number|null,    // valor da linha (2.5, -1.5...); null para mercados sem linha
  "opcaoA": string,        // rótulo da 1ª perna, ex.: "Mais de 2.5"
  "opcaoB": string,        // rótulo da 2ª perna, ex.: "Menos de 2.5"
  "oddA": number,          // odd decimal da 1ª perna (ponto como separador)
  "oddB": number,          // odd decimal da 2ª perna
  "casaA": string,         // casa de apostas da 1ª perna — em tipo="print_casa" é a ÚNICA casa do print
  "casaB": string,         // casa de apostas da 2ª perna
  "dataHora": string|null  // início da partida COMO IMPRESSO na imagem, copie LITERAL sem converter nem completar: "29/07/2026 21:30", "29/07 21:30", "Hoje 21:30", "Amanhã 16:00", "Ter 19:00", "21h30" ou só "21:30"; null se não aparecer
}
Regras:
- tipo="sinal": print da calculadora (layout descrito no prompt). Preencha todos os campos.
- tipo="print_casa": screenshot do site/app de UMA casa de apostas mostrando o evento/aposta. Preencha casaA, evento e principalmente dataHora (copie a data/hora da partida exatamente como exibida, ex.: "Hoje 21:30" — NÃO invente a parte que não estiver visível); demais campos podem ficar vazios/null. eh_sinal=false.
  · casaA = o nome da casa de apostas DONA do site/app (logo/marca no topo, nome do app). NÃO confunda com fornecedor de dados/estatística ("Opta", "Sportradar", "Betradar", "Genius") nem com nome de liga/campeonato — isso NUNCA é a casa. Se não conseguir identificar a casa com segurança, casaA=null (não chute).
- tipo="outro": meme, print de banca, propaganda, comprovante, tabela de resultados → {"tipo":"outro","eh_sinal":false,"confianca":0}.
- Horários impressos são horário de Brasília — copie como está, NÃO converta.
- Odds em formato decimal com ponto (2,10 na imagem → 2.10).
- NÃO invente valores: campo ilegível → reduza "confianca" proporcionalmente.`;

// Bloco TEMPLATE calibrado com docs/template_telegram_exemplo_{1,2}.jpg:
// prints da CALCULADORA de surebet que o grupo publica. Re-calibrar via
// POST /api/telegram/test-extract (dry-run) se o layout do grupo mudar.
export const PROMPT_EXTRACAO = `Extraia o sinal de surebet desta imagem seguindo o schema do sistema.

TEMPLATE (print da calculadora de surebet do grupo):
- Topo: "Time A – Time B" (separador travessão) → no campo evento converta para "Time A x Time B".
- 2ª linha: "Esporte / País - Campeonato" → o campo esporte é SÓ a primeira parte (ex.: "Futebol").
- 3ª linha: um percentual grande (lucro da arb) e "ROI: N%" — IGNORE os dois, não entram no schema.
- Faixa "Chance": abre a seção das duas pernas, LADO A LADO (coluna esquerda = perna A, direita = perna B). Em cada coluna:
  · Nome da casa em negrito, geralmente com sufixo "(BR)" — copie SEM o sufixo ("Betsson (BR)" → "Betsson").
  · Descrição da seleção, ex.: "Acima 8.5 - escanteios" ou "Abaixo 3.5 - escanteios 1º o time":
    → opcaoA/opcaoB = parte direcional com a linha ("Acima 8.5", "Abaixo 3.5");
    → mercado = derivado do restante ("escanteios" → "Total de Escanteios";
      "escanteios 1º o time" → "Total de Escanteios do 1º Time"; "gols" → "Total de Gols");
    → linha = o número da descrição (8.5, 3.5).
  · Caixa branca logo abaixo com a odd decimal ("2.150" → 2.15).
- Seções "Aposta"/"BRL"/"Lucro"/"Taxas de câmbio": valores da calculadora — IGNORE.
- Este template NÃO mostra data/hora da partida → dataHora: null (só preencha se alguma variação trouxer).

Se a imagem NÃO for a calculadora, mas sim um print do site/app de UMA casa de apostas
mostrando o evento/aposta (o grupo envia esses prints logo após o sinal), use
tipo="print_casa" e priorize extrair a casa (casaA), o evento e o dataHora da partida.

Responda só o JSON.`;

/** Piso de confiança da extração (0-100) — abaixo disso o sinal é descartado. */
function minConfianca(): number {
  const v = Number(process.env.TELEGRAM_MIN_CONFIANCA);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 70;
}

/** Componentes de uma data no fuso de Brasília (UTC-3 constante — Brasil sem
 *  horário de verão desde 2019; mesma premissa do scanner_v2). */
function diaEmBrasilia(instante: Date, maisDias = 0): { dia: number; mes: number; ano: number; dow: number } {
  const d = new Date(instante.getTime() - 3 * 60 * 60 * 1000 + maisDias * 24 * 60 * 60 * 1000);
  return { dia: d.getUTCDate(), mes: d.getUTCMonth() + 1, ano: d.getUTCFullYear(), dow: d.getUTCDay() };
}

/** Índice 0=domingo…6=sábado de um token de dia da semana pt-BR; null se não for. */
function indiceDiaSemana(token: string): number | null {
  const t = token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tabela = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const i = tabela.indexOf(t.slice(0, 3));
  return i >= 0 ? i : null;
}

/**
 * Normaliza a data/hora COMO IMPRESSA num print de casa/calculadora para
 * "DD/MM/AAAA HH:MM". Além do formato numérico ("DD/MM[/AAAA] HH:MM"), aceita
 * os formatos relativos que as casas realmente exibem — "Hoje 21:30",
 * "Amanhã 16:00", "Ter 19:00", "Sáb, 26/07 18:00", "21h30" ou só "21:30" —
 * ancorados em `ref` (a data da MENSAGEM do Telegram; default: agora). Antes
 * esses formatos eram descartados e o sinal seguia sem horário.
 * Retorna null quando não parseável — horário desconhecido não bloqueia o
 * gate de pré-jogo (ehPreJogo trata null como "não começou").
 */
export function normalizarDataHora(raw: any, ref: Date = new Date()): string | null {
  if (typeof raw !== 'string') return null;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const montar = (dia: number, mes: number, ano: number, hora: number, min: number): string | null => {
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12 || hora > 23 || min > 59) return null;
    return `${p2(dia)}/${p2(mes)}/${ano} ${p2(hora)}:${p2(min)}`;
  };

  // Limpeza leve: "às"/vírgulas e espaço múltiplo não carregam informação.
  // (não usa \b antes de "às": o \b do JS é ASCII e falha antes de acento)
  let s = raw.trim().replace(/(^|\s)[àa]s(?=\s)/gi, '$1').replace(/[,•·]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // Hora "21h30"/"21h" → "21:30"/"21:00" (grafia comum nas casas brasileiras).
  s = s.replace(/\b(\d{1,2})h(\d{2})?\b/gi, (_, h, m) => `${h}:${m || '00'}`);

  const HORA = /(\d{1,2}):(\d{2})/;

  // Dia da semana no começo ("Sáb 26/07 18:00" / "ter 19:00") — guarda e remove.
  let dowPrefixo: number | null = null;
  const mDow = s.match(/^([A-Za-zÀ-ÿ]{3,13})(?:-feira)?\.?\s+/i);
  if (mDow) {
    const idx = indiceDiaSemana(mDow[1]);
    if (idx !== null) {
      dowPrefixo = idx;
      s = s.slice(mDow[0].length).trim();
    }
  }

  // 1) Formato numérico completo: "DD/MM[/AAAA] HH:MM".
  const mNum = s.match(new RegExp(`^(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{4}))?\\s+${HORA.source}$`));
  if (mNum) {
    const ano = mNum[3] ? +mNum[3] : diaEmBrasilia(ref).ano;
    return montar(+mNum[1], +mNum[2], ano, +mNum[4], +mNum[5]);
  }

  // 2) "Hoje HH:MM" / "Amanhã HH:MM" (ancorado na data da mensagem).
  const mRel = s.match(new RegExp(`^(hoje|amanh[ãa])\\s+${HORA.source}$`, 'i'));
  if (mRel) {
    const d = diaEmBrasilia(ref, /^hoje$/i.test(mRel[1]) ? 0 : 1);
    return montar(d.dia, d.mes, d.ano, +mRel[2], +mRel[3]);
  }

  // 3) Só o horário "HH:MM" — com prefixo de dia da semana usa a PRÓXIMA
  //    ocorrência daquele dia (hoje conta); sem prefixo assume o dia da mensagem.
  const mHora = s.match(new RegExp(`^${HORA.source}$`));
  if (mHora) {
    let maisDias = 0;
    if (dowPrefixo !== null) {
      const hoje = diaEmBrasilia(ref);
      maisDias = (dowPrefixo - hoje.dow + 7) % 7;
    }
    const d = diaEmBrasilia(ref, maisDias);
    return montar(d.dia, d.mes, d.ano, +mHora[1], +mHora[2]);
  }

  return null;
}

/** Deriva a linha de um rótulo de opção quando ele a carrega explicitamente
 *  (mesma lógica conservadora de linhaDaOpcao do revalidationService — regex
 *  genérico pegaria número de nome de time, ex.: "Philadelphia 76ers"). */
function linhaDoRotulo(s: string): number | null {
  const emb = (s || '').match(/\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
  if (emb) return Math.abs(parseFloat(emb[1]));
  const m = (s || '').match(/\b(?:mais de|menos de|over|under|acima de|abaixo de)\s+([+-]?\d+(?:\.\d+)?)/i);
  return m ? Math.abs(parseFloat(m[1])) : null;
}

/** Valida/saneia o objeto cru do LLM. Determinístico — exportado p/ testes.
 *  `ref` ancora datas relativas ("Hoje 21:30") na data da mensagem do Telegram. */
export function validarSinal(obj: any, ref?: Date): { ok: boolean; motivo?: string; sinal?: SinalExtraido } {
  if (!obj || typeof obj !== 'object') return { ok: false, motivo: 'objeto ausente' };

  const camposTexto = ['evento', 'esporte', 'mercado', 'opcaoA', 'opcaoB', 'casaA', 'casaB'] as const;
  for (const campo of camposTexto) {
    if (typeof obj[campo] !== 'string' || !obj[campo].trim()) {
      return { ok: false, motivo: `campo obrigatório vazio: ${campo}` };
    }
  }

  const oddA = Number(obj.oddA);
  const oddB = Number(obj.oddB);
  if (!Number.isFinite(oddA) || !Number.isFinite(oddB) || oddA <= 1 || oddB <= 1) {
    return { ok: false, motivo: `odds inválidas (oddA=${obj.oddA}, oddB=${obj.oddB})` };
  }
  if (oddA >= 100 || oddB >= 100) {
    return { ok: false, motivo: `odd fora de sanidade (oddA=${oddA}, oddB=${oddB})` };
  }

  // Sem break-even não é surebet; ROI alto demais é quase certamente erro de
  // leitura da imagem (coerente com LIMITE_ERRO_PALPAVEL do riskAnalyzer).
  const totalPerc = 1 / oddA + 1 / oddB;
  if (totalPerc >= 1) {
    return { ok: false, motivo: `não é surebet (1/oddA + 1/oddB = ${totalPerc.toFixed(4)} >= 1)` };
  }
  const roi = (1 / totalPerc - 1) * 100;
  if (roi > 25) {
    return { ok: false, motivo: `ROI ${roi.toFixed(1)}% > 25% — provável erro de OCR` };
  }

  let confianca = Number(obj.confianca);
  if (!Number.isFinite(confianca)) confianca = 0;
  confianca = Math.max(0, Math.min(100, Math.round(confianca)));
  if (confianca < minConfianca()) {
    return { ok: false, motivo: `confiança ${confianca} abaixo do piso ${minConfianca()}` };
  }

  let linha: number | null = Number.isFinite(Number(obj.linha)) && obj.linha !== null && obj.linha !== ''
    ? Number(obj.linha)
    : null;
  if (linha === null) {
    linha = linhaDoRotulo(obj.opcaoA) ?? linhaDoRotulo(obj.opcaoB);
  }

  return {
    ok: true,
    sinal: {
      eh_sinal: true,
      confianca,
      evento: obj.evento.trim(),
      esporte: obj.esporte.trim(),
      mercado: obj.mercado.trim(),
      linha,
      opcaoA: obj.opcaoA.trim(),
      opcaoB: obj.opcaoB.trim(),
      oddA,
      oddB,
      casaA: obj.casaA.trim(),
      casaB: obj.casaB.trim(),
      dataHora: normalizarDataHora(obj.dataHora, ref),
    },
  };
}

/** Classifica e extrai um sinal de surebet de uma imagem (base64 sem prefixo).
 *  `ref` = data da mensagem no Telegram — âncora de "Hoje 21:30"/"21:30" nos prints. */
export async function extrairSinalDeImagem(imageBase64: string, mimeType: string, ref?: Date): Promise<ResultadoExtracao> {
  const { text, provider } = await generateFromImageWithFallback(
    PROMPT_EXTRACAO,
    { mimeType, dataBase64: imageBase64 },
    SYSTEM_EXTRACAO
  );

  // Chaves de IA ausentes → provider em mock: fonte desligada, sem erro.
  if (text.startsWith('[Mock')) {
    return { sinal: null, provider, motivoDescarte: 'mock_mode' };
  }

  const obj = extrairJsonDeLLM(text);
  if (obj === null) {
    return { sinal: null, provider, motivoDescarte: 'json_invalido' };
  }

  // Print de casa de apostas: não é um sinal, mas carrega o CONTEXTO do sinal
  // anterior (data/horário da partida) — o ingest correlaciona.
  if (obj.tipo === 'print_casa') {
    return {
      sinal: null,
      provider,
      motivoDescarte: 'print_casa',
      contexto: {
        casa: typeof obj.casaA === 'string' && obj.casaA.trim() ? obj.casaA.trim() : null,
        evento: typeof obj.evento === 'string' && obj.evento.trim() ? obj.evento.trim() : null,
        dataHora: normalizarDataHora(obj.dataHora, ref),
      },
    };
  }

  if (obj.eh_sinal !== true) {
    return { sinal: null, provider, motivoDescarte: 'nao_e_sinal' };
  }

  const validacao = validarSinal(obj, ref);
  if (!validacao.ok || !validacao.sinal) {
    return { sinal: null, provider, motivoDescarte: `validacao: ${validacao.motivo}` };
  }

  return { sinal: validacao.sinal, provider };
}
