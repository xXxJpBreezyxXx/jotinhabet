import { calcularArbitragem } from '../src/core/calculator';
import { projetarEvolucaoDiaria } from '../src/core/evolution';
import process from 'process';

function runTests() {
  console.log('🧪 Iniciando Testes do Motor de Arbitragem e Juros Compostos...\n');

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`✅ Aprovado: ${testName}`);
      passedTests++;
    } else {
      console.error(`❌ Reprovado: ${testName}`);
      failedTests++;
    }
  }

  // --- SEÇÃO 1: TESTES DE REGRAS DE ODDS (CONFORME regra.md) ---
  console.log('--- Seção 1: Regras de Validação de Odds ---');

  // Teste 1.1: Cotações corrompidas ou inválidas (Menor ou igual a 1.00)
  const oddInvalida1 = calcularArbitragem({
    banca1: 1000, banca2: 1000, odd1: 1.00, odd2: 2.00
  });
  const oddInvalida2 = calcularArbitragem({
    banca1: 1000, banca2: 1000, odd1: 2.00, odd2: 0.95
  });
  assert(oddInvalida1 === null, 'Deve ignorar o evento se Odd da Casa 1 for <= 1.00 (Exceção de dados corrompidos)');
  assert(oddInvalida2 === null, 'Deve ignorar o evento se Odd da Casa 2 for <= 1.00 (Exceção de dados corrompidos)');

  // Teste 1.2: Cálculo exato do limite mínimo (Break-even threshold)
  // Se Odd1 = 2.00, a Odd mínima exigida para a Casa 2 é: 2.00 / (2.00 - 1) = 2.00
  const resultThreshold = calcularArbitragem({
    banca1: 1000, banca2: 1000, odd1: 2.00, odd2: 2.50
  });
  if (resultThreshold) {
    assert(resultThreshold.oddMinimaExigida === 2.00, 'Para Odd1 = 2.00, o limite mínimo (oddMinimaExigida) deve ser exatamente 2.00');
  }

  // Teste 1.3: Tomada de decisão na fronteira (Gatilho de Arbitragem)
  // Caso A: Odd2 > limite mínimo (Lucro positivo)
  const resultLucroPositivo = calcularArbitragem({
    banca1: 1000, banca2: 1000, odd1: 2.00, odd2: 2.05
  });
  assert(resultLucroPositivo !== null && resultLucroPositivo.isArbitrage === true, 'Se Odd2 (2.05) > limite mínimo (2.00), isArbitrage deve ser VERDADEIRO');

  // Caso B: Odd2 = limite mínimo (Zero a zero / Sem arbitragem)
  const resultZeroZero = calcularArbitragem({
    banca1: 1000, banca2: 1000, odd1: 2.00, odd2: 2.00
  });
  assert(resultZeroZero !== null && resultZeroZero.isArbitrage === false, 'Se Odd2 (2.00) = limite mínimo (2.00), isArbitrage deve ser FALSO');

  // Caso C: Odd2 < limite mínimo (Prejuízo / Sem arbitragem)
  const resultPrejuizo = calcularArbitragem({
    banca1: 1000, banca2: 1000, odd1: 2.00, odd2: 1.95
  });
  assert(resultPrejuizo !== null && resultPrejuizo.isArbitrage === false, 'Se Odd2 (1.95) < limite mínimo (2.00), isArbitrage deve ser FALSO');


  // --- SEÇÃO 2: TESTES DE ALOCAÇÃO E LIMITES DE BANCA ---
  console.log('\n--- Seção 2: Alocação de Stakes e Limites de Banca ---');

  // Teste 2.1: Banca da Casa 1 é o gargalo (Aposta 1 maximizada a 50%, Aposta 2 reduzida proporcionalmente)
  const house1LimitResult = calcularArbitragem({
    banca1: 400,   // Limite 50% = 200
    banca2: 2000,  // Limite 50% = 1000
    maxStakePct: 0.5,
    odd1: 2.00,
    odd2: 2.00
  });
  if (house1LimitResult) {
    assert(house1LimitResult.stake1 === 200, 'Aposta na Casa 1 deve ser maximizada para R$ 200 (limite de banca)');
    assert(house1LimitResult.stake2 === 200, 'Aposta na Casa 2 deve ser R$ 200 para equilibrar a odd');
  }

  // Teste 2.2: Banca da Casa 2 é o gargalo (Aposta 2 maximizada a 50%, Aposta 1 reduzida proporcionalmente)
  const house2LimitResult = calcularArbitragem({
    banca1: 2000,  // Limite 50% = 1000
    banca2: 400,   // Limite 50% = 200
    maxStakePct: 0.5,
    odd1: 2.00,
    odd2: 2.00
  });
  if (house2LimitResult) {
    assert(house2LimitResult.stake2 === 200, 'Aposta na Casa 2 deve ser maximizada para R$ 200');
    assert(house2LimitResult.stake1 === 200, 'Aposta na Casa 1 deve ser reduzida para R$ 200 devido ao limite da Casa 2');
  }

  // Teste 2.3: Aplicação de regras de arredondamento configuráveis por casa
  const roundedResult = calcularArbitragem({
    banca1: 1000,
    banca2: 1000,
    maxStakePct: 0.5,
    odd1: 2.00,
    odd2: 2.15,
    roundStep1: 10.0, // Arredondar para múltiplos de 10
    roundStep2: 1.0   // Arredondar para inteiros de 1.00
  });
  if (roundedResult) {
    assert(roundedResult.stake1 % 10 === 0, `Aposta 1 arredondada deve ser múltipla de 10.00 (obtido: R$ ${roundedResult.stake1})`);
    assert(roundedResult.stake2 % 1 === 0, `Aposta 2 arredondada deve ser múltipla de 1.00 (obtido: R$ ${roundedResult.stake2})`);
  }


  // --- SEÇÃO 3: SIMULAÇÃO DE JUROS COMPOSTOS (PLANILHA EXCEL) ---
  console.log('\n--- Seção 3: Juros Compostos e Evolução Diária ---');

  // Teste 3.1: Evolução diária baseada nos dados do Excel: Banca inicial R$ 359, stake de 50%, ROI 4%, 3 turnos
  // Dia 1 Planilha: 
  // Banca Inicial: 359
  // Mão por turno (50%): 179.5
  // Lucro por turno (4%): 179.5 * 0.04 = 7.18
  // Total dia: 7.18 * 3 = 21.54
  // Banca Final: 359 + 21.54 = 380.54
  const evolution = projetarEvolucaoDiaria({
    bancaInicial: 359,
    dias: 5,
    maxStakePct: 0.5,
    roiMedioTurnoPct: 4.0,
    turnosPorDia: 3
  });

  assert(evolution.length === 5, 'A projeção deve conter exatamente 5 dias');
  if (evolution && evolution[0]) {
    const d1 = evolution[0];
    assert(d1.bancaInicial === 359, `Dia 1: A banca inicial de partida deve ser 359 (obtido: R$ ${d1.bancaInicial})`);
    assert(d1.maoPorTurno === 179.5, `Dia 1: O valor de aposta por turno deve ser 179.5 (obtido: R$ ${d1.maoPorTurno})`);
    assert(d1.lucroTurno1 === 7.18, `Dia 1: O lucro do turno 1 deve ser R$ 7.18 (obtido: R$ ${d1.lucroTurno1})`);
    assert(d1.lucroTotalDia === 21.54, `Dia 1: O lucro diário total deve ser R$ 21.54 (obtido: R$ ${d1.lucroTotalDia})`);
    assert(d1.bancaFinal === 380.54, `Dia 1: A banca final do dia deve ser R$ 380.54 (obtido: R$ ${d1.bancaFinal})`);
    
    // Check Dia 2
    const d2 = evolution[1];
    assert(d2.bancaInicial === 380.54, `Dia 2: A banca inicial deve iniciar com o saldo final do Dia 1 (obtido: R$ ${d2.bancaInicial})`);
  }

  console.log(`\n📊 Resumo da Execução dos Testes:`);
  console.log(`   - Aprovados: ${passedTests}`);
  console.log(`   - Reprovados: ${failedTests}`);

  if (failedTests > 0) {
    process.exit(1);
  } else {
    console.log('\n🌟 Todos os Testes de Cálculo e Projeções Foram Concluídos com Sucesso!');
    process.exit(0);
  }
}

runTests();
