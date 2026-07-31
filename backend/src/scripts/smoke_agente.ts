/**
 * Smoke do Agente (aba IA & Automação) — roda o loop de ferramentas de verdade contra
 * o provedor configurado e imprime as skills usadas.
 *
 * Uso:
 *   npx ts-node --transpile-only src/scripts/smoke_agente.ts "sua pergunta aqui"
 *
 * Sem argumento roda um roteiro fixo que exercita conhecimento + calculadora de
 * promoção + catálogo de casas (sem tocar em scraper, para não subir Chromium).
 */

import dotenv from 'dotenv';
dotenv.config();

import { rodarAgente } from '../IA/agent/agentLoop';
import { RevalidationService } from '../core/revalidationService';
import { skillsParaUI } from '../IA/agent/registry';
import { cadeiaAgente } from '../IA/agent/chatModels';
import { catalogoCasas } from '../IA/agent/catalogoCasas';

const PERGUNTAS_PADRAO = [
  'Quais casas de apostas você consegue consultar odds e quais delas dão odd ao vivo?',
  'Tenho uma freebet de R$ 10 na Joga Junto e peguei odd 7.75. A cobertura na Superbet está 1.06. Quanto eu cubro e qual o lucro? Valeu a pena essa odd?',
  'Quero fazer uma múltipla qualificadora de R$ 50 com odd total mínima 4.00 e 3 pernas de 1.59, cada uma resolvendo num horário diferente, com cobertura em 2.70. Como fica a cobertura sequencial?',
];

async function main() {
  const pergunta = process.argv.slice(2).join(' ').trim();
  const perguntas = pergunta ? [pergunta] : PERGUNTAS_PADRAO;

  console.log(`🔗 cadeia do agente: ${cadeiaAgente().join(' → ')}`);
  console.log(`🛠️ ${skillsParaUI().length} skills | 🏠 ${catalogoCasas().length} casas integradas\n`);

  const revalidation = new RevalidationService();
  const historico: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const p of perguntas) {
    console.log(`\n===================\n👤 ${p}\n`);
    historico.push({ role: 'user', content: p });
    const t0 = Date.now();
    const r = await rodarAgente(historico, revalidation);
    const ms = Date.now() - t0;
    for (const passo of r.passos) {
      console.log(`   🛠️ ${passo.skill} (${passo.ms}ms) → ${passo.resumo}`);
    }
    if (r.avisos.length) console.log(`   ⚠️ ${r.avisos.join(' | ')}`);
    console.log(`\n🤖 [${r.provider}/${r.modelo} · ${ms}ms]\n${r.reply}\n`);
    historico.push({ role: 'assistant', content: r.reply });
  }
}

main().catch((e) => {
  console.error('❌ smoke do agente falhou:', e);
  process.exit(1);
});
