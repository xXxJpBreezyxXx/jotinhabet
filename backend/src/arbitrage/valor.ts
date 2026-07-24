/**
 * Motor de VALOR (+EV) por linha de referência SHARP.
 *
 * Diferente da arbitragem pura (que exige totalPerc < 1 entre duas casas), o valor
 * mede o EDGE de uma odd de casa SOFT contra a "justa" (probabilidade real) estimada
 * a partir de uma casa afiada — a Pinnacle, no nosso caso. A Pinnacle tem margem baixa
 * e é reconhecida como o mercado mais eficiente; removendo a margem (de-vig) da linha
 * dela, sobra a melhor estimativa pública da probabilidade real do resultado. Se uma
 * casa soft paga acima da odd justa, a aposta tem valor esperado positivo.
 *
 * Este módulo é PURO (sem I/O): recebe odds já alinhadas (mesmo resultado no lado A e
 * no lado B) e devolve as contas. O alinhamento evento/mercado/seleção é do chamador
 * (reusa o matcher/markets), igual ao engine de arbitragem.
 *
 * DE-VIG: método PROPORCIONAL (multiplicativo) — divide cada probabilidade implícita
 * pelo overround. É o padrão de mercado para linhas 2-vias afiadas e o mais simples;
 * dá para trocar por Shin (corrige viés favorito-azarão) sem mexer nos chamadores, só
 * neste arquivo. Mantido proporcional no MVP.
 */

import { ScrapedOdd } from '../scraping/scraper_base';
import { areTeamsSame, areEventsSame, mesmoHorario, forcaMatchEvento } from './matcher';
import { normalizarMercado, mesmaOferta } from './markets';
import { mercadoPermitido, regraPermiteOportunidade } from './regras';

/** Probabilidade implícita de uma odd decimal (com a margem embutida). */
export function probImplicita(odd: number): number {
  return 1 / odd;
}

export interface JustaSemVig {
  probA: number;      // probabilidade real estimada do lado A [0..1]
  probB: number;      // probabilidade real estimada do lado B [0..1]
  fairOddA: number;   // odd justa do lado A (1/probA)
  fairOddB: number;   // odd justa do lado B (1/probB)
  overround: number;  // soma das probabilidades implícitas da referência (>1 = margem da casa)
}

/**
 * Remove a margem (de-vig proporcional) de um mercado 2-vias da casa de referência e
 * devolve as probabilidades e odds justas. Retorna null se as odds forem inválidas.
 *
 * overround < 1 significaria que a PRÓPRIA referência é uma arbitragem (raro; erro de
 * cotação) — ainda assim as contas fecham, mas o chamador deveria desconfiar.
 */
export function justaSemVig2Vias(oddRefA: number, oddRefB: number): JustaSemVig | null {
  if (!(oddRefA > 1) || !(oddRefB > 1)) return null;
  const pa = probImplicita(oddRefA);
  const pb = probImplicita(oddRefB);
  const overround = pa + pb;
  if (!(overround > 0)) return null;
  const probA = pa / overround;
  const probB = pb / overround;
  return {
    probA,
    probB,
    fairOddA: 1 / probA,
    fairOddB: 1 / probB,
    overround,
  };
}

/**
 * Edge de valor (%) de apostar numa odd SOFT dado a probabilidade real (justa).
 * EV por unidade apostada = oddSoft·probReal − 1. Positivo = valor esperado positivo.
 * Ex.: justa 2.00 (prob 0.5), soft paga 2.10 → 2.10·0.5 − 1 = +5%.
 */
export function edgeValorPct(oddSoft: number, probReal: number): number {
  if (!(oddSoft > 1) || !(probReal > 0)) return -Infinity;
  return (oddSoft * probReal - 1) * 100;
}

export interface AchadoValor {
  lado: 'A' | 'B';
  oddSoft: number;
  fairOdd: number;
  probReal: number;
  edgePct: number;
}

/**
 * Detecta valor (+EV) nos dois lados de um mercado 2-vias, comparando as odds de uma
 * casa SOFT (já alinhadas ao lado A/B da referência) contra a justa sem-vig da
 * referência SHARP. Só devolve os lados com edge >= `minEdgePct`.
 *
 * @param ref     odds da casa afiada (Pinnacle): { oddA, oddB } do MESMO mercado/seleção.
 * @param soft    odds da casa alvo, já alinhadas: softOddA ↔ lado A da ref, idem B.
 * @param minEdgePct piso de edge para reportar (ex.: 2 = 2%).
 * @param maxEdgePct teto de sanidade: edge absurdo indica linha travada/erro, não valor
 *   (mesma doutrina do ROI alto na arbitragem). Acima disso, descarta. Default 20%.
 */
export function detectarValor2Vias(
  ref: { oddA: number; oddB: number },
  soft: { oddA: number; oddB: number },
  minEdgePct: number,
  maxEdgePct = 20
): AchadoValor[] {
  const justa = justaSemVig2Vias(ref.oddA, ref.oddB);
  if (!justa) return [];
  const achados: AchadoValor[] = [];
  const avaliar = (lado: 'A' | 'B', oddSoft: number, probReal: number, fairOdd: number) => {
    if (!(oddSoft > 1)) return;
    const edgePct = edgeValorPct(oddSoft, probReal);
    if (edgePct >= minEdgePct && edgePct <= maxEdgePct) {
      achados.push({ lado, oddSoft, fairOdd, probReal, edgePct: Number(edgePct.toFixed(2)) });
    }
  };
  avaliar('A', soft.oddA, justa.probA, justa.fairOddA);
  avaliar('B', soft.oddB, justa.probB, justa.fairOddB);
  return achados;
}

// ---------------------------------------------------------------------------
// Detecção de valor sobre um SNAPSHOT de várias casas (usa a Pinnacle como
// referência sharp). Isolado do motor de arbitragem de propósito: o método de
// cluster do arb não tem teste unitário e não deve ser refatorado por tabela.
// ---------------------------------------------------------------------------

export interface OportunidadeValor {
  evento: string;
  mercado: string;
  esporte?: string;
  linha?: number;
  dataHora?: string;
  casa: string;        // casa SOFT onde está o valor
  opcao: string;       // seleção com valor (rótulo da casa soft)
  oddCasa: number;     // odd da casa soft
  fairOdd: number;     // odd justa (de-vig da referência)
  probReal: number;    // probabilidade real estimada [0..1]
  edgePct: number;     // edge de EV (%)
  referencia: string;  // nome da casa de referência (ex.: Pinnacle)
  oddRefA: number;     // odds da referência (lado A/B do mercado) — auditoria
  oddRefB: number;
  confianca: number;   // 0..1 — força do casamento de times (mesma ideia do arb)
}

const normNome = (s?: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Linha COM SINAL embutida no rótulo ("Time A (-1.5)"), ou null. Igual ao motor de arb. */
function linhaDoRotulo(s: string): number | null {
  const m = (s || '').match(/\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

/** Chave de bucket idêntica ao corte de mesmaOferta (canônico≠DESCONHECIDO → canônico; senão rótulo cru). */
function chaveBucket(esporte: string | undefined, mercado: string, linha: number | null | undefined): string {
  const canon = normalizarMercado(mercado);
  const m = canon === 'DESCONHECIDO' ? `D|${(mercado || '').trim().toLowerCase()}` : canon;
  return `${normNome(esporte)}|${m}|${linha ?? '∅'}`;
}

/**
 * Alinha a oferta SOFT à oferta de REFERÊNCIA: retorna { swap } se as seleções batem
 * (direto ou invertido) E o sinal do handicap confere (sign-aware, mesma lição do arb —
 * a oferta espelhada "-1.5"/"+1.5" NÃO é a mesma). null se não é a mesma oferta.
 */
function alinhar(ref: ScrapedOdd, soft: ScrapedOdd): { swap: boolean } | null {
  const direto = areTeamsSame(soft.opcaoA, ref.opcaoA) && areTeamsSame(soft.opcaoB, ref.opcaoB);
  const inverso = areTeamsSame(soft.opcaoA, ref.opcaoB) && areTeamsSame(soft.opcaoB, ref.opcaoA);
  if (!direto && !inverso) return null;
  const swap = !direto && inverso;
  const rotSoftA = swap ? soft.opcaoB : soft.opcaoA; // rótulo soft que corresponde ao lado A da ref
  const sinalRef = linhaDoRotulo(ref.opcaoA);
  const sinalSoft = linhaDoRotulo(rotSoftA);
  if (sinalRef !== null && sinalSoft !== null && Math.abs(sinalRef - sinalSoft) > 1e-9) return null;
  return { swap };
}

/**
 * Varre um snapshot multi-casa e devolve as apostas de VALOR (+EV) das casas soft
 * contra a justa sem-vig da casa de referência (Pinnacle). Radar-only: NÃO decide
 * alerta, só detecta. Bucketing por (esporte|mercado|linha) mantém a varredura
 * near-linear (não o O(n²) todos-contra-todos que derrubou a VPS).
 *
 * @param opts.referencia  nome da casa sharp (default 'Pinnacle').
 * @param opts.minEdgePct  piso de edge para reportar (default 2).
 * @param opts.maxEdgePct  teto de sanidade (default 20) — acima disso é linha travada/erro.
 */
export function encontrarValor(
  fontes: Array<{ nome: string; odds: ScrapedOdd[] }>,
  opts: { referencia?: string; minEdgePct?: number; maxEdgePct?: number } = {}
): OportunidadeValor[] {
  const nomeRef = opts.referencia || 'Pinnacle';
  const minEdgePct = opts.minEdgePct ?? 2;
  const maxEdgePct = opts.maxEdgePct ?? 20;

  const fonteRef = fontes.find((f) => normNome(f.nome) === normNome(nomeRef));
  if (!fonteRef || fonteRef.odds.length === 0) return [];

  // Indexa as ofertas SOFT (todas menos a referência) por bucket p/ busca dirigida.
  const buckets = new Map<string, Array<{ casa: string; odd: ScrapedOdd }>>();
  for (const f of fontes) {
    if (normNome(f.nome) === normNome(nomeRef)) continue;
    for (const o of f.odds) {
      if (!(o.oddA > 1) || !(o.oddB > 1)) continue;
      const chave = chaveBucket(o.esporte, o.mercado, o.linha);
      const arr = buckets.get(chave) || [];
      arr.push({ casa: f.nome, odd: o });
      buckets.set(chave, arr);
    }
  }

  const achados: OportunidadeValor[] = [];
  for (const refOdd of fonteRef.odds) {
    if (!(refOdd.oddA > 1) || !(refOdd.oddB > 1)) continue;
    if (!mercadoPermitido(refOdd.esporte, refOdd.mercado)) continue; // doutrina de mercado (ex.: futebol 1X2)
    const justa = justaSemVig2Vias(refOdd.oddA, refOdd.oddB);
    if (!justa) continue;

    const bucket = buckets.get(chaveBucket(refOdd.esporte, refOdd.mercado, refOdd.linha));
    if (!bucket) continue;

    for (const { casa, odd: soft } of bucket) {
      if (!mesmaOferta(refOdd.mercado, refOdd.linha, soft.mercado, soft.linha)) continue;
      if (!mesmoHorario(refOdd.dataHora, soft.dataHora)) continue;
      if (!areEventsSame(refOdd.evento, soft.evento)) continue;
      const al = alinhar(refOdd, soft);
      if (!al) continue;

      // Odds/rótulos da soft alinhados ao lado A/B da referência.
      const softOddA = al.swap ? soft.oddB : soft.oddA;
      const softOddB = al.swap ? soft.oddA : soft.oddB;
      const softLabelA = al.swap ? soft.opcaoB : soft.opcaoA;
      const softLabelB = al.swap ? soft.opcaoA : soft.opcaoB;

      const confianca = Number(forcaMatchEvento(refOdd.evento, soft.evento).toFixed(2));

      const lados: Array<{ odd: number; label: string; prob: number; fair: number }> = [
        { odd: softOddA, label: softLabelA, prob: justa.probA, fair: justa.fairOddA },
        { odd: softOddB, label: softLabelB, prob: justa.probB, fair: justa.fairOddB },
      ];
      for (const l of lados) {
        const edgePct = edgeValorPct(l.odd, l.prob);
        if (edgePct >= minEdgePct && edgePct <= maxEdgePct) {
          achados.push({
            evento: soft.evento,
            mercado: soft.mercado,
            esporte: soft.esporte,
            linha: soft.linha,
            dataHora: soft.dataHora,
            casa,
            opcao: l.label,
            oddCasa: l.odd,
            fairOdd: Number(l.fair.toFixed(3)),
            probReal: Number(l.prob.toFixed(4)),
            edgePct: Number(edgePct.toFixed(2)),
            referencia: fonteRef.nome,
            oddRefA: refOdd.oddA,
            oddRefB: refOdd.oddB,
            confianca,
          });
        }
      }
    }
  }

  // Maior edge primeiro (o teto de alertas/UI pega os melhores).
  return achados.sort((a, b) => b.edgePct - a.edgePct);
}

// ---------------------------------------------------------------------------
// MIDDLES (totais over/under com linhas DIFERENTES). Ex.: Over 2.5 numa casa +
// Under 3.5 em outra → se o total fechar em 3, ganha as DUAS pernas. O motor de
// arbitragem NÃO pega isto (exige linha idêntica via mesmaOferta), então é ganho
// genuíno. É aposta de 2 casas / 2 pernas → herda TODAS as Diretrizes de risco
// (regraPermiteOportunidade: futebol 1X2, grupos de W.O. do tênis, KTO...).
// ---------------------------------------------------------------------------

export interface Middle {
  evento: string;
  esporte?: string;
  mercado: string;         // rótulo do over (referência do par)
  dataHora?: string;
  overCasa: string; overOdd: number; overLinha: number;
  underCasa: string; underOdd: number; underLinha: number;
  janela: [number, number];   // (overLinha, underLinha): total ESTRITO no meio ganha os dois
  largura: number;            // underLinha - overLinha (mais largo = middle mais provável)
  piorCasoRoiPct: number;     // >=0: arb garantido + upside do middle; <0: custo se o meio não bater
}

/** Direção over/under de um rótulo de total, ou null quando não é total. */
function direcaoTotal(s: string): 'over' | 'under' | null {
  const n = (s || '').trim().toLowerCase();
  if (/^(mais de|over|acima)/.test(n)) return 'over';
  if (/^(menos de|under|abaixo)/.test(n)) return 'under';
  return null;
}

/**
 * Detecta MIDDLES em mercados de total (canon TOTAIS_*) entre casas. Agrupa por
 * (esporte|assunto+período) IGNORANDO a linha (a linha é justamente o que difere),
 * casa por evento+horário, e cruza cada OVER de linha L1 com cada UNDER de linha
 * L2 > L1 em casa diferente. Reporta os pares cujo custo no pior caso é aceitável.
 *
 * @param opts.maxCustoPct  perda máxima tolerada se o middle NÃO bater (default 10%).
 */
export function encontrarMiddles(
  fontes: Array<{ nome: string; odds: ScrapedOdd[] }>,
  opts: { maxCustoPct?: number } = {}
): Middle[] {
  const maxCusto = opts.maxCustoPct ?? 10;

  interface Oferta { casa: string; odd: ScrapedOdd; }
  interface Cluster { evento: string; dataHora?: string; esporte?: string; mercado: string; ofertas: Oferta[]; }
  const buckets = new Map<string, Cluster[]>();

  for (const f of fontes) {
    for (const o of f.odds) {
      const canon = normalizarMercado(o.mercado);
      if (!canon.startsWith('TOTAIS')) continue;          // só totais over/under
      if (!(o.oddA > 1) || !(o.oddB > 1)) continue;
      if (o.linha == null || !isFinite(o.linha)) continue;
      const chave = `${normNome(o.esporte)}|${canon}`;     // SEM a linha
      const lista = buckets.get(chave) || [];
      let c = lista.find((cl) => mesmoHorario(cl.dataHora, o.dataHora) && areEventsSame(cl.evento, o.evento));
      if (!c) {
        c = { evento: o.evento, dataHora: o.dataHora, esporte: o.esporte, mercado: o.mercado, ofertas: [] };
        lista.push(c);
        buckets.set(chave, lista);
      }
      c.ofertas.push({ casa: f.nome, odd: o });
    }
  }

  const middles: Middle[] = [];
  const vistos = new Set<string>();
  for (const lista of buckets.values()) {
    for (const c of lista) {
      // Cada oferta tem Over e Under NA MESMA linha; separo os dois lados.
      const overs: Array<{ casa: string; linha: number; odd: number }> = [];
      const unders: Array<{ casa: string; linha: number; odd: number }> = [];
      for (const { casa, odd } of c.ofertas) {
        const dirA = direcaoTotal(odd.opcaoA);
        const overOdd = dirA === 'under' ? odd.oddB : odd.oddA;
        const underOdd = dirA === 'under' ? odd.oddA : odd.oddB;
        overs.push({ casa, linha: odd.linha as number, odd: overOdd });
        unders.push({ casa, linha: odd.linha as number, odd: underOdd });
      }
      for (const ov of overs) {
        for (const un of unders) {
          if (un.linha <= ov.linha) continue;      // sem janela → não é middle
          if (un.casa === ov.casa) continue;        // exige 2 casas (como o arb)
          const totalPerc = 1 / ov.odd + 1 / un.odd;
          const piorCasoRoiPct = (1 / totalPerc - 1) * 100;
          if (piorCasoRoiPct < -maxCusto) continue; // custo no pior caso alto demais
          // Diretrizes de risco (2 casas, 2 pernas): futebol 1X2 não se aplica a totais,
          // mas tênis W.O./KTO sim — reusa a mesma guarda do arb.
          if (!regraPermiteOportunidade({ esporte: c.esporte, mercado: c.mercado, casaA: ov.casa, casaB: un.casa }).ok) continue;

          const sig = `${normNome(c.evento)}|${normNome(ov.casa)}|${ov.linha}|${normNome(un.casa)}|${un.linha}`;
          if (vistos.has(sig)) continue;
          vistos.add(sig);
          middles.push({
            evento: c.evento,
            esporte: c.esporte,
            mercado: c.mercado,
            dataHora: c.dataHora,
            overCasa: ov.casa, overOdd: ov.odd, overLinha: ov.linha,
            underCasa: un.casa, underOdd: un.odd, underLinha: un.linha,
            janela: [ov.linha, un.linha],
            largura: Number((un.linha - ov.linha).toFixed(2)),
            piorCasoRoiPct: Number(piorCasoRoiPct.toFixed(2)),
          });
        }
      }
    }
  }

  // Melhores primeiro: menor custo/maior lucro garantido, depois janela mais larga.
  return middles.sort((a, b) => b.piorCasoRoiPct - a.piorCasoRoiPct || b.largura - a.largura);
}
