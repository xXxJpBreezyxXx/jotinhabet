import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL não configurada no .env');
    process.exit(1);
  }

  console.log('🔄 Conectando ao banco de dados para rodar as migrações...');
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const migrationsDir = path.resolve(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      console.log(`📦 Executando migração: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      
      // Executa o script SQL
      await client.query(sql);
      console.log(`✅ Migração ${file} concluída com sucesso!`);
    }

    // Recarrega o schema cache do PostgREST para que colunas recém-adicionadas
    // fiquem imediatamente visíveis à REST API (supabase-js). Sem isso, chamadas
    // podem falhar com "Could not find the '<col>' column ... in the schema cache".
    try {
      await client.query("NOTIFY pgrst, 'reload schema';");
      console.log('🔄 PostgREST schema cache: reload solicitado.');
    } catch (notifyErr: any) {
      console.warn('⚠️ Não foi possível notificar o PostgREST para recarregar o schema:', notifyErr.message);
    }

    console.log('🎉 Todas as migrações foram aplicadas com sucesso!');
  } catch (err: any) {
    console.error('❌ Erro durante as migrações:', err.message);
  } finally {
    await client.end();
  }
}

migrate();
