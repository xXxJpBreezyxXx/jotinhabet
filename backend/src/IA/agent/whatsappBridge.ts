/**
 * PONTE WHATSAPP ↔ AGENTE — conversar com o agente pelo grupo do WhatsApp.
 *
 * A Evolution (evolution-go) POSTa cada evento da instância no webhook configurado;
 * `POST /api/whatsapp/webhook` entrega o corpo cru aqui. Esta classe faz a triagem
 * (é mensagem de texto? do grupo autorizado? nova?), roda o MESMO agente da aba
 * "IA & Automação" e devolve a resposta no grupo já convertida para o dialeto do
 * WhatsApp.
 *
 * Decisões que existem por motivo, não por estilo:
 *
 *  - PARSER TOLERANTE. O evolution-go é whatsmeow (Go) e o Evolution API v2 é baileys
 *    (Node): os nomes dos campos divergem (`remoteJID`/`ID` × `remoteJid`/`id`,
 *    `Info.Chat` × `key.remoteJid`), e o envelope muda entre versões. O parser tenta os
 *    caminhos conhecidos e, se nenhum casar, faz uma varredura em profundidade limitada.
 *    Os últimos payloads crus ficam em memória (`ultimosPayloads`) para diagnosticar sem
 *    precisar de log do container.
 *  - RESPOSTA HTTP IMEDIATA. Uma pergunta pode levar mais de 1 min (skills de scraper);
 *    a Evolution re-tenta 3x quando o webhook não responde 2xx rápido, e cada re-tentativa
 *    viraria uma execução duplicada do agente. Então: triagem síncrona, execução em
 *    background, sempre 200.
 *  - UMA EXECUÇÃO POR VEZ. A VPS tem 1 core e o agente sobe scraper/Chromium: duas
 *    perguntas simultâneas derrubam o backend. Enquanto uma roda, a próxima recebe aviso.
 *  - fromMe IGNORADO. As respostas do agente voltam no mesmo webhook; sem esse corte, ele
 *    conversaria consigo mesmo para sempre.
 *  - MENSAGEM ANTIGA IGNORADA. Um history-sync da Evolution re-entrega conversa velha; sem
 *    o corte por idade, o agente responderia a tudo de uma vez (e queimaria a cota da Groq).
 */

import { RevalidationService } from '../../core/revalidationService';
import { WhatsAppNotifier } from '../../notify/whatsapp';
import { dividirMensagem, markdownParaWhatsApp } from '../../notify/markdownWhatsapp';
import { lerImagemDaConversa, mensagemComImagem } from '../extractors/imagemChat';
import { MensagemCliente, rodarAgente } from './agentLoop';
import { SKILLS } from './registry';

/** Mensagem de entrada já normalizada, qualquer que seja o envelope do provedor. */
export interface EntradaWhatsApp {
  chatJid: string;
  autorJid: string | null;
  autorNome: string | null;
  texto: string;
  msgId: string | null;
  fromMe: boolean;
  ehGrupo: boolean;
  /** Epoch em ms (a Evolution manda em segundos, ms ou ISO — normalizado aqui). */
  tsMs: number | null;
  /** Nome do evento declarado no envelope, quando existe (ex.: "messages.upsert"). */
  evento: string | null;
  /** true quando veio mídia sem legenda. */
  soMidia: boolean;
  /** IMAGEM na mensagem: o objeto `Message` cru (a Evolution exige ele de volta para
   *  entregar os bytes) + o mimetype declarado. null quando não há imagem. */
  imagem: { mensagem: any; mimeType: string } | null;
  /**
   * true = os campos vieram da varredura em profundidade, não de um caminho conhecido.
   * Nesse caso `fromMe` e `tsMs` podem ser palpite, e as guardas anti-loop e de
   * history-sync perderiam o efeito — então a triagem RECUSA em vez de arriscar.
   */
  envelopeDesconhecido: boolean;
}

const num = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
};
const ligado = (nome: string, padrao: boolean): boolean => {
  const v = (process.env[nome] || '').trim().toLowerCase();
  if (!v) return padrao;
  return v === '1' || v === 'true' || v === 'sim' || v === 'on';
};

/** Grupo "Sure Agent" — canal do agente no WhatsApp (sobrescrito por AGENT_WHATSAPP_CHAT). */
export const CHAT_AGENTE_PADRAO = '120363411828181043@g.us';

/** JIDs autorizados a conversar com o agente (grupo e/ou contato). */
export function chatsPermitidos(): string[] {
  const cru = (process.env.AGENT_WHATSAPP_CHAT || CHAT_AGENTE_PADRAO).trim();
  return cru
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Segredo compartilhado do webhook (opcional, mas recomendado): a rota é pública —
 * Traefik expõe /api — e a Evolution não assina o payload. Sem token, qualquer um que
 * descubra a URL pode fazer o agente falar no grupo e queimar cota de IA.
 * Configure `AGENT_WHATSAPP_WEBHOOK_TOKEN` e cole a URL com `?token=...` na Evolution.
 */
export function tokenWebhookValido(tokenRecebido: unknown): boolean {
  const esperado = (process.env.AGENT_WHATSAPP_WEBHOOK_TOKEN || '').trim();
  if (!esperado) return true; // sem token configurado: aceita (compatibilidade)
  return typeof tokenRecebido === 'string' && tokenRecebido.trim() === esperado;
}

const JID_RE = /^[\w.:-]+@(g\.us|s\.whatsapp\.net|lid|c\.us|broadcast)$/i;

function primeiroTexto(...valores: any[]): string | null {
  for (const v of valores) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/** Normaliza timestamp em segundos, milissegundos ou ISO para epoch ms. */
function normalizarTs(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(v);
    if (!isNaN(d)) return d;
  }
  return null;
}

/**
 * Varredura em profundidade limitada: última linha de defesa quando o envelope não é
 * nenhum dos conhecidos. Procura o PRIMEIRO valor plausível para cada campo — de
 * propósito conservadora (só chaves com nome de JID/texto de mensagem).
 */
function varrerFundo(raiz: any): { chat?: string; texto?: string; id?: string; fromMe?: boolean; autor?: string } {
  const achado: { chat?: string; texto?: string; id?: string; fromMe?: boolean; autor?: string } = {};
  const fila: Array<{ v: any; d: number }> = [{ v: raiz, d: 0 }];
  let visitados = 0;
  while (fila.length && visitados < 400) {
    const { v, d } = fila.shift()!;
    visitados++;
    if (!v || typeof v !== 'object' || d > 6) continue;
    for (const [k, val] of Object.entries(v)) {
      const kl = k.toLowerCase();
      if (typeof val === 'string') {
        if (!achado.chat && /^(remotejid|chat|chatid|from|jid)$/.test(kl) && JID_RE.test(val)) achado.chat = val;
        if (!achado.autor && /^(participant|sender|senderjid|author)$/.test(kl) && JID_RE.test(val)) achado.autor = val;
        if (!achado.texto && /^(conversation|text|body|caption|message)$/.test(kl) && val.trim()) achado.texto = val;
        if (!achado.id && /^(id|messageid|msgid|stanzaid)$/.test(kl) && val.trim()) achado.id = val;
      } else if (typeof val === 'boolean' && /^(fromme|isfromme)$/.test(kl)) {
        if (achado.fromMe === undefined) achado.fromMe = val;
      } else if (val && typeof val === 'object') {
        fila.push({ v: val, d: d + 1 });
      }
    }
  }
  return achado;
}

/**
 * O evento declarado é RECEBIMENTO de mensagem?
 *
 * O evolution-go serializa os eventos do whatsmeow: `Message` (recebida), `SendMessage`
 * (enviada por nós), `Receipt`, `ChatPresence`, `Connected`... O baileys (Evolution v2)
 * usa `messages.upsert`. Os dois entram; o resto sai.
 *
 * `SendMessage` é rejeitado por NOME: a resposta do próprio agente volta pelo webhook, e
 * se o payload de envio não trouxer `IsFromMe`, o agente conversaria consigo mesmo em
 * loop — cada volta gastando cota de IA e scraper.
 */
function eventoDeMensagem(evento: string | null): boolean {
  if (!evento) return true; // sem declaração de evento: decide pelo conteúdo
  const e = evento.toLowerCase().trim();
  if (/^send/.test(e)) return false; // SendMessage / SendMessageError
  if (/receipt|presence|connection|qrcode|contact|chats?\.|call|delete|revoke|reaction|edit|update|history|logged|paircode/.test(e)) {
    return false;
  }
  return /mess?age/.test(e);
}

/**
 * Extrai a mensagem de texto de um payload de webhook da Evolution.
 * Retorna null quando o evento não é uma mensagem de texto utilizável.
 */
export function extrairMensagemWhatsApp(payload: any): EntradaWhatsApp | null {
  if (!payload || typeof payload !== 'object') return null;

  const evento =
    primeiroTexto(payload.event, payload.Event, payload.type, payload.Type, payload.eventType) || null;
  if (!eventoDeMensagem(evento)) return null;

  // O corpo útil pode estar na raiz, em data/Data, ou dentro de um array (baileys manda
  // `data.messages[]` em alguns builds).
  const candidatos: any[] = [payload.data, payload.Data, payload.message, payload.Message, payload];
  const lista = candidatos.find((c) => Array.isArray(c?.messages) && c.messages.length);
  if (lista) candidatos.unshift(lista.messages[0]);

  for (const d of candidatos) {
    if (!d || typeof d !== 'object') continue;
    const key = d.key || d.Key || d.info || d.Info || {};
    const msg = d.message || d.Message || d.msg || {};

    const chatJid = primeiroTexto(
      key.remoteJid, key.remoteJID, key.RemoteJid, key.RemoteJID,
      key.Chat, key.chat, d.remoteJid, d.remoteJID, d.chatId, d.chat, d.from
    );
    const texto = primeiroTexto(
      msg.conversation, msg.Conversation,
      msg.extendedTextMessage?.text, msg.ExtendedTextMessage?.text, msg.extendedTextMessage?.Text,
      msg.imageMessage?.caption, msg.videoMessage?.caption, msg.documentMessage?.caption,
      msg.ephemeralMessage?.message?.conversation,
      msg.ephemeralMessage?.message?.extendedTextMessage?.text,
      msg.viewOnceMessage?.message?.conversation,
      msg.buttonsResponseMessage?.selectedDisplayText,
      msg.listResponseMessage?.title,
      d.text, d.body, d.conversation
    );
    if (!chatJid || !JID_RE.test(chatJid)) continue;

    const temMidia = !!(
      msg.imageMessage || msg.audioMessage || msg.videoMessage || msg.documentMessage || msg.stickerMessage
    );
    // Imagem: só `imageMessage` e documento de imagem — áudio/vídeo/sticker o agente não lê.
    const imgMsg = msg.imageMessage || msg.ImageMessage;
    const docImg = (msg.documentMessage || msg.DocumentMessage)?.mimetype?.startsWith?.('image/')
      ? msg.documentMessage || msg.DocumentMessage
      : null;
    const imagem = imgMsg || docImg
      ? { mensagem: msg, mimeType: (imgMsg || docImg)?.mimetype || 'image/jpeg' }
      : null;
    const fromMeCru = key.fromMe ?? key.FromMe ?? key.IsFromMe ?? d.fromMe ?? d.FromMe;
    return {
      chatJid,
      autorJid:
        primeiroTexto(
          key.participant, key.Participant, key.Sender, key.SenderAlt,
          d.participant, d.sender, d.author
        ) || null,
      autorNome: primeiroTexto(d.pushName, d.PushName, key.PushName, d.notifyName, d.senderName) || null,
      texto: (texto || '').trim(),
      msgId: primeiroTexto(key.id, key.ID, key.Id, d.id, d.messageId, d.msgId) || null,
      fromMe: fromMeCru === true,
      ehGrupo: key.IsGroup === true || /@g\.us$/i.test(chatJid),
      // O whatsmeow manda `Info.Timestamp` como STRING RFC3339; o baileys manda
      // `messageTimestamp` em segundos. normalizarTs cobre os dois.
      tsMs: normalizarTs(d.messageTimestamp ?? d.timestamp ?? d.Timestamp ?? key.Timestamp ?? d.date_time),
      evento,
      soMidia: !texto && temMidia,
      imagem,
      envelopeDesconhecido: false,
    };
  }

  // Envelope desconhecido: varredura em profundidade. Serve para DIAGNOSTICAR uma versão
  // nova da Evolution (o payload aparece em /webhook/debug), não para responder às cegas —
  // quem decide isso é a triagem, que recusa `envelopeDesconhecido`.
  const f = varrerFundo(payload);
  if (!f.chat || !f.texto) return null;
  return {
    chatJid: f.chat,
    autorJid: f.autor || null,
    autorNome: null,
    texto: f.texto.trim(),
    msgId: f.id || null,
    fromMe: f.fromMe !== false, // sem prova de que NÃO é nossa, trata como nossa (anti-loop)
    ehGrupo: /@g\.us$/i.test(f.chat),
    tsMs: null,
    evento,
    soMidia: false,
    imagem: null,
    envelopeDesconhecido: true,
  };
}

/** Resultado da triagem (o que a rota devolve — útil para depurar com curl). */
export interface TriagemWebhook {
  aceito: boolean;
  motivo: string;
  chat?: string;
}

interface Sessao {
  mensagens: MensagemCliente[];
  at: number;
  /** Execução em andamento neste chat (uma pergunta por vez). */
  ocupado: boolean;
  /** Timestamps das perguntas aceitas (janela do rate limit). */
  recentes: number[];
  /** Último aviso automático (ocupado/limite/mídia) — tem cooldown para não spammar. */
  ultimoAviso: number;
}

const AJUDA = `🤖 *Sure Agent* — é só falar comigo aqui, em português, como no painel. Pode mandar *print* também (promoção, cupom, tela de odds).

*O que eu consigo fazer*
• varrer os jogos de uma casa (AO VIVO ou pré-jogo) e comparar odds entre casas
• olhar o radar: surebets, value bets, middles, dropping odds
• banca, saldo por casa, histórico de entradas e de promoções
• regras: mercado proibido, grupos de W.O. do tênis, política de void
• calcular surebet, cobertura de freebet/qualificativa e odd ótima
• buscar na base de conhecimento (doutrina de promoções)

*Exemplos*
• "quais jogos de futebol ao vivo tem na KTO agora?"
• "compara Flamengo x Palmeiras na KTO, Superbet e Betano"
• "tem surebet no radar acima de 3% de ROI?"
• "quanto cobrir de uma freebet de R$ 50 na odd 4.20?"

*Comandos*
• /novo — esquece o contexto da conversa
• /status — motor de IA, skills e sessão
• /ajuda — esta mensagem`;

export class WhatsAppAgentBridge {
  private sessoes = new Map<string, Sessao>();
  /** IDs já processados (dedup de re-entrega da Evolution). */
  private vistos = new Map<string, number>();
  /** Últimos payloads crus, para diagnóstico via /api/whatsapp/webhook/debug. */
  private ultimos: Array<{ em: string; payload: any; triagem: TriagemWebhook }> = [];
  private stats = { recebidos: 0, processados: 0, respondidos: 0, erros: 0, ignorados: 0 };
  /** Execuções do agente em voo (teto global: a VPS tem 1 core). */
  private emVoo = 0;

  constructor(private readonly revalidation: RevalidationService) {}

  private get maxHistorico() {
    return Math.max(2, num('AGENT_WHATSAPP_MAX_HISTORICO', 12));
  }
  private get ttlSessaoMs() {
    return Math.max(5, num('AGENT_WHATSAPP_SESSAO_MIN', 180)) * 60_000;
  }
  private get maxSimultaneas() {
    return Math.max(1, num('AGENT_WHATSAPP_SIMULTANEAS', 1));
  }

  /** Triagem SÍNCRONA + disparo em background. A rota responde 200 na hora. */
  receber(payload: any): TriagemWebhook {
    this.stats.recebidos++;
    const triagem = this.triar(payload);
    if (!triagem.aceito) this.stats.ignorados++;
    // Guarda só payloads relevantes ou recusados por motivo interessante — sem isso o
    // buffer de diagnóstico enche de recibo de leitura em segundos.
    if (triagem.motivo !== 'evento sem mensagem de texto' && triagem.motivo !== 'mensagem própria (fromMe)') {
      this.ultimos.unshift({ em: new Date().toISOString(), payload, triagem });
      this.ultimos = this.ultimos.slice(0, 8);
    }
    return triagem;
  }

  private triar(payload: any): TriagemWebhook {
    if (!ligado('AGENT_WHATSAPP_ATIVO', true)) return { aceito: false, motivo: 'canal desligado (AGENT_WHATSAPP_ATIVO)' };

    // O payload do evolution-go declara a instância no topo (`instanceName`). Se for de
    // OUTRA instância, não é nossa conversa — ignora (uma Evolution pode servir várias).
    const instanciaEsperada = (process.env.EVOLUTION_INSTANCE || '').trim();
    const instanciaDoPayload = `${payload?.instanceName || payload?.instance || ''}`.trim();
    if (instanciaEsperada && instanciaDoPayload && instanciaDoPayload !== instanciaEsperada) {
      return { aceito: false, motivo: `outra instância (${instanciaDoPayload})` };
    }

    const msg = extrairMensagemWhatsApp(payload);
    if (!msg) return { aceito: false, motivo: 'evento sem mensagem de texto' };
    if (msg.fromMe) return { aceito: false, motivo: 'mensagem própria (fromMe)' };
    // Envelope que não bate com nenhum formato conhecido: NÃO responde. As duas guardas
    // que impedem o agente de conversar consigo mesmo (fromMe) e de responder
    // history-sync (idade) dependem de campos que a varredura em profundidade só chuta.
    // O payload fica em /api/whatsapp/webhook/debug para ajustar o parser.
    if (msg.envelopeDesconhecido) {
      console.warn('⚠️ [WA-Agente] envelope de webhook não reconhecido — veja /api/whatsapp/webhook/debug');
      return { aceito: false, motivo: 'envelope de webhook não reconhecido', chat: msg.chatJid };
    }

    const permitidos = chatsPermitidos();
    if (!permitidos.includes(msg.chatJid)) {
      return { aceito: false, motivo: 'chat não autorizado', chat: msg.chatJid };
    }

    // Dedup: a Evolution re-entrega o mesmo evento quando o webhook demora/erra.
    if (msg.msgId) {
      const agora = Date.now();
      for (const [id, at] of this.vistos) if (agora - at > 30 * 60_000) this.vistos.delete(id);
      if (this.vistos.has(msg.msgId)) return { aceito: false, motivo: 'mensagem repetida', chat: msg.chatJid };
      this.vistos.set(msg.msgId, agora);
    }

    // Mensagem velha = history-sync (a Evolution re-entrega conversa antiga ao reconectar).
    const idadeMaxMs = Math.max(1, num('AGENT_WHATSAPP_IDADE_MAX_MIN', 10)) * 60_000;
    if (msg.tsMs === null) {
      // Sem timestamp não há como distinguir mensagem de agora de re-entrega de
      // history-sync. Os formatos conhecidos SEMPRE trazem (`Info.Timestamp` no
      // evolution-go, `messageTimestamp` no baileys), então cair aqui é sinal de formato
      // mudado — recusa em vez de responder conversa velha em rajada.
      return { aceito: false, motivo: 'mensagem sem horário (formato inesperado)', chat: msg.chatJid };
    }
    if (Date.now() - msg.tsMs > idadeMaxMs) {
      return { aceito: false, motivo: `mensagem antiga (${Math.round((Date.now() - msg.tsMs) / 60000)} min)`, chat: msg.chatJid };
    }

    const sessao = this.sessao(msg.chatJid);

    // IMAGEM é aceita (com ou sem legenda): a leitura vira texto na conversa e o agente
    // segue com as skills normais — print de promoção, cupom, tela de odds.
    if (!msg.texto && !msg.imagem) {
      if (msg.soMidia) {
        this.avisar(sessao, msg.chatJid, '📎 Eu leio *texto e imagem*. Áudio, vídeo e sticker eu não consigo ler — me escreve ou manda um print.');
        return { aceito: false, motivo: 'mídia não legível (áudio/vídeo/sticker)', chat: msg.chatJid };
      }
      return { aceito: false, motivo: 'texto vazio', chat: msg.chatJid };
    }

    // Comandos locais: não gastam IA.
    const cmd = msg.texto.trim().toLowerCase();
    if (/^\/(novo|limpar|reset|clear)\b/.test(cmd)) {
      sessao.mensagens = [];
      void this.responder(msg.chatJid, '🧼 Contexto limpo. Manda a próxima.');
      return { aceito: true, motivo: 'comando /novo', chat: msg.chatJid };
    }
    if (/^\/(ajuda|help|start)\b/.test(cmd) || cmd === 'ajuda') {
      void this.responder(msg.chatJid, AJUDA);
      return { aceito: true, motivo: 'comando /ajuda', chat: msg.chatJid };
    }
    if (/^\/status\b/.test(cmd)) {
      void this.responder(msg.chatJid, this.textoStatus(sessao));
      return { aceito: true, motivo: 'comando /status', chat: msg.chatJid };
    }

    // Rate limit por chat (protege a cota de IA de uma rajada de mensagens).
    const janelaMs = 60 * 60_000;
    sessao.recentes = sessao.recentes.filter((t) => Date.now() - t < janelaMs);
    const teto = Math.max(1, num('AGENT_WHATSAPP_MAX_POR_HORA', 30));
    if (sessao.recentes.length >= teto) {
      this.avisar(sessao, msg.chatJid, `🛑 Já respondi ${teto} perguntas nesta última hora — pausa de segurança da cota de IA. Tenta em alguns minutos.`);
      return { aceito: false, motivo: 'rate limit por hora', chat: msg.chatJid };
    }

    if (sessao.ocupado || this.emVoo >= this.maxSimultaneas) {
      this.avisar(sessao, msg.chatJid, '⏳ Ainda estou apurando a pergunta anterior (consulta ao vivo nas casas leva tempo). Te respondo e aí manda essa.');
      return { aceito: false, motivo: 'ocupado', chat: msg.chatJid };
    }

    sessao.recentes.push(Date.now());
    sessao.ocupado = true;
    this.emVoo++;
    // Execução em background: a rota já respondeu 200 (senão a Evolution re-tenta).
    void this.processar(msg, sessao).finally(() => {
      sessao.ocupado = false;
      this.emVoo = Math.max(0, this.emVoo - 1);
    });
    return { aceito: true, motivo: 'na fila do agente', chat: msg.chatJid };
  }

  /**
   * Aviso automático (ocupado, limite, mídia) com COOLDOWN de 60s por chat.
   * Sem o cooldown, uma rajada de 10 mensagens durante uma apuração longa geraria 10
   * avisos idênticos no grupo — o próprio agente virando spam.
   */
  private avisar(sessao: Sessao, chatJid: string, texto: string): void {
    if (Date.now() - sessao.ultimoAviso < 60_000) return;
    sessao.ultimoAviso = Date.now();
    void this.responder(chatJid, texto);
  }

  private sessao(chatJid: string): Sessao {
    const agora = Date.now();
    for (const [jid, s] of this.sessoes) if (agora - s.at > this.ttlSessaoMs) this.sessoes.delete(jid);
    let s = this.sessoes.get(chatJid);
    if (!s) {
      s = { mensagens: [], at: agora, ocupado: false, recentes: [], ultimoAviso: 0 };
      this.sessoes.set(chatJid, s);
    }
    s.at = agora;
    return s;
  }

  private async processar(msg: EntradaWhatsApp, sessao: Sessao): Promise<void> {
    const inicio = Date.now();
    const notifier = new WhatsAppNotifier(msg.chatJid);
    this.stats.processados++;
    console.log(
      `📲 [WA-Agente] ${msg.autorNome || msg.autorJid || 'alguém'} em ${msg.chatJid}: ` +
        `${msg.imagem ? '[imagem] ' : ''}${msg.texto.slice(0, 160)}`
    );

    // Feedback imediato no celular: lido + "digitando…" mantido durante a apuração.
    void notifier.marcarLido(msg.msgId ? [msg.msgId] : []);
    void notifier.presenca('composing', 55_000);

    // IMAGEM: baixa da Evolution e converte em texto por visão. Se falhar, segue com a
    // legenda (se houver) e AVISA — melhor responder o que dá do que ficar em silêncio.
    let textoDaMensagem = msg.texto;
    if (msg.imagem) {
      const midia = await notifier.baixarMidia(msg.imagem.mensagem);
      if (!midia) {
        await this.responder(msg.chatJid, '📎 Recebi a imagem mas não consegui baixar o arquivo da Evolution. Manda de novo, ou escreve os dados que eu sigo daqui.', notifier);
        if (!msg.texto) return;
      } else {
        try {
          const leitura = await lerImagemDaConversa(midia.base64, midia.mimeType || msg.imagem.mimeType, msg.texto);
          textoDaMensagem = mensagemComImagem(leitura.texto, msg.texto);
          console.log(`🖼️ [WA-Agente] imagem lida por ${leitura.provider} (${leitura.texto.length} chars)`);
        } catch (err: any) {
          const motivo = `${err?.message || err}`.slice(0, 140);
          console.error(`❌ [WA-Agente] visão falhou: ${motivo}`);
          await this.responder(
            msg.chatJid,
            `👁️ Recebi a imagem, mas a *leitura de imagem* falhou agora (${motivo}). Se for print de promoção, me manda por texto a odd mínima, a odd total e o valor — eu monto daqui.`,
            notifier
          );
          if (!msg.texto) return;
        }
      }
    }

    // Em GRUPO, quem falou entra no conteúdo: a sessão é por chat, então sem isso duas
    // pessoas viram um interlocutor só e o agente responde "você disse" para quem não disse.
    const conteudo = msg.ehGrupo && msg.autorNome ? `${msg.autorNome}: ${textoDaMensagem}` : textoDaMensagem;
    sessao.mensagens.push({ role: 'user', content: conteudo });
    sessao.mensagens = sessao.mensagens.slice(-this.maxHistorico);

    try {
      const r = await rodarAgente(sessao.mensagens, this.revalidation, { canal: 'whatsapp' });
      // Guarda a resposta CRUA (markdown) no histórico: é o que o modelo escreveu, e é
      // o que ele espera reler no próximo turno.
      sessao.mensagens.push({ role: 'assistant', content: r.reply });
      sessao.mensagens = sessao.mensagens.slice(-this.maxHistorico);

      const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
      const usadas = r.passos.filter((p) => p.ok).map((p) => p.skill);
      const rodape = ligado('AGENT_WHATSAPP_TRACE', true)
        ? `\n\n_🛠️ ${usadas.length ? usadas.join(', ') : 'sem skill'} · ${segundos}s · ${r.provider}${r.modelo ? `/${r.modelo}` : ''}_`
        : '';
      await this.responder(msg.chatJid, `${markdownParaWhatsApp(r.reply)}${rodape}`, notifier);
      this.stats.respondidos++;
      console.log(`📲 [WA-Agente] respondido em ${segundos}s (${r.passos.length} skill(s), ${r.provider})`);
    } catch (err: any) {
      this.stats.erros++;
      const detalhe = `${err?.message || err}`.slice(0, 200);
      console.error(`❌ [WA-Agente] falhou: ${detalhe}`);
      await this.responder(msg.chatJid, `❌ Deu erro aqui do meu lado: ${detalhe}\n\nTenta de novo — se persistir, olha o painel em IA & Automação.`, notifier);
    } finally {
      void notifier.presenca('paused');
    }
  }

  /** Envia (fatiando quando longo). Nunca lança: falha de envio não pode derrubar o worker. */
  private async responder(chatJid: string, texto: string, notifier?: WhatsAppNotifier): Promise<void> {
    const wa = notifier || new WhatsAppNotifier(chatJid);
    try {
      for (const parte of dividirMensagem(texto)) {
        await wa.enviarTexto(parte);
      }
    } catch (err: any) {
      console.error(`❌ [WA-Agente] envio falhou: ${`${err?.message || err}`.slice(0, 160)}`);
    }
  }

  private textoStatus(sessao: Sessao): string {
    const skills = SKILLS.length;
    return [
      '🤖 *Sure Agent — status*',
      `• skills disponíveis: *${skills}*`,
      `• contexto desta conversa: *${sessao.mensagens.length}* mensagem(ns)`,
      `• perguntas na última hora: *${sessao.recentes.length}*`,
      `• execuções em voo: *${this.emVoo}*`,
      `• recebidos/processados/respondidos: ${this.stats.recebidos}/${this.stats.processados}/${this.stats.respondidos}`,
      '',
      '_/novo limpa o contexto · /ajuda mostra o que eu sei fazer_',
    ].join('\n');
  }

  /** Estado para o painel/curl (GET /api/whatsapp/webhook). */
  getStatus() {
    return {
      ativo: ligado('AGENT_WHATSAPP_ATIVO', true),
      chats_autorizados: chatsPermitidos(),
      token_exigido: !!(process.env.AGENT_WHATSAPP_WEBHOOK_TOKEN || '').trim(),
      trace_no_rodape: ligado('AGENT_WHATSAPP_TRACE', true),
      sessoes: Array.from(this.sessoes.entries()).map(([jid, s]) => ({
        chat: jid,
        mensagens: s.mensagens.length,
        ocupado: s.ocupado,
        ultima_atividade: new Date(s.at).toISOString(),
      })),
      em_voo: this.emVoo,
      contadores: this.stats,
    };
  }

  /** Últimos payloads crus recebidos (diagnóstico do formato do webhook). */
  ultimosPayloads() {
    return this.ultimos;
  }
}
