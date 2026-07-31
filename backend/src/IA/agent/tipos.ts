/** Tipos do Agente: uma Skill é uma ferramenta que o modelo pode chamar. */

import { RevalidationService } from '../../core/revalidationService';

/** Subconjunto de JSON Schema que os provedores aceitam em function calling. */
export interface EsquemaParametros {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ContextoSkills {
  /** Serviço compartilhado (memo de 60s por casa|evento) — nunca instancie outro. */
  revalidation: RevalidationService;
  /** Origem da chamada, para log/telemetria. */
  origem?: string;
}

export interface Skill {
  nome: string;
  /** Descrição longa — vai para a UI (aba IA & Automação) e para a documentação. */
  descricao: string;
  /**
   * Descrição CURTA enviada ao modelo (~1 linha). Existe porque o teto de tokens por
   * minuto da Groq no free tier (8k–12k) é pago de novo em CADA rodada do loop: 20
   * descrições longas custavam ~4,4k tokens por chamada e estouravam o limite (HTTP 413).
   * Sem resumo, cai na `descricao`.
   */
  resumo?: string;
  parametros: EsquemaParametros;
  /**
   * Skill CARA (sobe browser, varre feed de várias casas). O loop do agente limita
   * quantas chamadas caras uma pergunta pode fazer e o prompt avisa o modelo.
   */
  custosa?: boolean;
  /** Skill que MUDA estado (cria oportunidade, manda WhatsApp). Exige pedido explícito. */
  escrita?: boolean;
  /** Grupo para exibição na UI. */
  grupo: 'odds' | 'radar' | 'banca' | 'regras' | 'calculo' | 'conhecimento' | 'acao';
  executar(args: any, ctx: ContextoSkills): Promise<any>;
}

/** Registro de uma execução de skill (vai no trace da resposta e no log). */
export interface PassoAgente {
  skill: string;
  args: any;
  ok: boolean;
  ms: number;
  /** Resumo curto do resultado para a UI (o payload completo vai para o modelo). */
  resumo: string;
  erro?: string;
}
