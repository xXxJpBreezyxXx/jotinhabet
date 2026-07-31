/**
 * Motores de chat com TOOL CALLING para o Agente.
 *
 * O `IAProvider` do projeto é single-prompt (texto → texto) e não serve para um loop
 * de ferramentas. Aqui há uma camada fina com um formato de mensagem NEUTRO
 * (MsgAgente) e três motores:
 *
 *  - Groq   → REST OpenAI-compatible (default openai/gpt-oss-120b: 131k ctx, tools nativos, LPU rápida)
 *  - OpenAI → mesma REST (gpt-4o-mini por default)
 *  - Gemini → @google/genai com functionDeclarations/functionCalls nativos
 *
 * O formato neutro é o que permite TROCAR DE PROVEDOR NO MEIO do loop sem perder os
 * resultados de ferramenta já obtidos: o histórico é reconvertido para o dialeto do
 * novo motor e o loop continua de onde estava.
 */

import { fetch as undiciFetch } from 'undici';
import { GoogleGenAI } from '@google/genai';
import { EsquemaParametros } from './tipos';

export type MotorNome = 'groq' | 'openai' | 'gemini';

export interface ChamadaFerramenta {
  id: string;
  nome: string;
  args: any;
}

export interface MsgAgente {
  papel: 'user' | 'assistant' | 'tool';
  texto?: string;
  /** assistant: ferramentas que o modelo pediu. */
  chamadas?: ChamadaFerramenta[];
  /** tool: resposta de UMA ferramenta. */
  tool?: { id: string; nome: string; conteudo: string };
}

export interface FerramentaModelo {
  nome: string;
  descricao: string;
  parametros: EsquemaParametros;
}

export interface RespostaModelo {
  texto: string;
  chamadas: ChamadaFerramenta[];
}

export interface MotorChat {
  nome: MotorNome;
  modelo: string;
  configurado: boolean;
  completar(system: string, historico: MsgAgente[], ferramentas: FerramentaModelo[]): Promise<RespostaModelo>;
}

// ───────────────────────────── OpenAI-compatible (Groq / OpenAI) ─────────────────────────────

class MotorOpenAICompat implements MotorChat {
  /** Modelos alternativos tentados quando o atual recusa por limite (413/429). */
  private escada: string[];
  private idxEscada = 0;

  constructor(
    public nome: MotorNome,
    public modelo: string,
    private baseURL: string,
    private apiKey: string,
    private temperatura = 0.25,
    escada: string[] = []
  ) {
    this.escada = [modelo, ...escada.filter((m) => m && m !== modelo)];
  }

  get configurado(): boolean {
    return !!this.apiKey && !this.apiKey.includes('your-');
  }

  /**
   * Uma chamada, com ESCADA DE MODELOS por limite de cota.
   *
   * A Groq no free tier limita TOKENS POR MINUTO por modelo (medido em 30/07/2026:
   * 8.000 no gpt-oss-120b/gpt-oss-20b/qwen, 12.000 no llama-3.3-70b, 70.000 no
   * compound-mini) e o loop de ferramentas reenvia system+tools em cada rodada. Sem
   * esta escada, a 2ª rodada de uma conversa voltava 413 "request too large" ou 429
   * "rate limit reached" e o agente morria no meio do raciocínio.
   *
   * Política: 413 (não cabe) → troca de modelo na hora. 429 (cota do minuto) →
   * espera se o reset for curto (≤ 20s, valor que a própria API informa), senão troca.
   */
  async completar(system: string, historico: MsgAgente[], ferramentas: FerramentaModelo[]): Promise<RespostaModelo> {
    let ultimoErro: any;
    let nudges = 0;
    let esperas = 0;
    /** Reforço só quando o modelo erra o TIPO do argumento (ver tool_use_failed abaixo). */
    let reforco = '';
    const MAX_TENTATIVAS = this.escada.length + 4;

    for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
      try {
        return await this.chamar(this.escada[this.idxEscada], system + reforco, historico, ferramentas);
      } catch (err: any) {
        ultimoErro = err;
        const status = err?.statusHttp;
        const esperaS = err?.esperaSegundos;

        // A Groq VALIDA os argumentos gerados contra o JSON Schema e devolve 400
        // `tool_use_failed` quando o modelo erra o tipo — o caso real observado foi
        // {"limite": "3"} (string onde o schema pede number). Não é falha de infra nem
        // de cota: é variância de amostragem. Re-tenta no MESMO modelo com um reforço
        // de formatação antes de desistir/trocar de provedor.
        const validacaoDeFerramenta = status === 400 && /tool_use_failed|did not match schema/i.test(`${err?.message || ''}`);
        if (validacaoDeFerramenta && nudges < 2) {
          nudges++;
          reforco =
            '\n\nFORMATO DAS FERRAMENTAS: os argumentos são JSON estrito — números SEM aspas ' +
            '(limite: 3, não "3"), booleanos true/false sem aspas, e nada de campos fora do schema.';
          console.warn(`🔧 [${this.nome}] o modelo errou o tipo de um argumento — re-tentando com reforço (${nudges}/2).`);
          continue;
        }

        const ultimoDegrau = this.idxEscada >= this.escada.length - 1;
        // Espera curta faz sentido enquanto há orçamento de tentativas; no ÚLTIMO degrau
        // é a única saída (não há mais modelo com balde separado), então tolera até 30s.
        const tetoEspera = ultimoDegrau ? 30 : 20;
        if (status === 429 && Number.isFinite(esperaS) && esperaS <= tetoEspera && esperas < (ultimoDegrau ? 3 : 2)) {
          esperas++;
          console.warn(`⏳ [${this.nome}] cota do minuto em ${this.escada[this.idxEscada]} — aguardando ${esperaS}s.`);
          await new Promise((r) => setTimeout(r, Math.ceil(esperaS * 1000) + 500));
          continue;
        }
        if ((status === 413 || status === 429 || validacaoDeFerramenta) && !ultimoDegrau) {
          this.idxEscada++;
          this.modelo = this.escada[this.idxEscada];
          console.warn(`🪜 [${this.nome}] ${status} — descendo a escada para ${this.modelo}.`);
          continue;
        }
        throw err;
      }
    }
    throw ultimoErro;
  }

  private async chamar(
    modelo: string,
    system: string,
    historico: MsgAgente[],
    ferramentas: FerramentaModelo[]
  ): Promise<RespostaModelo> {
    if (!this.configurado) throw new Error(`${this.nome}: API key ausente`);

    const messages: any[] = [{ role: 'system', content: system }];
    for (const m of historico) {
      if (m.papel === 'user') {
        messages.push({ role: 'user', content: m.texto || '' });
      } else if (m.papel === 'assistant') {
        const msg: any = { role: 'assistant', content: m.texto || '' };
        if (m.chamadas?.length) {
          msg.tool_calls = m.chamadas.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.nome, arguments: JSON.stringify(c.args ?? {}) },
          }));
          // A API exige content null (não "") quando há tool_calls em alguns modelos.
          if (!m.texto) msg.content = null;
        }
        messages.push(msg);
      } else if (m.papel === 'tool' && m.tool) {
        messages.push({ role: 'tool', tool_call_id: m.tool.id, name: m.tool.nome, content: m.tool.conteudo });
      }
    }

    const body: any = {
      model: modelo,
      messages,
      temperature: this.temperatura,
    };
    if (ferramentas.length) {
      body.tools = ferramentas.map((f) => ({
        type: 'function',
        function: { name: f.nome, description: f.descricao, parameters: f.parametros },
      }));
      body.tool_choice = 'auto';
    }

    // TIMEOUT explícito: o default do undici é 300s e uma chamada pendurada travaria a
    // requisição HTTP do painel por minutos (o loop ainda pode fazer várias rodadas).
    const timeoutMs = Number(process.env.AGENT_LLM_TIMEOUT_MS) > 0 ? Number(process.env.AGENT_LLM_TIMEOUT_MS) : 45_000;
    const resp = await undiciFetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      const erro: any = new Error(`${this.nome}/${modelo} ${resp.status}: ${txt.slice(0, 260)}`);
      erro.statusHttp = resp.status;
      // A Groq devolve o tempo de recarga da cota tanto no header quanto na mensagem
      // ("Please try again in 8.5s") — é esse número que decide esperar × trocar de modelo.
      const header = resp.headers.get('retry-after') || resp.headers.get('x-ratelimit-reset-tokens') || '';
      const doTexto = txt.match(/try again in (\d+(?:\.\d+)?)\s*s/i);
      const bruto = doTexto ? doTexto[1] : `${header}`.replace(/[^\d.]/g, '');
      const seg = parseFloat(bruto);
      if (Number.isFinite(seg)) erro.esperaSegundos = seg;
      throw erro;
    }
    const json: any = await resp.json();
    const msg = json?.choices?.[0]?.message || {};
    const chamadas: ChamadaFerramenta[] = (msg.tool_calls || [])
      .filter((t: any) => t?.function?.name)
      .map((t: any, i: number) => {
        let args: any = {};
        try {
          args = t.function.arguments ? JSON.parse(t.function.arguments) : {};
        } catch {
          args = { __erro_parse: `${t.function.arguments}`.slice(0, 200) };
        }
        return { id: t.id || `call_${i}`, nome: t.function.name, args };
      });
    return { texto: (msg.content || '').toString(), chamadas };
  }
}

// ───────────────────────────── Gemini (function calling nativo) ─────────────────────────────

class MotorGemini implements MotorChat {
  nome: MotorNome = 'gemini';
  modelo: string;
  private ai: GoogleGenAI | null = null;

  constructor(modelo?: string) {
    this.modelo = modelo || process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && !apiKey.includes('your-')) this.ai = new GoogleGenAI({ apiKey });
  }

  get configurado(): boolean {
    return !!this.ai;
  }

  async completar(system: string, historico: MsgAgente[], ferramentas: FerramentaModelo[]): Promise<RespostaModelo> {
    if (!this.ai) throw new Error('gemini: API key ausente');

    const contents: any[] = [];
    for (const m of historico) {
      if (m.papel === 'user') {
        contents.push({ role: 'user', parts: [{ text: m.texto || '' }] });
      } else if (m.papel === 'assistant') {
        const parts: any[] = [];
        if (m.texto) parts.push({ text: m.texto });
        for (const c of m.chamadas || []) parts.push({ functionCall: { name: c.nome, args: c.args ?? {} } });
        if (parts.length) contents.push({ role: 'model', parts });
      } else if (m.papel === 'tool' && m.tool) {
        let payload: any;
        try {
          payload = JSON.parse(m.tool.conteudo);
        } catch {
          payload = { resultado: m.tool.conteudo };
        }
        const parte = { functionResponse: { name: m.tool.nome, response: payload } };
        // AGRUPA respostas consecutivas no MESMO content: quando a rodada teve 3 tool
        // calls, o Gemini espera as 3 functionResponse como partes de um único turno
        // (uma por turno vira histórico ambíguo/rejeitado, e a ordem funcionCall↔Response
        // se perde). Só cria content novo quando o anterior não é um turno de respostas.
        const ultimo = contents[contents.length - 1];
        const ultimoEhRespostas = ultimo?.role === 'user' && ultimo.parts?.every((p: any) => p.functionResponse);
        if (ultimoEhRespostas) ultimo.parts.push(parte);
        else contents.push({ role: 'user', parts: [parte] });
      }
    }

    const config: any = { systemInstruction: system };
    if (ferramentas.length) {
      config.tools = [
        {
          functionDeclarations: ferramentas.map((f) => ({
            name: f.nome,
            description: f.descricao,
            parameters: f.parametros,
          })),
        },
      ];
    }

    const resp: any = await this.ai.models.generateContent({ model: this.modelo, contents, config });
    const chamadas: ChamadaFerramenta[] = (resp?.functionCalls || []).map((fc: any, i: number) => ({
      id: fc.id || `call_${i}`,
      nome: fc.name,
      args: fc.args || {},
    }));
    return { texto: (resp?.text || '').toString(), chamadas };
  }
}

// ───────────────────────────── fábrica ─────────────────────────────

export function criarMotor(nome: MotorNome): MotorChat {
  if (nome === 'groq') {
    // Escada default: cada modelo da Groq tem SEU PRÓPRIO balde de tokens/minuto, então
    // descer a escada multiplica a cota efetiva. Medido na conta em 30/07/2026:
    // llama-3.3-70b 12k → gpt-oss-120b 8k → qwen3.6-27b 8k → gpt-oss-20b 8k →
    // llama-3.1-8b 6k (~42k TPM somados). Sobrescrevível por GROQ_MODEL_FALLBACKS.
    //
    // groq/compound e compound-mini NÃO entram: têm 70k TPM mas a API responde
    // "`tool calling` is not supported with this model" — inúteis para o agente
    // (verificado por chamada real, não por documentação).
    const escada = (
      process.env.GROQ_MODEL_FALLBACKS ||
      'openai/gpt-oss-120b,qwen/qwen3.6-27b,openai/gpt-oss-20b,llama-3.1-8b-instant'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return new MotorOpenAICompat(
      'groq',
      process.env.GROQ_MODEL_AGENTE?.trim() || process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
      process.env.GROQ_BASE_URL?.trim() || 'https://api.groq.com/openai/v1',
      process.env.GROQ_API_KEY || '',
      0.25,
      escada
    );
  }
  if (nome === 'openai') {
    return new MotorOpenAICompat(
      'openai',
      process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
      process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
      process.env.OPENAI_API_KEY || ''
    );
  }
  return new MotorGemini();
}

/** Cadeia do agente (AGENT_PROVIDER_CHAIN), default groq → openai → gemini.
 *  Groq primeiro de propósito: tem tool-calling nativo, é rápida e é a única com
 *  crédito ativo desde 29/07 (OpenAI/Gemini estavam 429 por cota). */
export function cadeiaAgente(): MotorNome[] {
  const validos: MotorNome[] = ['groq', 'openai', 'gemini'];
  const bruto = (process.env.AGENT_PROVIDER_CHAIN || 'groq,openai,gemini').trim();
  const lista = bruto
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is MotorNome => (validos as string[]).includes(s));
  return Array.from(new Set(lista.length ? lista : validos));
}
