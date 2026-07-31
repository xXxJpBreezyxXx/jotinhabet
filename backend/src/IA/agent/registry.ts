/** Registro central das skills do Agente. */

import { Skill } from './tipos';
import { SKILLS_ODDS } from './skills/odds';
import { SKILLS_RADAR } from './skills/radar';
import { SKILLS_BANCA } from './skills/banca';
import { SKILLS_REGRAS } from './skills/regras';
import { SKILLS_CALCULO } from './skills/calculo';
import { SKILLS_CONHECIMENTO } from './skills/conhecimento';
import { SKILLS_ACOES } from './skills/acoes';
import { FerramentaModelo } from './chatModels';

export const SKILLS: Skill[] = [
  ...SKILLS_ODDS,
  ...SKILLS_RADAR,
  ...SKILLS_BANCA,
  ...SKILLS_REGRAS,
  ...SKILLS_CALCULO,
  ...SKILLS_CONHECIMENTO,
  ...SKILLS_ACOES,
];

export function acharSkill(nome: string): Skill | undefined {
  const n = (nome || '').trim().toLowerCase();
  return SKILLS.find((s) => s.nome.toLowerCase() === n);
}

/**
 * Definições no formato que os motores enviam ao modelo, em versão ENXUTA.
 *
 * O orçamento é apertado: a Groq no free tier limita tokens POR MINUTO (8k no
 * gpt-oss-120b, 12k no llama-3.3-70b) e o system prompt + tools são reenviados em
 * TODA rodada do loop. Com as descrições longas dava ~4,4k tokens só de ferramentas e
 * a chamada voltava 413 (request too large). Aqui usamos `resumo` (1 linha) e cortamos
 * descrição de parâmetro acima de 90 caracteres.
 */
export function ferramentasParaModelo(): FerramentaModelo[] {
  const enxugarParams = (p: any) => {
    const props: Record<string, any> = {};
    for (const [nome, def] of Object.entries<any>(p.properties || {})) {
      const copia: any = { ...def };
      if (typeof copia.description === 'string' && copia.description.length > 70) {
        copia.description = `${copia.description.slice(0, 67)}...`;
      }
      props[nome] = copia;
    }
    // Só type/properties/required vão ao modelo. `additionalProperties: false` na RAIZ
    // fica de fora: é validação nossa, custa tokens em toda rodada e há provedor que
    // recusa campos extras no schema de função.
    const enxuto: any = { type: 'object', properties: props };
    if (p.required?.length) enxuto.required = p.required;
    return enxuto;
  };
  return SKILLS.map((s) => ({
    nome: s.nome,
    descricao: s.resumo || s.descricao,
    parametros: enxugarParams(s.parametros),
  }));
}

/** Catálogo para a UI (aba IA & Automação) e para o /api/ai/skills. */
export function skillsParaUI(): Array<{
  nome: string;
  grupo: string;
  descricao: string;
  parametros: string[];
  custosa: boolean;
  escrita: boolean;
}> {
  return SKILLS.map((s) => ({
    nome: s.nome,
    grupo: s.grupo,
    descricao: s.descricao,
    parametros: Object.keys(s.parametros.properties || {}),
    custosa: !!s.custosa,
    escrita: !!s.escrita,
  }));
}
