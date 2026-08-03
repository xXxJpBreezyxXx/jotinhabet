/** Smoke da Betsson: coleta real + amostra por mercado + canônicos + busca dirigida. */
import { BetssonScraper } from '../scraping/casa_betsson';
import { normalizarMercado } from '../arbitrage/markets';
import { mercadoPermitido } from '../arbitrage/regras';

(async () => {
  const s = new BetssonScraper();
  const t0 = Date.now();
  const odds = await s.executarCrawler(['Futebol', 'Basquete', 'Tenis', 'Volei', 'TenisDeMesa', 'Beisebol', 'Esports'], ['hoje']);
  console.log(`\n⏱️  ${((Date.now() - t0) / 1000).toFixed(1)}s — ${odds.length} odds\n`);

  const porChave = new Map<string, { n: number; ex: any }>();
  for (const o of odds) {
    const k = `${o.esporte} | ${o.mercado}`;
    const at = porChave.get(k);
    if (at) at.n++;
    else porChave.set(k, { n: 1, ex: o });
  }
  console.log('══ mercados coletados ══');
  for (const [k, v] of [...porChave.entries()].sort()) {
    const canon = normalizarMercado(v.ex.mercado);
    const ok = mercadoPermitido(v.ex.esporte, v.ex.mercado);
    console.log(`${k.padEnd(34)} n=${String(v.n).padEnd(5)} canon=${canon.padEnd(24)} permitido=${ok ? 'sim' : 'NÃO'}`);
    console.log(`    ex: ${v.ex.evento} | linha=${v.ex.linha ?? '—'} | ${v.ex.opcaoA} @${v.ex.oddA} × ${v.ex.opcaoB} @${v.ex.oddB}`);
    console.log(`        ${v.ex.dataHora}  ${v.ex.url || '(sem url)'}`);
  }

  // Sanidade: nenhuma odd <= 1, nenhuma linha inteira, datas dentro da janela
  const ruins = odds.filter((o) => !(o.oddA > 1) || !(o.oddB > 1));
  const inteiras = odds.filter((o) => o.linha !== undefined && Math.abs(o.linha % 1) < 1e-9);
  const margemNeg = odds.filter((o) => 1 / o.oddA + 1 / o.oddB < 1).length;
  const fora = odds.filter((o) => {
    const t = Date.parse(o.dataHora);
    return !isNaN(t) && (t < Date.now() - 60000 || t > Date.now() + 49 * 3600 * 1000);
  });
  console.log(`\n══ sanidade ══`);
  console.log(`  odds <= 1: ${ruins.length} | linhas inteiras: ${inteiras.length} | fora da janela 48h: ${fora.length}`);
  console.log(`  pares com soma de probabilidades < 1 (surebet na PRÓPRIA casa, suspeito): ${margemNeg}`);
  if (fora.length) console.log(`    ex fora: ${fora.slice(0, 3).map((o) => o.dataHora).join(', ')}`);

  // Busca dirigida: com cache (atalho) e sem cache (processo novo)
  const alvo = odds.find((o) => o.esporte === 'Futebol');
  if (alvo) {
    console.log(`\n══ busca dirigida (com cache) — ${alvo.evento} ══`);
    const t1 = Date.now();
    const r = await s.oddsDoEvento(alvo.evento, 'Futebol');
    console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s → ${r.length} pernas: ${r.map((x) => `${x.mercado}${x.linha !== undefined ? '@' + x.linha : ''}`).join(', ')}`);

    const s2 = new BetssonScraper();
    console.log(`\n══ busca dirigida (SEM cache, processo novo) ══`);
    const t2 = Date.now();
    const r2 = await s2.oddsDoEvento(alvo.evento, 'Futebol');
    console.log(`  ${((Date.now() - t2) / 1000).toFixed(1)}s → ${r2.length} pernas`);

    console.log(`\n══ evento inexistente (deve devolver [] sem lançar) ══`);
    const r3 = await s2.oddsDoEvento('Time Que Nao Existe vs Outro Fantasma', 'Futebol');
    console.log(`  → ${r3.length} pernas (esperado 0)`);
  }
})().catch((e) => { console.error('❌', e); process.exit(1); });
