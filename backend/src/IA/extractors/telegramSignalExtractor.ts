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
  "dataHora": string|null  // início da partida "DD/MM/AAAA HH:MM" ou "DD/MM HH:MM" como impresso; null se ausente
}
Regras:
- tipo="sinal": print da calculadora (layout descrito no prompt). Preencha todos os campos.
- tipo="print_casa": screenshot do site/app de UMA casa de apostas mostrando o evento/aposta. Preencha casaA (nome da casa), evento e principalmente dataHora (data e horário da partida como exibidos — se só houver horário, use "DD/MM" de hoje implícito e retorne só o que estiver visível no formato pedido); demais campos podem ficar vazios/null. eh_sinal=false.
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

/**
 * Normaliza "DD/MM/AAAA HH:MM" ou "DD/MM HH:MM" (completa o ano corrente).
 * Retorna null quando não parseável — horário desconhecido não bloqueia o
 * gate de pré-jogo (ehPreJogo trata null como "não começou").
 */
export function normalizarDataHora(raw: any): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const dia = +m[1], mes = +m[2], ano = m[3] ? +m[3] : new Date().getFullYear();
  const hora = +m[4], min = +m[5];
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12 || hora > 23 || min > 59) return null;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(dia)}/${p2(mes)}/${ano} ${p2(hora)}:${p2(min)}`;
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

/** Valida/saneia o objeto cru do LLM. Determinístico — exportado p/ testes. */
export function validarSinal(obj: any): { ok: boolean; motivo?: string; sinal?: SinalExtraido } {
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
      dataHora: normalizarDataHora(obj.dataHora),
    },
  };
}

/** Classifica e extrai um sinal de surebet de uma imagem (base64 sem prefixo). */
export async function extrairSinalDeImagem(imageBase64: string, mimeType: string): Promise<ResultadoExtracao> {
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
        dataHora: normalizarDataHora(obj.dataHora),
      },
    };
  }

  if (obj.eh_sinal !== true) {
    return { sinal: null, provider, motivoDescarte: 'nao_e_sinal' };
  }

  const validacao = validarSinal(obj);
  if (!validacao.ok || !validacao.sinal) {
    return { sinal: null, provider, motivoDescarte: `validacao: ${validacao.motivo}` };
  }

  return { sinal: validacao.sinal, provider };
}
