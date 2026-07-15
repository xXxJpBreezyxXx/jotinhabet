import { Page, BrowserContext } from 'playwright';

export interface ScrapedOdd {
  esporte: string;       // ex: "Futebol", "Basquete", "Tenis"
  evento: string;        // ex: "Time A vs Time B"
  dataHora: string;      // ex: "2026-07-12T20:00:00Z" (ISO-8601) ou "Hoje", "Amanhã"
  mercado: string;       // ex: "Resultado Final", "Total de Gols", "Handicap Asiático"
  linha?: number;        // ex: 2.5 (Para Over/Under) ou -1.5 (Para Handicap)
  opcaoA: string;        // ex: "Vitória Time A", "Mais de 2.5"
  opcaoB: string;        // ex: "Time B ou Empate", "Menos de 2.5"
  oddA: number;          // Cotação da Opção A
  oddB: number;          // Cotação da Opção B
  url?: string;          // Link direto para o evento na casa
}

/**
 * Interface comum a todos os coletores de odds — tanto os DOM (ScraperBase) quanto
 * os baseados em API (ex.: KambiScraper). Permite misturá-los no scanner_v2.
 */
export interface OddsScraper {
  getNome(): string;
  executarCrawler(esportes: string[], datas: string[], headless?: boolean): Promise<ScrapedOdd[]>;
}

export abstract class ScraperBase {
  protected casaNome: string;
  protected context?: BrowserContext;

  constructor(casaNome: string) {
    this.casaNome = casaNome;
  }

  public getNome(): string {
    return this.casaNome;
  }

  /**
   * Método principal que orquestra o crawler profundo.
   * @param esportes Lista de esportes a serem raspados
   * @param datas Lista de dias (ex: ['hoje', 'amanha'])
   * @param headless Se deve rodar de forma invisível
   */
  public async executarCrawler(esportes: string[], datas: string[], headless: boolean = true): Promise<ScrapedOdd[]> {
    const oddsColetadas: ScrapedOdd[] = [];
    
    try {
      await this.inicializarNavegador(headless);
      
      for (const esporte of esportes) {
        console.log(`🤖 [${this.casaNome}] Iniciando extração de ${esporte}...`);
        const urlsDeEventos = await this.extrairLinksDaLista(esporte, datas);
        console.log(`   ✅ Encontrados ${urlsDeEventos.length} jogos de ${esporte}. Iniciando extração profunda...`);
        
        for (const url of urlsDeEventos) {
          try {
            const oddsDoEvento = await this.extrairMercadosDoEvento(url, esporte);
            oddsColetadas.push(...oddsDoEvento);
          } catch (err: any) {
            console.error(`   ⚠️ Erro ao extrair mercados do evento ${url}:`, err.message);
          }
        }
      }
      
    } catch (err: any) {
      console.error(`❌ [${this.casaNome}] Falha crítica no crawler:`, err.message);
    } finally {
      await this.fecharNavegador();
    }
    
    console.log(`✅ [${this.casaNome}] Crawler Finalizado! Total de odds extraídas: ${oddsColetadas.length}`);
    return oddsColetadas;
  }

  /**
   * Inicializa o navegador e lida com popups/cookies.
   */
  protected abstract inicializarNavegador(headless: boolean): Promise<void>;

  /**
   * Fecha o navegador.
   */
  protected async fecharNavegador(): Promise<void> {
    if (this.context) {
      await this.context.close();
    }
  }

  /**
   * Acessa o calendário de um esporte específico e extrai os links individuais de todas as partidas.
   */
  protected abstract extrairLinksDaLista(esporte: string, datas: string[]): Promise<string[]>;

  /**
   * Acessa a página de um único evento (jogo) e extrai os mercados secundários.
   */
  protected abstract extrairMercadosDoEvento(url: string, esporte: string): Promise<ScrapedOdd[]>;
}
