import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('your-supabase-project') || supabaseKey.includes('your-supabase-service-role')) {
  console.warn(
    '\x1b[33m%s\x1b[0m',
    '⚠️ WARNING: Supabase URL or Key is not configured correctly in .env. Database operations will fail.'
  );
}

// Create and export the Supabase client
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder-key'
);
