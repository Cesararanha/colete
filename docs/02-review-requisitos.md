# Colete — Review crítico da análise de requisitos

> **HISTÓRICO — NÃO NORMATIVO.** Retrata o levantamento de 17/08/2026 e pode citar arquivos,
> contagens e regras substituídos. Para implementação, prevalecem `01`, `04` e `09`–`17`.

**Data:** 17/08/2026
**Base revisada:** `colete-requisitos.md` (perguntas 1–62, blocos A a L)
**Documentos relacionados:** `colete-faculdade.md` (contexto acadêmico e plano de entrega) ·
`colete-pesquisa-usuarios.md` (roteiro de pesquisa)
**Postura desta revisão:** adversarial. O objetivo não é elogiar o levantamento, é achar
onde ele quebra. Levantamento está bom — por isso vale a pena atacá-lo agora, enquanto
mudar custa uma frase e não uma refatoração.

**Resumo:** 4 contradições internas, 19 lacunas funcionais, 6 riscos técnicos, 5 requisitos
não-funcionais ausentes e **1 risco de escopo que ameaça o projeto inteiro**.

---

## 🔴 PARTE 1 — Contradições internas

Decisões que se contradizem dentro do próprio documento. Todas de correção trivial, mas
qualquer uma delas vira bug ou discussão na hora de implementar.

### C1. Visibilidade da nota — duas regras opostas

- **Seção 5.6:** "o organizador escolhe se a nota é pública ou privada"
- **Seção 6.4:** "Recomendação: nota privada, visível só ao organizador"

A 6.4 ficou congelada na recomendação antiga e nunca foi atualizada depois que você decidiu
tornar configurável. **Vale a 5.6.** A 6.4 precisa ser reescrita como *risco social* — que
continua existindo — e não como decisão.

### C2. Stack aparece como decidida e como pendente

- **Seção 7-ter:** "Definido: React Native + Expo + TypeScript"
- **Seção 1 (Plataforma):** "React Native × Flutter ainda não decidido"
- **Seção 8:** "React Native (Expo) × Flutter — depende do bloco L"

Duas seções desatualizadas. Mesmo problema com **backend** (decidido Supabase na 7-bis,
listado como "a definir" na 8) e **push** (Expo Notifications na 7-bis, "provedor a definir"
na 8). A seção 8 inteira está obsoleta.

### C3. "Admin tem todas as permissões" × política de LGPD

- **Seção 2:** "Admin — Global. **Todas as permissões** da plataforma."
- **Seção 5.5:** comprovante — "Quem pode ver: só o organizador daquele racha —
  **nem o Admin** em operação normal."

Contradição direta, e é a que mais importa: é justamente o argumento de LGPD que você vai
apresentar. **Correção:** Admin tem poderes **administrativos** (moderar, banir, suspender
grupo), não acesso irrestrito a dado pessoal. Acesso a comprovante, se algum dia necessário,
seria excepcional, justificado e **registrado em log**. Isso é o princípio do menor
privilégio — e é uma frase que impressiona em banca.

### C4. Status das perguntas está inconsistente

A seção 7-bis se declara "DEFINIDO ✅ (perguntas 58–62)" e três linhas abaixo avisa que a 58
não foi respondida. E o cabeçalho do documento ainda diz "blocos A, B e C fechados. Próximo:
bloco D" — de quando tudo estava começando.

---

## 🟠 PARTE 2 — Lacunas funcionais

Comportamentos que o app vai precisar executar e que ninguém definiu. Cada um traz uma
proposta de default para você aprovar ou rejeitar rápido.

### L1. 🔴 "Mensalista" não existe como entidade

**A lacuna mais grave do documento.** A janela de prioridade, a regra de pagamento
pressuposto e o comportamento da abertura da lista **dependem inteiramente** do conceito de
mensalista. E em nenhum lugar está definido:

- Como alguém **vira** mensalista? O dono marca membro por membro?
- É atributo do **membro no grupo** ou do **usuário**? (tem que ser do membro no grupo)
- Existe **data de validade**? Mensalista de agosto continua mensalista em dezembro?
- Quem **remove** o status?
- O mensalista **vê** que é mensalista?

Sem isso, a etapa 3 do ciclo de vida não é implementável.

> **Proposta:** flag booleana no vínculo membro–grupo, ligada e desligada pelo dono ou
> organizador, sem data de validade na v1 (validade entra junto com o controle de
> mensalidade, que já ficou para depois). O jogador vê um selo "Mensalista" no perfil dele
> dentro do grupo.

### L2. 🔴 Estrela pode ser manipulada e não é auditada

Você criou a trilha de auditoria para o organizador "não sabotar o sorteio". Ela registra
**re-sorteios** e **trocas manuais**. Mas não registra o caminho mais fácil de manipular:
**mexer na estrela antes de sortear.**

Se o organizador rebaixa um craque de 5 para 3, o algoritmo entrega o time desequilibrado
sozinho, o sorteio sai "limpo", nenhuma troca manual acontece, e a trilha não mostra nada.
A defesa que você desenhou tem uma porta aberta do lado.

Agrava: **o organizador joga e avalia a si mesmo.** Ele pode se dar 5, ficar com os
melhores por consequência do algoritmo, e a auditoria fica muda.

> **Proposta:** versionar a nota. Toda alteração de estrela vira registro (quem, quando, de
> quanto para quanto). Alterações feitas **no dia do racha, com lista fechada**, aparecem na
> trilha pública junto com re-sorteios e trocas. Alterações rotineiras, feitas dias antes,
> ficam no histórico sem alarde. Isso preserva a liberdade de reavaliar e fecha a brecha.

### L3. 🔴 Nota pode ser alterada depois do sorteio publicado

"O organizador pode alterar a qualquer momento" não tem trava temporal. Alterar depois de
publicar os times corrompe o registro do que gerou aquela divisão.

> **Proposta:** ao publicar, o racha **congela** um retrato das notas usadas. Alterações
> posteriores valem para o próximo racha, não reescrevem o passado.

### L4. Racha não tem ciclo de vida completo

O documento descreve criação → lista → pagamento → sorteio → publicação. E depois? Não
existe estado "realizado". A "Tela de Rachas" mostra os próximos — para onde vai o racha de
ontem? Sem um estado final, não há histórico, e o histórico é pré-requisito do que você já
planejou para a v2 (estatísticas, ranking, evitar formações repetidas).

> **Proposta:** máquina de estados explícita — `rascunho → agendado → lista_aberta →
> lista_cheia → em_pagamento → times_publicados → realizado` com `cancelado` acessível a
> partir de quase todos. Transição para `realizado` automática algumas horas após a hora de
> início.

### L5. Cancelamento de racha não define o destino do dinheiro

A notificação "racha cancelado" existe. A regra do que acontece com quem já pagou, não.

> **Proposta:** ao cancelar, o app exige confirmação e exibe a lista de quem pagou, marcada
> como **"a devolver"**, com o valor total. O app não movimenta dinheiro (regra já
> estabelecida), mas não pode fingir que o problema não existe.

### L6. Edição de racha com lista aberta é indefinida

O organizador pode mudar data, hora, local ou valor depois que vinte pessoas já entraram e
dez já pagaram? Mudou de quinta para sexta — quem não pode na sexta continua ocupando vaga.

> **Proposta:** campos travados em níveis. **Local e hora** podem mudar com push obrigatório
> para todos. **Data** e **valor** não podem mudar com lista aberta — para mudar, cancela e
> cria outro. É restritivo de propósito: mudar o preço depois que metade pagou é fonte de
> briga garantida.

### L7. Vaga vazia sem ninguém na espera

A regra diz "a vaga vai para o 1º da lista de espera". E se a espera estiver vazia? A lista
já estava fechada por lotação. Ela **reabre**?

> **Proposta:** sim. Vaga vazia + espera vazia = lista volta ao estado aberto e notifica o
> grupo ("abriu uma vaga!"). Senão a vaga fica órfã e o racha joga com menos gente à toa.

### L8. Dono que sai do grupo ou apaga a conta deixa o grupo órfão

Exclusão de conta está prevista (LGPD) e sair do grupo também. Nenhuma das duas trata o caso
de o sujeito ser **dono**. Grupo sem dono não tem quem crie racha, aprove membro ou aprove
pagamento.

> **Proposta:** dono não consegue sair nem excluir a conta sem **transferir a titularidade**.
> Se não houver mais ninguém no grupo, o grupo é arquivado junto.

### L9. Expulsar membro confirmado e pago

O organizador pode expulsar. E se o cara está confirmado no racha de amanhã e já pagou?

> **Proposta:** expulsar remove das listas de rachas futuros e marca o pagamento como
> "a devolver", igual ao cancelamento.

### L10. Convidado avulso — vários pontos em aberto

- **Quem** gera o link do convidado: qualquer membro ou só o organizador?
- O convidado **ocupa vaga** da lista de linha? (presumo que sim, mas não está escrito)
- O convidado **vê o chat** do grupo? (deveria não ver — é privado do grupo)
- O convidado **entra na corrida** da abertura ou é colocado direto pelo organizador?
- Ele fica com **conta criada** depois. Como é o vínculo dele com o app depois do racha?

> **Proposta:** só organizador gera o link; convidado ocupa vaga de linha; não vê o chat nem
> a lista de membros; é adicionado direto pelo organizador, fora da corrida; depois do racha
> mantém a conta mas fica sem grupo, na tela vazia.

### L11. Mesma pessoa nas duas listas

Nada impede alguém de entrar na lista de linha **e** na de goleiro. Duas vagas, uma pessoa.

> **Proposta:** bloqueio explícito, com mensagem clara.

### L12. Estrela de goleiro trava o sorteio sem servir para nada

O goleiro recebe nota mas **não entra no sorteio**. E a regra diz que o sorteio só libera
"quando todos os participantes tiverem estrela". Ou o goleiro está fora dessa exigência, ou
o organizador é obrigado a preencher um dado que o algoritmo ignora.

> **Proposta:** a trava vale só para a **lista de linha**. Nota de goleiro é opcional e serve
> de histórico.

### L13. Recorrência sem antecedência definida

"Toda quinta 20h, o app cria sozinho" — cria **quando**? Uma semana antes? No domingo? E se
for feriado? E se a recorrência criar um racha que ninguém quer, quem cancela?

> **Proposta:** ao configurar a recorrência, o organizador define com quantos dias de
> antecedência o racha nasce (padrão: 7). Racha recorrente nasce em `agendado`, e o
> organizador recebe push de confirmação. Sem confirmação até a data de abertura da lista, a
> lista abre normalmente — o silêncio é consentimento, senão vira trabalho manual toda semana.

### L14. Onboarding do usuário zerado não existe

Usuário se cadastra. Não tem grupo nenhum. **O que ele vê?** O documento salta direto para
"Tela de Rachas" e "Tela de Grupos", ambas vazias.

Isso importa muito além do produto: é **literalmente a segunda tela** que o professor vai ver
na apresentação, logo depois do login.

> **Proposta:** estado vazio com duas ações — "Criar meu grupo" e "Entrar com código" — e uma
> frase explicando o modelo (você entra em grupo por convite).

### L15. Rachas passados não têm destino na navegação

Ligado à L4. A Tela de Rachas é linha do tempo dos próximos. O histórico fica dentro do
grupo? Vira aba? Não definido.

### L16. Antecedência do lembrete "a lista vai abrir" não foi definida

Está na tabela de push sem parâmetro. 15 minutos? Uma hora? Configurável?

### L17. Organizador que esquece de avaliar não é cobrado

O sorteio trava sem estrelas, mas nada lembra o organizador. Racha à noite, organizador
esqueceu, ninguém sabe o time.

> **Proposta:** push para o organizador quando o pagamento fecha, e novamente algumas horas
> antes do racha se ainda faltar avaliação.

### L18. Fuso horário não é tratado

Todo horário do app é crítico — abertura da lista, prazo de pagamento, início do racha. Sem
armazenar com fuso, um usuário viajando ou um servidor em UTC quebra a regra por 3 horas.

> **Proposta:** gravar sempre em UTC com o fuso do racha registrado à parte, exibir no fuso
> do racha, nunca no do aparelho. É detalhe de sênior — vale ponto em entrevista.

### L19. O app não tem nome

O glossário define "Racha" como o **evento**. Se o app se chamar Racha, o nome do produto
colide com o vocabulário de domínio ("abra o Racha e entre no racha"). Para um projeto que
vai pro LinkedIn e pro GitHub, o nome é a primeira coisa que se vê.

---

## 🟡 PARTE 3 — Riscos técnicos

### T1. A segunda corrida por vaga é mais complicada que a primeira

Você já mapeou as duas disputas. Mas a segunda tem um detalhe que a primeira não tem:
**quem vence a corrida não é quem clica, é quem envia comprovante** — e o comprovante fica
"em análise" até o organizador aprovar.

Consequências:

- A reserva atômica acontece no **upload do comprovante**, não na aprovação. O upload é a
  operação que precisa ser transacional.
- Se o organizador **rejeitar**, a vaga volta ao bolo — e pode já haver outros esperando.
- Existe **vetor de bloqueio**: alguém sobe um print qualquer só para segurar a vaga em
  análise e decidir depois. Mitigação: prazo máximo em análise (ex.: 2 horas) e rejeição
  automática se o organizador não agir.

### T2. Chave Pix exposta e responsabilidade

A chave é de pessoa física, do organizador. O app exibe e o jogador paga direto. Se o
organizador sumir com o dinheiro, o app não tem como reverter — e o usuário vai reclamar
com **você**.

> **Mitigação:** os Termos de Uso precisam declarar explicitamente que o app **não
> intermedia, não processa e não custodia pagamento** — apenas exibe a chave informada pelo
> organizador e registra comprovantes. Isso não é burocracia: é a diferença entre um app de
> agenda e uma instituição de pagamento, que é atividade regulada pelo Banco Central.

### T3. Chat é um subsistema inteiro disfarçado de item de lista

Está uma linha na seção 5.8 e é, sozinho, o item mais caro da v1: tempo real, ordenação,
paginação, não-lidas, push por mensagem, moderação, denúncia, bloqueio. Some com a exclusão
de conta (mensagens de quem saiu) e com LGPD.

**E o grupo já tem WhatsApp.** O chat não resolve nenhuma das quatro dores que originaram o
projeto — lista, times, dinheiro, organização. Ver R1.

### T4. Plano gratuito do Supabase pausa por inatividade

Projeto free pausa após alguns dias sem requisição. Para um app apresentado em banca, o risco
é abrir na hora H e não responder.

> **Mitigação:** acordar o projeto antes de apresentar; se for demo pública, um ping
> agendado. E ter **captura de tela ou vídeo** como plano B.

### T5. Notificação depende de build nativo

Push do Expo não funciona no Expo Go em todos os cenários, e **não funciona igual em PWA**
(iOS só entrega web push em PWA instalado). Como notificação é peça central do produto,
convém validar cedo em vez de descobrir na véspera.

### T6. Trilha de auditoria precisa ser imutável

Se a trilha for uma tabela comum que o organizador pode alterar, ela não prova nada.
Precisa ser **append-only**, sem update nem delete, garantido por permissão no banco.

---

## 🔵 PARTE 4 — Requisitos não-funcionais ausentes

O documento declara "qualidade nível sênior" no objetivo e depois não define nenhum
requisito não-funcional. Um avaliador técnico nota isso.

| Faltando | Por que importa |
|---|---|
| **Estratégia de testes** | "Qualidade sênior" sem teste é afirmação vazia. No mínimo: teste da reserva atômica e do algoritmo de balanceamento — as duas peças onde erro é invisível e caro. |
| **Critérios de acessibilidade concretos** | Continua tudo em aberto esperando material. Dá para adotar WCAG 2.2 AA como baseline agora e refinar quando o material chegar. |
| **Tratamento de erro e estado offline** | App de campo, sinal ruim. O que acontece se cair a rede no meio da entrada na lista? |
| **Performance mensurável** | "Rápido e leve" não é requisito. Vira requisito quando é "entrar na lista responde em menos de 300 ms". |
| **Observabilidade** | Sem log de erro, você não descobre por que o amigo não conseguiu entrar na lista. |

---

## ⚫ PARTE 5 — O risco que ameaça o projeto

### R1. 🔴 O v1 desenhado é grande demais para o contexto

Este é o achado mais importante do review. Nada acima chega perto.

**O que a v1 acumulou:**

autenticação com três provedores · verificação de e-mail · unificação de contas · exclusão
com anonimização · grupos · convite por link e código · aprovação de membro · expulsão ·
mensalista · racha avulso e recorrente · agendamento automático de abertura · reserva atômica
com idempotência · lista de espera com promoção automática · janela de prioridade ·
convidado avulso · geração de BR Code Pix · upload e aprovação de comprovante · expurgo
automático por LGPD · estrelas com persistência e versionamento · algoritmo de balanceamento ·
trilha de auditoria imutável · chat em tempo real · nove tipos de push · tela de preferência
de notificação · duas telas principais · mapa e deep link.

**Isso é escopo de equipe, medido em meses** — construído por uma pessoa cujo repertório de
programação ainda é desconhecido (pergunta 58 sem resposta).

Nenhuma linha do levantamento está errada. O erro seria tratar tudo como se fosse a mesma
entrega.

> **Recomendação: faseamento em v0 → v1 → v1.5 → v2**, sendo a **v0** um recorte de telas
> navegáveis com dados falsos, sem backend.
>
> O plano completo, com o conteúdo de cada fase e a amarração aos prazos, está em
> **`colete-faculdade.md`, seção 6**.
>
> Nada do que foi levantado se perde. O documento de requisitos continua sendo o destino.
> Muda só a ordem de chegada.

---

## ✅ O que está bem resolvido

Para não parecer que só há problema — estes pontos estão acima da média e devem ser
destacados na apresentação:

1. **Separação Grupo × Racha.** Modelagem correta, e você chegou nela sozinho corrigindo o
   vocabulário no meio da conversa.
2. **Regime duplo da lista** — antes do prazo vale ordem de chegada, depois vale quem paga.
   Regra simples, cobre o racha que não enche, e é original.
3. **Trilha de auditoria do sorteio.** Diferencial real de produto. Resolve desconfiança, não
   só logística. (Fechada a brecha da L2.)
4. **Política de retenção do comprovante.** Está mais rigorosa que a de muito app comercial.
5. **Não coletar telefone.** Minimização de dados aplicada de verdade, com justificativa.
6. **Duas listas independentes, goleiro fora do sorteio.** Fiel a como pelada funciona de
   verdade — e isso é o que o professor chama de "app que faz sentido".

---

## Decisões que precisam de você

Em ordem de impacto:

1. **Aceita o faseamento com a v0?** (R1 — decide o que a gente faz esta semana)
2. **Como alguém vira mensalista?** (L1 — trava a implementação da lista)
3. **Versionar as estrelas para fechar a brecha da auditoria?** (L2)
4. **O que você já programa hoje?** (pergunta 58, ainda sem resposta)
5. Aprovar em bloco os defaults propostos de L3 a L19 — ou apontar os que discorda.

---

## Mapa dos documentos

| Documento | Contém |
|---|---|
| `colete-requisitos.md` | Requisitos do produto — glossário, papéis, fluxos, pagamento, sorteio, arquitetura |
| `colete-faculdade.md` | Disciplinas, critérios de nota, metodologia UX, prazos, plano de entrega faseado |
| `colete-review-requisitos.md` | Este documento — revisão crítica dos requisitos |
| `colete-pesquisa-usuarios.md` | Roteiro de entrevista e questionário para aplicar no grupo |
