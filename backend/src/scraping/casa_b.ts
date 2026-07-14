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

