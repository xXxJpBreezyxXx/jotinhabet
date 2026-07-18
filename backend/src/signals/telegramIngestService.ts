import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { extrairSinalDeImagem, SinalExtraido } from '../IA/extractors/telegramSignalExtractor';
import { SignalPipeline, LinkSinal } from './signalPipeline';
import { WhatsAppNotifier } from '../notify/whatsapp';

/**
 * Listener do(s) grupo(s) de sinais no Telegram (MTProto, sessão de USUÁRIO
 * via GramJS — bot não pode ser adicionado a grupo de terceiros).
 *
 * O grupo publica o sinal em SEQUÊNCIA: primeiro o print da calculadora (o
 * sinal), depois prints das casas (com o horário da partida) e links. Por
 * isso o sinal extraído fica PENDENTE por uma janela curta
 * (TELEGRAM_CONTEXTO_SEGUNDOS, default 75s) colhendo contexto das mensagens
 * seguintes — dataHora dos prints de casa, links de captions/textos — e só
 * então desce o pipeline (gates, dedup, insert, revalidação, WhatsApp).
 *
 * Event-driven (sem interval), mas segue o padrão start()/stop() dos serviços
 * do repo. Envs ausentes/placeholder 'your-' ⇒ start() vira no-op.
 */

interface SinalPendente {
  sinal: SinalExtraido;
  links: LinkSinal[];
  dataHoraContexto: string | null;
  printsDeCasa: number;
  timer: NodeJS.Timeout;
}

export class TelegramIngestService {
  private client: TelegramClient | null = null;
  private pipeline = new SignalPipeline();
  /** Serialização: 1 mensagem por vez — evita visão concorrente num burst e
   *  corrida entre dois sinais iguais no dedup/insert. */
  private filaAtual: Promise<void> = Promise.resolve();
  private grupoIds: string[] = [];
  private pendente: SinalPendente | null = null;
  private ativo = false;
  private stats = { processadas: 0, sinais: 0, descartadas: 0, ultimoEventoEm: null as string | null };
  private ultimoAvisoSessaoEm = 0;
  /** Polling (o update-loop push do GramJS 2.26 dá "Error: TIMEOUT" e para de
   *  entregar updates — ver logs 18/07). O pull via getMessages é confiável. */
  private lastId = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;

  private envConfigurada(nome: string): string | null {
    let v = process.env[nome];
    if (!v) return null;
    // O parser de env_file do Swarm NÃO remove comentário inline
    // ("-100123 # nome do grupo" chega inteiro) — removemos aqui.
    v = v.replace(/\s+#.*$/, '').trim();
    if (!v || v.includes('your-')) return null;
    return v;
  }

  /** Janela de coleta de contexto após um sinal (prints de casa, links). */
  private janelaContextoMs(): number {
    const v = Number(process.env.TELEGRAM_CONTEXTO_SEGUNDOS);
    return Number.isFinite(v) && v >= 5 && v <= 600 ? v * 1000 : 75_000;
  }

  async start(): Promise<void> {
    const apiId = this.envConfigurada('TELEGRAM_API_ID');
    const apiHash = this.envConfigurada('TELEGRAM_API_HASH');
    const session = this.envConfigurada('TELEGRAM_SESSION');
    const grupoRaw = this.envConfigurada('TELEGRAM_GRUPO_ID');

    if (!apiId || !apiHash || !session || !grupoRaw) {
      console.warn('⚠️ [Telegram] Envs TELEGRAM_* não configuradas — fonte Telegram desligada.');
      return;
    }
    if (!Number.isFinite(Number(apiId))) {
      console.error(`❌ [Telegram] TELEGRAM_API_ID inválido ("${apiId}") — fonte desligada.`);
      return;
    }
    // Aceita VÁRIOS grupos separados por vírgula (ex.: grupo real + grupo de teste).
    this.grupoIds = grupoRaw
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
    const invalidos = this.grupoIds.filter((g) => !Number.isFinite(Number(g)));
    if (this.grupoIds.length === 0 || invalidos.length > 0) {
      console.error(`❌ [Telegram] TELEGRAM_GRUPO_ID inválido ("${invalidos.join('", "') || grupoRaw}") — use só números separados por vírgula (ex.: -1002090851484,-100987654321). Fonte desligada.`);
      this.grupoIds = [];
      return;
    }

    this.client = new TelegramClient(new StringSession(session), Number(apiId), apiHash, {
      connectionRetries: 10,
      retryDelay: 5000,
    });

    try {
      await this.client.connect();
      const autorizado = await this.client.checkAuthorization();
      if (!autorizado) {
        console.error('❌ [Telegram] Sessão expirada/desautorizada — rode: npx ts-node --transpile-only src/scripts/telegram_login.ts');
        await this.avisarSessaoCaida();
        await this.client.disconnect();
        this.client = null;
        return;
      }
    } catch (e: any) {
      console.error(`❌ [Telegram] Falha ao conectar: ${e?.message || e}`);
      this.client = null;
      return;
    }

    // POLLING em vez de addEventHandler/NewMessage: o update-loop (push) do GramJS
    // 2.26 quebra com "Error: TIMEOUT" e para de entregar updates silenciosamente
    // (0 sinais em 9h30 em prod, 18/07). O getMessages (pull) é confiável. Semeia o
    // último id por grupo (não reprocessa histórico → sem spam de alerta no boot).
    for (const g of this.grupoIds) {
      try {
        const ultimas = await this.client.getMessages(g, { limit: 1 });
        this.lastId.set(g, ultimas[0]?.id || 0);
      } catch {
        this.lastId.set(g, 0);
      }
    }

    this.ativo = true;
    this.pollTimer = setInterval(() => {
      void this.poll().catch((e) => console.error(`⚠️ [Telegram] Erro no poll: ${e?.message || e}`));
    }, this.pollMs());
    console.log(
      `📲 [Telegram] Fonte ATIVA (polling ${this.pollMs() / 1000}s) no(s) grupo(s) ${this.grupoIds.join(', ')} — ` +
      `janela de contexto ${this.janelaContextoMs() / 1000}s.`
    );
  }

  /** Intervalo do polling (pull via getMessages). */
  private pollMs(): number {
    const v = Number(process.env.TELEGRAM_POLL_SEGUNDOS);
    return Number.isFinite(v) && v >= 5 && v <= 120 ? v * 1000 : 15_000;
  }

  /** Pull das mensagens novas de cada grupo e enfileira o processamento (serializado). */
  private async poll(): Promise<void> {
    if (!this.client || !this.ativo) return;
    // Reconecta se o transporte caiu (o getMessages falharia em cadeia).
    if (!this.client.connected) {
      try { await this.client.connect(); } catch { /* próxima rodada tenta de novo */ }
    }
    for (const g of this.grupoIds) {
      try {
        const msgs = await this.client.getMessages(g, { limit: 40 });
        const desde = this.lastId.get(g) || 0;
        const novas = msgs.filter((m) => m.id > desde).sort((a, b) => a.id - b.id);
        if (novas.length === 0) continue;
        this.lastId.set(g, novas[novas.length - 1].id);
        for (const m of novas) this.enfileirar(m);
      } catch (e: any) {
        const waitS = Number(e?.seconds);
        if (/FLOOD/i.test(e?.errorMessage || e?.message || '') && Number.isFinite(waitS)) {
          console.warn(`⏳ [Telegram] FloodWait ${waitS}s no poll do grupo ${g}.`);
        } else {
          console.warn(`⚠️ [Telegram] Falha no poll do grupo ${g}: ${e?.message || e}`);
        }
      }
    }
  }

  /**
   * Triagem barata + enfileira (nunca lança). Fotos sempre entram; texto só se
   * carrega URL (contexto). O vínculo com o sinal pendente é decidido em
   * processarMensagem (no MOMENTO do processamento, já em ordem), não aqui — assim
   * um lote com [sinal-foto, texto-link] processa a foto antes e o link anexa certo.
   */
  private enfileirar(message: Api.Message): void {
    if (!this.ehDoGrupo(message)) return;
    const temFoto = !!message.photo;
    const temUrl = this.extrairUrls(message).length > 0;
    if (!temFoto && !temUrl) return;
    this.filaAtual = this.filaAtual
      .then(() => this.processarMensagem(message))
      .catch((e) => console.error(`⚠️ [Telegram] Erro ao processar mensagem ${message.id}: ${e?.message || e}`));
  }

  async stop(): Promise<void> {
    this.ativo = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pendente) {
      // Não perde um sinal capturado: despacha com o contexto que já tem.
      await this.flushPendente('serviço parando');
    }
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch { /* segue */ }
      this.client = null;
    }
  }

  getStatus() {
    return {
      ativo: this.ativo,
      conectado: !!this.client?.connected,
      grupos: this.grupoIds,
      janelaContextoS: this.janelaContextoMs() / 1000,
      sinalPendente: this.pendente
        ? { evento: this.pendente.sinal.evento, links: this.pendente.links.length, printsDeCasa: this.pendente.printsDeCasa }
        : null,
      ...this.stats,
    };
  }

  private ehDoGrupo(message: Api.Message): boolean {
    const chatId = message.chatId?.toString() || '';
    const semPrefixo = (s: string) => s.replace(/^-100/, '');
    return this.grupoIds.some((g) => chatId === g || semPrefixo(chatId) === semPrefixo(g));
  }

  /** URLs do texto/caption + entidades (links "embutidos" em texto formatado). */
  private extrairUrls(message: Api.Message): string[] {
    const urls: string[] = [];
    const texto = message.message || '';
    urls.push(...(texto.match(/https?:\/\/[^\s)\]]+/gi) || []));
    for (const ent of message.entities || []) {
      if (ent instanceof Api.MessageEntityTextUrl && ent.url) urls.push(ent.url);
    }
    return [...new Set(urls)];
  }

  private async processarMensagem(message: Api.Message): Promise<void> {
    if (!this.client) return;
    this.stats.ultimoEventoEm = new Date().toISOString();
    const urls = this.extrairUrls(message);

    // Mensagem de TEXTO com links durante a janela de contexto.
    if (!message.photo) {
      if (this.pendente && urls.length > 0) {
        this.pendente.links.push(...urls.map((url) => ({ url, casa: null })));
        console.log(`🔗 [Telegram] ${urls.length} link(s) de texto anexado(s) ao sinal pendente (${this.pendente.sinal.evento}).`);
      }
      return;
    }

    let base64: string;
    try {
      const buf = await this.client.downloadMedia(message, {});
      if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
        console.warn(`⚠️ [Telegram] Mensagem ${message.id}: download da foto vazio — ignorada.`);
        return;
      }
      base64 = buf.toString('base64');
    } catch (e: any) {
      // FloodWait: o Telegram pediu pausa — espera e NÃO derruba o listener.
      const waitS = Number(e?.seconds);
      if (e?.errorMessage?.includes('FLOOD') && Number.isFinite(waitS)) {
        console.warn(`⏳ [Telegram] FloodWait de ${waitS}s no download — aguardando.`);
        await new Promise((r) => setTimeout(r, (waitS + 1) * 1000));
        return;
      }
      console.error(`⚠️ [Telegram] Falha no download da mensagem ${message.id}: ${e?.message || e}`);
      return;
    }

    this.stats.processadas++;
    // Fotos do Telegram chegam re-encodadas como JPEG.
    const extracao = await extrairSinalDeImagem(base64, 'image/jpeg');

    // ---- Novo SINAL (print da calculadora) ----
    if (extracao.sinal) {
      if (this.pendente) {
        await this.flushPendente('novo sinal chegou');
      }
      const sinal = extracao.sinal;
      const timer = setTimeout(() => {
        // O flush roda DENTRO da fila para não competir com mensagens em processamento.
        this.filaAtual = this.filaAtual
          .then(() => this.flushPendente('janela de contexto encerrada'))
          .catch((e) => console.error(`⚠️ [Telegram] Erro no flush do sinal pendente: ${e?.message || e}`));
      }, this.janelaContextoMs());
      this.pendente = {
        sinal,
        links: urls.map((url) => ({ url, casa: null })),
        dataHoraContexto: null,
        printsDeCasa: 0,
        timer,
      };
      console.log(
        `📡 [Telegram] Sinal extraído (${extracao.provider}): ${sinal.evento} | ${sinal.mercado} | ` +
        `${sinal.casaA} ${sinal.oddA} × ${sinal.casaB} ${sinal.oddB} — aguardando contexto por ${this.janelaContextoMs() / 1000}s (prints de casa/links).`
      );
      return;
    }

    // ---- PRINT DE CASA (contexto do sinal pendente: dataHora + links) ----
    if (extracao.motivoDescarte === 'print_casa' && extracao.contexto) {
      if (!this.pendente) {
        console.log(`🔎 [Telegram] Print de casa sem sinal pendente (${extracao.contexto.casa || '?'}) — ignorado.`);
        return;
      }
      this.pendente.printsDeCasa++;
      if (!this.pendente.dataHoraContexto && extracao.contexto.dataHora) {
        this.pendente.dataHoraContexto = extracao.contexto.dataHora;
      }
      if (urls.length > 0) {
        this.pendente.links.push(...urls.map((url) => ({ url, casa: extracao.contexto!.casa })));
      }
      console.log(
        `🧩 [Telegram] Contexto anexado ao sinal pendente: casa ${extracao.contexto.casa || '?'}` +
        `${extracao.contexto.dataHora ? `, dataHora ${extracao.contexto.dataHora}` : ''}${urls.length ? `, ${urls.length} link(s)` : ''}.`
      );
      return;
    }

    // ---- Outros (meme/propaganda/etc): descarta SEM colher links (anúncio tem link). ----
    this.stats.descartadas++;
    console.log(`🔎 [Telegram] Mensagem ${message.id} descartada (${extracao.motivoDescarte}).`);
  }

  /** Despacha o sinal pendente pro pipeline com o contexto colhido. */
  private async flushPendente(motivo: string): Promise<void> {
    const p = this.pendente;
    if (!p) return;
    this.pendente = null;
    clearTimeout(p.timer);

    // O print da calculadora não traz horário — herda do print de casa.
    if (!p.sinal.dataHora && p.dataHoraContexto) {
      p.sinal.dataHora = p.dataHoraContexto;
    }

    this.stats.sinais++;
    console.log(
      `📤 [Telegram] Despachando sinal (${motivo}): ${p.sinal.evento}` +
      `${p.sinal.dataHora ? ` @ ${p.sinal.dataHora}` : ' (sem horário)'} | ${p.printsDeCasa} print(s) de casa, ${p.links.length} link(s).`
    );
    const resultado = await this.pipeline.processarSinal(p.sinal, { links: p.links });
    console.log(`📡 [Telegram] Pipeline: ${resultado.acao}${resultado.motivo ? ` — ${resultado.motivo}` : ''}`);
  }

  /** Aviso de sessão caída no WhatsApp, no máximo 1 por dia. */
  private async avisarSessaoCaida(): Promise<void> {
    const agora = Date.now();
    if (agora - this.ultimoAvisoSessaoEm < 24 * 60 * 60 * 1000) return;
    this.ultimoAvisoSessaoEm = agora;
    try {
      await new WhatsAppNotifier().enviarTexto(
        '⚠️ Sessão do Telegram caiu — a fonte de sinais do grupo está PARADA. Rode o telegram_login.ts e atualize TELEGRAM_SESSION no .env.'
      );
    } catch { /* aviso é best-effort */ }
  }
}
