# Análise de assertividade — SureRadar & Cashout

_Gerado em 2026-07-25 por varredura multi-agente com verificação adversarial (Claude Code)._

**18 achados confirmados** (7 alta, 11 média) · **2 refutados** · **7 corrigidos nesta sessão**.

Cada achado foi lido no código real e um verificador adversarial tentou refutá-lo antes de entrar aqui.

---

## ✅ Corrigidos nesta sessão

### #4 [MEDIA] Reconfirmação de surebet ativa não atualiza odds/ROI — radar mostra odd velha com carimbo de fresca
`scanner_v2.ts:446`

**Correção aplicada:** Reconfirmação agora atualiza odd_casa_1/2, roi_pct, stake e lucro_esperado (não só visto_em).

### #5 [MEDIA] Reconciliação do SureRadar não limpa nada quando a lista autoritativa vem vazia
`scanner_v2.ts:690`

**Correção aplicada:** reconciliarSureRadar(…, fonteAutoritativa=true): lista vazia da API limpa o radar.

### #6 [MEDIA] alertKey inclui ROI com 1 casa decimal e casas sem ordenação — duplicatas no ciclo deleta/reinsere
`scanner_v2.ts:507`

**Correção aplicada:** alertKey com casas ordenadas e SEM o ROI (evita alerta duplicado no ciclo deleta/reinsere).

### #9 [ALTA] Linha com vírgula decimal ("2,5") é truncada para o inteiro e casa a linha ERRADA por match exato
`revalidationService.ts:249`

**Correção aplicada:** linhaEmbutida/linhaDaOpcao normalizam vírgula→ponto ('2,5'→2.5). +teste.

### #13 [MEDIA] Memo de 60s permite alertar com perna A fresca e perna B de até ~2 min atrás (e reusa [] de falha)
`revalidationService.ts:164`

**Correção aplicada:** oddsDoEventoMemo não cacheia lista vazia (falha transitória não envenena 60s).

### #14 [MEDIA] Quarter-line (.25/.75): caminho da lista SureRadar não aplica o piso e a opp SureRadar nunca carrega linha
`revalidationService.ts:374`

**Correção aplicada:** Caminho da lista SureRadar aplica o piso de quarter-line (.25/.75).

### #18 [MEDIA] alignOdd pode inverter home/away: orientação decidida com OR e sem tratamento de ambiguidade
`cashoutMatch.ts:95`

**Correção aplicada:** alignOdd pontua as duas pontas; homônimos ambíguos → null (não inverte home/away). +teste.

---

## 🔧 Backlog priorizado (precisam de decisão de produto / iteração ao vivo / migração)

### #1 [ALTA] Gate de alerta só roda no INSERT: supressão não-infra vira silêncio de até 24h
`scanner_v2.ts:441`

- **Problema:** A decisão de alertar (janela 48h, ehPreJogo, ROI, confiança, teto MAX_ALERTAS_MOTOR, revalidação) só é avaliada quando a oportunidade é INSERIDA. Se a linha já existe ('existingId' → atualiza visto_em e `continue`, linhas 441-451), o gate nunca roda de novo. Só a supressão por falha de INFRA deleta a linha para re-gate (linhas 525-531). Casos não cobertos: (a) oportunidade detectada com kickoff além de 48h — entra no banco, não alerta, e quando entra na janela já existe → nunca alerta até a limpeza de 24h (detectada_em) deletar e reinserir; (b) oportunidade nº 7+ cortada pelo teto de 6 — inserida sem alerta, nunca reavaliada; (c) revalidação com ROI momentâneo < 1.5% (arb viva, não é infra) — linha mantida, sem re-gate se o ROI voltar; (d) `enviarAlerta` retorna success=false (falha do WhatsApp) — alertKey não é marcado, mas a linha existe → o alerta nunca é retentado.
- **Impacto:** Falsos negativos sistêmicos: oportunidades reais e dentro da janela ficam sem alerta por até 24 horas (tempo de vida da linha no banco), justamente na classe de arbs de vida curta em que 24h equivale a perder a oportunidade de vez.
- **Sugestão:** Avaliar o gate de alerta também no caminho de reconfirmação (existingId): manter uma flag 'alertado' (ou consultar o alertCache pela chave) e, se a linha ainda não foi alertada e agora passa nos gates (entrou na janela, sobrou teto, ROI revalidado >= 1.5), disparar o alerta. Alternativa mínima: além de infra, deletar para re-gate também nos casos de teto estourado, fora da janela e falha de envio.

### #2 [ALTA] Revalidação pré-alerta do SureRadar é tautológica para casas sem scraper (cache semeado com a própria extração)
`scanner_v2.ts:338`

- **Problema:** O scanner semeia o cache do revalidador com a MESMA extração do scan (`seedSureRadarCache(srOps, ...)`, linha 338; revalidationService.ts linhas 136-141, TTL 60s). Em `checarPernasAoVivo`, oportunidades SureRadar cujo par de casas não está inteiro no SCRAPER_FACTORY (ex.: bet365, Betfair, Novibet) — ou cujo mercado cai em 'DESCONHECIDO' no `normalizarMercado` (revalidationService.ts linhas 344-346) — usam o fallback da lista (linhas 355-375), que dentro dos 60s do seed devolve exatamente a lista de onde a oportunidade saiu. A 'revalidação' então compara a surebet com ela mesma e sempre confirma, e o alerta ainda sai com a nota '✅ Revalidada agora nas casas (odds ao vivo)' (linha 580).
- **Impacto:** Falsos positivos: a lista do SureRadar tem até ~10 min de idade (o próprio código admite isso nas linhas 341-342 do revalidationService); odds já corrigidas/removidas nas casas passam pelo gate como 'revalidadas ao vivo', e o apostador chega na casa e a odd não existe. O gate anti-defasagem, razão de existir da revalidação, vira no-op exatamente nas casas onde não há como conferir.
- **Sugestão:** No gate pré-alerta, distinguir confirmação real de tautologia: quando a confirmação vier do fallback da lista e a lista em cache for a MESMA extração da varredura corrente (marcar o seed com um id de varredura), não tratar como revalidação — ou re-extrair de fato o SureRadar, ou alertar com tag '⚠️ não revalidado' (como já se faz para sinais do Telegram), ou suprimir. E corrigir a nota do alerta para não afirmar 'odds ao vivo' quando a fonte foi a lista agregada.

### #3 [ALTA] sb.line descartado na conversão do SureRadar: dedupe/reconciliação colidem linhas diferentes do mesmo mercado
`casa_sureradar.ts:225`

- **Problema:** `converterSurebet` ignora completamente `sb.line`: o mercado vira só `market_label` (linha 225) e `opp.linha` nunca é setada. No scanner, o dedupe de banco usa evento+casas+mercado (scanner_v2.ts linhas 420-431, sem opcao_a/opcao_b), a assinatura de reconciliação usa evento+casas+mercado (linhas 638-643) e a alertKey usa evento+mercado+casas+ROI (linha 507). Duas surebets simultâneas do mesmo jogo, mesmo par de casas e mesmo mercado de totais, mas com linhas diferentes (ex.: Over/Under 2.25 e Over/Under 2.5 — comum no SureRadar), têm chaves idênticas.
- **Impacto:** Falso negativo: a segunda linha é descartada como 'já ativa' e nunca é inserida nem alertada. Falso positivo: na reconciliação, a assinatura da linha morta continua 'válida' enquanto a outra linha viver — a oportunidade defasada fica no radar. Bônus: sem `opp.linha`, o aviso de quarter-line (.25/.75) do alerta (scanner_v2.ts linhas 582-584) nunca aparece para oportunidades do SureRadar.
- **Sugestão:** Propagar `sb.line`: setar `linha` no ArbitrageOpportunity e/ou concatenar a linha ao mercado (ex.: `market_label + ' ' + line`), e incluir a linha (ou as opções) no dedupe de banco, na assinaturaSurebet e na alertKey.

### #8 [ALTA] Scrapers de API engolem falha de infra em oddsDoEvento e o gate suprime a arb para sempre
`revalidationService.ts:425`

- **Problema:** Todos os oddsDoEvento de casas de API (casa_kambi.ts ~l.240, casa_superbet.ts, casa_pinnacle.ts, casa_betboom.ts, casa_swarm.ts, casa_altenar.ts, casa_esportesdasorte.ts) fazem catch e devolvem [] tanto em falha de rede/HTTP quanto em ausência genuína do evento. Só as casas de browser (Betano/Blaze/1xBet/Betnacional) cumprem o contrato 'throw = infra'. Com [], acharPerna devolve null e revalidarPelasCasas responde 'perna não encontrada agora em X (linha removida/movida?)' — que NÃO casa com o regex de infra do scanner (/falha ao|indisponível/i, scanner_v2.ts:527). A linha fica no banco, e como o alerta só roda em INSERT novo (existingId → continue, scanner_v2.ts:443-454), a surebet nunca mais passa pelo gate enquanto viver no banco (a reconciliação a mantém, pois o motor segue re-encontrando a arb).
- **Impacto:** Falso negativo permanente: uma queda transitória da API de qualquer casa (ex.: túnel Tailscale da Pinnacle, sabidamente frágil — e arbs com Pinnacle são as de maior prioridade) no instante do gate mata o alerta daquela arb real por até 24h. Também polui a calibração: logAlerta grava resultado='suprimido' (falso positivo do scan) quando na verdade foi 'nao_verificado'. O comentário do casa_kambi.ts ('falha vira re-gate no próximo scan') descreve um comportamento que não acontece.
- **Sugestão:** Replicar nos scrapers de API o contrato já implementado em Betnacional/Betano/Blaze/1xBet: lançar erro quando NENHUMA lista/feed carregou (infra) e só devolver [] quando a lista carregou e o evento está genuinamente ausente. Alternativa mais barata no gate: em revalidarPelasCasas, distinguir 'lista da casa veio vazia' (infra provável) de 'evento listado mas perna ausente' e usar motivo que case com o ehInfra do scanner.

### #15 [ALTA] Handicap espelhado: cruzamento bússola×alvo não é sign-aware (a lição do motor não foi portada)
`cashoutCapture.ts:405`

- **Problema:** O match do alvo usa `mesmaOferta(o.mercado, o.linha, ev.marketLabel, ev.linha)`, que compara a linha por igualdade numérica crua. A `linha` de handicap é 'o sinal da casa' (markets.ts:14), ou seja, depende da orientação home/away de CADA casa. O motor de surebet corrigiu isso com `linhaDoRotulo`/`alinharAoCluster` (engine.ts:120-129, valor.ts:163-165), mas o caminho do cashout não tem o equivalente — nem aqui nem em `acharPernas` (cashoutSources.ts:96-98). `alignOdd` inverte as seleções por identidade de time, mas NÃO inverte/valida o sinal da linha.
- **Impacto:** Alvo que lista o evento invertido ('B vs A'): (a) a oferta REAL equivalente (B +1.5, linha=+1.5) não casa com ev.linha=-1.5 → falso negativo; (b) a oferta ESPELHADA (B -1.5, linha=-1.5) CASA → a perna 'away' do alvo (B -1.5) é comparada com a prob justa da bússola de 'away' = B +1.5 — apostas completamente diferentes. fair(B+1.5) é muito maior que 1/odd(B-1.5), então nasce um gap gigante fantasma que vai pro topo do radar e do WhatsApp, com selection_label ainda por cima errado ('B (-1.5)' avaliado pela justa de B (+1.5)).
- **Sugestão:** Ao alinhar com orientação invertida em `alignOdd`/no cruzamento, exigir `o.linha === -ev.linha` (e na mesma orientação `o.linha === ev.linha`); adicionalmente validar o sinal pelo rótulo da opção ('Time (+1.5)') com o mesmo `linhaDoRotulo` do engine. Aplicar também em `acharPernas` (cashoutSources.ts).

### #16 [ALTA] Gates de R² e slope estão mortos; a 'queda' é medida por só 2 pontos extremos da janela
`cashoutEngine.ts:163`

- **Problema:** `detectOpportunity` filtra bússolas apenas por `sampleSize >= minSampleSize`; `rSquaredMin` (0.7), `minSlopeAbs` e `oddDirection` NUNCA entram na decisão (o comentário admite: 'só métrica'). O gate real de direção é `dropPct >= minDropPct`, e `dropPct` (linhas 116-125) compara SOMENTE o ponto mais antigo com o mais recente da janela — sem robustez a outlier.
- **Impacto:** Um único tick ruim numa das pontas da janela (glitch de scrape, odd transitória, ponto lixo do seed) fabrica 'queda de 2%' em série plana/ruidosa (R²≈0) e dispara oportunidade — exatamente o falso positivo que a spec (§2.1, R2_MIN) mandava barrar. Também derruba a assertividade do rótulo 'trending'.
- **Sugestão:** Reintroduzir o gate: exigir `rSquared >= cfg.rSquaredMin && |slope| >= cfg.minSlopeAbs && slope > 0` (ou medir a queda pelos valores AJUSTADOS da regressão: slope*Δt/oddInício), ou no mínimo usar mediana dos 2-3 primeiros/últimos pontos em vez de endpoints crus.

### #7 [MEDIA] Gate do SureRadar sem teto de sanidade de ROI (motor tem 15%, SureRadar não tem)
`scanner_v2.ts:487`

- **Problema:** `alertarSureRadar = ehSureRadar && roi >= 1.5` não tem limite superior, enquanto o motor próprio exige `roi <= 15.0` justamente porque 'ROI absurdo = odd travada/erro' (linhas 493-497). Um ROI de 20-30% vindo do SureRadar (odd palpável/stale no agregador, típico das VIP/locked) passa direto — e, combinado com a revalidação tautológica para casas sem scraper (achado anterior), pode chegar ao WhatsApp sem nenhuma checagem real.
- **Impacto:** Falso positivo da pior espécie: alerta de odd errada/corrigida, com risco real de anulação de aposta (palps) — a mesma classe de erro que o teto de 15% do motor foi criado para bloquear.
- **Sugestão:** Aplicar o mesmo teto de sanidade (ou um teto próprio, ex.: 15-20%) ao SureRadar; para ROI acima do teto, só alertar se a revalidação tiver sido feita pelas casas reais (caminho 'casas reais' do checarPernasAoVivo), nunca pelo fallback da lista.

### #10 [MEDIA] seedSureRadarCache torna o gate circular para opps SureRadar sem scraper nas duas casas
`revalidationService.ts:136`

- **Problema:** O scanner semeia o cache com a MESMA extração que gerou as oportunidades (scanner_v2.ts:340) e o gate, quando alguma casa não tem scraper (ou as pernas não são achadas nas casas), 'revalida' contra essa lista dentro do TTL de 60s (l.355/361). O match encontra o próprio card com odds idênticas às do scan — a checagem confirma trivialmente, sem nenhum dado novo. As odds da lista do SureRadar já podem estar ~10 min defasadas em relação às casas (comentário na l.341). Pior: o alerta enviado afirma incondicionalmente '✅ Revalidada agora nas casas (odds ao vivo)' (scanner_v2.ts:582), mesmo quando o motivo foi 'confirmada no SureRadar' via lista semeada.
- **Impacto:** Falso positivo: cards do SureRadar com pernas em casas sem scraper (Bet365, Pixbet, Novibet, Betfair, Pitaco etc., frequentes na lista) passam pelo gate sem revalidação real e o apostador recebe uma nota que atesta frescor que não existe — odds podem estar 10-15 min velhas ao chegar no WhatsApp.
- **Sugestão:** No caminho de fallback pela lista, diferenciar a nota do alerta (ex.: '↻ Confirmada na lista do SureRadar (fonte agregada, pode ter defasagem)') usando reval.motivo, e/ou reduzir o TTL do seed para o gate (forçar re-extração da API do SureRadar, que é barata sem chromium) quando o motivo da confirmação for a lista.

### #11 [MEDIA] Gate trata 'não está na lista' de fonte degradada (browser) como arb morta — sem a guarda que o revalidar() tem
`revalidationService.ts:369`

- **Problema:** No checarPernasAoVivo, quando a lista fresca do SureRadar veio do fallback via browser (ultimaFonteFresh !== 'api', lista PARCIAL que não enxerga as VIP/locked) e não-vazia, a ausência do card retorna 'não está mais na lista do SureRadar' sem checar a fonte. O método revalidar() trata exatamente esse caso como 'erro' (l.578-593, comentário: 'fallback browser não enxerga as VIP/locked'), mas o gate não. No scanner, esse motivo não casa com ehInfra (scanner_v2.ts:527) → a linha fica no banco e o dedupe por existingId suprime o alerta permanentemente.
- **Impacto:** Falso negativo nas melhores oportunidades: as VIP/locked são justamente as de maior ROI (12%+). Se a API cair no meio da varredura e o gate reconsultar >60s após o seed, uma surebet VIP viva é declarada morta e nunca alertada; a calibração ainda registra 'suprimido' (falso positivo do scan) indevidamente.
- **Sugestão:** Espelhar a guarda do revalidar(): no gate, se !match e ultimaFonteFresh !== 'api', retornar motivo de indisponibilidade/degradação (que case com /indisponível/ do ehInfra) em vez de 'não está mais na lista'.

### #12 [MEDIA] Revalidação ignora o horário do jogo: eventos homônimos (doubleheader/rematch) podem responder pela perna
`revalidationService.ts:291`

- **Problema:** Os oddsDoEvento filtram só por areEventsSame — que descarta o sufixo de data via splitEvento — e agregam até 2 eventos casados num único array (slice(0,2) em casa_kambi.ts:215, casa_superbet.ts:168, casa_pinnacle.ts:178). acharPerna varre esse array misto e devolve a primeira odd cujo mercado/linha/opção bata, sem olhar ScrapedOdd.dataHora. O motor usa mesmoHorario (tolerância 10 min) para parear entre casas, mas a revalidação abandonou essa dimensão. Beisebol está na varredura (doubleheaders MLB: mesmos times, mesmo dia, dois jogos pré-jogo simultâneos) e a janela de alerta é de 48h (rematches de basquete/e-sports em dias consecutivos entram juntos no feed).
- **Impacto:** A perna pode ser confirmada (e enviada no WhatsApp como 'odd ao vivo') com a cotação do JOGO ERRADO — mesma classe do bug de clusters, agora entre partidas em vez de mercados. Pode tanto validar arb morta quanto matar arb viva.
- **Sugestão:** Passar o kickoff da opp (parseKickoff do sufixo do evento / opp.dataHora) até acharPerna e descartar ScrapedOdd cujo dataHora parseável difira além da tolerância (mesmoHorario); nos scrapers, preferir o candidato de kickoff mais próximo em vez de mesclar os 2 slice(0,2).

### #17 [MEDIA] Defasagem temporal intra-ciclo: fair prob da bússola sem idade máxima e captured_at único fabricam/escondem gap
`cashoutEngine.ts:170`

- **Problema:** O consenso usa `fairProbability` = último ponto da série de cada bússola sem checar a IDADE desse ponto: bússola pesada é puxada só a cada `heavyEveryN` ciclos (~4 min) e bússola que falhou no ciclo mantém série de até 15 min entrando no consenso com peso igual. Além disso, todos os snapshots do ciclo recebem `captured_at = nowIso` calculado no INÍCIO do ciclo (cashoutCapture.ts:288), mas bússolas e alvos são coletados sequencialmente — o alvo pode ser lido 1-2+ min depois da bússola numa VPS de 1 core, e o gap compara valores de instantes diferentes rotulados como o mesmo.
- **Impacto:** Gap fantasma quando a linha afiada fez um pico e reverteu (a série velha ainda 'mostra' a queda) e gap subestimado quando a queda continuou (falso negativo). Com 2ª bússola habilitada (Betfair/1xBet), o problema vira sistemático via throttle das pesadas.
- **Sugestão:** Registrar `tSeconds`/`captured_at` no momento REAL de cada fetch; exigir idade máxima do último ponto (ex.: <= 2×intervalSeconds) para a bússola entrar no consenso; opcionalmente ponderar o consenso pela frescura.

---

## ⚪ Refutados na verificação (não são bugs)

- **ROI do fallback browser: regex não aceita vírgula decimal e confia no texto do painel** — A mecânica citada é real no código: o regex da linha 325 de fato não aceita vírgula ('2,53%' casa '53%' e vira 53 — verificado empiricamente), o card.roi cru vai para lucroGarantidoPerc sem cross-check com as odds quando não há exchange (linhas 353-354/367), é persistido como roi_pct (scanner_v2.ts:395), ordena o radar e passa no gate SureRadar roi >= 1.5 que não tem teto (scanner_v2.ts:489; o Ris

- **Bússola ao vivo × alvo só-pré-jogo sem gate de kickoff fabrica gaps enormes pós-gol** — A afirmação literal está certa: a FASE B de cashoutCapture.ts (linhas 399-482) não compara ev.startsAtIso com o relógio. Porém a guarda existe a jusante, em TODOS os scrapers alvo só-pré-jogo, dentro do mesmo ciclo: Superbet (casa_superbet.ts:188-198) pede offerState=prematch à API e ainda filtra localmente 't > agora'; BetBoom (casa_betboom.ts:205-207) descarta status!==0 e 't <= agora' (estrito)
