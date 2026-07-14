import { Client } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL not found in env');
    process.exit(1);
  }

  console.log('Connecting to database...');
  const client = new Client({ connectionString });
  try {
    await client.connect();
    console.log('Connected. Adding columns...');
    
    await client.query('ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS esporte TEXT;');
    await client.query('ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS url TEXT;');
    
    console.log('Columns esporte and url added successfully!');
  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

run();
