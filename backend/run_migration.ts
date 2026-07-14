import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

async function runMigration() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL not found');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    console.log('Connected to database.');

    const sqlPath = path.join(__dirname, 'src', 'migrations', '002_add_arbitrage_v2_fields.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');

    console.log('Running migration...');
    await client.query(sql);
    console.log('Migration applied successfully.');
  } catch (err: any) {
    console.error('Error applying migration:', err.message);
  } finally {
    await client.end();
  }
}

runMigration();
