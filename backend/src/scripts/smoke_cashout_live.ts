/**
 * Smoke-test das fontes AO VIVO do Radar Cashout (sem tocar banco/WhatsApp). Serve pra
 * validar, com um jogo EM ANDAMENTO real, os spikes do plano: Pinnacle live, KTO/Kambi
 * live e Betano /live/. Para cada fonte, roda oddsDoEvento em PRÉ-JOGO e AO VIVO e mostra
 * a diferença (a flag incluirAoVivo funcionando = o evento aparece só na coluna AO VIVO).
 *
 *   # 1) só ver as odds ao vivo de cada fonte p/ um confronto:
 *   npx ts-node --transpile-only src/scripts/smoke_cashout_live.ts "Alcaraz vs Sinner" Tenis
 *
 *   # 2) avaliação COMPLETA da aposta (justa + odd da casa + saque/hedge):
 *   #    args: "<evento>" <esporte> <casa> <selection> [market] [line] [oddEntrada] [stake]
 *   npx ts-node --transpile-only src/scripts/smoke_cashout_live.ts \
 *       "Alcaraz vs Sinner" Tenis KTO home "Resultado Final" "" 2.75 100
 *   npx ts-node --transpile-only src/scripts/smoke_cashout_live.ts \
 *       "Flamengo vs Palmeiras" Futebol Betano over "Total de Gols" 2.5 1.90 50
 *
 * Notas:
 *  - Pinnacle só responde com PINNACLE_PROXY setado (túnel Tailscale — de DENTRO do
 *    container do backend). Sem ele, a bússola sai vazia (403 por ASN).
 *  - Betano sobe um Chromium (precisa do playwright instalado no ambiente).
 *  - Futebol 1X2 (3 vias) não alinha (dupla chance sintética) — use 2 vias ou Total.
 */
import { PinnacleScraper } from '../scraping/casa_pinnacle';
import { KtoScraper, BetWarriorScraper } from '../scraping/casa_kambi';
import { BetanoScraper } from '../scraping/casa_a';
import { ScrapedOdd } from '../scraping/scraper_base';
import { areEventsSame } from '../arbitrage/matcher';
import { justaAoVivo, oddCasaAoVivo, casasComFonteLive, type ApostaRef } from '../cashout/cashoutSources';
import { estimateCashout, CASHOUT_ESTIMATE_CONFIG, type CashoutSelection } from '../cashout/cashoutEngine';

function fmtOdds(odds: ScrapedOdd[], evento: string): string {
  const casados = odds.filter((o) => areEventsSame(o.evento, evento));
  if (!casados.length) return odds.length ? `0 casaram (feed trouxe ${odds.length} outros eventos)` : 'feed vazio';
  return casados
    .map((o) => `    • ${o.mercado}${o.linha != null ? ' ' + o.linha : ''} | ${o.opcaoA}@${o.oddA?.toFixed?.(2) ?? o.oddA} × ${o.opcaoB}@${o.oddB?.toFixed?.(2) ?? o.oddB}`)
    .join('\n');
}

/** Roda oddsDoEvento numa fonte em PRÉ-JOGO e AO VIVO, imprimindo lado a lado. */
async function compararFonte(
  nome: string,
  makePre: () => { oddsDoEvento(e: string, s?: string): Promise<ScrapedOdd[]> },
  makeLive: () => { oddsDoEvento(e: string, s?: string): Promise<ScrapedOdd[]> },
  evento: string,
  esporte: string
): Promise<void> {
  console.log(`\n=== ${nome} ===`);
  for (const [rotulo, make] of [['PRÉ-JOGO', makePre], ['AO VIVO', makeLive]] as const) {
    try {
      const t0 = Date.now();
      const odds = await make().oddsDoEvento(evento, esporte);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const casados = odds.filter((o) => areEventsSame(o.evento, evento));
      console.log(`  [${rotulo}] ${casados.length} casaram em ${dt}s`);
      if (casados.length) console.log(fmtOdds(odds, evento));
    } catch (e: any) {
      console.log(`  [${rotulo}] ERRO: ${e?.message}`);
    }
  }
}

(async () => {
  const evento = process.argv[2];
  const esporte = process.argv[3] || 'Futebol';
  if (!evento) {
    console.error('Uso: smoke_cashout_live.ts "<Time A vs Time B>" <Esporte> [casa] [selection] [market] [line] [oddEntrada] [stake]');
    process.exit(1);
  }
  console.log(`>>> Smoke cashout AO VIVO — "${evento}" (${esporte})`);
  console.log(`    casas com odd ao vivo integrada: ${casasComFonteLive().join(', ')}`);
  if (!process.env.PINNACLE_PROXY) console.log('    ⚠️ PINNACLE_PROXY ausente — a bússola (Pinnacle) sairá vazia. Rode de dentro do container do backend.');

  // 1) Compara pré-jogo × ao vivo em cada fonte leve (a Betano é dirigida e cara → só ao vivo).
  await compararFonte(
    'Pinnacle (bússola)',
    () => new PinnacleScraper(),
    () => new PinnacleScraper({ incluirAoVivo: true }),
    evento, esporte
  );
  await compararFonte(
    'KTO (Kambi)',
    () => new KtoScraper(),
    () => new KtoScraper({ incluirAoVivo: true }),
    evento, esporte
  );
  await compararFonte(
    'BetWarrior (Kambi)',
    () => new BetWarriorScraper(),
    () => new BetWarriorScraper({ incluirAoVivo: true }),
    evento, esporte
  );
  console.log('\n=== Betano (navegador — só AO VIVO dirigido) ===');
  try {
    const t0 = Date.now();
    const odds = await new BetanoScraper({ incluirAoVivo: true }).oddsDoEvento(evento, esporte);
    const casados = odds.filter((o) => areEventsSame(o.evento, evento));
    console.log(`  [AO VIVO] ${casados.length} casaram em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (casados.length) console.log(fmtOdds(odds, evento));
  } catch (e: any) {
    console.log(`  [AO VIVO] ERRO: ${e?.message}`);
  }

  // 2) Avaliação COMPLETA da aposta (se casa+selection forem passados).
  const casa = process.argv[4];
  const selection = process.argv[5] as CashoutSelection | undefined;
  if (casa && selection) {
    const market_label = process.argv[6] || 'Resultado Final';
    const line = process.argv[7] ? Number(process.argv[7]) : null;
    const oddEntrada = process.argv[8] ? Number(process.argv[8]) : NaN;
    const stake = process.argv[9] ? Number(process.argv[9]) : 0;
    const ref: ApostaRef = { event_label: evento, sport: esporte, market_label, selection, line };

    console.log(`\n>>> Avaliação da aposta: ${casa} | ${market_label}${line != null ? ' ' + line : ''} | ${selection} | entrada ${oddEntrada || '—'} | stake ${stake || '—'}`);
    const justa = await justaAoVivo(ref).catch((e) => { console.log('  justaAoVivo ERRO:', e?.message); return null; });
    if (!justa) {
      console.log('  ❌ bússola sem o evento ao vivo (ou mercado 3 vias não suportado).');
    } else {
      console.log(`  🧭 justa ao vivo: prob ${(justa.fairProb * 100).toFixed(1)}% → odd ${justa.fairOdd.toFixed(2)} | oposto justo ${justa.oddOposto?.toFixed(2) ?? '—'}`);
      const casaOdd = await oddCasaAoVivo(ref, casa).catch(() => null);
      console.log(`  🏠 odd da ${casa} ao vivo: ${casaOdd?.odd?.toFixed(2) ?? '—'} | oposto ${casaOdd?.oddOposto?.toFixed(2) ?? '—'}`);
      if (Number.isFinite(oddEntrada)) {
        const est = estimateCashout({
          stake, oddEntrada, fairProbNow: justa.fairProb,
          oddCasaNow: casaOdd?.odd ?? null, oddOpostoNow: casaOdd?.oddOposto ?? justa.oddOposto ?? null,
        }, CASHOUT_ESTIMATE_CONFIG);
        console.log(`  💰 estimateCashout:`, {
          dropDesdeEntrada: `${(est.dropPctSinceEntry * 100).toFixed(1)}%`,
          valorJusto: est.fairValue.toFixed(2),
          saqueEstimadoCasa: est.houseCashout?.toFixed(2) ?? '—',
          lucro: (est.houseProfit ?? est.fairProfit).toFixed(2),
          sacarAgora: est.sacarAgora,
          hedge: est.hedge ? `banque ${est.hedge.stakeHedge.toFixed(2)} @ ${est.hedge.oddOposto.toFixed(2)} (lucro ${est.hedge.lucroTravado.toFixed(2)})` : '—',
        });
      }
    }
  }

  console.log('\n>>> Fim do smoke-test.');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
