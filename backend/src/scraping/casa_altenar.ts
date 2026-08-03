import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';

/**
 * Scraper para casas na plataforma Altenar servidas pelo widget "sb2" (biahosted) —
 * ex.: Aposta1, BetPix365. API PÚBLICA (sem login), descoberta via recon+browser.
 *
 * Estrutura RELACIONAL (join por id):
 *  - GetClickableSportMenu?sportId=X → campeonatos {id, eventsCount}.
 *  - widget/GetEvents?champIds=a,b   → { events, markets, odds, competitors }.
 *    event.marketIds → markets(id) → market.oddIds → odds(id). odds em DECIMAL.
 *    Total: market.name "Total", linha no campo `sv`; odds "Mais de X"/"Menos de X".
 *    1x2: 3 odds (casa/empate/fora por competitorId) → dupla chance sintética.
 *  (Handicap não vem neste endpoint — exigiria detalhe por evento; fica p/ depois.)
 *  - widget/GetLiveEvents?sportId=X → MESMO formato, mas só IN-PLAY (ver incluirAoVivo).
 */

interface AltenarConfig {
  nome: string;
  integration: string; // ex: 'aposta1'
  referer: string; // ex: 'https://www.aposta1.bet.br/'
  maxCampeonatosPorEsporte?: number; // default 40 (maiores ligas)
  // Agente/Radar ao vivo: quando true a coleta muda de endpoint (GetLiveEvents) e mantém
  // partidas EM ANDAMENTO. Aqui a flag TROCA o feed em vez de só relaxar o filtro porque
  // o GetEvents?champIds do pré-jogo simplesmente NÃO lista jogo iniciado (probe 31/07:
  // 176 eventos, 0 em andamento). O scanner de surebet constrói SEM a opção e continua
  // percorrendo o mesmo caminho pré-jogo de antes.
  incluirAoVivo?: boolean;
}

interface AltCompetitor { id: number; name: string; }
interface AltOdd { id: number; price: number; name?: string; competitorId?: number; typeId?: number; oddStatus?: number; }
interface AltMarket { id: number; name?: string; sv?: string; oddIds?: number[]; }
interface AltEvent {
  id: number; name?: string; startDate?: string; sportId?: number;
  competitorIds?: number[]; marketIds?: number[]; status?: number;
}
interface AltSport { id: number; catIds?: number[]; }
interface AltCategory { id: number; champIds?: number[]; }
interface AltChamp { id: number; name?: string; eventsCount?: number; }
interface AltResp {
  events?: AltEvent[]; markets?: AltMarket[]; odds?: AltOdd[]; competitors?: AltCompetitor[];
  champs?: AltChamp[]; sports?: AltSport[]; categories?: AltCategory[];
}

// sportId 145 = E-Sports (confirmado ao vivo: VCT/Valorant, Esports World Cup, etc.).
// Neste endpoint só vem o mercado principal (Vencedor da partida) para e-sports.
// 69=Vôlei, 77=Tênis de Mesa, 76=Beisebol (confirmados no menu ao vivo; vôlei/mesa
// expõem "Total pontos"/"Handicap pontos", beisebol "Total/Handicap/Vencedor
// (incluindo innings extra)").
const SPORT_ID: Record<string, number> = {
  Futebol: 66, Basquete: 67, Tenis: 68, Tênis: 68, Esports: 145,
  Volei: 69, 'Vôlei': 69,
  TenisDeMesa: 77, 'Tenis de Mesa': 77, 'Tênis de Mesa': 77,
  Beisebol: 76,
};
const SPORT_LABEL: Record<number, string> = {
  66: 'Futebol', 67: 'Basquete', 68: 'Tenis', 145: 'Esports',
  69: 'Volei', 77: 'Tenis de Mesa', 76: 'Beisebol',
};
/**
 * Rótulos que são o MESMO mercado com outro nome. O vocabulário do Altenar VARIA por
 * integration (ver aviso na memória do projeto): a mesma oferta que a Aposta1 publica como
 * "Total" a EstrelaBet publica como "Total de Gols (incluindo linhas Asiáticas)".
 *
 * ⚠️ Até 03/08/2026 esta tabela só era aplicada com `incluirAoVivo`, "para o scanner
 * pré-match continuar idêntico". O custo disso foi medido e é alto: a **EstrelaBet emitia
 * ZERO total de gols no pré-match** (contra 555 da 4Play e 416 da Aposta1 na mesma
 * varredura) — ~520 ofertas/varredura descartadas em silêncio no mercado de MAIOR cobertura
 * cruzada do sistema (778 clusters com 2+ casas). Agora vale sempre.
 *
 * Cada linha é o MESMO mercado, não uma aproximação:
 *  - "Total de Gols (incluindo linhas Asiáticas)" = total de gols da partida; o "incluindo
 *    linhas Asiáticas" só diz que vêm também linhas quarter (.25/.75), que o projeto já
 *    trata com o ROI-piso (`ehLinhaQuarter`/`linhaArbitravel`). Over 2.5 é over 2.5.
 *  - "Total jogos" = total de GAMES do tênis (rótulo final sai de TOTAL_LABEL).
 *  - "Handicap de jogos" = handicap de games = o handicap geral do tênis, convenção que já
 *    vale na Pinnacle/NSoft/BetBoom (e agora também no Kambi, ver MERCADO_CONVENCAO lá).
 */
const MERCADO_EQUIVALENTE: Record<string, string> = {
  'Total de Gols (incluindo linhas Asiáticas)': 'Total',
  'Total jogos': 'Total',
  'Handicap de jogos': 'Handicap',
};
const TOTAL_LABEL: Record<number, string> = {
  66: 'Total de Gols', 67: 'Total de Pontos', 68: 'Total de Games',
  69: 'Total de Pontos', 77: 'Total de Pontos', 76: 'Total de Corridas',
};

export class AltenarWidgetScraper implements OddsScraper {
  private cfg: Required<AltenarConfig>;
  private readonly F = 'https://sb2frontend-altenar2.biahosted.com/api';

  constructor(cfg: AltenarConfig) {
    this.cfg = { maxCampeonatosPorEsporte: 40, incluirAoVivo: false, ...cfg };
  }

  getNome(): string {
    return this.cfg.nome;
  }

  private q(): string {
    return `culture=pt-BR&timezoneOffset=180&integration=${this.cfg.integration}&deviceType=1&numFormat=en-GB&countryCode=BR`;
  }
  private headers() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: this.cfg.referer,
      Origin: this.cfg.referer.replace(/\/$/, ''),
    };
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(
      `🤖 [${this.cfg.nome}] Extração via Altenar widget (biahosted)${this.cfg.incluirAoVivo ? ' — AO VIVO (in-play)' : ''}...`
    );
    const todas: ScrapedOdd[] = [];
    const vistos = new Set<number>(); // dedupe de eventos entre esportes
    // O menu do Altenar IGNORA o param sportId (retorna tudo); busca 1x e filtra os
    // campeonatos por esporte via a cadeia sport.catIds → category.champIds → champ.id.
    // Ao vivo o menu não é necessário: GetLiveEvents já busca por sportId direto.
    let menu: AltResp = {};
    if (!this.cfg.incluirAoVivo) {
      try {
        const menuResp = await fetchTextoComRetry(
          `${this.F}/widget/GetClickableSportMenu?${this.q()}`, { headers: this.headers() }, 3, `${this.cfg.nome}/menu`
        );
        menu = JSON.parse(menuResp.body);
      } catch (e: any) {
        console.error(`   ⚠️ [${this.cfg.nome}] menu falhou: ${e.message}`);
        return todas;
      }
    }
    for (const esporte of esportes) {
      const sid = SPORT_ID[esporte];
      if (!sid) continue;
      try {
        const odds = await this.extrairEsporte(sid, menu, vistos);
        console.log(`   [${this.cfg.nome}] ${esporte}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [${this.cfg.nome}] Falha em ${esporte}: ${err.message}`);
      }
    }
    console.log(`✅ [${this.cfg.nome}] Total: ${todas.length} odds.`);
    return todas;
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): odds atuais de UM evento. A API do widget
   * só busca por campeonato, então re-extrai o esporte (menu + lotes) e filtra o evento
   * — ~5 requests. Reusa o parser de produção.
   *
   * Com incluirAoVivo procura no feed IN-PLAY (1 request por esporte, sem menu); o evento
   * pré-jogo NÃO aparece nesse feed, então quem quiser os dois casos chama duas vezes
   * (é o que o memo live/pré da revalidação já faz).
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    try {
      let menu: AltResp = {};
      if (!this.cfg.incluirAoVivo) {
        const menuResp = await fetchTextoComRetry(
          `${this.F}/widget/GetClickableSportMenu?${this.q()}`, { headers: this.headers() }, 1, `${this.cfg.nome}/reval-menu`, 10000
        );
        menu = JSON.parse(menuResp.body);
      }
      const sids = esporte && SPORT_ID[esporte] ? [SPORT_ID[esporte]] : [...new Set(Object.values(SPORT_ID))];
      for (const sid of sids) {
        const odds = await this.extrairEsporte(sid, menu, new Set());
        const doEvento = odds.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return doEvento;
      }
    } catch {
      /* melhor esforço */
    }
    return [];
  }

  private async extrairEsporte(sportId: number, menu: AltResp, vistos: Set<number>): Promise<ScrapedOdd[]> {
    if (this.cfg.incluirAoVivo) return this.extrairEsporteAoVivo(sportId, vistos);
    // Campeonatos DESTE esporte: sport.catIds → categories.champIds → champ.
    const sport = (menu.sports || []).find((s) => s.id === sportId);
    if (!sport) return [];
    const catIds = new Set(sport.catIds || []);
    const champIdsDoEsporte = new Set<number>();
    for (const cat of menu.categories || []) {
      if (catIds.has(cat.id)) (cat.champIds || []).forEach((id) => champIdsDoEsporte.add(id));
    }
    const champs = (menu.champs || [])
      .filter((c) => champIdsDoEsporte.has(c.id) && (c.eventsCount || 0) > 0)
      .sort((a, b) => (b.eventsCount || 0) - (a.eventsCount || 0))
      .slice(0, this.cfg.maxCampeonatosPorEsporte);

    const odds: ScrapedOdd[] = [];
    // 2) Eventos por campeonato (em lotes de 5 champIds).
    for (let i = 0; i < champs.length; i += 5) {
      const ids = champs.slice(i, i + 5).map((c: any) => c.id).join(',');
      let resp;
      try {
        resp = await fetchTextoComRetry(`${this.F}/widget/GetEvents?${this.q()}&champIds=${ids}`, { headers: this.headers() }, 2, `${this.cfg.nome}/ev`);
      } catch { continue; }
      if (resp.status !== 200) continue;
      const j: AltResp = JSON.parse(resp.body);
      this.parseResposta(j, odds, vistos);
    }
    return odds;
  }

  /**
   * IN-PLAY: 1 request por esporte em GetLiveEvents (sem menu, sem champIds, sem lotes —
   * sportId é OBRIGATÓRIO, sem ele volta vazio). O corpo é o MESMO formato relacional do
   * GetEvents (events/markets/odds/competitors), então o parser é reusado inteiro; odd
   * suspensa vem com price=0 e já cai no filtro `ativa()`. Só os mercados PRINCIPAIS
   * (5-6 por evento) vêm nesse feed, o que basta para o agente.
   */
  private async extrairEsporteAoVivo(sportId: number, vistos: Set<number>): Promise<ScrapedOdd[]> {
    const odds: ScrapedOdd[] = [];
    let resp;
    try {
      resp = await fetchTextoComRetry(
        `${this.F}/widget/GetLiveEvents?${this.q()}&sportId=${sportId}`, { headers: this.headers() }, 2, `${this.cfg.nome}/live`
      );
    } catch { return odds; }
    if (resp.status !== 200) return odds;
    this.parseResposta(JSON.parse(resp.body), odds, vistos);
    return odds;
  }

  private parseResposta(j: AltResp, out: ScrapedOdd[], vistos: Set<number>): void {
    const comp = new Map<number, string>((j.competitors || []).map((c) => [c.id, c.name]));
    const oddById = new Map<number, AltOdd>((j.odds || []).map((o) => [o.id, o]));
    const mktById = new Map<number, AltMarket>((j.markets || []).map((m) => [m.id, m]));
    const agora = Date.now();
    // Meia-linha e quarter asiática (.25/.75); inteira barrada (push). Piso da
    // quarter aplicado no engine.
    const ehLinhaOk = (l: number) => linhaArbitravel(l);
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;

    for (const ev of j.events || []) {
      if (vistos.has(ev.id)) continue;
      vistos.add(ev.id);
      // Rotula pelo esporte REAL do evento (o menu por sportId às vezes mistura esportes,
      // ex.: NFL sportId 75). Só mantém futebol/basquete/tênis.
      const espId = ev.sportId || 0;
      const esporte = SPORT_LABEL[espId];
      if (!esporte) continue;
      const cids = ev.competitorIds || [];
      if (cids.length !== 2) continue;
      const home = comp.get(cids[0]);
      const away = comp.get(cids[1]);
      if (!home || !away) continue;
      // Só PRÉ-JOGO (com incluirAoVivo mantém a partida em andamento; o consumidor
      // reconhece "ao vivo" pelo dataHora no passado, que aqui é o startDate real).
      const t = Date.parse(ev.startDate || '');
      if (!this.cfg.incluirAoVivo && !isNaN(t) && t <= agora) continue;
      const evento = `${home} vs ${away}`;
      const dataHora = ev.startDate || 'Hoje';

      for (const mid of ev.marketIds || []) {
        const m = mktById.get(mid);
        if (!m) continue;
        const oddsM = (m.oddIds || []).map((id) => oddById.get(id)).filter(Boolean) as AltOdd[];
        const ativa = (o?: AltOdd) => o && o.price > 1 && o.oddStatus !== 1;
        // Nome base sem o sufixo "(incluindo Prorrogação)" / "(incluindo innings extra)"
        // — normaliza futebol/basquete/tênis/beisebol. (Ambos os sufixos indicam a
        // convenção padrão de liquidação do esporte, então remover não muda o mercado.)
        const cru = (m.name || '').replace(/\s*\(incluindo (?:prorroga[cç][aã]o|innings? extras?)\)\s*/i, '').trim();
        // Normaliza os nomes que variam por integration (ver MERCADO_EQUIVALENTE) — sempre,
        // não só ao vivo: era isso que fazia a EstrelaBet não emitir total de gols nenhum.
        const base = MERCADO_EQUIVALENTE[cru] || cru;

        // --- Resultado Final (1x2 3-way / Vencedor 2-way; e-sports: "Vencedor da partida") ---
        // "Vencedor do encontro": rótulo do futebol na integration da Luvabet.
        // ATENÇÃO: a comparação é por nome EXATO de propósito. Dois mercados desta
        // integration têm a MESMA FORMA de um 1x2 (odds com competitorId + uma terceira
        // opção sem competitorId) e entrariam por engano num match frouxo:
        //   • "Primeiro gol"  → é o time que abre o placar (3ª opção "Nenhum"), NÃO o
        //     resultado da partida. Casar isso com o Resultado Final de outra casa seria
        //     arbitragem entre mercados diferentes = prejuízo.
        //   • "Vencedor do encontro - Odds Aumentadas" → mercado PROMOCIONAL de odd
        //     turbinada, com limite de aposta; fica fora por não ser liquidável no volume
        //     que a calculadora sugere.
        if (
          base === '1x2' ||
          base === 'Vencedor' ||
          base === 'Vencedor da partida' ||
          base === 'Vencedor do encontro'
        ) {
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          const oDraw = oddsM.find((o) => !o.competitorId || /empate|draw|^x$/i.test(o.name || ''));
          if (!ativa(oHome) || !ativa(oAway)) continue;
          if (oDraw && ativa(oDraw)) {
            // Diretrizes §5: e-sports não admite 1X2/3-vias (empate de BO2) → descarta.
            if (esporte === 'Esports') continue;
            // Dupla chance SINTÉTICA (dividir a mão entre empate e fora). Quando a
            // probabilidade implícita de empate+fora passa de 100% — mandante zebra
            // extrema + margem alta — a odd combinada cai ABAIXO de 1.0, ou seja
            // apostar nos dois custa mais do que retorna. Odd <=1 é impossível e nunca
            // compõe arbitragem: descarta (visto na Luvabet 29/07 em Estrela Amadora x
            // Sporting, oddA=9.0 → oddB=0.994; vale para TODA casa Altenar).
            const oddDC = 1 / (1 / oDraw!.price + 1 / oAway!.price);
            if (!(oddDC > 1)) continue;
            out.push({
              esporte, evento, dataHora, mercado: 'Resultado Final',
              opcaoA: `Vitória ${home}`, opcaoB: `${away} ou Empate`,
              oddA: oHome!.price, oddB: oddDC,
            });
          } else {
            out.push({
              esporte, evento, dataHora, mercado: 'Resultado Final',
              opcaoA: home, opcaoB: away, oddA: oHome!.price, oddB: oAway!.price,
            });
          }
        }

        // --- Total DA PARTIDA (Over/Under), linha em sv. "base" exatamente "Total"
        //     exclui "Total de escanteios", "X total" (por-time), "Nº tempo - total".
        //     Vôlei/mesa usam "Total pontos" (rótulo final vem de TOTAL_LABEL). ---
        // "Total de gols": rótulo do futebol na integration da Luvabet (as demais usam
        // "Total"). NÃO incluir "Primeiro gol", que também traz `sv` (=1) mas é outro mercado.
        else if ((base === 'Total' || base === 'Total pontos' || base === 'Total de gols') && m.sv) {
          const linha = parseFloat(m.sv);
          if (!Number.isFinite(linha) || !ehLinhaOk(linha)) continue;
          const over = oddsM.find((o) => /mais/i.test(o.name || ''));
          const under = oddsM.find((o) => /menos/i.test(o.name || ''));
          if (!ativa(over) || !ativa(under)) continue;
          out.push({
            esporte, evento, dataHora, mercado: TOTAL_LABEL[espId] || 'Total',
            linha, opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
            oddA: over!.price, oddB: under!.price,
          });
        }

        // --- Handicap Asiático 2-way (home/away com sinal), linha em sv, só meia-linha.
        //     Vôlei/mesa usam "Handicap pontos" → rótulo com ASSUNTO ("Handicap de
        //     Pontos"), para nunca colidir com handicap de SETS de outra casa. ---
        // "Handicap de sets" (tênis): mercado DIFERENTE do handicap de games, então sai com
        // rótulo próprio "Handicap de Sets" (mesmo nome que Pinnacle/Superbet/Rivalo/BetBoom
        // usam) — nunca cruza com "Handicap". Deixou de ficar atrás da flag de ao vivo em
        // 03/08/2026: o motivo era só "o resultado do scanner não pode mudar", e o nome
        // também aparece no PRÉ-JOGO, onde era descartado de graça.
        else if ((base === 'Handicap' || base === 'Handicap pontos' || base === 'Handicap de sets') && m.sv) {
          const linha = parseFloat(m.sv); // linha do mandante
          if (!Number.isFinite(linha) || !ehLinhaOk(linha)) continue;
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          if (!ativa(oHome) || !ativa(oAway)) continue;
          out.push({
            esporte, evento, dataHora,
            mercado:
              base === 'Handicap pontos' ? 'Handicap de Pontos'
              : base === 'Handicap de sets' ? 'Handicap de Sets'
              : 'Handicap',
            linha,
            opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
            oddA: oHome!.price, oddB: oAway!.price,
          });
        }

        // --- Ambas equipes marcam (BTTS): Sim/Não ---
        else if (base === 'Ambas equipes marcam') {
          const sim = oddsM.find((o) => /^sim$/i.test(o.name || ''));
          const nao = oddsM.find((o) => /^n[aã]o$/i.test(o.name || ''));
          if (!ativa(sim) || !ativa(nao)) continue;
          out.push({
            esporte, evento, dataHora, mercado: 'Ambas equipes marcam',
            opcaoA: 'Sim', opcaoB: 'Não', oddA: sim!.price, oddB: nao!.price,
          });
        }

        // --- DNB / Empate devolve aposta: home vs away (empate reembolsa) ---
        else if (base === 'Empate devolve aposta') {
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          if (!ativa(oHome) || !ativa(oAway)) continue;
          out.push({
            esporte, evento, dataHora, mercado: 'Empate Anula',
            opcaoA: home, opcaoB: away, oddA: oHome!.price, oddB: oAway!.price,
          });
        }
      }
    }
  }
}

/**
 * Luvabet — Altenar widget, integration "luvabet".
 *
 * Recon 29/07/2026: o domínio NÃO é luvabet.bet.br (não existe) e sim **luva.bet.br**;
 * o nome da integration saiu da config da própria página
 * (`"sportsbookIntegrator":{"altenarIntegrationName":"luvabet"}`). Feed confirmado:
 * menu de 58KB / 355 campeonatos / 7 esportes (66,67,68,69,76,77,145) e GetEvents com
 * 125 eventos e 1821 odds decimais só nas 5 maiores ligas de futebol.
 *
 * Vocabulário de mercado DIFERE das outras integrations Altenar: no futebol usa
 * "Vencedor do encontro" e "Total de gols" (as outras usam "1x2" e "Total"); nos demais
 * esportes usa os mesmos "Vencedor"/"Total pontos"/"Handicap pontos". Ver as ressalvas
 * de nome exato no parseResposta (Primeiro gol / Odds Aumentadas).
 *
 * Operador distinto (preço próprio) → entra como FONTE do scanner e no SCRAPER_FACTORY.
 */
/**
 * Onabet — Altenar `onabet`. O domínio regulado é **ona.bet.br** (onabet.bet.br não existe:
 * NXDOMAIN). O tenant saiu do próprio config da home
 * (`"sportsbookIntegrator":{"altenarIntegrationName":"onabet"}`) e foi confirmado por
 * controle negativo (tenant inventado não responde). O site tem challenge de Cloudflare,
 * mas a coleta não passa por ele — as odds vêm do host da Altenar.
 */
export class OnabetScraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'Onabet', integration: 'onabet', referer: 'https://ona.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}

/**
 * BrBET — Altenar `brbet`. O site (brbet.bet.br) responde 403 de WAF do Cloudflare para o
 * IP da VPS, o que é indiferente aqui: o feed é o host da Altenar. A camada de site é NGX
 * ("BET_PLUS2"), que suporta NGX/Altenar/BETBY — o sportsbook desta marca é o Altenar.
 */
export class BrBetScraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'BrBET', integration: 'brbet', referer: 'https://www.brbet.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}

export class LuvabetScraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'Luvabet', integration: 'luvabet', referer: 'https://luva.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}

/** Aposta1 — Altenar widget, integration "aposta1". */
export class Aposta1Scraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'Aposta1', integration: 'aposta1', referer: 'https://www.aposta1.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}

/**
 * BetPix365 — Altenar widget, integration "betpix365" (confirmado no recon: GetClickableSportMenu
 * responde com menu completo). Usada só para REVALIDAÇÃO (SCRAPER_FACTORY), NÃO como fonte do
 * scanner — as odds são correlacionadas com Aposta1 (mesma plataforma), então cruzar traria
 * pouco arb novo e muita redundância.
 */
export class BetPix365Scraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'BetPix365', integration: 'betpix365', referer: 'https://betpix365.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}

/**
 * EstrelaBet — Altenar widget, integration "estrelabet" (confirmado no recon: menu completo,
 * 51KB). Operador distinto (preço próprio, ≠ Aposta1/BetPix365), então serve para revalidação
 * por casa. Adicionada só ao SCRAPER_FACTORY (não é fonte do scanner nesta rodada).
 */
export class EstrelaBetScraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'EstrelaBet', integration: 'estrelabet', referer: 'https://www.estrelabet.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}

/**
 * MC Games — Altenar widget, integration "mcgames2" (extraído da config do WSDK na página;
 * confirmado no biahosted). Adicionada só ao SCRAPER_FACTORY (revalidação; não é fonte do scanner).
 */
export class MCGamesScraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'MC Games', integration: 'mcgames2', referer: 'https://www.mcgames.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}

/**
 * 4Play — Altenar widget, integration "4play" (confirmado no recon 25/07/2026: menu de
 * 80KB / 537 campeonatos, GetEvents com odds decimais; o feed biahosted responde direto,
 * sem passar pelo bloqueio Akamai da home). Operador distinto → preço próprio: entra como
 * FONTE do scanner e também no SCRAPER_FACTORY (revalidação).
 */
export class FourPlayScraper extends AltenarWidgetScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: '4Play', integration: '4play', referer: 'https://4play.bet.br/', incluirAoVivo: opts?.incluirAoVivo });
  }
}
