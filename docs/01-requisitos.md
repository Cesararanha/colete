# Colete — Requisitos do Produto

**Documento de requisitos funcionais e técnicos do aplicativo.**
Última atualização: 25/08/2026 — revisão adversarial pré-migration e consolidação das
decisões em `09-pivo-produto.md`. Base anterior: perguntas 1 a 111 (17/08).

Este documento trata **exclusivamente do produto**. O contexto acadêmico
(`05-faculdade.md`) é **histórico** — a entrega de faculdade saiu do escopo em 25/08;
o objetivo é uso real no grupo e possível comercialização futura. A revisão crítica está
em `08-review-geral.md`.

---

## 📖 Glossário

Vocabulário oficial do projeto. Vale para todo o código.

| Termo | Significado |
|---|---|
| **Grupo** | Entidade permanente, equivalente a um grupo de WhatsApp. Tem dono, organizadores, membros e foto. Existe para sempre, mesmo em semana sem jogo. |
| **Racha** | O **evento de jogar futebol**. Tem data, horário de início e término, local, vagas, valor, chave Pix, lista de confirmação e times. |

Um **grupo** tem muitos **rachas** ao longo do tempo.

**Nome do produto: Colete.** O colete é o objeto que divide os times na pelada — metáfora
direta do que o app faz. Não colide com nenhum termo de domínio ("abra o **Colete** e entre
no **racha**"). Disponibilidade de marca, domínio e nomes de loja é verificada novamente
antes de qualquer publicação comercial; o levantamento em `07-concorrentes.md` é histórico.

### Vocabulário de interface

| Em vez de | Usar |
|---|---|
| Confirmado na lista | **Titular** |
| Lista de espera | **Reservas** / **Banco** |
| "Você é o 3º da lista de espera" | "Você é o **3º reserva**" |

---

## 1. Visão do produto

**Problema:** organizar o futebol semanal é caótico. Ninguém sabe quem vai de verdade, a
cobrança se perde no grupo do WhatsApp e a divisão dos times gera discussão toda semana.

**Proposta:** um app que resolve tudo que acontece **antes da bola rolar** — lista,
confirmação, pagamento e sorteio equilibrado dos times.

### Princípios de produto

- **Acessibilidade é requisito de primeira classe**, não polimento final.
- **LGPD por design** — minimização de dados, finalidade declarada, retenção mínima.
- **Transparência contra desconfiança** — o app torna regra, re-sorteio e intervenção
  humana observáveis e contestáveis, sem prometer prova pública da correção das notas.
- **Qualidade de engenharia nível sênior** — performático, leve, arquitetura limpa, testado.

### Escopo por versão

| Versão | Conteúdo |
|---|---|
| **v1** | Antes da bola rolar: lista, presença, pagamento, sorteio dos times |
| **v2** | **Chat** + dentro de campo: gols, estatísticas, ranking, artilheiro, histórico · verificação de pagamento via PSP (Pix dinâmico + webhook) · balanceamento por posição (restrição suave) |

### Plataforma

**Mobile é a versão principal** — iOS e Android. O app **também precisa rodar na web**.

Stack: **React Native + Expo + TypeScript**, com React Native Web para o alvo web.

**Estratégia de distribuição:** enquanto não houver orçamento para publicar nas lojas, a
distribuição é por **PWA** — solução de contorno consciente, não decisão de arquitetura.

**Consequência de projeto:** interface **mobile-first**, comportando-se bem em tela larga;
o celular manda nas decisões de layout quando houver conflito.

---

## 2. Papéis

| Papel | Como se torna | Escopo |
|---|---|---|
| **Admin** | Só o César | Global. Poderes administrativos e continuidade financeira excepcional. Pode transferir titularidade e resolver apenas `financial_case` atribuído, com motivo/acesso logados. Não vira membro nem recebe leitura irrestrita do grupo. |
| **Dono do grupo** | Qualquer usuário pode criar um grupo | Por grupo. **Um dono por grupo.** |
| **Organizador** | Convidado pelo dono | Por grupo. Vários por grupo. |
| **Jogador** | Cadastro + convite aprovado | Por grupo |

1. **Papel é por grupo**, não global.
2. **Qualquer um pode criar um grupo** e ser dono dele.
3. Um grupo pode ter **vários organizadores**, inclusive pontualmente.
4. **Dono e organizador também jogam** — entram na lista e **também são avaliados**.
5. **Princípio do menor privilégio:** administrar não é ver tudo. Acesso a dado pessoal é
   excepcional, justificado e registrado no log administrativo append-only.

---

## 3. Grupo e Racha

### 3.1 Grupo

- Entidade permanente. Tem **nome** e **foto**.
- Dono, organizadores e membros.
- **Teto de 100 membros** por grupo.
- **Máximo de 5 memberships ativas em grupos não arquivados por usuário na v1** (grupo
  próprio também conta). Pedido pendente não ocupa cota, mas entrada e aprovação revalidam
  sob lock para duas aprovações simultâneas não criarem a 6ª membership.
- **Mensalista é recurso opcional por grupo** — um toggle nas configurações, **desligado
  por padrão**. Grupos sem mensalista não veem janela de prioridade nem selo.

**Titularidade:**

- O dono **não sai do grupo nem exclui a conta sem transferir a titularidade e os casos
  financeiros abertos**.
- Se não houver outro membro ativo ou pendente, a exclusão arquiva o grupo e remove a
  membership ativa na mesma operação; `owner_id` permanece apenas como referência histórica
  ao perfil desidentificado. Caso contrário, exige transferência.
- Dono ausente/inativo: outro membro ativo elegível pode assumir. Sem candidato, Admin só
  recebe casos financeiros explícitos para fechamento; não assume acesso geral ao grupo.

### 3.2 Racha

- **Sempre tem data**, com **horário de início e de término**. A duração é definida pelo
  organizador na criação — alimenta a transição para `realizado`, lembretes e histórico.
- Criação: **manual** pelo organizador, ou **recorrente**.
- **Recorrência:** série possui `active`, autoridade, regra/template/Pix versionados e no
  máximo um racha futuro automático. Ao terminal do atual, o avanço trava série e revalida
  estado/versão/segredo antes de copiar um snapshot para a primeira ocorrência futura. Edição
  afeta somente ocorrência ainda não materializada. Desligar concorrentemente cancela o
  próximo intocado; se já houver participação/ciclo, exige confirmação e usa o cancelamento
  financeiro normal. Cron atrasado não cria passado e registra skips.
- **Pode haver mais de um racha futuro aberto** no mesmo grupo.
- **Local:** endereço, com botão de abrir no **Waze / Google Maps**.

**Configuração por racha, definida pelo organizador:**

- Quantidade de vagas de linha
- **Goleiros:** quantidade de vagas, **se goleiro paga e quanto** (ver 5.3)
- Valor por jogador de linha
- Chave Pix de destino, tipo da chave, nome e cidade do recebedor para o BR Code
- **TP — início da prioridade mensalista**, quando habilitada (`T0 − janela`)
- **T0 — horário de abertura geral da lista**
- **T1 — prazo de pagamento** (padrão: 3h antes do início)
- **T2 — fechamento da lista** (padrão: 1h antes do início)
- Duração da janela de prioridade dos mensalistas (se o grupo usa mensalista)

A configuração vem **pré-preenchida com a do racha anterior**.

Recorrência guarda fuso IANA e horário local. Horário inexistente por mudança de fuso é
rejeitado na configuração; horário local ambíguo exige política de offset explícita na
regra, para a mesma ocorrência não mudar entre retries.
Somente dono/organizador ativo edita/ativa/desativa. Pix da série fica cifrado em tabela
própria, nunca no JSON; ocorrência copia uma versão e não lê configuração mutável depois.

**Definição temporal canônica:** T0 é sempre a abertura para todos. Se o grupo usa
mensalistas, TP é derivado como `T0 − janela`; a fase de inscrições começa em TP, mas o
servidor rejeita não-mensalistas até T0. Com a janela desligada, TP = T0.

**UX dos horários:** T1 e T2 são expressos em tempo **relativo ao jogo**
("3 horas antes", "1 hora antes") — mais fácil de entender e reaproveitável na recorrência.
O formulário mostra os padrões preenchidos, esconde o ajuste fino num bloco recolhido
("Horários da lista") e exibe uma **frase-resumo** gerada: *"A lista abre terça às 20h, o
pagamento vence quinta às 17h e a lista fecha quinta às 19h."* Validação de ordem
(TP ≤ T0 < T1 < T2 < início) com mensagem clara. O jogador nunca configura nada — só vê
etiquetas e contagens regressivas.

### 3.3 Estados do racha

Dois eixos **ortogonais** — a fase do racha e o estado da lista:

```
Fase do racha:  agendado → inscrições → fechado → times_publicados → realizado
                                   ↘ cancelado (de qualquer fase antes de realizado)

Exceção auditada: times_publicados → fechado, apenas se uma remoção antes do início
invalidar a escalação; a publicação antiga continua histórica e um novo sorteio é exigido.

Lista (durante inscrições): aberta ⇄ cheia   (reabre se vagar e a espera estiver vazia)
```

- **Não existe `rascunho` no servidor.** Racha meio-preenchido fica salvo localmente no
  aparelho; só existe no servidor quando nasce `agendado`.
- `inscrições` começa em TP (ou T0 sem prioridade); `fechado` começa em T2 **ou** no clique em Sortear, o que
  vier primeiro.
- **Transição para `realizado` é automática: 1 hora após o horário de término.**
- Racha `cancelado` **permanece no histórico**, marcado como cancelado.

### 3.4 Edição de racha com lista aberta

| Campo | Pode mudar? | Regra |
|---|---|---|
| **Local** | ✅ Sim | Push obrigatório para todos os confirmados |
| **Horário do jogo** | ✅ Antes do início | Push obrigatório; recomputa claims/lembretes/retenção futura, sem estender promessa ativa nem reabrir marker |
| **T1/T2** | ⚠️ Até o marco | Pode mudar antes de ser aplicado, com confirmação dura se o novo prazo já venceu; depois do marker não há rollback/reabertura |
| **TP/T0** | ⚠️ Até abrir | Depois de TP, abertura/prioridade não voltam no tempo nem são remarcadas; para corrigir, cancelar e criar outro |
| **Valor** | ⚠️ Condicional | **Só enquanto não houver pagamento real aprovado.** Push obrigatório |
| **Chave Pix / recebedor** | ⚠️ Condicional | Só antes de T0. Depois disso, cancelar e criar outro racha |
| **Data** | ❌ Não | Para mudar a data, cancela e cria outro racha |

**Regra do valor:** `price_locked_at` trava na primeira resolução **real** aceita.
**Pagamento presumido de mensalista NÃO arma essa trava.** Mesmo antes dela, uma edição é
recusada enquanto existir ciclo `pending|under_review`, sessão de
upload ou claim ativa:
a pessoa pode já ter concluído o Pix fora do app. Se só houver mensalistas presumidos e
goleiros isentos, o valor pode mudar com notificação e recomputação atômica. Para destravar
após pagamento real, todos os ciclos precisam constar `refunded`, nenhuma prova pode estar
indecidida e não pode haver contestação aberta. Ao aplicar novo valor, o ciclo antigo
permanece fechado e nasce `charge_version+1` `pending`; nenhum status histórico é reescrito.
A matriz completa de T0/T1/T2/início/fim/local/preço está em
`13-contratos-funcoes.md` §3.2.1.

### 3.5 Cancelamento

Ao cancelar, o app **exige confirmação** e exibe a lista de quem já pagou, marcada como
**"a devolver"**, com o valor total. O app **não movimenta dinheiro** — apenas registra.
Cancelamento exige `reason_code` fechado e gera exatamente um evento público tipado
`match_canceled`; nota opcional permanece privada.
Comprovantes `under_review` aparecem separados e continuam decidíveis depois do
cancelamento: aprovação cria pagamento + `refund_due`, rejeição encerra a disputa. Claims
e sessões não finalizadas são canceladas; o aviso diz que quem já concluiu o Pix no banco
deve procurar o organizador, que registra pagamento tardio + estorno sem reabrir vaga.
Ao cancelar, `purge_after` de provas ainda existentes passa para cancelamento + 7 dias.

---

## 4. Convites e membros

- **Convite por link** e **por código** do grupo.
- Quem entra pelo link **fica pendente de aprovação** do organizador.
- **O jogador pode sair do grupo** por conta própria (exceto o dono — ver 3.1).
- **O organizador pode expulsar.** Expulsão remove das listas de rachas futuros e marca
  pagamento confirmado como **"a devolver"**. Se houver comprovante `under_review`, a
  expulsão é bloqueada até ele ser aprovado/rejeitado: remover a pessoa não pode apagar
  uma disputa financeira.
- Remoção não é banimento permanente na v1. Novo código/link válido pode transformar a mesma
  membership `removed` apenas em `pending`, com papel `player`, mensalista desligado e nova
  aprovação; não existe reativação silenciosa para `active`.
- “Racha futuro” aqui significa `starts_at > now()` e não cancelado/realizado. Se a pessoa
  já estiver em times publicados, a remoção preserva a publicação antiga como histórico,
  limpa o ponteiro atual, volta o racha a `fechado`, incrementa a revisão e avisa os demais
  que é preciso sortear/publicar novamente. Saída voluntária segue a mesma regra; a
  membership só é removida depois de todas essas mutações concluírem atomicamente.

---

## 5. Fluxo do produto

### 5.1 Login e cadastro

**Autenticação do beta PWA:**

- E-mail + senha · **Login com Google**
- **SMTP externo é dependência de produção**, porque o serviço padrão do Supabase não envia
  OTP para usuários externos de forma adequada ao uso real.
- **Login com Apple fica para a fase nativa/lojas.** Nessa fase entra também o vínculo Apple,
  a rotação semestral do segredo web e o atendimento à regra da App Store.
- **Confirmação por e-mail obrigatória** — preferir **código OTP digitável** a link
  (link abre no Safari e não autentica o PWA instalado no iOS)
- **Termos de uso + política de privacidade (LGPD)**, com versão e aceite registrados
- Recuperação de senha
- **Unificação de contas:** e-mail verificado igual pode iniciar um fluxo de vínculo, mas
  nunca mescla perfis silenciosamente; exige sessão recente, confirmação explícita e
  tratamento seguro quando a identidade já pertence a outro perfil.
- **Vínculo manual de contas:** botão "Vincular login Google" no beta. Apple é acrescentado
  na fase nativa; o fluxo exige usuário já autenticado e confirmação explícita antes do
  `linkIdentity`.
- **Completar perfil após OAuth:** provedor que não entregar nome abre uma etapa obrigatória
  de nome antes de criar o perfil ativo.
- **Antiabuso:** login/OTP/reset e resgate de convite têm rate limit por IP + identificador,
  backoff e respostas genéricas que não confirmam se um e-mail possui conta. Redirects OAuth
  usam allowlist exata. O domínio de e-mail configura SPF/DKIM/DMARC antes do beta.

**Campos do perfil:**

| Campo | Status |
|---|---|
| Nome | Obrigatório |
| E-mail | Obrigatório |
| Senha (ou Google no beta) | Obrigatório |
| Apelido | Opcional |
| Foto | Opcional |
| Posição preferida | Opcional — informativa; exibida no cartão do time, **não** entra no sorteio |
| Perna dominante | Opcional |
| Número da camisa | Opcional |

- ❌ **Telefone não é coletado** (minimização LGPD).
- ❌ **Campo "Sou goleiro" removido do perfil** (decisão 25/08) — goleiro é quem entra na
  lista de goleiros do racha; o flag não tinha função.

**Exclusão de conta (LGPD):** Auth é apagado; `profiles.auth_user_id` vira `null`; nome,
apelido, foto e demais atributos são eliminados. Registros históricos usam identificador
interno desidentificado e obedecem à tabela de retenção — pseudônimo reversível continua
sendo tratado como dado pessoal, não como anonimização.

### 5.2 Navegação

**Usuário sem grupo — estado vazio:** "Criar meu grupo" e "Entrar com código", com frase
explicando que se entra em grupo por convite.

**Usuário com grupo — duas telas:**

- **Rachas** — linha do tempo única dos próximos rachas de todos os grupos. Tela de ação.
- **Grupos** — todos os grupos, inclusive sem racha marcado. Tela de gestão + histórico.

### 5.3 Listas e goleiros

**Duas listas independentes por racha:**

| Lista | Vagas | Pagamento |
|---|---|---|
| **Linha** | Definida pelo organizador | Obrigatório, valor da linha |
| **Goleiro** | Quantidade definida pelo organizador | **Definido pelo organizador: paga ou não, e quanto** (pode diferir do valor da linha) |

**Definição das vagas de linha** — por capacidade de time (total vira múltiplo) ou total
livre.

**🥅 Goleiro — modelo único (decisão 25/08):**

- O goleiro pertence ao **gol**, não a um time. Os times de linha rodam na frente dele.
- **Goleiro nunca entra no sorteio.** O algoritmo roda só sobre a lista de linha.
- O organizador cria a lista de goleiros com a quantidade que quiser (normalmente 2),
  independente do número de times.
- Nota de goleiro: **opcional**, serve de histórico. **Nunca bloqueia o sorteio.**
- **Qualquer jogador pode ocupar vaga de goleiro.**
- **A mesma pessoa não pode estar nas duas listas** — bloqueio explícito, mensagem clara.

> O antigo "Modo Sorteado" (um goleiro por time, dentro do sorteio) foi **removido**.

### 5.4 Ciclo de vida da lista

Linha do tempo com três marcos e um início derivado de prioridade:

```
TP prioridade ───── apenas mensalistas; TP = T0 − janela (opcional)
T0 abertura geral ─ entrada por ordem de chegada
T1 prazo de pagar ─ padrão 3h antes do jogo: quem não pagou nem enviou comprovante
                    perde a vaga; reservas sobem
T2 fechamento ───── padrão 1h antes do jogo: lista trava para autoatendimento;
                    só o organizador mexe (registrado na trilha)
```

**Entre TP/T0 e T1 — ordem de chegada:**

1. Em TP a fase abre apenas para mensalistas; em T0 abre para todos. Janela configurável:
   desligada / 30 min / 1h / 2h.
2. Entrada com **um toque**. Lotou → **lista de espera ilimitada**, com posição visível.
3. **Desistência sem ter pago:** sai livremente; o 1º reserva sobe automaticamente com
   push. **Espera vazia** → a lista **reabre** e o grupo recebe push de "abriu vaga".
4. **Desistência depois de pagar:** falar com o organizador (reembolso por fora; remoção
   manual).
5. `joined_at` registra a primeira entrada. A ordem da espera usa `queue_tier, queue_seq`;
   toda ida ao fim recebe nova sequência, sem adulterar o histórico.

**Em T1 — o prazo:**

- Quem não pagou **nem enviou comprovante** perde a vaga (sem tolerância extra — o push de
  "prazo acabando" já avisou antes; padrão editável).
- T1 é aplicado **uma única vez** por racha (`payment_deadline_applied_at`). A expiração de
  ofertas posteriores é uma transição separada, executada por `expire_slot_claims`.
- Cada vaga liberada é oferecida ao **1º da espera**. Pagante recebe push e tem **30 min**
  (padrão, configurável) com a vaga reservada antes de abrir o banco; se não finalizar o
  comprovante, volta ao fim. Mensalista `presumed` e goleiro `exempt` sobem imediatamente,
  sem claim financeira, e o preenchimento continua até a capacidade ou fila acabar.
- **Espera vazia** → aparece **Reservar vaga**. A RPC `claim_open_slot` reserva a vaga por
  10 min; só então a pessoa abre o banco, paga e envia o comprovante. Há no máximo uma
  reserva aberta por pessoa/racha e espera de 10 min após expiração para tentar novamente.
- `join_match` não aceita entrada após T1. Ninguém de fora nem reserva fora da vez pode
  saltar a fila enviando comprovante.
- A reserva é garantia de **vaga temporária**, não prova de pagamento. O app nunca escreve
  “pagar garante”.

**Em T2 — fechamento:**

- Ninguém entra nem sobe sozinho. O organizador **adiciona ou remove manualmente**
  (trilha de auditoria). Ex.: 20 vagas, 19 pagos, 1h antes → fecha com 19; aparecendo o
  20º, o organizador o coloca antes do sorteio. Pagante adicionado pós-T1 recebe claim
  `manual` até `min(agora+30min, início)` antes de ver o Pix e recebe N7 na variante
  manual; mensalista/isento entra confirmado. A adição de membro só existe entre T2 e o
  início e com capacidade; antes de T2, o painel não pode usá-la para furar a fila.
  Expiração pós-T2 não promove fila automaticamente.
- Exceção explícita: um `match_invite` emitido pelo organizador é autorização prévia e
  pode ser resgatado até sua validade/início, inclusive pós-T2, sempre sob capacidade,
  claim e auditoria. Sem esse convite, a tela fechada não oferece autoatendimento.
- **Clicar em Sortear congela a lista no ato**, mesmo antes de T2.

**Botão Sortear:** habilitado quando cada titular tem ciclo com resolução aceita,
`presumed` ou `exempt`, não há prova/claim pendente e todos os
de linha têm estrela. O primeiro sorteio só fecha a lista quando `commit_draw` grava o
resultado na mesma transação; falha de cálculo não congela nada.

**Operação da lista:**

- **Todos veem quem está na lista** e **quem já pagou ou não**.
- Quem está na espera vê a **própria posição** e o **tamanho da fila**.
- Adição manual pelo organizador — **registrada na trilha de auditoria**.
- Remoção manual antes do início continua possível após a publicação; nesse caso invalida
  a escalação atual, preserva o histórico e exige novo sorteio/publicação.
- **Painel financeiro do racha** para o organizador: esperado, arrecadado, pendente
  (mensalistas contam como "presumido", isentos ficam separados e reembolsos usam ledger).

**Mensalista:**

- Recurso **opcional por grupo** (padrão desligado — ver 3.1).
- **Como vira:** dono ou organizador liga o selo no membro. Atributo do **membro naquele
  grupo**. Sem validade na v1. O jogador vê o próprio selo.
- **Benefício:** janela de prioridade + entra com **pagamento presumido** (não trava o
  valor do racha — ver 3.4).
- Vale em todos os rachas abertos do grupo. Quem perde a janela perde só a prioridade e
  disputa por ordem de chegada em T0; o pagamento continua presumido. O status é
  materializado na entrada e não muda retroativamente se o selo for alterado.
- ⚠️ Controle da mensalidade em si fica para etapa posterior.

**Convidado avulso:**

- Não-membro que participa **apenas daquele racha**. Só o organizador gera o link, coloca
  e remove. Ocupa vaga de linha, fora da corrida. Não vê a lista de membros do grupo.
- O link é um `match_invite` com token armazenado como hash, expiração, revogação e limite
  de uso; a validade nunca passa do início do racha. O resgate trava convite e racha,
  consome um uso e ocupa capacidade na mesma transação, sem tornar o convidado membro do
  grupo. Antes de T1 usa o prazo geral; pós-T1 cria claim `manual` antes de mostrar o Pix.
- Paga normalmente e recebe estrela. Depois do racha mantém a conta, sem grupo; o racha
  aparece no histórico pessoal dele.

### 5.5 Pagamento

**Valor:** fixo por cabeça, definido pelo organizador — valor de linha e, se houver,
valor de goleiro (pode ser diferente, inclusive zero).

**Meio:** Pix manual, sem integração bancária. QR Code BR Code/EMV montado com chave, valor,
nome e cidade do recebedor + copia-e-cola. Em tela larga, o copia-e-cola é a ação principal.
Antes de confirmar no banco, o app orienta conferir o nome devolvido pela instituição.
Valor é visível no detalhe; chave, QR e recebedor completos só são retornados ao organizador
ou a starter/claim válida por `get_payment_instructions`. A lista de espera e quem está fora
não leem as colunas Pix da tabela.

**Comprovante:**

- A vaga já precisa estar ocupada ou temporariamente reservada **antes** do pagamento.
- Cada valor/versão usa um `payment_cycle` imutável. Um ciclo aceita no máximo uma resolução:
  aprovação de comprovante **ou** `marked_paid`; novo preço cria ciclo seguinte, não recicla status.
- Upload em duas etapas: `create_proof_upload` cria uma sessão estável;
  `PUT /proof-upload-sessions/:id/content` reautentica/revalida e recebe o binário sem expor
  token/URL/path de Storage; `finalize_proof` verifica o objeto e muda o ciclo para **em
  análise**. Sessões/órfãos expiram. A leitura também passa por Edge autenticada, com checagem
  fresca e `private,no-store`, nunca por signed URL reutilizável.
- Formatos aceitos no beta: JPEG, PNG, WebP e PDF, identificados por assinatura binária e
  limite de bytes no servidor — nunca só pela extensão/`Content-Type`. SVG/HTML são
  recusados; PDF abre em visualizador isolado ou como download, sem execução no domínio do app.
- SHA-256 bruto existe somente durante a finalização. O banco guarda fingerprint
  `HMAC-SHA-256` versionado, com domínio e `group_id`: arquivo igual só coincide no mesmo
  grupo. A API retorna somente `duplicate_signal`, nunca fingerprint/origem. Dump sem a
  chave externa não permite localizar um arquivo. Não existe selo
  “dados conferem”, OCR ou promessa antifraude no beta. Pix dinâmico via PSP fica para v2.
- **SLA de análise: 2 horas, sem vencer antes de T1.** A reserva vence em
  `max(finalized_at + 2h, T1)`: envio cedo nunca pune o jogador antes do prazo geral.
  Se o SLA vencer **antes do início** e o racha estiver ativo, o jogador perde a reserva e
  entra na espera com `queue_tier = 10` (`review_expired`); o comprovante continua pendente
  e nunca é rejeitado automaticamente. Se o relógio vencer ou o job só rodar quando
  `now() >= starts_at`, a escalação já está congelada: starter permanece participante,
  espera permanece espera e o atraso vira somente pendência financeira, com texto próprio.
  Aprovação tardia antes de T2 ocupa uma vaga somente se houver capacidade e ele for o
  primeiro elegível; nunca expulsa titular válido. Entre T2 e o início, uma espera aprovada
  com capacidade retorna `manual_add_required`; sem capacidade, com times publicados ou a
  partir do início, cria `refund_due`. No início, qualquer espera já paga que não foi
  adicionada também vira `refund_due` automaticamente.
- O organizador **aprova** ou **rejeita**. Antes de T1, rejeição volta a `pending`, mantém
  a titularidade e permite novo envio até o prazo; em/após T1, libera a vaga e manda o
  jogador ao fim da fila normal.
- O organizador pode **marcar como pago sem comprovante**.
- Aprovar prova, marcar pago e registrar pagamento de racha cancelado disputam o mesmo lock
  de ciclo e a unique da resolução. Se a marcação externa vencer, a prova vira
  `resolved_elsewhere`; se a aprovação vencer, não nasce segundo pagamento.

**Reembolso:** sempre **fora do app**. O ledger distingue `refund_due` de `refunded`, liga
obrigação à resolução e devolução à obrigação, guarda valor, horário declarado/registro e ator e
nunca reescreve o pagamento aprovado. “Devolvido” é declaração auditada do organizador, não
confirmação bancária; o jogador é avisado para conferir/contestar.

**Contestação financeira:** a pessoa afetada contesta evento do próprio ciclo/grupo/racha por
FK composta. Há resposta e decisão de primeira instância do organizador, janela de sete dias
para o autor aceitar ou apelar uma única vez, e decisão final Admin após apelação/SLA. Toda
transição é append-only. O preço fica travado em aberto/respondida/primeira instância/janela/
apelação/escalonamento; só decisão final ou renúncia encerra.

**Retenção do comprovante — política LGPD:**

| Item | Regra |
|---|---|
| Finalidade | Exclusivamente comprovar o pagamento daquele racha |
| Quem vê | Titular e organizador/dono; Admin somente em `financial_case` atribuído, com acesso logado |
| Retenção | Arquivo, caminho e fingerprint apagados 7 dias após `ends_at`; se cancelado, 7 dias após `canceled_at`; disputa não estende |
| O que sobra | Ledger/ciclo/resolução mínimos pelo mapa; sem OCR, fingerprint ou caminho |
| Armazenamento | Bucket privado; upload/download somente por Edge autenticada, sem signed URL/path no cliente e sem cache compartilhado |
| Transparência | Prazo e finalidade visíveis no upload |
| Direito do titular | Exclusão antecipada: se pendente, retira o comprovante e libera a reserva; se decidido, apaga só o arquivo |

O expurgo de 7 dias não é prorrogado por inércia do organizador. Se uma prova ainda estiver
sem decisão, o arquivo some no prazo, o estado financeiro permanece pendente e o painel vira
incidente operacional: decidir depois exige confirmação explícita de que a evidência não está
mais disponível, motivo e conferência por outra fonte (por exemplo, extrato do recebedor).
Nunca há rejeição automática por causa do expurgo.

O inventário/expurgo canônico está em `17-mapa-dados-lgpd.md`. Backup cifrado inclui somente
provas finalizadas ainda dentro de `purge_after`, com RPO de 24 h sujeito a aceite; órfãos e
exports não entram. Restore descarta prova vencida e reaplica exclusões/prazos antes de abrir.

### 5.6 Avaliação por estrelas

- Escala de **1 a 5**, um único número. Só o organizador avalia. Escopo por grupo.
- A nota persiste entre rachas; o organizador pode alterar.
- **Visibilidade:** privada ou visível aos **membros ativos** do grupo, **padrão privada**;
  nunca pública. O titular sempre enxerga a própria durante a retenção, inclusive removido.
- **Goleiro:** nota **opcional**, histórico apenas. Nunca trava sorteio.
- **Jogador de linha sem nota bloqueia o sorteio.** Sem valor padrão.
- **Finalidade:** exclusivamente balancear os times e preservar a auditabilidade do racha.
- **Retenção:** nota atual enquanto membro ativo; histórico identificável por 12 meses após
  saída do grupo; depois, valores pessoais são eliminados ou agregados. Contestação aponta por
  FK para uma versão de `rating_history`, tem SLA/resposta/escalonamento/resolução e suspende
  purge somente daquela versão.
- Para convidado que nunca virou membro, o relógio de 12 meses começa no último racha dele
  naquele grupo; não existe “membro ativo” eterno sustentando a retenção.

**🔐 Versionamento:** toda alteração registrada — quem, quando, de quanto para quanto.
Alterações **no dia do racha, com lista fechada**, aparecem na trilha pública.
**Com nota privada, a trilha registra QUE houve alteração (quem, quando) — nunca os
valores** (decisão 25/08).

**🔒 Congelamento:** ao publicar, congela o retrato privado das notas. Mudança posterior
exige refazer o sorteio. Aos 12 meses, snapshots/entrada/seed/HMAC/score são fisicamente
apagados; a composição publicada permanece sem estrelas.

### 5.7 Sorteio, times e divulgação

- **O organizador decide quantos times.** Se os tamanhos diferirem, o app exige confirmação
  de que média por jogador não compensa a diferença de quantidade; a confirmação viaja no
  contrato e é validada no servidor, não só num modal local.
- **Execução server-side (decisão 25/08):** o algoritmo roda numa **Edge Function**, que
  grava resultado e semente no registro técnico privado e o fato sanitizado do sorteio
  na trilha pública — o cliente não escreve nenhum dos dois. É o que faz a trilha valer
  como registro confiável sem expor a nota.
- Algoritmo **v3**: busca exata em streaming/reservoir para N≤12; acima disso, partições
  aleatórias e buscas 1↔1/2↔2 com orçamento determinístico versionado. Timeout de parede
  falha sem persistir resultado; benchmark adversarial é gate — especificação binária e
  vetores dourados em `04-algoritmo-sorteio.md`.
- O organizador pode **sortear de novo** ou ajustar um draft manualmente. O draft pode ficar
  temporariamente inválido só na UI; **Publicar** exige cada pessoa uma vez e tamanhos finais
  permitidos. O servidor compara proposta/final e grava `manual_move` por pessoa alterada;
  nenhum time 2/4 intermediário chega ao banco.
- **Posições não entram no sorteio na v1** — posição preferida aparece como informação no
  cartão do time. Balanceamento por posição: v2 (restrição suave).

**🔍 Trilha de auditoria — visível a todos os participantes:** re-sorteios (quantidade),
movimentos manuais finais, alterações de estrela no dia com lista fechada (sem valores, se nota
privada), adições manuais, republicações, identificador opaco + versão do sorteio, quem e
quando. Semente, hash do snapshot e score detalhado ficam no registro privado do
organizador: o domínio de notas 1–5 torna hash público vulnerável a enumeração offline.
**Append-only** — sem update nem delete, garantido por permissão no banco, escrita apenas
server-side.

A trilha pública prova **quais operações o servidor registrou**, não permite reproduzir o
sorteio sem revelar notas e não certifica que as avaliações humanas estavam corretas. Em
contestação, o registro técnico privado pode ser inspecionado por acesso controlado durante
o prazo de retenção; a comunicação do produto não chama a trilha de prova criptográfica.

**Fica para v2:** evitar repetição das mesmas formações semana a semana.

### 5.8 Notificações

**Arquitetura:** outbox com `notifications` (fato mínimo), `notification_contents` (payload
tipado por 90 dias) e uma entrega por destino/canal. O despachante usa lease/retry e entrega
*at least once*; o cliente deduplica por ID. Fato/delivery ficam 12 meses sem depender do
conteúdo; não existe tombstone `{}` inválido.

| Canal | Quando |
|---|---|
| **Web Push (VAPID + service worker)** | PWA — canal atual. Android/desktop direto; **iOS 16.4+ só com PWA instalado na tela inicial** → onboarding iOS com prompt de instalação |
| **Expo Push** | Builds nativos, quando existirem (não suporta web) |
| **Central in-app** (sino, não-lidas) | Sempre — rede de segurança para quem está sem push |
| **E-mail** | Eventos críticos, via provedor externo configurado; nunca pelo SMTP padrão |

Catálogo N1–N28 em `12-notificacoes.md`: abertura/prioridade/vaga · prazo, perda, promoção
e decisão de pagamento · times/lembrete/alteração/cancelamento · membership · trabalho do
organizador · estorno devido/registrado · visibilidade de notas e mudança de papel/
titularidade · suspensão/restauração administrativa · contestação financeira. Entrar/ir à espera é resposta imediata da própria ação e pode ficar como
atividade in-app, sem push adicional.

- Preferência controla **alerta externo por evento**, agrupado visualmente. O fato in-app
  sempre existe. Eventos transacionais têm push/e-mail obrigatórios; os demais permitem
  suprimir esses canais. A regra mora no servidor.
- N1 é fixo em T0−30 min. N13 sempre cria dois fatos in-app; seu único toggle controla em
  conjunto os dois pushes (20h da véspera e 3h antes), sem seleção parcial.

---

## 6. Requisitos críticos

### 6.1 Concorrência na corrida por vaga 🔴

A garantia mora **no banco**. Toda mutação leva `request_id`; em `READ COMMITTED`, uma unique
idempotente é adquirida antes do domínio na mesma transação. O estado
`executing_uncommitted` nunca é commitado: concorrente espera o commit e reproduz
`completed`; rollback elimina chave e efeito juntos. Não há lease/takeover. A entrada usa
normalização por schema + JCS/RFC 8785 e HMAC versionado por operação, com vetor dourado.
Outcome fica 30 dias e tombstone 24 meses; Pix/token/projeção privada nunca entra.

**Dois momentos de disputa:**

1. Corrida na **abertura (T0)** — reserva no toque do botão.
2. Pós-**T1**: promoção da espera é reserva temporária de 30 min; sem fila,
   `claim_open_slot` reserva por 10 min **antes** de abrir o banco. Finalizar o upload
   mantém a reserva até `max(envio+2h,T1)`; rejeição/expiração segue a fase sem overbooking,
   e nunca reescreve a escalação depois que o jogo começa.

A mesma disciplina protege limites de 5 grupos, 100 membros e `used_count<=max_uses`:
locks seguem perfil → grupo → membership → recorrência → racha → convite → participante/claim → ciclo →
prova/financeiro, com UUID crescente em lote. Cenários simultâneos fazem parte do gate.

### 6.2 Balanceamento não é média igual 🔴

O algoritmo v3 distribui força e extremos, cobre dispersão entre todos os times e usa busca
exata para N≤12 — ver `04-algoritmo-sorteio.md`.

### 6.3 LGPD sobre comprovante de Pix 🟡

Dado pessoal de terceiro. Acesso restrito e descarte automático — política em 5.5.

### 6.4 Sensibilidade social da nota 🟡

Padrão privada, aviso ao tornar pública, jogador vê a própria, trilha sem valores.

### 6.5 Login Google + e-mail no beta

SMTP externo é obrigatório para OTP real. Apple entra apenas junto da distribuição nativa,
quando a regra da loja e a conta de desenvolvedor passam a existir; até lá não faz parte do
critério de pronto do PWA.

### 6.6 Segurança do link de convite 🟡

Convite de grupo exige aprovação, expiração/revogação e rate limit. Convite de racha é uma
entidade separada, vinculada ao racha e com limite de uso. Links carregam o token no fragmento
da URL; a landing page troca por POST e limpa a URL imediatamente, com
`Referrer-Policy: no-referrer`, sem analytics/Sentry. O banco guarda só digest com segredo.

### 6.7 Responsabilidade sobre o Pix 🟡

Termos de Uso declaram que o app **não intermedia, não processa e não custodia
pagamento** — exibe a chave informada e registra comprovantes. (A eventual integração PSP
da v2 muda esse desenho: o PSP é a instituição regulada.)

### 6.8 Organizador malicioso e disputa

Rejeição/aprovação, marcação manual de pagamento, reembolso e mudança financeira geram log
do racha; expulsão, papel, titularidade, mensalista e visibilidade de nota geram log do grupo.
Ambos são append-only, payload tipado/validado e visíveis ao afetado por projeção sanitizada.
Contestação financeira é ligada por FKs compostas a ciclo/evento/grupo/racha, com SLA,
primeira decisão, apelação única e decisão final; imagem/motivo nunca vira público.

Suspensão administrativa bloqueia novas inscrições, convites, edições, sorteios e
publicações e exige motivo. Antes de revogar sessões, transfere casos a organizador ativo;
sem candidato, abre caso Admin explícito. Admin atua só pela projeção do caso, com acesso
logado, para prova/estorno/disputa. Exclusão voluntária fica bloqueada se não houver
substituto/canal para obrigação aberta. Restauração é nova entrada append-only.

### 6.9 Falha do relógio

Cron não é a única forma de chegar ao estado correto. Transições têm marcador, podem ser
reconciliadas com segurança, entram em ledger operacional e geram alerta se atrasarem; o
organizador possui ação **Reconciliar agora** que chama a mesma função idempotente.

### 6.10 Governança LGPD

- `policy_acceptances` registra documento, versão, horário e origem do aceite. Aceite dos
  documentos prova ciência/concordância; a base legal de cada tratamento vem do mapa de
  dados e não é presumida como “consentimento” por causa de um checkbox.
- No beta, César responde pela plataforma/autenticação/segurança; o dono do grupo determina
  notas e comprovantes do grupo. O enquadramento controlador conjunto/operador será validado
  juridicamente antes de comercializar; Supabase e provedor de e-mail são operadores.
- Há canal gratuito para acesso, exportação, correção, eliminação, contestação e informação.
  Export tem entidade, ZIP allowlist, expiração 24 h, download reautenticado one-shot e purge.
  Exclusão é saga: `deletion_pending` corta autoridade imediatamente; worker limpa Storage,
  apaga Auth com retry e finaliza desidentificação.
- A Política publica também retenção de aceite, pedido LGPD, notificações, logs e backups;
  “excluir conta” diferencia eliminação imediata, desidentificação e retenção legal
  justificada em linguagem simples.
- Logs/Sentry nunca recebem OTP, chave Pix completa, path/bytes de comprovante ou payload de
  OCR. Dados pessoais permitidos passam por allowlist e redaction.
- O inventário fechado, hipóteses de base legal a validar, operadores, derivados, retenção,
  purge, exceções e backup estão em `17-mapa-dados-lgpd.md`; JSON novo não escapa do mapa.

---

## 7. Requisitos não-funcionais

| Requisito | Definição |
|---|---|
| **Testes** | Reserva/cotas/convites concorrentes; idempotência/replay; resolução financeira cruzada; RLS/payloads negativos; algoritmo com vetores dourados, propriedades e benchmark adversarial |
| **Acessibilidade** | **WCAG 2.2 AA** como baseline — requisito de primeira classe e diferencial de mercado |
| **Performance** | Entrar na lista responde em **menos de 300 ms** (p95, rede normal) |
| **Falha de rede** | Falha honesta com retry. **Nunca** confirmação otimista numa corrida por vaga |
| **Observabilidade** | **Sentry** free com redaction/allowlist de PII e alertas dos jobs |
| **Tema** | Claro **e** escuro |
| **Idioma** | Interface em **português**; código, commits, branches e PRs em inglês; textos centralizados |
| **Fuso horário** | Horários em **UTC**, fuso do racha à parte; exibição sempre no fuso do racha |

---

## 8. Arquitetura técnica

### Stack

| Camada | Escolha | Por quê |
|---|---|---|
| App | **React Native + Expo + TypeScript** | Multiplataforma + PWA, DOM acessível |
| Navegação | **Expo Router** | Rotas por arquivo, deep link pronto |
| Backend | **Supabase (free)** | Postgres, Auth, Storage, Cron, Edge Functions |
| Banco | **PostgreSQL** | Transação atômica de verdade (6.1) |
| Auth | Supabase Auth + SMTP externo | Google e e-mail com OTP no beta; Apple na fase nativa |
| Regras de acesso | **RLS** | Aplica no banco as regras de LGPD |
| Agendamento | **pg_cron / Edge Function** | T0, T1, T2, expurgo de comprovante, `realizado` |
| **Sorteio + trilha** | **Edge Function** | Trilha confiável — cliente não escreve auditoria |
| Push | **Web Push (VAPID) via Edge Function** no PWA; Expo Notifications nos builds nativos | Expo não suporta web |
| Comprovante | Supabase Storage privado + Edge autenticada | Sessão, stream sem signed URL/cache, limpeza de órfãos e backup cifrado dentro de `purge_after` |
| Pix | BR Code montado no app | Sem API bancária na v1 |
| Erros | **Sentry** | Plano gratuito |

**Restrições:** orçamento R$ 0 · lojas adiadas por custo · César tem Mac.

### ⚠️ Pontos de atenção do alvo web

| Ponto | Situação |
|---|---|
| **Push** | Ver 5.8 — arquitetura de canais resolve; iOS exige PWA instalado |
| **Auth no iOS PWA** | OTP digitável não depende de sessão criada no Safari; testar OAuth redirect e instalação cedo |
| **Service worker** | No beta trata push e atualização; sem precache/offline agressivo para não prender versão antiga |
| **QR Code Pix** | Desktop: copia-e-cola é a ação principal |
| **Comprovante** | Upload por seletor de arquivo + arrastar e soltar |
| **Link de convite** | Deep link no celular, URL na web — mesma rota |
| **Abas inferiores** | Acima de ~768 px viram navegação lateral |
| **Armazenamento local** | Rascunho de racha: aparelho no mobile, navegador na web |

---

## 9. Pontos ainda em aberto

| # | Pendência |
|---|---|
| **1** | **Design e layout** — a definir |
| **2** | Padrões de T1/T2, reserva aberta de 10 min e prazo do promovido — validar no grupo |
| **3** | Validar juridicamente os papéis de agente de tratamento antes de comercializar |

Ver `04-algoritmo-sorteio.md` (algoritmo v3) e `09-pivo-produto.md` (decisões).

---

## 10. Histórico do levantamento

Requisitos levantados por entrevista estruturada com César entre 13 e 17/08/2026
(perguntas 1–111, blocos A–V — tabela na versão anterior). **25/08:** pivô de produto e
consolidação de decisões (`09-pivo-produto.md`): faculdade fora do escopo, goleiro em
modelo único, ciclo TP/T0/T1/T2, algoritmo v3, push por outbox multi-canal, sorteio
server-side, vínculo manual de contas. A revisão pré-migration acrescentou reservas antes do
Pix, fila explícita, idempotência, algoritmo v3, identidade histórica, ledger financeiro,
RLS default-deny, operação reconciliável e governança LGPD.
