import { SessionManager } from '../src/scraping/casa_a';
import { supabase } from '../src/db/client';

async function runSessionTests() {
  console.log('🧪 Iniciando Integração e Testes do Módulo de Sessão (Playwright)...\n');

  // 1. Garantir que as casas de apostas padrão estão cadastradas no Supabase
  console.log('1. Verificando e cadastrando as Casas de Apostas padrão no banco...');
  
  const casasPadrao = [
    { nome: 'Bet365', url_base: 'https://www.bet365.com', ativo: true },
    { nome: 'Betano', url_base: 'https://br.betano.com', ativo: true }
  ];

  for (const casa of casasPadrao) {
    const { data: existente } = await supabase
      .from('casas_apostas')
      .select('*')
      .eq('nome', casa.nome)
      .maybeSingle();

    if (!existente) {
      const { data: inserida, error } = await supabase
        .from('casas_apostas')
        .insert(casa)
        .select()
        .single();
      
      if (error) {
        console.error(`❌ Erro ao cadastrar ${casa.nome}:`, error.message);
      } else {
        console.log(`✅ Cadastrada casa de apostas: ${casa.nome} (ID: ${inserida.id})`);
      }
    } else {
      console.log(`ℹ️ Casa de apostas já existente: ${casa.nome} (ID: ${existente.id})`);
    }
  }

  // 2. Inicializar o gerenciador de sessão da Betano (Casa A)
  console.log('\n2. Inicializando SessionManager para a Betano...');
  const manager = new SessionManager('Betano', 'https://br.betano.com');

  console.log('✅ Instanciação do SessionManager concluída com sucesso!');
  console.log('\n🌟 Para testar um fluxo de login real com o navegador Playwright:');
  console.log('   - Você precisa criar uma Conta com login e senha na tabela "contas" do Supabase.');
  console.log('   - As credenciais devem ser gravadas criptografadas usando a ferramenta de criptografia.');
  
  process.exit(0);
}

runSessionTests().catch(err => {
  console.error('❌ Erro durante o teste de sessão:', err);
  process.exit(1);
});
