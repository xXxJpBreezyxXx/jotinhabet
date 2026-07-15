import { ScrapedOdd } from '../scraping/scraper_base';
import { areEventsSame, areTeamsSame } from './matcher';
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
      // Mesma oferta = mesmo evento + mercado normalizado + MESMA linha.
      // A linha (over/under, handicap) entra na chave: Over 2.5 nunca cruza com Over 3.0.
      const eventosCorrespondentes = oddsCasa2.filter(odd2 =>
        areEventsSame(odd1.evento, odd2.evento) &&
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
    let probA1_B2 = 0;
    let probB1_A2 = 0;

    if (direto) {
      probA1_B2 = (1 / odd1.oddA) + (1 / odd2.oddB);
      if (probA1_B2 < 1.0) {
        oportunidades.push(this.criarOportunidade(
          odd1.evento, odd1.mercado, 
          odd1.opcaoA, odd2.opcaoB, 
          odd1.oddA, odd2.oddB, 
          nomeCasa1, nomeCasa2, probA1_B2,
          odd1.esporte, odd1.url
        ));
      }

      probB1_A2 = (1 / odd1.oddB) + (1 / odd2.oddA);
      if (probB1_A2 < 1.0) {
        oportunidades.push(this.criarOportunidade(
          odd1.evento, odd1.mercado, 
          odd1.opcaoB, odd2.opcaoA, 
          odd1.oddB, odd2.oddA, 
          nomeCasa1, nomeCasa2, probB1_A2,
          odd1.esporte, odd1.url
        ));
      }
    } else {
      const probA1_A2 = (1 / odd1.oddA) + (1 / odd2.oddA);
      if (probA1_A2 < 1.0) {
        oportunidades.push(this.criarOportunidade(
          odd1.evento, odd1.mercado, 
          odd1.opcaoA, odd2.opcaoA, 
          odd1.oddA, odd2.oddA, 
          nomeCasa1, nomeCasa2, probA1_A2,
          odd1.esporte, odd1.url
        ));
      }

      const probB1_B2 = (1 / odd1.oddB) + (1 / odd2.oddB);
      if (probB1_B2 < 1.0) {
        oportunidades.push(this.criarOportunidade(
          odd1.evento, odd1.mercado, 
          odd1.opcaoB, odd2.opcaoB, 
          odd1.oddB, odd2.oddB, 
          nomeCasa1, nomeCasa2, probB1_B2,
          odd1.esporte, odd1.url
        ));
      }
    }
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
