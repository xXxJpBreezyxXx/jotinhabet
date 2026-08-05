-- 022: tipos FREEBET_SRR, SUPERODD e LUCRO_EXTRA + tetos de regulamento.
-- Cada tipo é uma definição DIFERENTE de retorno bruto da perna promocional, com
-- S = stake elegível (min(stake, teto_stake)) e v = valor do bônus/ficha em 0..1:
--   FREEBET_SRR  R = S×(odd−1+v), custo 0 — a ficha VOLTA (v=1 → S×odd, e aí a
--                retenção passa de 100%); ler como SNR paga metade da cobertura.
--   SUPERODD     em dinheiro R = S×odd, custo S (a odd turbinada JÁ contém o
--                excedente); em bônus R = S×odd_padrao + v×S×(odd−odd_padrao).
--   LUCRO_EXTRA  R = S×odd + v×min(boost_pct×S×(odd−1), teto_extra), custo S
--                (boost_sobre_stake troca a base do % de lucro para a stake).
-- teto_incide_sobre='GANHO' limita só o LUCRO; 'RETORNO' limita o pagamento inteiro
-- — não é a mesma fórmula, e trocar as duas manda aportar mais do que a casa paga.
-- Tudo é idempotente (ADD IF NOT EXISTS / DROP CONSTRAINT antes de recriar): o runner
-- db/migrate.ts roda TODAS as migrations dentro de um único try, então uma falha aqui
-- aborta as seguintes.

-- CHECK recriado com os 6 valores de PROMO_TYPES_BANCO (core/promocoes.ts). O nome é o
-- mesmo que a 020 gerou implicitamente e a 021 recriou — daí o DROP IF EXISTS.
ALTER TABLE promo_surebets DROP CONSTRAINT IF EXISTS promo_surebets_promo_type_check;
ALTER TABLE promo_surebets
    ADD CONSTRAINT promo_surebets_promo_type_check
    CHECK (promo_type IN ('FREEBET_SNR', 'FREEBET_SRR', 'QUALIFYING', 'PROTECAO', 'SUPERODD', 'LUCRO_EXTRA'));

-- FREEBET_SRR: quanto vale a ficha devolvida no green (100 = dinheiro sacável,
-- 70 = a ficha volta como bônus). É o v da fórmula; sem gravar, a linha não reproduz.
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS valor_ficha_pct NUMERIC(6,2);

-- SUPERODD: odd NORMAL do mesmo mercado (sem boost). Mede o excedente e a margem real.
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS odd_padrao NUMERIC(8,3);

-- Teto de stake elegível ("super odd até R$ 30"): a conta vale só até aqui, o excedente
-- entraria na odd normal da casa (qualificativa com prejuízo colada na operação).
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS teto_stake NUMERIC(12,2);

-- LUCRO_EXTRA: % do extra e a base sobre a qual ele incide.
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS boost_pct NUMERIC(6,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS boost_sobre_stake BOOLEAN NOT NULL DEFAULT false;

-- Teto do extra em reais: corta a FACE, ANTES da valorização do bônus (invertendo a
-- ordem, min(v×extra, teto) devolve mais do que a casa paga sempre que o teto morde).
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS teto_extra NUMERIC(12,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS extra_em_bonus BOOLEAN NOT NULL DEFAULT false;
-- Quanto vale R$ 1 desse bônus, em % (default 70). ZERO é valor válido: bônus que não
-- dá para converter — e aí a promoção não paga a operação.
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS valor_extra_pct NUMERIC(6,2);

-- Teto de ganho/retorno do regulamento (qualquer tipo).
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS teto_ganho NUMERIC(12,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS teto_incide_sobre TEXT;
-- NULL passa (a esmagadora maioria das linhas não tem teto); só GANHO/RETORNO são
-- leituras válidas do regulamento.
ALTER TABLE promo_surebets DROP CONSTRAINT IF EXISTS promo_surebets_teto_incide_sobre_check;
ALTER TABLE promo_surebets
    ADD CONSTRAINT promo_surebets_teto_incide_sobre_check
    CHECK (teto_incide_sobre IS NULL OR teto_incide_sobre IN ('GANHO', 'RETORNO'));

-- Devolução que cai nos DOIS cenários (raro, mas existe): sem gravar isso, toda linha é
-- relida como devolução condicional e o aporte reconstruído sai errado — com R$ 50
-- incondicionais numa stake de 100 @2,00 × 2,10 o aporte certo é 95,24 e o condicional 71,43.
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS cashback_so_se_perder BOOLEAN NOT NULL DEFAULT true;

-- Derivados do core (fonte única): face e valor efetivo do extra, e a odd que o retorno
-- bruto implica já com boost e tetos. Ficam gravados para o histórico não ter de
-- reimplementar o boost — cada camada que recalcula acaba divergindo do que foi executado.
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS extra_nominal NUMERIC(12,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS extra_efetivo NUMERIC(12,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS odd_efetiva_promo NUMERIC(8,3);

-- Stake que a promoção REALMENTE aceitou (min(valor_promocao, teto_stake)). valor_promocao
-- continua sendo o que o usuário digitou, então sem esta coluna todo leitor da tabela tem de
-- lembrar de aplicar o teto: o card "Investido" somava R$ 128,57 numa operação em que só
-- R$ 58,57 foram à mesa (super odd de R$ 100 com teto de R$ 30), e o ROI da linha não fechava
-- com o roi_pct gravado ao lado.
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS stake_elegivel NUMERIC(12,2);

GRANT ALL ON promo_surebets TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
