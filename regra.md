## 8. Lógica de Varredura e Filtro de Oportunidades (Scanner)

Este módulo define a regra de decisão para a identificação de *Surebets* durante a raspagem de dados (*web scraping* ou consumo via API) nas casas de apostas. O algoritmo deve descartar automaticamente cenários com margem a favor da casa (prejuízo) e sinalizar apenas operações com lucro matemático positivo.

### 8.1. A Regra de Validação (Ponto de Empate / Break-even)

Para que um par de cotações represente uma oportunidade de arbitragem, a soma das probabilidades implícitas deve ser inferior a 100%. A validação ocorre cruzando a Cotação da Casa 1 ($O_1$) com a Cotação da Casa 2 ($O_2$).

A operação é classificada como **APTA PARA EXECUÇÃO** se, e somente se, a seguinte inequação for verdadeira:

$$O_2 > \frac{O_1}{O_1 - 1}$$

Alternativamente, a validação global do mercado (Soma das probabilidades menor que 1) é calculada por:

$$\left(\frac{1}{O_1}\right) + \left(\frac{1}{O_2}\right) < 1$$

---

### 8.2. Pseudo-código de Triagem para o Bot

Abaixo está a estrutura lógica (*conditional statements*) que a automação deve processar a cada evento escaneado antes de acionar a calculadora de aportes:

```python
FUNCAO validar_entrada(odd_casa_A, odd_casa_B):
    
    # 1. Tratamento de exceção de dados corrompidos
    SE odd_casa_A <= 1.00 OU odd_casa_B <= 1.00:
        RETORNAR Falso (Ignorar evento)
        
    # 2. Cálculo do gatilho mínimo para a Casa B
    odd_minima_exigida = odd_casa_A / (odd_casa_A - 1)
    
    # 3. Tomada de decisão
    SE odd_casa_B > odd_minima_exigida:
        # A combinação gera lucro positivo
        ACIONAR_CALCULADORA_DE_STAKE()
        RETORNAR Verdadeiro 
    SENAO:
        # A combinação gera prejuízo ou zero a zero
        RETORNAR Falso