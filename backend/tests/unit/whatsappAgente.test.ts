import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { markdownParaWhatsApp, dividirMensagem } from '../../src/notify/markdownWhatsapp';
import {
  extrairMensagemWhatsApp,
  chatsPermitidos,
  tokenWebhookValido,
  CHAT_AGENTE_PADRAO,
} from '../../src/IA/agent/whatsappBridge';

describe('markdownParaWhatsApp', () => {
  it('converte negrito, itálico e riscado para o dialeto do WhatsApp', () => {
    const r = markdownParaWhatsApp('**Flamengo** venceu, *tranquilo*, sem ~~drama~~.');
    expect(r).toBe('*Flamengo* venceu, _tranquilo_, sem ~drama~.');
  });

  it('não come a pontuação em volta do negrito (o marcador não usa espaços)', () => {
    expect(markdownParaWhatsApp('**Casa**: KTO.')).toBe('*Casa*: KTO.');
  });

  it('título vira NEGRITO, não itálico, e sem asterisco aninhado', () => {
    expect(markdownParaWhatsApp('## Resumo')).toBe('*Resumo*');
    expect(markdownParaWhatsApp('### Sub *item* com `skill_x`')).toBe('*Sub item com skill_x*');
  });

  it('tabela GFM vira bloco monoespaçado com colunas alinhadas', () => {
    const r = markdownParaWhatsApp(['| Casa | Odd |', '|---|---:|', '| KTO | 2.15 |', '| Superbet | 1.98 |'].join('\n'));
    expect(r).toBe('```\nCasa     | Odd\nKTO      | 2.15\nSuperbet | 1.98\n```');
  });

  it('não formata nada DENTRO de bloco de código', () => {
    const r = markdownParaWhatsApp('```\nx = **nao_negrito**\n```');
    expect(r).toBe('```\nx = **nao_negrito**\n```');
  });

  it('lista markdown vira bullet preservando o nível', () => {
    const r = markdownParaWhatsApp('- pai\n  - filho');
    expect(r).toBe('• pai\n  ◦ filho');
  });

  it('link markdown fica legível (o WhatsApp linkifica URL crua)', () => {
    expect(markdownParaWhatsApp('veja [o jogo](https://kto.bet.br/x)')).toBe('veja o jogo: https://kto.bet.br/x');
    expect(markdownParaWhatsApp('[https://a.b](https://a.b)')).toBe('https://a.b');
  });

  it('não deixa caractere de controle no resultado (o marcador interno é removido)', () => {
    const r = markdownParaWhatsApp('**a** e `b` e | c |');
    expect([...r].some((c) => c.charCodeAt(0) < 9)).toBe(false);
  });

  it('texto vazio não explode', () => {
    expect(markdownParaWhatsApp('')).toBe('');
    expect(markdownParaWhatsApp(undefined as any)).toBe('');
  });
});

describe('dividirMensagem', () => {
  it('mantém mensagem curta inteira e sem numeração', () => {
    expect(dividirMensagem('curta')).toEqual(['curta']);
  });

  it('fatia mensagem longa em fronteira de parágrafo e numera as partes', () => {
    const paragrafo = `${'a'.repeat(300)}`;
    const texto = Array.from({ length: 10 }, () => paragrafo).join('\n\n'); // ~3k+
    const partes = dividirMensagem(texto, 800);
    expect(partes.length).toBeGreaterThan(1);
    expect(partes[0]).toContain('(1/');
    // Nenhuma parte estoura o limite + o sufixo de numeração.
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(800 + 20);
  });
});

describe('extrairMensagemWhatsApp', () => {
  it('lê o formato baileys (Evolution API v2): data.key.remoteJid + message.conversation', () => {
    const m = extrairMensagemWhatsApp({
      event: 'messages.upsert',
      instance: 'Geek-Imperial',
      data: {
        key: { remoteJid: '120363411828181043@g.us', fromMe: false, id: 'ABC123', participant: '551199@s.whatsapp.net' },
        pushName: 'Joao',
        message: { conversation: 'quais jogos ao vivo na KTO?' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    });
    expect(m).toBeTruthy();
    expect(m!.chatJid).toBe('120363411828181043@g.us');
    expect(m!.texto).toBe('quais jogos ao vivo na KTO?');
    expect(m!.msgId).toBe('ABC123');
    expect(m!.fromMe).toBe(false);
    expect(m!.ehGrupo).toBe(true);
    expect(m!.autorNome).toBe('Joao');
  });

  it('lê o formato whatsmeow/Go (remoteJID e ID em maiúsculas, Info/Message)', () => {
    const m = extrairMensagemWhatsApp({
      event: 'Message',
      data: {
        Info: { Chat: '120363411828181043@g.us', Sender: '9981571112984@lid', IsFromMe: false, ID: 'XYZ', PushName: 'Joao' },
        Message: { extendedTextMessage: { text: 'compara Flamengo x Palmeiras' } },
      },
    });
    expect(m).toBeTruthy();
    expect(m!.chatJid).toBe('120363411828181043@g.us');
    expect(m!.texto).toBe('compara Flamengo x Palmeiras');
    expect(m!.msgId).toBe('XYZ');
    expect(m!.autorJid).toBe('9981571112984@lid');
  });

  it('lê data.messages[] (variação de alguns builds)', () => {
    const m = extrairMensagemWhatsApp({
      event: 'messages.upsert',
      data: { messages: [{ key: { remoteJid: '5511@s.whatsapp.net', fromMe: false, id: 'M1' }, message: { conversation: 'oi' } }] },
    });
    expect(m?.texto).toBe('oi');
    expect(m?.ehGrupo).toBe(false);
  });

  it('marca fromMe (as próprias respostas do agente voltam pelo webhook)', () => {
    const m = extrairMensagemWhatsApp({
      event: 'messages.upsert',
      data: { key: { remoteJid: '120363411828181043@g.us', fromMe: true, id: 'S1' }, message: { conversation: 'resposta do agente' } },
    });
    expect(m?.fromMe).toBe(true);
  });

  it('sinaliza mídia sem legenda em vez de devolver texto vazio como pergunta', () => {
    const m = extrairMensagemWhatsApp({
      event: 'messages.upsert',
      data: { key: { remoteJid: '120363411828181043@g.us', fromMe: false, id: 'I1' }, message: { imageMessage: { mimetype: 'image/jpeg' } } },
    });
    expect(m?.soMidia).toBe(true);
    expect(m?.texto).toBe('');
  });

  it('legenda de imagem conta como texto', () => {
    const m = extrairMensagemWhatsApp({
      event: 'messages.upsert',
      data: { key: { remoteJid: '120363411828181043@g.us', fromMe: false, id: 'I2' }, message: { imageMessage: { caption: 'confere esse print' } } },
    });
    expect(m?.texto).toBe('confere esse print');
    expect(m?.soMidia).toBe(false);
  });

  it('ignora eventos que não são mensagem (recibo, presença, conexão)', () => {
    expect(extrairMensagemWhatsApp({ event: 'Receipt', data: { Chat: '120363411828181043@g.us' } })).toBeNull();
    expect(extrairMensagemWhatsApp({ event: 'presence.update', data: {} })).toBeNull();
    expect(extrairMensagemWhatsApp({ event: 'connection.update', data: { state: 'open' } })).toBeNull();
    expect(extrairMensagemWhatsApp({ event: 'messages.update', data: { key: { remoteJid: 'x@g.us' } } })).toBeNull();
  });

  it('envelope desconhecido: cai na varredura em profundidade', () => {
    const m = extrairMensagemWhatsApp({
      payload: { qualquerCoisa: { chat: '120363411828181043@g.us', conversation: 'texto no fundo', id: 'D1', fromMe: false } },
    });
    expect(m?.chatJid).toBe('120363411828181043@g.us');
    expect(m?.texto).toBe('texto no fundo');
  });

  it('lixo não vira mensagem', () => {
    expect(extrairMensagemWhatsApp(null)).toBeNull();
    expect(extrairMensagemWhatsApp('texto')).toBeNull();
    expect(extrairMensagemWhatsApp({ event: 'messages.upsert', data: {} })).toBeNull();
    // JID inválido não passa (protege contra payload forjado sem grupo real).
    expect(
      extrairMensagemWhatsApp({ event: 'messages.upsert', data: { key: { remoteJid: 'nao-e-jid' }, message: { conversation: 'x' } } })
    ).toBeNull();
  });
});

describe('configuração do canal', () => {
  const envOriginal = { ...process.env };
  beforeEach(() => {
    delete process.env.AGENT_WHATSAPP_CHAT;
    delete process.env.AGENT_WHATSAPP_WEBHOOK_TOKEN;
  });
  afterEach(() => {
    process.env = { ...envOriginal };
  });

  it('sem env, o grupo autorizado é o "Sure Agent"', () => {
    expect(chatsPermitidos()).toEqual([CHAT_AGENTE_PADRAO]);
  });

  it('aceita vários JIDs separados por vírgula', () => {
    process.env.AGENT_WHATSAPP_CHAT = '120363411828181043@g.us, 5516999@s.whatsapp.net';
    expect(chatsPermitidos()).toEqual(['120363411828181043@g.us', '5516999@s.whatsapp.net']);
  });

  it('sem token configurado o webhook aceita (compatibilidade); com token, exige o valor exato', () => {
    expect(tokenWebhookValido(undefined)).toBe(true);
    process.env.AGENT_WHATSAPP_WEBHOOK_TOKEN = 'segredo';
    expect(tokenWebhookValido(undefined)).toBe(false);
    expect(tokenWebhookValido('errado')).toBe(false);
    expect(tokenWebhookValido('segredo')).toBe(true);
    expect(tokenWebhookValido(' segredo ')).toBe(true);
  });
});
