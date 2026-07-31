/**
 * Comparador de ofertas entre casas para as skills do Agente.
 *
 * O motor (arbitrage/engine.ts) só EMITE o que fecha surebet — perfeito para alertar,
 * insuficiente para responder "onde está a melhor odd desse mercado?" ou "quanto falta
 * pra virar arbitragem?". Este módulo agrupa as mesmas ofertas com as MESMAS regras do
 * motor (mercado canônico + linha + alinhamento SIGN-AWARE de handicap) e devolve a
 * tabela completa, com ou sem arbitragem.
 *
 * Reusa os mesmos utilitários do motor de propósito: se o pareamento mudar lá, muda
 * aqui — nada de segunda implementação de matching para desincronizar.
 */

import { ScrapedOdd } from '../../scraping/scraper_base';
import { areEventsSame, areTeamsSame, jaroWinkler, mesmoHorario } from '../../arbitrage/matcher';
import { mesmaOferta, normalizarMercado, ehLinhaQuarter } from '../../arbitrage/markets';
import { oddEfetiva } from '../../arbitrage/comissao';
import { regraPermiteOportunidade } from '../../arbitrage/regras';

export interface FonteOdds {
  nome: string;
  odds: ScrapedOdd[];
}

export interface OfertaDaCasa {
  casa: string;
  oddA: number;
  oddB: number;
  /** Odd já com comissão de exchange descontada (só difere em exchange). */
  oddAEfetiva: number;
  oddBEfetiva: number;
}

export interface MercadoComparado {
  esporte: string | null;
  evento: string;
  mercado: string;
  linha: number | null;
  opcaoA: string;
  opcaoB: string;
  dataHora: string | null;
  casas: OfertaDaCasa[];
  melhorA: { casa: string; odd: number };
  melhorB: { casa: string; odd: number };
  /** 1/oddA + 1/oddB do MELHOR PAR entre casas distintas (odds efetivas). < 1 = surebet. */
  somaProb: number;
  /** Margem garantida em % — MESMA base do motor/radar: (1 − soma)·100 (piso em quarter). */
  roiPct: number | null;
  /** Lucro sobre o investido em % ((1/soma − 1)·100, piso em quarter) — base do calculator. */
  lucroSobreInvestidoPct: number | null;
  /** Quanto falta subir na melhor odd para fechar surebet (em %), quando não fecha. */
  faltaPct: number | null;
  /** true = só UMA casa tem esse mercado; não existe arbitragem possível (roi/falta = null). */
  umaCasaSo: boolean;
  /** Bloqueio das Diretrizes (mercado proibido, grupo de W.O. incompatível). */
  bloqueio: string | null;
  quarter: boolean;
}

const linhaDoRotulo = (s: string): number | null => {
  const m = (s || '').match(/\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
  return m ? parseFloat(m[1]) : null;
};

const normEsp = (s?: string) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Rótulo de opção normalizado para comparar orientação (sem acento/pontuação). */
const rotulo = (s?: string) => normEsp(s).replace(/[^a-z0-9.+-]/g, '');

/**
 * Tipo de seleção embutido no rótulo. Existe para separar RECORTES do mesmo mercado
 * canônico: no futebol os parsers emitem "Flamengo vence"/"Palmeiras ou empate" E
 * "Palmeiras vence"/"Flamengo ou empate" com o MESMO mercado normalizado. Como os dois
 * rótulos de um time compartilham o nome dele, a similaridade textual acha que
 * "Palmeiras vence" e "Palmeiras ou empate" são a mesma seleção — e a odd de um lado
 * era publicada como odd do outro. Comparar o TIPO resolve: 'simples' ≠ 'dupla'.
 */
/**
 * NÚCLEO do rótulo: o que sobra depois de remover o modificador ("Vitória", "ou Empate",
 * "Mais de", "Empate Anula"...). É o que identifica o LADO da oferta.
 *
 * Necessário porque comparar o rótulo inteiro engana: `areTeamsSame('Vitória Vasco',
 * 'Vitória Flamengo')` é TRUE (jaroWinkler 0,88 por causa do "Vitória" comum), então a
 * odd do Vasco entrava como odd do Flamengo. Comparando núcleo ("vasco" × "flamengo") o
 * par é rejeitado; e como "Vitória Vasco" e "Vasco ou Empate" têm o MESMO núcleo, é o
 * tipoSelecao (simples × dupla) que separa os dois recortes.
 */
const nucleoRotulo = (s?: string): string => {
  const base = rotulo(s)
    .replace(/^vitoria|^vencedor|^vencedora|^ganhador|vence$/g, '')
    .replace(/ouempate|empateou|duplachance|doublechance|empateanula|drawnobet|dnb/g, '')
    .replace(/^maisde|^menosde|^acima|^abaixo|^over|^under|^total/g, '');
  return base || rotulo(s);
};

type TipoSelecao = 'dupla' | 'over' | 'under' | 'sim' | 'nao' | 'simples';
function tipoSelecao(rotuloBruto?: string): TipoSelecao {
  const s = normEsp(rotuloBruto);
  if (/(\bou\b)|dupla chance|double chance|empate anula|draw no bet/.test(s)) return 'dupla';
  if (/mais de|acima|\bover\b/.test(s)) return 'over';
  if (/menos de|abaixo|\bunder\b/.test(s)) return 'under';
  if (/^sim\b|\bsim$|^yes\b/.test(s)) return 'sim';
  if (/^n[ao]o\b|\bn[ao]o$|^no\b/.test(s)) return 'nao';
  return 'simples';
}

/**
 * Agrupa as ofertas de N casas por (esporte | mercado canônico | linha), alinhando os
 * lados A/B e escolhendo a melhor odd de cada lado EM CASAS DIFERENTES.
 */
export function compararOfertas(fontes: FonteOdds[], filtroMercado?: string): MercadoComparado[] {
  interface Cluster {
    esporte?: string;
    evento: string;
    mercado: string;
    linha: number | null;
    labelA: string;
    labelB: string;
    dataHora?: string;
    ofertas: OfertaDaCasa[];
  }

  const buckets = new Map<string, Cluster[]>();
  const chaveBucket = (esporte: string | undefined, mercado: string, linha: number | null) => {
    const canon = normalizarMercado(mercado);
    const m = canon === 'DESCONHECIDO' ? `D|${(mercado || '').trim().toLowerCase()}` : canon;
    return `${normEsp(esporte)}|${m}|${linha ?? '∅'}`;
  };

  const alvoMercado = (filtroMercado || '').trim().toLowerCase();

  for (const fonte of fontes) {
    for (const o of fonte.odds || []) {
      if (!(o.oddA > 1) || !(o.oddB > 1)) continue;
      if (alvoMercado) {
        const canonAlvo = normalizarMercado(alvoMercado);
        const casaMercado = normalizarMercado(o.mercado);
        const bateCanon = canonAlvo !== 'DESCONHECIDO' && canonAlvo === casaMercado;
        const bateTexto = (o.mercado || '').toLowerCase().includes(alvoMercado);
        if (!bateCanon && !bateTexto) continue;
      }
      const linha = o.linha ?? null;
      const chave = chaveBucket(o.esporte, o.mercado, linha);
      const lista = buckets.get(chave) || [];

      let alvo: Cluster | null = null;
      let swap = false;
      for (const cl of lista) {
        if (!mesmaOferta(cl.mercado, cl.linha, o.mercado, linha)) continue;

        // MESMO JOGO e MESMO horário — as duas travas que o motor aplica (engine.ts) e
        // que faltavam aqui. Sem elas, "Flamengo x Palmeiras" de hoje e o de outra data
        // (ou o Sub-20 homônimo) caíam no mesmo cluster e podiam fabricar surebet entre
        // partidas diferentes. mesmoHorario tolera 10min e aceita horário desconhecido.
        if (!areEventsSame(cl.evento, o.evento)) continue;
        if (!mesmoHorario(cl.dataHora, o.dataHora)) continue;

        // Orientação por COMPARAÇÃO das duas leituras, não por um teste de igualdade
        // isolado: rótulos como "Mais de 2.5" e "Menos de 2.5" são fuzzy-similares
        // (jaroWinkler ~0,85), então "opcaoA parece labelA" dava TRUE nos dois sentidos
        // e uma casa que listasse Under antes de Over entrava invertida — over pareado
        // com over, ROI fabricado. Aqui vence a leitura com maior similaridade total.
        const nA = nucleoRotulo(o.opcaoA);
        const nB = nucleoRotulo(o.opcaoB);
        const cA = nucleoRotulo(cl.labelA);
        const cB = nucleoRotulo(cl.labelB);
        const direto = jaroWinkler(nA, cA) + jaroWinkler(nB, cB);
        const trocado = jaroWinkler(nA, cB) + jaroWinkler(nB, cA);

        // Uma leitura só é candidata quando: (1) o TIPO de seleção casa nos DOIS lados
        // ('simples' × 'dupla' separa os recortes irmãos do 1X2) e (2) os NÚCLEOS casam
        // (barra "Vitória Vasco" virar "Vitória Flamengo", que o texto cheio aceitava).
        const tipoCasa = (x?: string, y?: string) => tipoSelecao(x) === tipoSelecao(y);
        const validoDireto =
          tipoCasa(o.opcaoA, cl.labelA) &&
          tipoCasa(o.opcaoB, cl.labelB) &&
          (direto / 2 >= 0.75 || (areTeamsSame(nA, cA) && areTeamsSame(nB, cB)));
        const validoTrocado =
          tipoCasa(o.opcaoA, cl.labelB) &&
          tipoCasa(o.opcaoB, cl.labelA) &&
          (trocado / 2 >= 0.75 || (areTeamsSame(nA, cB) && areTeamsSame(nB, cA)));
        if (!validoDireto && !validoTrocado) continue;
        const s = validoTrocado && (!validoDireto || trocado > direto);

        // Sign-aware: oferta espelhada (linha ancorada no time oposto) NÃO é o mesmo cluster.
        const ladoA = s ? o.opcaoB : o.opcaoA;
        const sinalCluster = linhaDoRotulo(cl.labelA);
        const sinalOferta = linhaDoRotulo(ladoA);
        if (sinalCluster !== null && sinalOferta !== null && Math.abs(sinalCluster - sinalOferta) > 1e-9) continue;

        alvo = cl;
        swap = s;
        break;
      }

      if (!alvo) {
        alvo = {
          esporte: o.esporte,
          evento: o.evento,
          mercado: o.mercado,
          linha,
          labelA: o.opcaoA,
          labelB: o.opcaoB,
          dataHora: o.dataHora,
          ofertas: [],
        };
        lista.push(alvo);
        buckets.set(chave, lista);
      }

      const oddA = swap ? o.oddB : o.oddA;
      const oddB = swap ? o.oddA : o.oddB;
      // Uma casa pode trazer o mesmo mercado duas vezes (feeds diferentes): mantém a melhor.
      const existente = alvo.ofertas.find((x) => x.casa === fonte.nome);
      const novo: OfertaDaCasa = {
        casa: fonte.nome,
        oddA,
        oddB,
        oddAEfetiva: oddEfetiva(fonte.nome, oddA),
        oddBEfetiva: oddEfetiva(fonte.nome, oddB),
      };
      if (!existente) alvo.ofertas.push(novo);
      else if (novo.oddAEfetiva + novo.oddBEfetiva > existente.oddAEfetiva + existente.oddBEfetiva) {
        Object.assign(existente, novo);
      }
    }
  }

  const saida: MercadoComparado[] = [];
  for (const lista of buckets.values()) {
    for (const cl of lista) {
      if (!cl.ofertas.length) continue;

      // MELHOR PAR entre casas distintas, não a escolha gulosa "melhor A global + melhor
      // B nas outras". A gulosa erra: se uma casa tem a maior odd dos DOIS lados, ela
      // monopoliza o lado A e o par ótimo (A na 2ª melhor + B na monopolista) nunca é
      // testado — o comparador respondia "não fecha" com surebet na mesa. Com ≤16 casas,
      // varrer os pares (i≠j) é irrelevante em custo.
      const umaCasaSo = new Set(cl.ofertas.map((o) => o.casa)).size < 2;
      let melhorA = cl.ofertas[0];
      let melhorB = cl.ofertas[0];
      let somaProb = 1 / melhorA.oddAEfetiva + 1 / melhorB.oddBEfetiva;
      if (!umaCasaSo) {
        let melhorSoma = Infinity;
        for (const a of cl.ofertas) {
          for (const b of cl.ofertas) {
            if (a.casa === b.casa) continue;
            const soma = 1 / a.oddAEfetiva + 1 / b.oddBEfetiva;
            if (soma < melhorSoma) {
              melhorSoma = soma;
              melhorA = a;
              melhorB = b;
            }
          }
        }
        somaProb = melhorSoma;
      }

      const quarter = cl.linha !== null && ehLinhaQuarter(cl.linha);
      let roiPct: number | null = null;
      let faltaPct: number | null = null;
      if (!umaCasaSo && somaProb < 1) {
        // Base do ROI IGUAL à do motor/radar (engine.ts: (1 − soma)·100), para o mesmo par
        // não aparecer com dois números diferentes no app. O lucro sobre o investido
        // (1/soma − 1) vai em campo separado.
        const bruto = (1 - somaProb) * 100;
        // Quarter (.25/.75): o cenário do meio devolve metade de cada perna → o lucro
        // GARANTIDO é o piso (metade do nominal), mesma convenção do motor.
        roiPct = Math.round((quarter ? bruto / 2 : bruto) * 100) / 100;
      } else if (!umaCasaSo) {
        // Quanto a melhor odd precisa subir para a soma cair abaixo de 1.
        faltaPct = Math.round((somaProb - 1) * 10000) / 100;
      }
      const lucroSobreInvestidoPct =
        roiPct === null ? null : Math.round((quarter ? (1 / somaProb - 1) / 2 : 1 / somaProb - 1) * 10000) / 100;

      const bloqueio = !umaCasaSo
        ? regraPermiteOportunidade({
            esporte: cl.esporte,
            mercado: cl.mercado,
            casaA: melhorA.casa,
            casaB: melhorB.casa,
          })
        : { ok: true as const };

      saida.push({
        esporte: cl.esporte || null,
        evento: cl.evento,
        mercado: cl.mercado,
        linha: cl.linha,
        opcaoA: cl.labelA,
        opcaoB: cl.labelB,
        dataHora: cl.dataHora || null,
        casas: cl.ofertas.map((o) => ({
          casa: o.casa,
          oddA: Math.round(o.oddA * 1000) / 1000,
          oddB: Math.round(o.oddB * 1000) / 1000,
          oddAEfetiva: Math.round(o.oddAEfetiva * 1000) / 1000,
          oddBEfetiva: Math.round(o.oddBEfetiva * 1000) / 1000,
        })),
        melhorA: { casa: melhorA.casa, odd: Math.round(melhorA.oddA * 1000) / 1000 },
        melhorB: { casa: melhorB.casa, odd: Math.round(melhorB.oddB * 1000) / 1000 },
        somaProb: Math.round(somaProb * 10000) / 10000,
        roiPct,
        lucroSobreInvestidoPct,
        faltaPct,
        umaCasaSo,
        bloqueio: bloqueio.ok ? null : bloqueio.motivo || 'bloqueado pelas Diretrizes',
        quarter,
      });
    }
  }

  // Melhores primeiro: quem fecha surebet, depois quem está mais perto de fechar.
  return saida.sort((a, b) => {
    if (a.roiPct !== null && b.roiPct !== null) return b.roiPct - a.roiPct;
    if (a.roiPct !== null) return -1;
    if (b.roiPct !== null) return 1;
    return (a.faltaPct ?? 1e9) - (b.faltaPct ?? 1e9);
  });
}
