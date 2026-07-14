# PROMPT DE KICKOFF — MVP JotinhaBet (Sistema de Arbitragem Esportiva / Surebet)

> Cole este documento inteiro como primeira mensagem para o agente de código (Claude Code ou similar). Ele contém contexto de negócio, decisões técnicas já fechadas, guardrails de segurança e o roadmap de execução. Não pule as seções de segurança — elas são requisito, não sugestão.

---

## 1. Contexto do Projeto

**Nome do projeto: JotinhaBet**

Estou construindo um sistema pessoal de automação para identificar oportunidades de arbitragem esportiva (surebet) entre 2 casas de apostas, calcular o stake ideal em cada perna, e me notificar via WhatsApp para eu confirmar a aposta manualmente. **A execução da aposta é sempre humana — o sistema não aposta sozinho.**

Este é um projeto solo, rodando em VPS própria, com banco de dados self-hosted. Escopo do MVP: monolito simples, sem microserviços, sem Kubernetes.

---

## 2. Stack Técnica (decidida — não sugerir alternativas)

| Camada | Ferramenta |
|---|---|
| Linguagem | Python 3.12 |
| Scraping/Login | Playwright + Patchright (stealth) |
| Scheduler | APScheduler (cron interno, sem Celery) |
| Banco de dados | Supabase self-hosted (Postgres) na própria VPS |
| Notificação | Evolution API (WhatsApp próprio) |
| Hosting | VPS própria (já provisionada) |
| Secrets | Variáveis de ambiente + criptografia em coluna (ver seção 4) |

---

## 3. Escopo Funcional do MVP

1. **Módulo de login/coleta (2 casas de apostas)**: automação de login via Playwright/Patchright, captura e persistência de cookies/sessão por casa.
2. **Módulo de scraping de odds**: rotina agendada (5-10 min) que coleta odds do mercado pré-jogo (D+1) das 2 casas.
3. **Motor de cálculo de arbitragem**: identifica margem < 100%, calcula stake ótimo por perna, ROI e lucro esperado.
4. **Persistência**: grava oportunidades detectadas, histórico de odds, banca por casa, e operações confirmadas manualmente.
5. **Notificação via WhatsApp (Evolution API)**: envia alerta formatado com evento, stakes sugeridos, ROI e link/instrução rápida.
6. **Confirmação manual**: o usuário decide e registra o resultado da operação (não há clique automático de aposta neste MVP).

### Fora de escopo neste MVP (não implementar, não sugerir):
- Aposta automática (auto-click) nas casas.
- Múltiplas contas na mesma casa para "disfarçar" padrão de detecção — isso não faz parte do design, ponto final.
- Suporte a mais de 2 casas (fica para fase 2).

---

## 4. Requisitos de Segurança (não-negociáveis, valem desde o primeiro commit)

Como o sistema vai armazenar **login, senha e cookies de sessão** de contas reais de apostas, os seguintes pontos são obrigatórios desde o MVP, não "débito técnico para depois":

- **Nunca** armazenar senha em texto puro no banco. Usar criptografia simétrica (ex: `cryptography.Fernet` ou `pgcrypto` no próprio Postgres) com a chave mestra vindo de variável de ambiente / secrets manager da VPS — nunca commitada no repositório.
- Cookies de sessão também devem ser criptografados em repouso, não só a senha.
- `.env` no `.gitignore` desde o primeiro commit; incluir `.env.example` sem valores reais.
- Se o Supabase self-hosted expuser a REST API publicamente, habilitar Row Level Security (RLS) nas tabelas de credenciais desde a criação da tabela — não deixar para depois.
- Logs da aplicação **nunca** devem imprimir senha, cookie completo ou payload de login — mascarar antes de logar.
- Rotação: prever campo `updated_at` na tabela de credenciais para saber quando a sessão precisa ser renovada (login expira).

---

## 5. Modelo de Dados (schema inicial — Supabase/Postgres)

Peço que o agente gere as migrations para as tabelas abaixo (ajustando tipos conforme necessário):

- `casas_apostas` (id, nome, url_base, ativo)
- `contas` (id, casa_id FK, login_criptografado, senha_criptografada, cookies_criptografados, status [ativa/limitada/expirada], last_login_at)
- `banca_historico` (id, conta_id FK, saldo, snapshot_at)
- `odds_scan` (id, casa_id FK, evento, mercado, odd, coletado_em)
- `oportunidades` (id, evento, odd_casa_1, odd_casa_2, margem_mercado, stake_casa_1, stake_casa_2, lucro_esperado, roi_pct, status [detectada/notificada/executada/expirada], detectada_em)
- `operacoes` (id, oportunidade_id FK, stake_real_1, stake_real_2, resultado, lucro_real, confirmado_em) — preenchida manualmente pelo usuário após execução

---

## 6. Motor de Cálculo (lógica de referência)

```python
def calcular_arbitragem(banca_disponivel: float, odd1: float, odd2: float, taxa_max_stake: float = 0.5):
    v_t = banca_disponivel * taxa_max_stake
    inv1, inv2 = 1 / odd1, 1 / odd2
    margem = inv1 + inv2  # se < 1.0, há surebet real

    if margem >= 1.0:
        return None

    aposta1 = v_t * inv1 / margem
    aposta2 = v_t * inv2 / margem
    retorno_bruto = aposta1 * odd1
    lucro = retorno_bruto - v_t

    return {
        "aposta1": round(aposta1, 2),
        "aposta2": round(aposta2, 2),
        "lucro_esperado": round(lucro, 2),
        "roi_pct": round((lucro / v_t) * 100, 2),
        "margem_mercado": round((1 - margem) * 100, 2),
    }
```

Requisitos adicionais que o agente deve implementar em cima disso:
- Revalidação da odd no momento da notificação (não confiar só na odd coletada no scan, se já se passou tempo).
- Stake calculado por **banca da casa individual**, não por banca global somada.
- Arredondamento configurável por casa (algumas exigem múltiplos específicos de stake).

---

## 7. Estrutura de Pastas Sugerida

```
jotinhabet/
├── src/
│   ├── scraping/          # playwright/patchright, 1 módulo por casa
│   │   ├── casa_a.py
│   │   └── casa_b.py
│   ├── auth/              # login, gestão de sessão/cookies, criptografia
│   ├── core/               # motor de cálculo de arbitragem
│   ├── notify/             # integração Evolution API (WhatsApp)
│   ├── db/                 # models/queries Supabase
│   └── scheduler/          # jobs do APScheduler
├── migrations/
├── tests/
├── .env.example
└── README.md
```

---

## 8. Roadmap de Execução (siga nesta ordem, sem pular etapas)

1. **Setup do projeto**: estrutura de pastas, `.env.example`, conexão com Supabase self-hosted, migrations das tabelas da seção 5.
2. **Módulo de criptografia de credenciais** (seção 4) — implementar e testar isoladamente antes de qualquer scraping.
3. **Motor de cálculo** (seção 6) com testes unitários usando odds manuais — validar a lógica antes de conectar scraping.
4. **Módulo de login/sessão de 1 casa** (Playwright/Patchright) — persistir cookies criptografados, validar sessão ativa.
5. **Repetir para a 2ª casa.**
6. **Scraper de odds pré-jogo (D+1)** para as 2 casas + job agendado.
7. **Job de detecção de oportunidade**: cruza odds das 2 casas, chama o motor de cálculo, grava em `oportunidades`.
8. **Integração Evolution API**: envio de alerta formatado ao detectar oportunidade com margem positiva.
9. **Fluxo de confirmação manual**: endpoint/tabela simples para eu registrar o que de fato executei.
10. **Somente depois de 30-60 dias de dados reais**: revisar se faz sentido evoluir para mais casas ou qualquer nível adicional de automação.

---

## 9. Primeira Tarefa para o Agente

Comece pelo **item 1 do roadmap**: gerar a estrutura de pastas, o `.env.example`, o script de conexão com o Supabase self-hosted e as migrations SQL das tabelas da seção 5. Não avance para scraping ou criptografia até esse setup estar funcional e eu confirmar.
