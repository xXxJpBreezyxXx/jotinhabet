-- 001_initial_schema.sql
-- Migration to set up initial JotinhaBet schema.

-- Enable pgcrypto if it isn't enabled (useful for UUID generation and pg-side encryption if needed)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. CASAS DE APOSTAS
CREATE TABLE IF NOT EXISTS casas_apostas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT UNIQUE NOT NULL,
    url_base TEXT,
    ativo BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 2. CONTAS
CREATE TABLE IF NOT EXISTS contas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    casa_id UUID REFERENCES casas_apostas(id) ON DELETE CASCADE NOT NULL,
    login_criptografado TEXT NOT NULL,
    senha_criptografada TEXT NOT NULL,
    cookies_criptografados TEXT,
    status TEXT CHECK (status IN ('ativa', 'limitada', 'expirada')) DEFAULT 'ativa' NOT NULL,
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Enable RLS on credentials table as required by the security section
ALTER TABLE contas ENABLE ROW LEVEL SECURITY;

-- Create policy allowing only service role (authenticated backend) access
-- (By default, when RLS is enabled and no policy is created, all access is denied except for Superusers/Service Role bypass).
-- To make it explicit:
CREATE POLICY "Allow backend service role bypass" ON contas 
    FOR ALL 
    TO service_role 
    USING (true);

-- 3. BANCA HISTORICO
CREATE TABLE IF NOT EXISTS banca_historico (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conta_id UUID REFERENCES contas(id) ON DELETE CASCADE NOT NULL,
    saldo NUMERIC(12,2) NOT NULL,
    snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 4. ODDS SCAN
CREATE TABLE IF NOT EXISTS odds_scan (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    casa_id UUID REFERENCES casas_apostas(id) ON DELETE CASCADE NOT NULL,
    evento TEXT NOT NULL,
    mercado TEXT NOT NULL,
    odd NUMERIC(6,3) NOT NULL,
    coletado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 5. OPORTUNIDADES (Surebet opportunities detected by calculations)
CREATE TABLE IF NOT EXISTS oportunidades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evento TEXT NOT NULL,
    odd_casa_1 NUMERIC(6,3) NOT NULL,
    odd_casa_2 NUMERIC(6,3) NOT NULL,
    margem_mercado NUMERIC(5,2) NOT NULL, -- e.g., margin percentage under 100% or expected profit percentage
    stake_casa_1 NUMERIC(12,2) NOT NULL,
    stake_casa_2 NUMERIC(12,2) NOT NULL,
    lucro_esperado NUMERIC(12,2) NOT NULL,
    roi_pct NUMERIC(5,2) NOT NULL,
    status TEXT CHECK (status IN ('detectada', 'notificada', 'executada', 'expirada')) DEFAULT 'detectada' NOT NULL,
    detectada_em TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 6. OPERACOES (Manually confirmed bets by the user)
CREATE TABLE IF NOT EXISTS operacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    oportunidade_id UUID REFERENCES oportunidades(id) ON DELETE SET NULL,
    stake_real_1 NUMERIC(12,2) NOT NULL,
    stake_real_2 NUMERIC(12,2) NOT NULL,
    resultado TEXT, -- e.g., 'ganha_casa1', 'ganha_casa2', 'devolvida', 'perdida'
    lucro_real NUMERIC(12,2),
    confirmado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);
