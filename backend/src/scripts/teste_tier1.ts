/**
 * Teste ao vivo do Tier 1 (sem tocar banco/WhatsApp): roda os scrapers de API nos
 * esportes passados por argumento (default: os novos — Volei, TenisDeMesa, Beisebol),
 * imprime o volume de odds por casa/esporte e cruza tudo no motor.
 *
 *   npx ts-node --transpile-only src/scripts/teste_tier1.ts            # esportes novos
 *   npx ts-node --transpile-only src/scripts/teste_tier1.ts Futebol,Tenis
 *
 * Pinnacle só entra quando PINNACLE_PROXY está setado (túnel Tailscale — de dentro
 * do container do backend; do host da VPS a Pinnacle responde 403 por ASN).
 */
import { KtoScraper, BetWarriorScraper } from '../scraping/casa_kambi';
import { SuperbetScraper } from '../scraping/casa_superbet';
import { Aposta1Scraper } from '../scraping/casa_altenar';
import { PinnacleScraper } from '../scraping/casa_pinnacle';
import { BetBoomScraper } from '../scraping/casa_betboom';
import { SeuBetScraper } from '../scraping/casa_swarm';
import { ArbitrageEngine } from '../arbitrage/engine';
import { ehLinhaQuarter } from '../arbitrage/markets';
import { OddsScraper } from '../scraping/scraper_base';

(async () => {
  const esportes = process.argv[2] ? process.argv[2].split(',') : ['Volei', 'TenisDeMesa', 'Beisebol'];
  console.log(`>>> Teste Tier 1 — esportes: ${esportes.join(', ')}`);

  const scrapers: OddsScraper[] = [new KtoScraper(), new BetWarriorScraper(), new SuperbetScraper(), new Aposta1Scraper(), new BetBoomScraper(), new SeuBetScraper()];
  if (process.env.PINNACLE_PROXY) scrapers.push(new PinnacleScraper());
  else console.log('(Pinnacle pulada: PINNACLE_PROXY não setado — rode de dentro do container p/ incluí-la)');

  const fontes: Array<{ nome: string; odds: any[] }> = [];
  for (const s of scrapers) {
    try {
      const t0 = Date.now();
      const odds = await s.executarCrawler(esportes, ['Hoje'], true);
      const porEsporte: Record<string, number> = {};
      const porMercado: Record<string, number> = {};
      for (const o of odds) {
        porEsporte[o.esporte] = (porEsporte[o.esporte] || 0) + 1;
        porMercado[o.mercado] = (porMercado[o.mercado] || 0) + 1;
      }
      const quarters = odds.filter((o) => o.linha != null && ehLinhaQuarter(o.linha)).length;
      console.log(`\n=== ${s.getNome()}: ${odds.length} odds (${quarters} em quarter-line) em ${((Date.now() - t0) / 1000).toFixed(1)}s`, porEsporte);
      const topMercados = Object.entries(porMercado).sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.log('    mercados:', topMercados.map(([m, n]) => `${m}×${n}`).join(', '));
      for (const o of odds.slice(0, 3)) {
        console.log(`    ex: ${o.esporte} | ${o.evento} | ${o.mercado}${o.linha != null ? ' ' + o.linha : ''} | ${o.opcaoA}@${o.oddA} × ${o.opcaoB}@${o.oddB}`);
      }
      fontes.push({ nome: s.getNome(), odds });
    } catch (e: any) {
      console.error(`ERRO ${s.getNome()}:`, e.message);
    }
  }

  const engine = new ArbitrageEngine();
  const ops = await engine.encontrarMelhoresOportunidades(fontes.filter((f) => f.odds.length > 0));
  console.log(`\n### ${ops.length} oportunidade(s) do motor (já filtradas pelas Diretrizes de risco)`);
  for (const o of ops.slice(0, 20)) {
    console.log(
      ` ${o.lucroGarantidoPerc}% | ${o.esporte} | ${o.evento} | ${o.mercado} | ` +
      `${o.casaA}(${o.opcaoA}@${o.oddA}) × ${o.casaB}(${o.opcaoB}@${o.oddB}) | conf=${o.confianca}${o.alertaPrecisao ? ' ⚠ ' + o.alertaPrecisao : ''}`
    );
  }
  process.exit(0);
})();
