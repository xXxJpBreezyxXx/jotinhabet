import { WhatsAppNotifier } from '../src/notify/whatsapp';

async function runNotifyTest() {
  console.log('🧪 Iniciando Teste de Integração com a Evolution API (WhatsApp)...');

  const recipient = process.env.EVOLUTION_RECIPIENT || '';

  if (!recipient || recipient.includes('xxxxx')) {
    console.error('\n⚠️ ATENÇÃO: O número de WhatsApp de destino está configurado como placeholder no seu .env.');
    console.log('👉 Por favor, abra o arquivo "backend/.env" e preencha a variável "EVOLUTION_RECIPIENT" com seu número de WhatsApp real (ex: EVOLUTION_RECIPIENT=5511999999999).');
    console.log('Depois de configurar, execute este teste de novo para receber o alerta no celular!\n');
    process.exit(1);
  }

  const notifier = new WhatsAppNotifier();
  
  // Dados simulados de uma surebet real no mercado de E-Sports (League of Legends)
  const mockAlert = {
    evento: 'LOUD vs paiN Gaming (CBLOL Playoffs)',
    mercado: 'Primeiro Abate (Mapa 1)',
    opcao1: 'LOUD',
    opcao2: 'paiN Gaming',
    odd1: 2.19,
    odd2: 2.30,
    stake1: 250.00,
    stake2: 238.00,
    investimento: 488.00,
    lucro: 59.50,
    roi: 12.19
  };

  console.log(`\n📬 Tentando enviar alerta para: ${recipient}`);
  
  const sucesso = await notifier.enviarAlerta(mockAlert);

  if (sucesso) {
    console.log('\n🌟 Alerta enviado com sucesso! Verifique seu celular para confirmar a formatação do WhatsApp.');
    process.exit(0);
  } else {
    console.error('\n❌ Falha ao enviar o alerta. Verifique os logs e garanta que a Evolution API está online e autenticada.');
    process.exit(1);
  }
}

runNotifyTest();
