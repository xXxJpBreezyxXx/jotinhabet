/**
 * Login one-shot no Telegram (MTProto/GramJS) — gera a TELEGRAM_SESSION.
 *
 * Uso:
 *   1. Crie um app em https://my.telegram.org/apps e preencha TELEGRAM_API_ID
 *      e TELEGRAM_API_HASH no backend/.env.
 *   2. npx ts-node --transpile-only src/scripts/telegram_login.ts
 *   3. Informe telefone (+55...), código recebido no app e senha 2FA (se tiver).
 *   4. Cole a session string impressa em TELEGRAM_SESSION no .env.
 *   5. Copie o ID do grupo de sinais da lista impressa no final para
 *      TELEGRAM_GRUPO_ID (supergrupos têm a forma -100xxxxxxxxxx).
 *
 * A sessão vale até você deslogá-la (Configurações → Dispositivos no app).
 * "Encerrar todas as outras sessões" no celular MATA esta sessão.
 */
import dotenv from 'dotenv';
dotenv.config();

import * as readline from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const perguntar = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  if (!Number.isFinite(apiId) || !apiHash || apiHash.includes('your-')) {
    console.error('❌ Preencha TELEGRAM_API_ID e TELEGRAM_API_HASH no .env antes (https://my.telegram.org/apps).');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => perguntar('📞 Telefone (com DDI, ex. +5511999999999): '),
    phoneCode: () => perguntar('🔑 Código recebido no Telegram: '),
    password: () => perguntar('🔒 Senha 2FA (Enter se não tiver): '),
    onError: (err) => console.error('❌ Erro no login:', err?.message || err),
  });

  console.log('\n✅ Logado! Cole a linha abaixo em TELEGRAM_SESSION no backend/.env:\n');
  console.log(client.session.save());

  console.log('\n📋 Seus grupos/canais (procure o grupo de sinais e copie o ID para TELEGRAM_GRUPO_ID):\n');
  const dialogs = await client.getDialogs({ limit: 100 });
  for (const d of dialogs) {
    if (d.isGroup || d.isChannel) {
      console.log(`   ${String(d.id).padEnd(18)} ${d.title}`);
    }
  }

  console.log('\nPronto. Preencha o .env e suba o backend — o listener liga sozinho.');
  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Falha no login:', e?.message || e);
  process.exit(1);
});
