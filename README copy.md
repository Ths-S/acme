# Sistema de Monitoramento Pessoal (Habit & Task Tracker)

Este é um sistema premium de monitoramento pessoal baseado nas duas imagens de referência, implementado com um backend em Node.js (Express), um banco de dados não relacional baseado em arquivos JSON (com API estilo MongoDB) e gráficos interativos usando a biblioteca **Chart.js**.

## 🚀 Funcionalidades

1. **Habit Tracker (Página 1)**:
   - Dashboard de hábitos para o mês de Janeiro (com suporte a adição e exclusão).
   - Grid de hábitos interativo dividido por semanas com cores exclusivas (conforme imagem).
   - Gráfico de progresso diário de hábitos (linha) usando Chart.js.
   - Monitoramento do **Estado Mental** (Humor e Motivação) com notas de 1 a 10 e cálculo automático de score.
   - Painéis laterais de análise de conclusão de hábitos e médias semanais de mentalidade.

2. **Task Tracker (Página 2)**:
   - Planejamento semanal com seções de domingo a sábado.
   - Indicadores visuais de progresso circular (SVG animados) por dia.
   - Lista interativa de tarefas com cores personalizadas para cada dia da semana.
   - Adicione novas tarefas de forma rápida em cada dia e veja os gráficos atualizarem instantaneamente!
   - Gráfico de progresso semanal (barra) e monitoramento de energia/foco/motivação (linha) usando Chart.js.

## 🛠️ Tecnologias Utilizadas

- **Frontend**: HTML5, Vanilla CSS3 (Design Premium Escuro), Javascript (ES6)
- **Gráficos**: Chart.js (via CDN)
- **Backend**: Node.js, Express.js
- **Banco de Dados**: NoSQL customizado baseado em JSON (persiste dados na pasta `data/`)

## 📦 Como Executar o Projeto

Certifique-se de ter o **Node.js** instalado em sua máquina.

1. **Instalar dependências**:
   No diretório do projeto, execute:
   ```bash
   npm install
   ```

2. **Iniciar o Servidor**:
   Execute o seguinte comando para iniciar o servidor:
   ```bash
   node server.js
   ```

3. **Acessar no Navegador**:
   Abra o seu navegador e acesse:
   [http://localhost:3000](http://localhost:3000)

## 🗄️ Estrutura do Banco de Dados

Os dados são salvos de forma não relacional em arquivos JSON no diretório `data/`:
- `habits.json` — Lista de hábitos ativos.
- `habit_entries.json` — Registro diário de hábitos concluídos.
- `mental_state.json` — Registro de humor e motivação diário.
- `tasks.json` — Lista de tarefas diárias por semana.
- `mindset_tracker.json` — Registro diário de energia, foco e motivação da semana.

*Nota: O banco de dados é populado automaticamente com os dados idênticos aos das imagens de referência na primeira execução.*
