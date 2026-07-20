/**
 * STUB INTENCIONAL — bet365 NÃO tem scraper e NÃO está no scanner nem no
 * SCRAPER_FACTORY (revalidationService). Recon de 2026-07-19 concluiu que é inviável
 * em headless: as odds só vêm pelo WebSocket "zap" (protocolo próprio) e o cupom não
 * monta em headless, então o cliente nunca se inscreve no feed (nem DOM nem WS entregam
 * odds); ainda depende do tsproxy p/ IP residencial BR (Cloudflare). bet365 só aparece
 * via SureRadar, onde a revalidação já cai no fallback da lista. NÃO reinvestir sem ler
 * a memória bet365-recon (caminhos restantes: xvfb-headed ou reverter o protocolo WS).
 */
export class Bet365Scraper {
  async coletarOdds(): Promise<any[]> {
    return [];
  }
}

export class Bet365SessionManager {
  async validarSessao(): Promise<boolean> {
    return true;
  }
  async realizarLogin(): Promise<boolean> {
    return true;
  }
}

