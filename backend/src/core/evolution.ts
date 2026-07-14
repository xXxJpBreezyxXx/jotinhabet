export interface EvolutionDay {
  dia: number;
  bancaInicial: number;
  maoPorTurno: number;
  lucroTurno1: number;
  lucroTurno2: number;
  lucroTurno3: number;
  lucroTotalDia: number;
  bancaFinal: number;
}

export interface ProjectionInput {
  bancaInicial: number;       // Saldo de partida (ex: R$ 359,00)
  dias?: number;              // Quantidade de dias da projeção (padrão 30)
  maxStakePct?: number;       // Percentual da banca por turno (padrão 50% / 0.5)
  roiMedioTurnoPct?: number;  // ROI médio esperado por turno de aposta (padrão 4.0%)
  turnosPorDia?: number;      // Número de turnos operados por dia (padrão 3)
}

/**
 * Gera a projeção de juros compostos diários baseada na planilha de Evolução Diária.
 */
export function projetarEvolucaoDiaria(input: ProjectionInput): EvolutionDay[] {
  const {
    bancaInicial,
    dias = 30,
    maxStakePct = 0.5,
    roiMedioTurnoPct = 4.0,
    turnosPorDia = 3
  } = input;

  const projecao: EvolutionDay[] = [];
  let bancaCorrente = bancaInicial;
  const roiFator = roiMedioTurnoPct / 100;

  for (let d = 1; d <= dias; d++) {
    const maoPorTurno = Number((bancaCorrente * maxStakePct).toFixed(2));
    
    // Calcula o lucro unitário de cada turno
    const lucroTurno = Number((maoPorTurno * roiFator).toFixed(2));
    
    // Lógica com 3 turnos por dia padrão (ou parametrizados)
    const lucroTurno1 = turnosPorDia >= 1 ? lucroTurno : 0;
    const lucroTurno2 = turnosPorDia >= 2 ? lucroTurno : 0;
    const lucroTurno3 = turnosPorDia >= 3 ? lucroTurno : 0;

    const lucroTotalDia = Number((lucroTurno1 + lucroTurno2 + lucroTurno3).toFixed(2));
    const bancaFinal = Number((bancaCorrente + lucroTotalDia).toFixed(2));

    projecao.push({
      dia: d,
      bancaInicial: Number(bancaCorrente.toFixed(2)),
      maoPorTurno,
      lucroTurno1,
      lucroTurno2,
      lucroTurno3,
      lucroTotalDia,
      bancaFinal
    });

    // A banca final do dia corrente é a banca inicial do dia seguinte
    bancaCorrente = bancaFinal;
  }

  return projecao;
}
