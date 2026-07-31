/**
 * Smoke das SKILLS DE ODDS sem passar pelo LLM — valida o caminho real de scraper.
 *
 * 1. Pega um evento real do feed de uma casa de API (default KTO, sobrescrevível).
 * 2. Roda consultar_odds_casa nesse evento.
 * 3. Roda comparar_odds_casas (todas as casas de API/WS) e imprime a tabela.
 *
 * Uso:
 *   npx ts-node --transpile-only src/scripts/smoke_skills_odds.ts [esporte] ["Nome do evento"]
 */

import dotenv from 'dotenv';
dotenv.config();

import { RevalidationService } from '../core/revalidationService';
import { skillConsultarOddsCasa, skillCompararOddsCasas, skillListarCasas } from '../IA/agent/skills/odds';
import { KtoScraper } from '../scraping/casa_kambi';
import { ContextoSkills } from '../IA/agent/tipos';

async function main() {
  const esporte = process.argv[2] || 'Futebol';
  let evento = process.argv.slice(3).join(' ').trim();

  const ctx: ContextoSkills = { revalidation: new RevalidationService(), origem: 'smoke' };

  const casas: any = await skillListarCasas.executar({}, ctx);
  console.log(`🏠 ${casas.total_integradas} casas integradas | fonte do scanner: ${casas.integradas.filter((c: any) => c.fonte_scanner).length}`);

  if (!evento) {
    console.log(`\n🔎 pegando um evento de ${esporte} no feed da KTO...`);
    const odds = await new KtoScraper().executarCrawler([esporte], ['hoje']);
    if (!odds.length) {
      console.log('⚠️ feed da KTO vazio agora — passe o nome do evento como argumento.');
      return;
    }
    evento = odds[0].evento;
    console.log(`   evento escolhido: "${evento}" (${odds.length} odds no feed)`);
  }

  console.log(`\n=== consultar_odds_casa (KTO) ===`);
  const uma: any = await skillConsultarOddsCasa.executar({ casa: 'KTO', evento, esporte }, ctx);
  console.log(JSON.stringify(uma, null, 2).slice(0, 1500));

  console.log(`\n=== comparar_odds_casas ===`);
  const t0 = Date.now();
  const comp: any = await skillCompararOddsCasas.executar({ evento, esporte, max_casas: 8 }, ctx);
  console.log(`(${Date.now() - t0}ms)`);
  console.log(`casas com o evento: ${JSON.stringify(comp.casas_com_o_evento)}`);
  console.log(`casas sem o evento: ${JSON.stringify(comp.casas_sem_o_evento)}`);
  if (comp.falhas?.length) console.log(`falhas: ${JSON.stringify(comp.falhas)}`);
  console.log(`mercados comparados: ${comp.total_mercados_comparados} | surebets: ${comp.surebets_encontradas}`);
  for (const m of (comp.mercados || []).slice(0, 6)) {
    console.log(
      `  · ${m.mercado}${m.linha !== null ? ` ${m.linha}` : ''} | ${m.opcaoA} @${m.melhorA.odd} (${m.melhorA.casa}) × ` +
        `${m.opcaoB} @${m.melhorB.odd} (${m.melhorB.casa}) | soma ${m.somaProb}` +
        `${m.roiPct !== null ? ` → ROI ${m.roiPct}%` : ` (falta ${m.faltaPct}%)`}${m.bloqueio ? ` | 🚫 ${m.bloqueio}` : ''}`
    );
  }
}

main().catch((e) => {
  console.error('❌ smoke de skills falhou:', e);
  process.exit(1);
});
