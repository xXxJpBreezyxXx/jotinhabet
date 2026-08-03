/**
 * Smoke da REVALIDAÇÃO da Betsson: exercita o caminho de produção (RevalidationService →
 * SCRAPER_FACTORY → BetssonScraper.oddsDoEvento) e o gate `checarPernasAoVivo`.
 *
 * Uso: npx ts-node src/scripts/_smoke_betsson_reval.ts
 */
import { BetssonScraper } from '../scraping/casa_betsson';
import { RevalidationService, casaTemScraper, casaColetaAoVivo, casasComScraper } from '../core/revalidationService';
import { canonizarCasa } from '../signals/casasAliases';
import { ArbitrageScannerV2 } from '../core/scanner_v2';

(async () => {
  console.log('══ 1. fiação ══');
  console.log(`  canonizarCasa("Betsson (BR)") = ${canonizarCasa('Betsson (BR)')}`);
  console.log(`  casaTemScraper("Betsson")     = ${casaTemScraper('Betsson')}`);
  console.log(`  casaColetaAoVivo("Betsson")   = ${casaColetaAoVivo('Betsson')}`);
  console.log(`  está em casasComScraper()     = ${casasComScraper().includes('betsson')}`);
  const fontes = ArbitrageScannerV2.fontesDaVarredura();
  console.log(`  é FONTE da varredura de 5min  = ${fontes.api.includes('Betsson')} (api) / ${fontes.browser.includes('Betsson')} (browser)`);
  console.log(`  total de fontes agora         = ${fontes.todas.length}`);

  // Pega um evento real com duas pernas na Betsson para revalidar de verdade.
  const s = new BetssonScraper();
  const odds = await s.executarCrawler(['Futebol', 'Basquete'], ['hoje']);
  const alvo = odds.find((o) => o.esporte === 'Futebol' && o.mercado === 'Total de Gols');
  if (!alvo) {
    console.log('\n⚠️ sem evento de futebol/Total de Gols agora — nada a revalidar.');
    return;
  }

  console.log(`\n══ 2. oddsDaCasa (caminho de produção) ══`);
  console.log(`  alvo: ${alvo.evento} | ${alvo.mercado}@${alvo.linha} | ${alvo.opcaoA} @${alvo.oddA} × ${alvo.opcaoB} @${alvo.oddB}`);
  const rev = new RevalidationService();
  const t0 = Date.now();
  const pernas = await rev.oddsDaCasa('Betsson', alvo.evento, 'Futebol');
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s → ${pernas.length} ofertas re-buscadas`);
  for (const p of pernas.slice(0, 6)) {
    console.log(`    ${p.mercado}${p.linha !== undefined ? '@' + p.linha : ''} — ${p.opcaoA} @${p.oddA} × ${p.opcaoB} @${p.oddB}`);
  }
  // Memo de 60s: a 2ª chamada não deve bater na rede.
  const t1 = Date.now();
  await rev.oddsDaCasa('Betsson', alvo.evento, 'Futebol');
  console.log(`  2ª chamada (memo 60s): ${Date.now() - t1}ms`);

  console.log(`\n══ 3. gate checarPernasAoVivo (surebet sintética Betsson×Betsson) ══`);
  // Monta uma oportunidade com as odds REAIS das duas pernas do mesmo mercado. Não é
  // surebet (a margem da casa é positiva), então o gate DEVE suprimir — é o resultado
  // correto e prova que ele encontrou e mediu as duas pernas.
  const gate = await rev.checarPernasAoVivo({
    esporte: 'Futebol',
    evento: alvo.evento,
    mercado: alvo.mercado,
    linha: alvo.linha,
    casaA: 'Betsson',
    casaB: 'Betsson',
    opcaoA: alvo.opcaoA,
    opcaoB: alvo.opcaoB,
    oddA: alvo.oddA,
    oddB: alvo.oddB,
  } as any);
  console.log(`  ok=${gate.ok} motivo="${gate.motivo || '—'}"`);
  console.log(`  oddA=${(gate as any).oddA ?? '—'} oddB=${(gate as any).oddB ?? '—'} roi=${(gate as any).roi ?? '—'}`);
  const achouPernas = /roi|margem|suprimid|abaixo|sem lucro/i.test(gate.motivo || '') || gate.ok;
  console.log(`  → gate ${achouPernas ? 'ENCONTROU as duas pernas e mediu' : 'NÃO encontrou as pernas (revisar)'}`);
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
