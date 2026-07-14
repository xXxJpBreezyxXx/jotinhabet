import { ArbitrageScanner } from '../src/core/scanner';
import { supabase } from '../src/db/client';

async function runScraperTest() {
  console.log('🧪 Iniciando Teste de Varredura Completa de Arbitragem (Sem Login)...');

  const scanner = new ArbitrageScanner();
  
  try {
    // 1. Apaga oportunidades anteriores de teste para limpar o histórico do banco de dados local
    console.log('🧹 Limpando oportunidades antigas para teste limpo...');
    await supabase.from('oportunidades').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    // 2. Executa a varredura (Betano + Bet365 e cruzamento de 3 mercados futebol + 3 e-Sports)
    const opports = await scanner.executarVarredura();

    console.log('\n📊 RESULTADOS DO SCANNER DE TESTE:');
    console.log(`- Quantidade de surebets encontradas e salvas: ${opports.length}`);
    
    if (opports.length > 0) {
      console.log('\n📋 Detalhes das Surebets no Supabase:');
      for (const op of opports) {
        console.log(`👉 Evento: ${op.evento}`);
        console.log(`   ROI: ${op.roi_pct}% | Lucro Esperado: R$ ${op.lucro_esperado}`);
        console.log(`   Stakes Sugeridas: Casa 1 R$ ${op.stake_casa_1} | Casa 2 R$ ${op.stake_casa_2}\n`);
      }
      console.log('✅ SUCESSO: Integração de Scraping público + Banco de Dados concluída!');
    } else {
      console.log('⚠️ Nenhuma surebet viável encontrada nesta rodada (odds sem diferença suficiente).');
    }

    process.exit(0);
  } catch (err: any) {
    console.error('❌ Erro no teste de varredura:', err.message || err);
    process.exit(1);
  }
}

runScraperTest();
