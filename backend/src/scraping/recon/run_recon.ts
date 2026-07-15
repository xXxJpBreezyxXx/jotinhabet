/**
 * Runner standalone do reconhecimento de feeds de odds.
 *
 * Uso (rodar numa máquina com IP brasileiro — .bet.br é geobloqueado):
 *   npx ts-node src/scraping/recon/run_recon.ts            # todas as casas
 *   npx ts-node src/scraping/recon/run_recon.ts blaze       # uma casa (smoke)
 *
 * Saída: um JSON por casa em backend/logs/recon/<casa>.json (gitignored) +
 * uma tabela ranqueada por scoreFinal (facilidade × cobertura + bônus de plataforma).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CASAS_ALVO, acharCasa } from './casas_alvo';
import { ReconProbe } from './probe_harness';
import { bonusPlataformaCompartilhada } from './platform_signatures';
import { ReconReport } from './tipos';

const OUT_DIR = path.resolve(__dirname, '../../../logs/recon');

async function main() {
  const arg = process.argv[2];
  const casas = arg ? [acharCasa(arg)].filter(Boolean) : CASAS_ALVO;

  if (arg && casas.length === 0) {
    console.error(`❌ Casa "${arg}" não encontrada. Opções: ${CASAS_ALVO.map((c) => c.nome).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n🛰️  Recon iniciado — ${casas.length} casa(s). Saída em ${OUT_DIR}\n`);

  const probe = new ReconProbe();
  const relatorios: ReconReport[] = [];

  // Sequencial (1 casa por vez) — evita concorrência agressiva e footprint anti-bot.
  for (const casa of casas) {
    if (!casa) continue;
    const rel = await probe.probe(casa);
    relatorios.push(rel);
    try {
      const arquivo = path.join(OUT_DIR, `${casa.nome.toLowerCase()}.json`);
      fs.writeFileSync(arquivo, JSON.stringify(rel, null, 2));
    } catch (e: any) {
      console.error(`   ⚠️ Falha ao gravar relatório de ${casa.nome}: ${e.message}`);
    }
  }

  // Bônus de plataforma compartilhada: quantas casas usam cada plataforma.
  const contagemPlataforma: Record<string, number> = {};
  for (const r of relatorios) {
    if (r.ok && r.plataformaProvavel !== 'desconhecida' && r.plataformaProvavel !== 'proprietaria') {
      contagemPlataforma[r.plataformaProvavel] = (contagemPlataforma[r.plataformaProvavel] || 0) + 1;
    }
  }
  for (const r of relatorios) {
    const bonus = bonusPlataformaCompartilhada(r.plataformaProvavel, contagemPlataforma);
    r.scoreFinal = (r.facilidadeScore + bonus) * r.pesoCobertura;
  }

  imprimirTabela(relatorios);
  imprimirResumoPlataformas(contagemPlataforma);
  console.log(`\n✅ Recon concluído. Relatórios completos em ${OUT_DIR}\n`);
}

function pad(s: string, n: number): string {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

function imprimirTabela(relatorios: ReconReport[]) {
  const ordenados = [...relatorios].sort((a, b) => b.scoreFinal - a.scoreFinal);
  console.log('\n════════════════ RANKING DE FACILIDADE ════════════════\n');
  console.log(
    pad('CASA', 16) +
      pad('SCORE', 7) +
      pad('AUTH', 15) +
      pad('PLATAFORMA', 14) +
      pad('BOT', 14) +
      pad('FEED (host)', 28)
  );
  console.log('─'.repeat(94));
  for (const r of ordenados) {
    if (!r.ok) {
      console.log(pad(r.casa, 16) + pad('—', 7) + pad('FALHOU', 15) + pad('', 14) + pad('', 14) + pad(r.erro || '', 28));
      continue;
    }
    console.log(
      pad(r.casa, 16) +
        pad(String(r.scoreFinal), 7) +
        pad(r.auth, 15) +
        pad(r.plataformaProvavel, 14) +
        pad(r.botProtection.join(','), 14) +
        pad(r.feedPrincipal?.host || '(nenhum)', 28)
    );
  }
  console.log('─'.repeat(94));
  console.log('Legenda auth: publico > precisa_cookie > precisa_token > so_browser');
}

function imprimirResumoPlataformas(contagem: Record<string, number>) {
  const compartilhadas = Object.entries(contagem)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]);
  if (compartilhadas.length === 0) return;
  console.log('\n🔗 Plataformas compartilhadas (reverter uma libera várias casas):');
  for (const [plat, n] of compartilhadas) {
    console.log(`   • ${plat}: ${n} casas`);
  }
}

main().catch((e) => {
  console.error('❌ Erro fatal no recon:', e);
  process.exit(1);
});
