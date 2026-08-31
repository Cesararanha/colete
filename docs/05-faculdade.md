# Colete — Contexto acadêmico e plano de entrega

> **HISTÓRICO — NÃO NORMATIVO.** O pivô D1 retirou a faculdade do caminho crítico. Este
> documento não define escopo, prazo nem gate atual do produto.

**Exigências das disciplinas, metodologia cobrada, prazos e faseamento da entrega.**
Última atualização: 17/08/2026

Os requisitos do produto estão em `colete-requisitos.md`. O roteiro de pesquisa de usuários
está em `colete-pesquisa-usuarios.md`.

---

## 1. Objetivos do projeto

| Objetivo | Peso |
|---|---|
| Trabalho de faculdade em **duas disciplinas** | Nota |
| **Teste real** com o grupo de futebol dos amigos | Validação |
| **Portfólio** — publicação no LinkedIn e GitHub, usado em candidatura a vagas | Carreira |

Os três objetivos empurram na mesma direção: o app precisa ser bom de verdade, não só
entregável. Mas o objetivo de carreira só se realiza se o de nota se realizar primeiro.

---

## 2. Disciplina 1 — Desenvolvimento Mobile

**Objetivo do trabalho:** desenvolver as **telas iniciais** do aplicativo. Tema livre, mas o
app precisa fazer sentido — telas com inputs e botões sem nexo são explicitamente reprovadas.

### Pontuação

| Pontos | Requisito |
|---|---|
| **3,0** | Pelo menos **4 telas**, sendo **uma de autenticação** |
| **2,0** | Um **formulário com validação** |
| **3,0** | **Layout visual** trabalhado (professor sugere referência no Pinterest) |
| **1,0** | **Organização e estrutura do código** |
| **1,0** | **Navegação simples (Stack)** |

### Bônus — +0,5 cada

- Navegação adicional: **Bottom tabs / Drawer / subnavegação**
- Usar **bibliotecas externas** não apresentadas em sala
- Subir o projeto no **servidor do Expo com EAS Update** (tutorial anexo do professor)

> Os três bônus são alcançáveis. O de EAS Update também resolve o link público do portfólio.

### Ônus — penalidade

- Projetos iguais entre alunos
- 🔴 **"Projetos feitos com LLM sem o aluno conseguir explicar o que tem lá"**

### Entrega

- Anexar e disponibilizar **link do projeto no GitHub**
- O aluno **apresenta as telas e explica o código**
- Presencial ou online **até 08/09**
- Prazo no sistema: **31/08/2026, 23:59** — submissões múltiplas permitidas
- Se online: GitHub + **vídeo** apresentando o app rodando e explicando o código
- Framework livre — **não precisa ser React Native**

> ⚠️ Conferir com o professor a divergência entre "Due August 31" e "entrega até 08/09".

### 🔴 Como o projeto será conduzido — regra metodológica

O ônus por "projeto feito com LLM sem o aluno saber explicar" **não é um detalhe**: é o
critério que pode zerar a nota, independentemente da qualidade do código. E o professor
arguí, presencialmente ou por vídeo.

**Regra adotada: nada entra no projeto sem César entender.** Cada bloco de código vem
acompanhado da explicação do *por quê*, não só do *o quê*. Ao final, produzir um material de
defesa — as perguntas prováveis e as respostas, na linguagem dele.

Isso serve aos dois objetivos ao mesmo tempo: numa entrevista de emprego, o recrutador
pergunta exatamente as mesmas coisas.

---

## 3. Disciplina 2 — UX / Engenharia da Empatia

### Entregáveis exigidos

1. **Pesquisa**
2. **Perfil do usuário**
3. **Persona**
4. **Jornada do usuário**
5. **Arquitetura da informação**
6. **Principais fluxos**

### Metodologia cobrada — Aula 02: Pesquisa de Usuários

- Tese central: *"Design não é achismo, é processo baseado em dados."*
- Pesquisa de usuários = **coleta de requisitos humanos**. Objetivo: evitar retrabalho.
- **Pilares da usabilidade:** Eficácia (atingir o objetivo sem frustração) · Eficiência
  (otimização de tempo e recursos) · Satisfação (resposta emocional ao uso).

| Métodos (como obtemos dados) | Artefatos (o que construímos) |
|---|---|
| Entrevistas — o "Porquê" (qualitativo) | Perfis de Usuários |
| Observação — o "Como" (comportamental) | Personas |
| Questionários — a Escala (quantitativo) | Mapas de Empatia |
| | Jornada do Usuário |

- **Perfis: Novatos × Expertos.** Novato busca facilidade de aprendizagem → interfaces
  guiadas, fluxo passo a passo. Expert busca eficiência → atalhos, customização, arquitetura
  densa. *"Um novato não é um eterno novato."*
- **Persona** destaca dados demográficos, comportamentos, necessidades e motivações. Serve
  para **evitar o design centrado no próprio desenvolvedor ("eu acho que…")**.
- **Mapa de Empatia** — quadrantes: **Pensa e Sente** · **Vê** · **Escuta** · **Fala e Faz**;
  mais as faixas de **Dores** e **Necessidades/Ganhos**.
- **Ciclo do design baseado em dados:** Pesquisa → Síntese → Interface → Avaliação →
  (recomeça). *"Interfaces usáveis não são acidentes."*

### Metodologia cobrada — Aula 03: Jornada do Usuário

**Os 6 elementos essenciais:**

1. **Persona / Ator** — quem passa pela jornada (*baseado em pesquisa real, nunca em achismo*)
2. **Cenário e Objetivo** — o que a pessoa quer resolver
3. **Fases (Estágios)** — os grandes blocos de tempo
4. **Ações, Pensamentos e Emoções** — em cada fase
5. **Touchpoints (Pontos de contato)** — onde a interação acontece
6. **Oportunidades e Dores** — o diagnóstico final

**Processo linear em 3 fases:** Preparação (passos 1–2) → Construção (passos 3–4) → Análise
(passos 5–6). Passo 5 = marcar a **curva emocional**; passo 6 = converter as quedas da curva
em prioridades de produto.

**As 4 regras de ouro:**

1. **Uma persona por jornada** — não misturar públicos no mesmo mapa
2. **Dados, não opinião** — *"uma jornada bonita mas fictícia engana o time"*
3. **A curva emocional é o ouro** — é nela que se vê onde dói
4. **Compartilhe com o time**

Ferramentas sugeridas: Figma/FigJam, Canva, Miro.

### 🔴 Implicação crítica — a pesquisa tem que ser real

A professora afirma explicitamente que **suposições invalidam o mapa**. Persona e jornada
**não podem ser inventadas** — nem por César, nem por IA.

**Vantagem do projeto:** César **tem** os usuários reais — o próprio grupo de futebol
semanal. Enquanto a turma inventa persona de app de delivery, ele pode entrevistar gente que
sofre o problema toda semana.

| Etapa | Quem faz |
|---|---|
| Roteiro de entrevista e questionário | ✅ Pronto — `colete-pesquisa-usuarios.md` |
| Aplicar com 5 a 8 amigos do grupo | **César** |
| Transformar as respostas nos 6 artefatos | Claude + César |

> Observe que os dois professores estão medindo a mesma coisa por ângulos diferentes: um pune
> o código que o aluno não sabe explicar, a outra pune a pesquisa que o aluno não fez.

---

## 4. Acessibilidade 🔴 aguardando material

César indicou que uma disciplina exige critérios de acessibilidade — cores, TDAH, dislexia —
além de LGPD. **As Aulas 02 e 03 enviadas não contêm esse conteúdo**: tratam de pesquisa de
usuário e jornada.

Pendências:

- Slides/documentos da disciplina de acessibilidade — **não enviados**
- Norma exigida (WCAG 2.2 AA, eMAG, NBR 17060) — **desconhecida**
- Se há relatório/laudo de acessibilidade além do app — **desconhecido**

**Enquanto não chega:** adotar **WCAG 2.2 AA** como baseline e refinar quando o material
aparecer. É o padrão de mercado e cobre a maior parte do que qualquer ementa vai pedir.

---

## 5. Prazos

| Data | Entrega |
|---|---|
| **31/08/2026, 23:59** | Prazo no sistema — projeto mobile (submissões múltiplas permitidas) |
| **08/09/2026** | Apresentação presencial ou online — mobile |
| A definir | Entregáveis de UX (pesquisa, persona, jornada, AI, fluxos) |

---

## 6. Plano de entrega faseado

### O problema

A v1 desenhada no documento de requisitos é escopo de **equipe**, medido em meses:
autenticação com três provedores · grupos e convites · mensalista · racha recorrente ·
reserva atômica com idempotência · lista de espera · BR Code Pix · comprovante com expurgo
automático · estrelas · algoritmo de balanceamento · trilha de auditoria imutável · chat em
tempo real · nove tipos de push.

**O que a faculdade pede:** quatro telas, um formulário validado, layout caprichado, código
organizado, navegação Stack. **Sem backend. Sem banco. Sem autenticação real.**

### A solução — três fases

#### 🎓 v0 — Acadêmica (prazo: 31/08)

Telas navegáveis com **dados falsos**, sem backend:

- Login e cadastro — **com validação de formulário** (vale 2,0 pontos)
- Onboarding do usuário sem grupo (estado vazio)
- Lista de rachas
- Detalhe do racha com a lista de confirmados
- Times sorteados

Entrega **a nota inteira** do professor de mobile, incluindo os três bônus, e serve de
protótipo para ilustrar o trabalho de UX. E — o mais importante — é do tamanho que **César
consegue explicar linha por linha** numa arguição.

#### ⚙️ v1 — App real

Backend Supabase, na ordem: auth → grupos → racha → lista atômica → pagamento → estrelas →
sorteio.

#### 📊 v2

**Chat** + dentro de campo: gols, estatísticas, ranking, artilheiro, histórico de formações.

> O chat foi movido da v1 direto para a v2 por decisão de César: é um subsistema inteiro,
> não resolve nenhuma das quatro dores originais, e o grupo já tem WhatsApp.

> Nada do que foi levantado se perde. O documento de requisitos continua sendo o destino.
> Muda só a ordem de chegada.

---

## 7. Pendências com César

1. **Aprovar a v0 acadêmica** — decide o que fazer esta semana
2. **Pergunta 58: o que você já programa hoje?** — define o quanto explicar de cada linha
3. **Rodar as entrevistas** com o grupo (roteiro pronto)
4. **Enviar o material de acessibilidade**
5. **Confirmar com o professor** a divergência de prazo 31/08 × 08/09
