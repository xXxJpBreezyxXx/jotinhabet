import { ScrapedOdd } from '../scraping/scraper_base';
import { areEventsSame, areTeamsSame, mesmoHorario, forcaMatchEvento, parseKickoff } from './matcher';
import { mesmaOferta } from './markets';

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
    const quando = this.fmtDataEvento(dataHora);

    // Enriquece cada oportunidade com linha, data, confiança e alerta antes de guardar.
    const registrar = (opp: ArbitrageOpportunity) => {
      opp.linha = odd1.linha ?? odd2.linha;
      opp.dataHora = dataHora;
      // Anexa "(DD/MM/AAAA HH:MM)" ao evento (mesmo formato do SureRadar) para o
      // filtro de data e a exibição funcionarem uniformemente.
      if (quando && !/\(\d{2}\/\d{2}/.test(opp.evento)) opp.evento = `${opp.evento} (${quando})`;
      const { confianca, alerta } = this.avaliarConfianca(forca, tempoConhecido, opp.lucroGarantidoPerc);
      opp.confianca = confianca;
      if (alerta) opp.alertaPrecisao = alerta;
      oportunidades.push(opp);
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
   */
  calcularDistribuicaoStake(opp: ArbitrageOpportunity, stakeTotal: number) {
    const apostaA = stakeTotal * opp.oddCombinadaA;
    const apostaB = stakeTotal * opp.oddCombinadaB;
    const retorno = apostaA * opp.oddA; // retorno é igual em qualquer lado se hitar
    const lucroR$ = retorno - stakeTotal;

    return {
      apostaA: apostaA.toFixed(2),
      apostaB: apostaB.toFixed(2),
      retornoEsperado: retorno.toFixed(2),
      lucroR$: lucroR$.toFixed(2)
    };
  }
}
