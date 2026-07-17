import { ScrapedOdd } from '../scraping/scraper_base';
import { areEventsSame, areTeamsSame, mesmoHorario, forcaMatchEvento, parseKickoff } from './matcher';
import { mesmaOferta, ehLinhaQuarter, normalizarMercado } from './markets';
import { regraPermiteOportunidade } from './regras';

export interface ArbitrageOpportunity {
  evento: string;
  mercado: string;
  opcaoA: string;
  opcaoB: string;
  oddA: number;
  oddB: number;
  casaA: string;
  casaB: string;
  lucroGarantidoPerc: number;
  oddCombinadaA: number;
  oddCombinadaB: number;
  totalPerc: number;
  analiseIA?: string; // Parecer da Inteligência Artificial sobre a Surebet
  esporte?: string;
  url?: string;
  linha?: number;            // linha do mercado (over/under, handicap), quando aplicável
  dataHora?: string;         // início da partida (ISO), quando disponível
  confianca?: number;        // 0..1 — qualidade do casamento (time + horário + sanidade do ROI)
  alertaPrecisao?: string;   // motivo de cautela (ROI alto, horário desconhecido, match fraco)
}

export class ArbitrageEngine {
  /**
   * Compara duas listas de odds de casas de apostas diferentes e retorna as Surebets encontradas.
   */
  async encontrarOportunidades(
    nomeCasa1: string, oddsCasa1: ScrapedOdd[], 
    nomeCasa2: string, oddsCasa2: ScrapedOdd[]
  ): Promise<ArbitrageOpportunity[]> {
    
    const oportunidades: ArbitrageOpportunity[] = [];
    
    for (const odd1 of oddsCasa1) {
      // Procura o mesmo evento na casa 2
      // Mesma oferta = mesmo evento + mesmo horário + mercado normalizado + MESMA linha.
      // A trava de horário evita parear jogos diferentes de times homônimos; a linha
      // (over/under, handicap) entra na chave: Over 2.5 nunca cruza com Over 3.0.
      const eventosCorrespondentes = oddsCasa2.filter(odd2 =>
        areEventsSame(odd1.evento, odd2.evento) &&
        mesmoHorario(odd1.dataHora, odd2.dataHora) &&
        mesmaOferta(odd1.mercado, odd1.linha, odd2.mercado, odd2.linha)
      );
      
      for (const odd2 of eventosCorrespondentes) {
        // Verifica se as opções se alinham.
        // Como o ScrapedOdd mapeia OpcaoA vs OpcaoB, precisamos pareá-los.
        // Cenário 1: odd1.opcaoA equivale a odd2.opcaoA
        if (areTeamsSame(odd1.opcaoA, odd2.opcaoA) && areTeamsSame(odd1.opcaoB, odd2.opcaoB)) {
          this.testarCruze(odd1, odd2, nomeCasa1, nomeCasa2, oportunidades, true);
        }
        // Cenário 2: as casas inverteram a ordem (TimeB vs TimeA)
        else if (areTeamsSame(odd1.opcaoA, odd2.opcaoB) && areTeamsSame(odd1.opcaoB, odd2.opcaoA)) {
          this.testarCruze(odd1, odd2, nomeCasa1, nomeCasa2, oportunidades, false);
        }
      }
    }
    
    // Filtra duplicatas se a mesma arbitragem for achada na inversão
    const unicas = oportunidades.filter((v, i, a) => a.findIndex(t => (
      t.evento === v.evento && 
      t.opcaoA === v.opcaoA && 
      t.casaA === v.casaA
    )) === i);

    // Retorna ordenado pelo maior lucro
    return unicas.sort((a, b) => b.lucroGarantidoPerc - a.lucroGarantidoPerc);
  }

  /**
   * MELHOR COMBINAÇÃO entre N casas: para cada aposta (esporte + evento + mercado +
   * linha), agrupa as ofertas de todas as casas e escolhe a MAIOR odd de cada lado
   * (em casas diferentes) — o ROI ótimo. Emite UMA oportunidade por aposta, o que
   * também deduplica naturalmente (bem menos ruído que o cruzamento par a par).
   */
  async encontrarMelhoresOportunidades(
    fontes: Array<{ nome: string; odds: ScrapedOdd[] }>
  ): Promise<ArbitrageOpportunity[]> {
    interface OfertaAlinhada { casa: string; evento: string; dataHora?: string; oddA: number; oddB: number; opcaoA: string; opcaoB: string; }
    interface Cluster {
      evento: string; mercado: string; linha?: number; esporte?: string; dataHora?: string;
      labelA: string; labelB: string; ofertas: OfertaAlinhada[]; casas: Set<string>;
    }
    const normEsp = (s?: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // Handicap COM SINAL embutido no rótulo da opção (ex.: "Time A (-1.5)").
    // null quando o rótulo não carrega linha (RF, totais, DNB...).
    const linhaDoRotulo = (s: string): number | null => {
      const m = (s || '').match(/\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
      return m ? parseFloat(m[1]) : null;
    };
    const clusters: Cluster[] = [];
    // ÍNDICE de clusters por (esporte | mercado canônico | linha): com 7 casas são
    // ~20k+ odds e a varredura linear clusters×odds virou O(n²) real — a varredura
    // passou de 7 min e derrubou a VPS (load 56) em 17/07/2026. A chave reproduz
    // EXATAMENTE o corte de mesmaOferta: canônico ≠ DESCONHECIDO → (canônico, linha);
    // DESCONHECIDO → (rótulo cru exato, linha) — então buscar só no bucket é
    // equivalente a testar mesmaOferta contra todos.
    const buckets = new Map<string, Cluster[]>();
    const chaveBucket = (esporte: string | undefined, mercado: string, linha: number | null | undefined) => {
      const canon = normalizarMercado(mercado);
      const m = canon === 'DESCONHECIDO' ? `D|${(mercado || '').trim().toLowerCase()}` : canon;
      return `${normEsp(esporte)}|${m}|${linha ?? '∅'}`;
    };

    /**
     * Alinhamento da oferta ao cluster, SIGN-AWARE para handicaps. Alinhar só por
     * NOME de time ignora o sinal: casas que ancoram a linha no time oposto
     * ("Phantom (-1.5)/K27 (+1.5)" vs "K27 (-1.5)/Phantom (+1.5)") têm |linha| e
     * times iguais, mas são a oferta ESPELHADA — misturá-las pareava K27(-1.5) com
     * Phantom(-1.5) (pernas não complementares) e fabricava ROI de 20-40%, inclusive
     * 2 alertas falsos no WhatsApp. Retorna null quando a oferta NÃO pertence ao
     * cluster (aí ela forma/acha um cluster na convenção dela — nada se perde).
     */
    const alinharAoCluster = (cl: Cluster, o: ScrapedOdd): { swap: boolean } | null => {
      const swap = !areTeamsSame(o.opcaoA, cl.labelA) && areTeamsSame(o.opcaoA, cl.labelB);
      const ladoA = swap ? o.opcaoB : o.opcaoA;
      const sinalCluster = linhaDoRotulo(cl.labelA);
      const sinalOferta = linhaDoRotulo(ladoA);
      if (sinalCluster !== null && sinalOferta !== null && Math.abs(sinalCluster - sinalOferta) > 1e-9) {
        return null; // oferta espelhada — não é o mesmo mercado deste cluster
      }
      return { swap };
    };

    for (const fonte of fontes) {
      for (const odd of fonte.odds) {
        if (!(odd.oddA > 1) || !(odd.oddB > 1)) continue;
        const chave = chaveBucket(odd.esporte, odd.mercado, odd.linha);
        const bucket = buckets.get(chave) || [];
        let c: Cluster | undefined;
        let swap = false;
        for (const cl of bucket) {
          // Dentro do bucket, mesmaOferta é garantida pela chave; sobram horário
          // (numérico, barato) e o casamento fuzzy de evento.
          if (mesmoHorario(cl.dataHora, odd.dataHora) && areEventsSame(cl.evento, odd.evento)) {
            const al = alinharAoCluster(cl, odd);
            if (al) { c = cl; swap = al.swap; break; }
            // sign-aware rejeitou: segue procurando (pode existir o cluster espelhado)
          }
        }
        let oddA = odd.oddA, oddB = odd.oddB, opcaoA = odd.opcaoA, opcaoB = odd.opcaoB;
        if (!c) {
          c = {
            evento: odd.evento, mercado: odd.mercado, linha: odd.linha, esporte: odd.esporte,
            dataHora: odd.dataHora, labelA: odd.opcaoA, labelB: odd.opcaoB, ofertas: [], casas: new Set(),
          };
          clusters.push(c);
          bucket.push(c);
          buckets.set(chave, bucket);
        } else if (swap) {
          // Casa listou os lados invertidos em relação ao cluster → troca.
          oddA = odd.oddB; oddB = odd.oddA; opcaoA = odd.opcaoB; opcaoB = odd.opcaoA;
        }
        c.ofertas.push({ casa: fonte.nome, evento: odd.evento, dataHora: odd.dataHora, oddA, oddB, opcaoA, opcaoB });
        c.casas.add(fonte.nome);
      }
    }

    const ops: ArbitrageOpportunity[] = [];
    for (const c of clusters) {
      if (c.casas.size < 2) continue; // arbitragem exige 2+ casas
      // Melhor odd do lado A; melhor do lado B numa casa DIFERENTE (arb real entre 2 casas).
      const melhorA = c.ofertas.reduce((m, o) => (o.oddA > m.oddA ? o : m));
      const candidatosB = c.ofertas.filter((o) => o.casa !== melhorA.casa);
      if (candidatosB.length === 0) continue;
      const melhorB = candidatosB.reduce((m, o) => (o.oddB > m.oddB ? o : m));

      const totalPerc = 1 / melhorA.oddA + 1 / melhorB.oddB;
      if (totalPerc >= 1) continue;

      const forca = forcaMatchEvento(melhorA.evento, melhorB.evento);
      const tempoConhecido = parseKickoff(melhorA.dataHora) !== null && parseKickoff(melhorB.dataHora) !== null;

      const opp = this.criarOportunidade(
        c.evento, c.mercado, melhorA.opcaoA, melhorB.opcaoB,
        melhorA.oddA, melhorB.oddB, melhorA.casa, melhorB.casa, totalPerc, c.esporte
      );
      // Diretrizes de risco: pula mercado/cruzamento proibido (ex.: futebol 1X2, tênis A×B).
      if (!regraPermiteOportunidade(opp).ok) continue;
      ops.push(this.enriquecer(opp, forca, tempoConhecido, c.dataHora, c.linha));
    }

    return ops.sort((a, b) => b.lucroGarantidoPerc - a.lucroGarantidoPerc);
  }

  private testarCruze(
    odd1: ScrapedOdd, odd2: ScrapedOdd,
    nomeCasa1: string, nomeCasa2: string,
    oportunidades: ArbitrageOpportunity[],
    direto: boolean
  ): void {
    // Confiança do casamento, calculada uma vez por par (time + horário).
    const forca = forcaMatchEvento(odd1.evento, odd2.evento);
    const tempoConhecido = parseKickoff(odd1.dataHora) !== null && parseKickoff(odd2.dataHora) !== null;

    const dataHora = odd1.dataHora || odd2.dataHora;
    const linha = odd1.linha ?? odd2.linha;
    const registrar = (opp: ArbitrageOpportunity) => {
      if (!regraPermiteOportunidade(opp).ok) return; // Diretrizes de risco
      oportunidades.push(this.enriquecer(opp, forca, tempoConhecido, dataHora, linha));
    };

    if (direto) {
      const probA1_B2 = (1 / odd1.oddA) + (1 / odd2.oddB);
      if (probA1_B2 < 1.0) {
        registrar(this.criarOportunidade(
          odd1.evento, odd1.mercado, odd1.opcaoA, odd2.opcaoB,
          odd1.oddA, odd2.oddB, nomeCasa1, nomeCasa2, probA1_B2, odd1.esporte, odd1.url
        ));
      }
      const probB1_A2 = (1 / odd1.oddB) + (1 / odd2.oddA);
      if (probB1_A2 < 1.0) {
        registrar(this.criarOportunidade(
          odd1.evento, odd1.mercado, odd1.opcaoB, odd2.opcaoA,
          odd1.oddB, odd2.oddA, nomeCasa1, nomeCasa2, probB1_A2, odd1.esporte, odd1.url
        ));
      }
    } else {
      const probA1_A2 = (1 / odd1.oddA) + (1 / odd2.oddA);
      if (probA1_A2 < 1.0) {
        registrar(this.criarOportunidade(
          odd1.evento, odd1.mercado, odd1.opcaoA, odd2.opcaoA,
          odd1.oddA, odd2.oddA, nomeCasa1, nomeCasa2, probA1_A2, odd1.esporte, odd1.url
        ));
      }
      const probB1_B2 = (1 / odd1.oddB) + (1 / odd2.oddB);
      if (probB1_B2 < 1.0) {
        registrar(this.criarOportunidade(
          odd1.evento, odd1.mercado, odd1.opcaoB, odd2.opcaoB,
          odd1.oddB, odd2.oddB, nomeCasa1, nomeCasa2, probB1_B2, odd1.esporte, odd1.url
        ));
      }
    }
  }

  /**
   * Confiança [0..1] de uma oportunidade e um eventual alerta de cautela.
   * Combina a força do casamento de times, se o horário foi confirmado e a
   * sanidade do ROI (ROI muito alto costuma indicar odd travada/erro/1 lado stale).
   */
  private avaliarConfianca(
    forca: number,
    tempoConhecido: boolean,
    roiPct: number
  ): { confianca: number; alerta?: string } {
    const timeScore = tempoConhecido ? 1 : 0.6;
    const roiSanity = roiPct <= 6 ? 1 : roiPct <= 15 ? 0.75 : 0.45;
    const confianca = Math.max(0, Math.min(1, 0.55 * forca + 0.25 * timeScore + 0.2 * roiSanity));

    const motivos: string[] = [];
    if (forca < 0.85) motivos.push('casamento de times fraco');
    if (!tempoConhecido) motivos.push('horário não confirmado');
    if (roiPct > 15) motivos.push('ROI muito alto (possível odd travada/erro)');

    return { confianca: parseFloat(confianca.toFixed(2)), alerta: motivos.length ? motivos.join('; ') : undefined };
  }

  /** Anexa linha/data/confiança/alerta a uma oportunidade recém-criada. */
  private enriquecer(
    opp: ArbitrageOpportunity,
    forca: number,
    tempoConhecido: boolean,
    dataHora?: string,
    linha?: number
  ): ArbitrageOpportunity {
    opp.linha = linha;
    opp.dataHora = dataHora;
    // QUARTER-LINE (.25/.75): a aposta é dividida nas duas linhas vizinhas e o
    // cenário do MEIO devolve metade de cada perna → com os stakes da arbitragem
    // (s=k/odd), o retorno do meio é 0.5·k·(1+totalPerc) e o lucro cai para
    // EXATAMENTE metade do nominal. O lucroGarantidoPerc passa a ser esse PISO —
    // nos demais cenários o lucro real é o dobro do informado. (A distribuição de
    // stake não muda; só o lucro garantido.)
    if (linha !== undefined && ehLinhaQuarter(linha)) {
      opp.lucroGarantidoPerc = parseFloat((opp.lucroGarantidoPerc / 2).toFixed(2));
    }
    const quando = this.fmtDataEvento(dataHora);
    // Anexa "(DD/MM/AAAA HH:MM)" ao evento (mesmo formato do SureRadar) para o
    // filtro de data e a exibição funcionarem uniformemente.
    if (quando && !/\(\d{2}\/\d{2}/.test(opp.evento)) opp.evento = `${opp.evento} (${quando})`;
    const { confianca, alerta } = this.avaliarConfianca(forca, tempoConhecido, opp.lucroGarantidoPerc);
    opp.confianca = confianca;
    if (alerta) opp.alertaPrecisao = alerta;
    return opp;
  }

  /** Formata o início da partida como "DD/MM/AAAA HH:MM" (America/Sao_Paulo) — null se não parseável. */
  private fmtDataEvento(dataHora?: string): string | null {
    const t = parseKickoff(dataHora);
    if (t === null) return null;
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(t)).replace(',', '');
  }

  private criarOportunidade(
    evento: string, mercado: string,
    opcaoA: string, opcaoB: string,
    oddA: number, oddB: number,
    casaA: string, casaB: string,
    totalPerc: number,
    esporte?: string, url?: string
  ): ArbitrageOpportunity {
    const lucro = (1.0 - totalPerc) * 100;

    const opp: ArbitrageOpportunity = {
      evento, mercado,
      opcaoA, opcaoB,
      oddA, oddB,
      casaA, casaB,
      lucroGarantidoPerc: parseFloat(lucro.toFixed(2)),
      oddCombinadaA: (1 / oddA) / totalPerc,
      oddCombinadaB: (1 / oddB) / totalPerc,
      totalPerc: parseFloat(totalPerc.toFixed(4)),
      esporte, url
    };

    // A análise de IA foi movida para fora do hot path de matching.
    // As oportunidades são persistidas com ia_status='pendente' e enriquecidas
    // de forma assíncrona pelo EnrichmentService.
    return opp;
  }

  /**
   * Calcula quanto apostar em cada ponta dado um valor de banca (stake) total.
   * Em QUARTER-LINE (.25/.75) o lucroR$ informado é o PISO (o cenário do meio
   * devolve metade de cada perna → lucro = metade do nominal); nos demais
   * cenários o lucro real é o dobro. As apostas em si não mudam.
   */
  calcularDistribuicaoStake(opp: ArbitrageOpportunity, stakeTotal: number) {
    const apostaA = stakeTotal * opp.oddCombinadaA;
    const apostaB = stakeTotal * opp.oddCombinadaB;
    const retorno = apostaA * opp.oddA; // retorno é igual em qualquer lado se hitar
    const lucroNominal = retorno - stakeTotal;
    const ehQuarter = opp.linha != null && ehLinhaQuarter(opp.linha);
    const lucroR$ = ehQuarter ? lucroNominal / 2 : lucroNominal;

    return {
      apostaA: apostaA.toFixed(2),
      apostaB: apostaB.toFixed(2),
      retornoEsperado: retorno.toFixed(2),
      lucroR$: lucroR$.toFixed(2)
    };
  }
}
