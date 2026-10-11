# Colete — Roadmap executável (v2, implementação incremental; D63-A–I em 30/09/2026)

**Atualizado em 30/09/2026 pelas respostas D63-A–I.** M0, M1-A e M1-B foram entregues;
`0001`–`0019`, UI-A e UI-B estão entregues em `main`. O roteiro agora prioriza o ciclo de um
piloto com amigos e preserva em `27-piloto-minimo.md` a classificação das
partes posteriores e das especificações pré-marco. Os documentos `01`, `04` e
`09`–`17` continuam a especificação; o #41 foi mergeado em `main`
(`9805ece`), e `0017`/`0018`/`0019`, UI-A e UI-B foram implementadas (evidências em `26`).

Emendas documentais de 28–29/09/2026 (M2-D24/M2-D25/M2-D31–M2-D42):
`0017` concentra convites e limitador **de piloto**, com uma chave v1 e
barreira por perfil; `0018` publica **só renomear** para a UI-B, sem foto
(M2-D40).
Rotação de chave, dimensão por IP, alarme automático da taxa global e
arquivamento por RPC estão em `25` §8.2 “Pendências pós-piloto”,
**obrigatório antes de abrir o app ao público** (M2-D39).

## 1. Estado da definição

| Bloco | Artefato | Estado atual |
|---|---|---|
| Requisitos e decisões | `01-requisitos.md` · `09-pivo-produto.md` | D1–D62 preservadas; D63-A–I fixam o recorte do piloto |
| Algoritmo | `04-algoritmo-sorteio.md` | v3 binária preservada como evolução; simples por serpentina exige especificação exata antes de M6 (D63-A) |
| Schema/RLS | `10-schema-db.md` | `0001`–`0019` aplicadas/testadas em marcos incrementais; domínios seguintes ainda pendentes |
| Telas e fluxos | `11-telas-v1.md` | 25 telas e F1–F6 alinhados |
| Notificações | `12-notificacoes.md` | N1–N28, payloads, canais e semântica de entrega fechados |
| Contratos | `13-contratos-funcoes.md` | entradas, erros, locks, JCS/HMAC, apelações, recorrência e sagas fechados |
| Projeto/operação | `14-convencoes-app.md` | decisões do beta fechadas |
| Acessibilidade | `15-acessibilidade.md` | critério de pronto desde o primeiro marco |
| Dados/LGPD | `17-mapa-dados-lgpd.md` | inventário e purge físico fechados; validação jurídica segue como gate externo |

Questões de calibragem que podem mudar com o piloto — por exemplo T1/T2, duração de
claim e tom dos textos — são configuração ou conteúdo. Elas não justificam enfraquecer
invariantes: reserva antes do banco, nenhuma ultrapassagem de fila, ledger imutável,
RLS default-deny e sorteio versionado.
**D63-H:** TP/T1 e claims associados são evolução; a adaptação do contrato
T0/fila/T2 precisa ser especificada antes do M4.

## 2. Gates de início e de convite ao beta

- [x] **Antes da migration que usa a regra:** limites iniciais definidos em `private.app_limits`
      e `private.allowed_proof_mime_types` na fatia 1 do B2: `proof_max_bytes = 10485760`,
      `claim_cooldown_seconds = 300`, dispatcher `max_attempts = 6` com backoff de 60 s até
      3600 s, e a allowlist MIME de `13-contratos-funcoes.md` §2.1. São valores de calibragem
      iniciais, sujeitos a revisão no piloto.
- [x] **Gate histórico anterior à primeira migration:** criar o commit de baseline e provar
      que clone limpo reproduz documentos/checksums. Cumprido no M0-A; tag documental e
      proteção de `main` continuam como preparação do primeiro PR remoto.
- [x] **Antes da primeira RPC mutável:** gateway Edge exclusivo implementado e testado na
      Fatia A do M1-A. O cliente chama somente a Edge; `public`, `anon` e `authenticated` não
      recebem `EXECUTE` na RPC interna, e a secret key permanece apenas no backend.
- [ ] **Antes de convidar o beta:** escolher provedor SMTP transacional e validar domínio remetente (SPF/DKIM/DMARC).
      O SMTP padrão do ambiente de desenvolvimento não atende beta com usuários reais.
- [ ] **Antes de convidar o beta:** registrar `VAPID` e estratégia mínima do service worker; nenhum cache de Pix,
      comprovante ou resposta autenticada.
      **D63-B/D:** a estratégia mínima e a proibição de cache valem no piloto;
      `VAPID` é exigido quando push entrar na evolução, sem notificações no app
      durante o piloto.
- [x] **Antes da primeira migration:** mapa técnico fechado em `17-mapa-dados-lgpd.md`,
      com finalidade, hipóteses de base legal, papéis, acesso, derivados, retenção e purge.
- [ ] **Antes de convidar o beta:** validar juridicamente papéis/bases/prazos e registrar
      subprocessadores efetivos; a documentação técnica não substitui essa validação.
- [x] **Antes da primeira migration:** runbook de backup/restore definido em
      `14-convencoes-app.md`, separando banco, migrations, configuração e Storage.
- [ ] **Antes de guardar dado real:** escolher destino externo/chave, executar e aprovar o
      primeiro restore isolado com manifesto de exclusões.
- [ ] **Antes de convidar o beta:** RPO/RTO de comprovante em 24 h formalmente aceitos;
      ainda falta implementar o export diário por allowlist e provar em restore que
      vencido/órfão não volta.
      **D63:** a aceitação de RPO/RTO de 24 h permanece gate do piloto e cobre o
      restore em geral (`14` §5.1; `25` §8.2). A parte específica do comprovante
      (export por allowlist e prova de vencido/órfão) precede habilitar essa evolução.
- [ ] **Antes de convidar o beta:** confirmar que o beta é pessoal/não comercial enquanto usar Vercel Hobby; cobrança
      ou uso por terceiros exige revisão de plano/provedor.
- [ ] **Antes de convidar o beta:** publicar o catálogo de políticas com **pelo menos uma
      versão obrigatória de `terms` e uma de `privacy`** em `private.policy_documents`, com
      `content_sha256` correspondente ao arquivo publicado. Enquanto o catálogo está vazio, o
      gate de `13-contratos-funcoes.md` §5.2 deixa as mutações comuns passarem — decisão
      explícita, registrada lá, porque fechá-lo antes da migration pré-beta deixaria o app
      inutilizável. Convidar usuários com catálogo vazio significaria operar sem aceite
      exigível. O estado **pela metade** — um tipo obrigatório e o outro não — é o único
      incoerente e está proibido por asserção pgTAP na suíte da `0006`, que verifica as duas
      pontas: o catálogo vazio como entregue e o catálogo completo, recusando o parcial.

## 3. B2 — migrations SQL executáveis

Criar migrations pequenas e reversíveis nesta ordem. B2 avança incrementalmente com os
marcos; não é uma migration monolítica nem pré-requisito para começar toda a interface:

1. extensões, helpers seguros e perfis internos;
2. aceite, sessão revogada, pedidos, exports e saga de exclusão;
3. grupos, reentrada e convites por nonce/versão/HMAC;
4. recorrências versionadas, segredos Pix separados, rachas, fila e claims;
5. ciclos e filhos com FKs compostas, sessões/provas, resolução, ledger, estorno,
   contestação, apelação e casos;
6. notas, contestação de versão, artefatos privados, times/draft final e views sanitizadas;
7. auditoria tipada, idempotência transacional/JCS, external-effects, outbox N1–N28 com
   conteúdo separado, markers e job runs;
8. constraints, índices e triggers de revisão/imutabilidade;
9. varredura final de revogação de privilégios e de policies por papel das tabelas das
   fatias 3–8; `enable/force row level security` não espera esta fatia: **toda tabela de
   `public`** nasce com RLS ligada e default-deny na migration que a cria, e tabela de
   serviço em `private` nasce sem RLS, conforme `14` §5.2. A dívida de
   `private.app_limits` e `private.allowed_proof_mime_types`, criadas na `0002` com
   `enable` + `force row level security` e zero policies antes daquela regra existir, foi
   **saldada pela `0008`** e sai desta varredura; a suíte da `0008` prova, camada por
   camada, que a proteção efetiva dessas tabelas são os `revoke all` da `0002` mais a
   ausência de `usage` no schema `private`;
10. RPCs transacionais e jobs; por último, policies do Storage.

### Reordenamento do M1 e mapa fatia→migration

A regra 2 de `13` §0 exige que toda mutação conquiste uma chave idempotente transacional
antes de qualquer efeito. Por isso o M1 antecipa as partes estritamente necessárias das
fatias 7 e 10: esperar a ordem nominal impediria implementar com segurança os primeiros
RPCs de identidade. A antecipação é permitida por esta seção, que define B2 como avanço
incremental por marco, e não muda a ordem de locks nem relaxa os critérios de saída.

| Entrega | Escopo da fatia | Migration |
| --- | --- | --- |
| Baseline de segurança do M0-A | bootstrap anterior às fatias B2 | `0001_bootstrap_security.sql` |
| B2 fatia 1 | extensões, helpers seguros, limites operacionais e perfis | `0002_identity_foundation.sql` |
| B2 fatia 2 | aceite, denylist, pedidos, exports e base da saga | `0003_privacy_and_deletion.sql` |
| M1-A, antecipação da fatia 7 | envelope transacional, validador de outcomes, trigger diferido e suporte à canonicalização; sem helper HMAC produtivo sem chamador | `0004_idempotency_foundation.sql` |
| M1-A, antecipação da fatia 7 | tabelas operacionais estritamente necessárias: `private.external_effects`, `private.job_runs` e `private.retention_runs` | `0005_operational_runs.sql` |
| M1-A, antecipação da fatia 10 | catálogo de políticas, dispatcher interno e RPCs `accept_policies`, `complete_profile`, `revoke_current_session` e `update_profile` | `0006_identity_rpcs.sql` |
| M1-A, retenção antecipada da fatia 7 | expurgo de outcomes e tombstones nos prazos normativos | `0007_idempotency_retention.sql` |
| M1-B, antecipação de identidade/privacidade da fatia 10 | worker e jobs de identidade; saga de exclusão; export governado, bucket `data-exports` e download Edge | `0011_worker_foundation.sql` → `0012_account_deletion.sql` → `0013_data_export_delivery.sql`, conforme o plano normativo `22` |
| M2, fatia 3 e antecipação de grupos/convites da fatia 10 | fundação, isolamento e extensão da exclusão; membership e titularidade; convites/HMAC, limitador e `create_group`; renomear (sem foto); UI-A (telas 10, 11, 12, 16 e 24) e UI-B (telas 17 e 25), sem migration | `0015_group_foundation.sql` → `0016_group_membership_rpcs.sql` → `0017_group_invites.sql` → UI-A → `0018` (só renomear) → `0019_group_members_read.sql` (leitura de membros, M2-D44) → UI-B, conforme o plano normativo `25` |
| B2 fatias 3–6 e partes restantes das fatias 7–10 | ordem nominal desta seção | a numerar quando cada fatia começar |

Permanecem na fatia 7 a auditoria tipada, o outbox N1–N28 com conteúdo separado,
`transition_markers` e os objetos de notificação que dependem das tabelas de domínio. Na
fatia 10 permanecem os RPCs e jobs de grupos, rachas, lista, financeiro, times e comunicação,
as reconciliações/retention que dependem desses domínios e as demais policies de Storage. O
M1-B antecipa apenas a parte de exportação e exclusão de identidade exigida antes do beta.

As linhas `0004`–`0007` estão **executadas**, com evidência em `21`; `0011`–`0014`
fecharam o M1-B (`23`) e `0015`–`0019`, UI-A e UI-B estão entregues no M2 (`26`). O limitador de convites
do #41 foi implementado pela `0017`; textos/digests de políticas, rate limit geral do
gateway e configuração operacional remota seguem pendentes. `0001`–`0003` têm evidência
operacional em `19`/`20`. `private.job_runs.match_id` nasce nullable e sem FK enquanto `public.matches` não
existe; a migration de `matches` adiciona e testa a FK. É sequenciamento explícito, não
relaxamento permanente. Versões fictícias de políticas ficam em fixtures ou seed local; antes
do beta, outra migration publica textos efetivos/digests, sem `m1-draft-1` canônico.

Critério de saída de B2:

- banco sobe do zero somente pelas migrations;
- `supabase db reset` é determinístico;
- nenhum papel cliente escreve tabela crítica diretamente;
- pgTAP prova isolamento entre grupos, arquivos privados, notas privadas e snapshots;
- concorrência não cria sexta membership, 101º membro, uso excedente, overbooking, ocorrência,
  resolução, obrigação ou contestação duplicada; lotes não deadlockam;
- conta/grupo suspenso não muta domínio; casos financeiros são transferidos antes de revogar
  sessão e exclusão só segue com substituto/canal seguro;
- todo RPC mutável cobre `executing_uncommitted→completed`, rollback em crash,
  `payload_expired`, espera concorrente, `IDEMPOTENCY_CONFLICT` e replay sem Pix/token;
- toda mutação externa atravessa a Edge, sem ator/HMAC vindo do cliente, e nenhuma RPC mutável
  concede `EXECUTE` a `public`, `anon` ou `authenticated`;
- nenhum `executing_uncommitted` pode dar commit; efeito Auth/Storage usa saga/outbox e teste
  de crash em cada fronteira;
- dump não permite enumerar payload, nota ou comprovante: HMAC de domínio/versão tem vetores;
- validador rejeita chave desconhecida/sensível em auditoria/notificação.
- scanner do catálogo encontra toda coluna JSON exatamente uma vez e toda FK composta rejeita
  combinações cruzadas mesmo por `service_role`.

## 4. Estratégia de testes

### Banco e concorrência

O harness de 25 conexões pertence à estratégia/suíte de concorrência, não a uma migration.
Para o M1-A, a calibragem proposta é `idempotency_wait_timeout_ms=3000`, unidade
`milliseconds`: timeout retorna `IDEMPOTENCY_WAIT_TIMEOUT`, sem efeito parcial, e o retry usa
o mesmo `request_id`. O piloto valida o número antes de tratá-lo como calibragem estável.

- N entradas e N claims concorrentes contra a última vaga;
- `join_match` concorrendo com saída/remoção/suspensão/exclusão, nas duas ordens, sem
  participante ativo residual nem deadlock;
- quinta/sexta membership, 99º/100º/101º membro, último uso de convite e UUIDs em ordem
  invertida concorrentes;
- T1 aplicado simultaneamente por cron e reconciliação manual;
- expiração de claim concorrendo com `finalize_proof`;
- aprovação × rejeição × `mark_paid` × pagamento de cancelado no mesmo ciclo, em ambos os orders;
- aprovação tardia sem desalojar starter válido;
- SLA de comprovante cruzando `starts_at` sem mover participante e pagamento de espera
  não adicionada virando `refund_due`;
- cancelamento concorrendo com upload/finalização e decisão financeira posterior;
- cancelamento/recorrência em retry sem ocorrência duplicada;
- adição comum antes de T2 rejeitada e convite avulso concorrente respeitando capacidade;
- remoção concorrente após publicação preservando histórico, invalidando a versão atual e
  impedindo escalação obsoleta;
- estorno/correção/contestação concorrentes mantendo preço travado; nova versão de preço
  cria novo ciclo sem alterar o anterior;
- primeira decisão × aceitar × apelar × expirar janela, com apelação única e caso Admin;
- inserts cruzados de grupo/racha/ciclo/prova/evento/disputa/apelação/caso rejeitados no banco;
- desligar/editar série concorrendo com avanço terminal; estado final sem ocorrência inesperada;
- convite criado/recompartilhado/rotacionado; dump sem cofre não cria token válido;
- suspensão/exclusão de único owner com/sem substituto e caso Admin limitado;
- fixture do único owner combina convidado, claim, prova em análise, pagamento, estorno e
  times publicados; não sobra dinheiro/participante sem autoridade;
- upload órfão e purge removendo binário, caminho e fingerprint; mesmo arquivo coincide só
  no mesmo grupo e dump não permite localizar;
- prova indecidida expurgada sem rejeição automática e decisão posterior exigindo
  confirmação de evidência indisponível;
- URL assinada de comprovante nunca é emitida; remoção/reatribuição corta próximo stream;
- exclusão crasha antes/depois de Storage, Auth e finalize; `deletion_pending` nega JWT antigo;
- export pronto, download, logout, exclusão e expiração são exercitados em fluxos separados e
  nenhum permite segundo download: download/exclusão/expiração convergem para remoção do
  artefato; logout não o remove, mas a denylist torna-o inalcançável pela sessão revogada;
- contestação de nota concorrendo com saída/purge preserva somente `rating_history_id` alvo;
- conteúdo de notificação com 91 dias é apagado sem quebrar delivery de 11 meses;

### Algoritmo v3 — provas da evolução D63-A

- invariantes de pertencimento, duplicata e diferença máxima de tamanho;
- todos os vetores dourados literais e força bruta independente para N≤12;
- regressão do contraproblema `(3,2,2,1,1,1,1)`;
- sementes iguais reproduzem o mesmo resultado na mesma versão;
- sementes diferentes realmente alteram os inícios para N>12;
- busca 1×1/2×2 nunca piora score e respeita orçamento/passes completos;
- benchmark adversarial N=12/13/30 e K=2/10 registra p50/p95/p99/memória sem OOM;
- timeout de parede falha sem draw/publicação parcial.

### Interface e acessibilidade

Testes e2e mínimos: criar conta; entrar por convite; corrida por vaga; reservar antes de
pagar; upload interrompido e retomado; decisão de prova; sorteio/ajuste por teclado;
cancelamento/estorno/contestação e exclusão bloqueada por caso. Cada fatia de
interface faz provas automatizadas de acessibilidade. Pela M2-D43, uma passada
manual com leitor de tela cobre todas as telas do piloto no gate do piloto,
registrada por tela em documento operacional; M8 é auditoria final.

## 5. Construção por marcos

O beta entrega **PWA responsivo primeiro**. A arquitetura continua compatível com Expo
nativo, mas iOS/Android, Apple Sign In e Expo Push não estão no caminho crítico inicial.

### Fronteira da tela Perfil no M1-A

No M1-A a tela oferece somente: criação/conclusão do perfil, edição dos próprios dados,
leitura do provedor vinculado, troca de senha e logout seguro. Não renderiza controles de
exportar dados, excluir conta ou vincular/desvincular Google. Esses controles entram apenas
quando seus contratos estiverem implementados e testados; não há botão oculto/desabilitado
prometendo trabalho futuro.

### Fronteira da área autenticada no M1-A

`11-telas-v1.md` §1 descreve a área autenticada como três abas — Rachas, Grupos e Perfil.
No M1-A só o Perfil existe: Rachas entra no M3 e Grupos no M2. Renderizar as três abas
agora produziria exatamente o controle vazio que a fronteira da tela Perfil proíbe, e um
alvo de toque que não leva a lugar nenhum é pior do que a ausência da navegação. Por isso
a navegação por abas entra com a fatia que trouxer a primeira aba adicional, e até lá a
área autenticada leva direto ao Perfil. A arquitetura de informação de `11` §1 não muda;
muda apenas o momento em que a navegação entre abas passa a ter destino.

### Fronteira das telas de autenticação no M1-A

No M1-A as quatro telas entregam e-mail/senha, confirmação por OTP, recuperação de senha e
conclusão do perfil. O bloco de aceite de Termos e Política entra junto da migration pré-beta
que publica os textos e digests reais; antes disso não existe versão canônica que a interface
possa apresentar ou aceitar. O Google é evolução (D63-I) e entra somente na fatia operacional que
configura e verifica o provedor e os redirects no projeto remoto, nos três
alvos. Até cada contrato estar disponível e testado, a interface não renderiza botão oculto ou desabilitado prometendo trabalho futuro.

A D63-A–I (`09-pivo-produto.md` §D63) fixa o recorte; o censo está em
`27-piloto-minimo.md`. Todas as estimativas abaixo são **INFERÊNCIA em sessões**,
não prazo, medição ou dispensa de gate. Cada fatia que toca vaga, dinheiro,
login ou dado pessoal recebe revisão completa por sessão distinta e, se
necessário, uma conferência. As demais recebem uma revisão. Os marcos são
menores para entregar e revisar cada contrato antes do próximo.

### Critérios de saída e conteúdo do roteiro original, preservados

O quadro original permanece literalmente abaixo. **D63:** M0/M1 já foram entregues e
M2 está em execução. Os itens que a D63 adiou mantêm estes critérios quando
forem implementados; a tabela seguinte detalha as fatias menores do piloto.

| Marco | Conteúdo | Pronto quando |
|---|---|---|
| **M0 — fundação** | repo do app, Expo Web/PWA, TypeScript, CI, Supabase dev, harness de migrations + fatias B2 1–2, Sentry sanitizado, tokens AA | pipeline verde; fatia atual do banco recria do zero; PWA abre por teclado; redaction e backup de teste funcionam |
| **M1 — identidade** | e-mail/OTP/Google, aceite, sessão revogada, export governado e saga de exclusão | JWT revogado/deletion_pending não acessa; crash externo retoma; export expira/purga |
| **M2 — grupos** | grupos, reentrada, owner, papéis, convites nonce/versão/HMAC, transferência e renomear | recompartilha na chave v1; dump não forja; RLS impede acesso cruzado; rotação é pós-piloto (M2-D39) |
| **M3 — racha** | criar/editar, segredos Pix separados, TP/T0/T1/T2, série versionada | desligar×advance não gera inesperado; Pix purga sem corromper racha; retry não duplica |
| **M4 — lista** | lista atômica, fila tier/seq, T1, claims 30/10 min, T2, reconciliação e saúde dos jobs | testes de corrida passam; nenhum pagamento é orientado sem reserva válida; falha de job alerta |
| **M5 — financeiro** | grafo composto, stream Edge, resolução, estorno, primeira decisão/apelação, caso Admin, purge/backup | insert cruzado falha; URL assinada inexiste; corridas têm uma resolução; binário some em 7d |
| **M6 — times** | notas/contestação, algoritmo v3, commit por revisão, draft acessível, composição sem nota | target de nota/purge exato; draft inválido não publica; vetores/benchmark/purge passam |
| **M7 — comunicação** | sino, outbox N1–N28, N1/N13 fixas, push, e-mail, payloads tipados e retry/dead-letter | N13 único controla duas instâncias; payload sensível falha; reprocessamento não duplica evento lógico |
| **M8 — hardening** | temas, tela larga, axe/reflow, performance, recuperação, runbooks e revisão de segurança | checklist `15` completo; teste de restauração; pentest manual de RLS/storage; zero PII nos erros/Sentry |
| **Beta controlado** | um racha real com WhatsApp apenas como contingência | ciclo inteiro concluído; incidentes e intervenções manuais registrados; retrospectiva decide ajustes |

**D63 por marco:** M0: Sentry é pré-público; M1: Google é evolução; M2:
arquivamento/rotação/IP seguem `25` §8.2; M3: Pix no app, TP/T1 e recorrência
são evolução; M4: T0/fila/T2 ficam no piloto e T1/claims de pagamento são
evolução; M5: acerto externo, marcação e devolução manual ficam no piloto,
comprovante e apelação seguem o recorte D63-D; M6: serpentina simples fica no
piloto, v3 e contestação depois; M7: notificações são pós-piloto; M8: segurança,
acessibilidade e restore valem no piloto, Sentry antes do público; Beta:
WhatsApp leva os avisos humanos do piloto. Os critérios originais permanecem.

### Fatias menores até o piloto (D63)

| Ordem até o piloto | Fatias previstas | Telas | Risco / cerimônia | Sessões (INFERÊNCIA) | Pronto quando (D63) |
|---|---|---|---|---|---|
| M0 e M1-A/M1-B — entregues | `0001`–`0014`, gateway, Auth e privacidade; gates reais seguem abertos | 1–4, 13 | histórico entregue | 0 de implementação já entregue | Evidência histórica conferida; gates abertos identificados. |
| M2 — terminar grupos | `0015`–`0019`, UI-A e UI-B entregues; faxina/review pendentes; rotação/IP/arquivamento ficam em `25` §8.2 | 10–12, 16, 17, 24, 25 | cheia nas fatias de dado pessoal/login; uma revisão na faxina estrita | `0017` 5–8; `0018` 2–3; UI-A 4–6; UI-B 3–5; faxina 2–3 | Recompartilha na chave v1; dump não forja; RLS impede acesso cruzado; UI-A/UI-B verificadas. |
| Após M2 — staging | ambiente isolado, configuração/smoke e gates operacionais; acesso remoto/deploy dependem de autorização própria | telas M2 | cheia por login/dado pessoal | 3–5 | Smoke isolado e gates operacionais registrados. |
| Pré-M3 — registro de operações | migration append-only, validador estável de idempotência, replay/privilégios/outcomes | nenhuma | cheia por dinheiro/login/dado pessoal | 3–5 | Replay, privilégio e outcomes do registro estável provados. |
| M3a — racha básico | especificar adaptação do `config` sem TP/T1/Pix no app; schema, criação, UI de criar e lista vazia | 5, 18, 6 parcial | cheia por dado pessoal/dinheiro | 4–6 | Racha criado sem duplicar retry; estado inicial coerente. |
| M3b — editar/cancelar | especificar patches do racha publicado; `update_match`, `cancel_match`, invalidação de publicação, obrigações de devolução; recorrência fica depois | 18, 23 | cheia por dinheiro/dado pessoal | 4–6 | Edição publicada respeita locks e invalidação; cancelamento gera obrigação única de devolução. |
| M4a — T0, vaga, fila, T2 | especificar contrato sem T1/TP; locks/capacidade, entrada/saída e reconciliação; nenhuma demissão por falta de `mark_paid` | 6, 7 | cheia por vaga | 5–7 | Testes de corrida passam, fila não é ultrapassada e falta de `mark_paid` não remove vaga. |
| M4b — gestão manual | `add_player`/`remove_player`, fila sem ultrapassagem, posição/estado atual na tela e provas de corrida | 7, 19 parcial | cheia por vaga/dinheiro | 3–4 | Adição e remoção manuais preservam capacidade, fila e posição exibida. |
| M5a — pagamento externo | texto «pague ao organizador», ledger de resolução única, `mark_paid`, painel e leitura do estado; sem Pix no app | 8, 19 | cheia por dinheiro | 3–5 | Nenhum pagamento é orientado sem reserva válida; `mark_paid` e ledger têm resolução única. |
| M5b — devolução manual | pagamento conhecido após cancelamento, `refund_due`/`refunded`, correção, transferência de autoridade financeira e trava de preço conforme `13`; primeira instância entra antes do público (D63-D, extensão) | 19, 23 | cheia por dinheiro | 3–4 | Devolução é declarada manualmente; preço travado até conclusão; exclusão transfere autoridade ou retorna `FINANCIAL_SUBSTITUTE_REQUIRED`. |
| M6 — notas e times | antes da fatia, especificar empates, times, seed, persistência, versão e testes; nota por jogador de linha, serpentina simples guardada/reproduzível, publicação | 9, 21, 22 | cheia por dado pessoal/vaga fechada | 4–6 após especificação | Sorteio simples guardado/reproduzível e publicação válida; sequência A/B é exemplo de dois times, número e formato de persistência definidos antes do marco. |
| Gate do piloto de amigos | acessibilidade/segurança, restore isolado, políticas/digests reais, SMTP, incidentes e smoke com WhatsApp; sem Sentry no piloto | telas piloto | cheia onde tocar riscos | 3–5, excluídos gates externos de terceiros | Checklist `15`, restore, segurança e políticas reais verificados; gates concluídos antes do primeiro convite. |
| Piloto | um grupo percorre criar → convidar → racha/edição/cancelamento → vaga/fila → acerto externo/`mark_paid` → devolução manual quando aplicável → sorteio/publicação | jornada acima | operação com critério de interrupção de §6 | duração de campo a decidir; sem sessões de código | Ciclo inteiro concluído; incidentes e intervenções manuais registrados; retrospectiva decide ajustes. |

### Depois do piloto

**Obrigatório antes da abertura pública (D63-C/D):** apelação financeira,
caso Admin, contestação de nota, rotação/keyring de convite, limitador por IP
e Sentry com filtro de dados pessoais, além do arquivamento e dos gates M2 já
marcados em `25` §8.2 pelo #41. **Evolução (D63-A/B/D–I):** comprovante,
push/e-mail, sino,
Pix no app, Google, recorrência, mensalistas e v3. A extensão D63-D inclui
primeira instância financeira e três intervenções Admin de grupo/conta
entre os obrigatórios pré-público. A correção de 30/09 acrescenta N26 e N28
ao mesmo gate de N27 e põe `transfer_financial_authority` no M5 do piloto;
`27-piloto-minimo.md` fica com zero perguntas.
Nenhum controle aparece sem contrato publicado; gates de
segurança/LGPD do §2 seguem válidos.

## 6. Beta e rollback

1. Convidar um grupo pequeno; não importar histórico desnecessário.
2. Manter canal de contingência, mas declarar qual sistema é autoridade para vaga e
   pagamento. Se o app falhar, o organizador congela novas entradas e usa o painel de
   reconciliação antes de migrar para a lista manual.
   **D63:** WhatsApp leva avisos humanos; o app é autoridade para vaga e para a
   declaração manual de pagamento, exibindo lista, fila e posição sem sino.
3. Registrar tempos de análise, claims expiradas, notificações falhas, reconciliações e
   estornos; não usar nota privada em analytics.
   **D63:** no piloto, registrar vagas/fila, marcações manuais, devoluções,
   falhas de reconciliação e incidentes; métricas das partes adiadas entram
   quando elas forem implementadas.
4. Se houver perda de integridade (overbooking, fila fora de ordem, RLS ou ledger),
   interromper o piloto. Bug visual isolado não exige apagar dados nem resetar banco.
5. Duas ou três semanas estáveis autorizam discutir expansão; não autorizam
   automaticamente venda ou publicação em loja.

## 7. Gate nativo e gate comercial

### Aplicativos nativos

Só após o PWA provar o fluxo: builds iOS/Android, Apple Sign In, Expo Push, links
universais/app links, permissões, política das lojas e testes VoiceOver/TalkBack em
dispositivo. O contrato de domínio não muda; entram adaptadores de plataforma.

### Uso comercial ou grupos de terceiros

Antes de cobrar ou operar além do círculo pessoal:

- migrar do Vercel Hobby ou confirmar plano compatível com uso comercial — o Hobby é
  pessoal/não comercial: [Vercel Hobby Plan](https://vercel.com/docs/plans/hobby);
- decidir upgrade do Supabase: o Free pode pausar por baixa atividade e não oferece a
  mesma garantia/backup de planos pagos: [Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
  e [Production Checklist](https://supabase.com/docs/guides/deployment/going-into-prod);
- revisar Termos, Política, base legal, contratos com operadores, canal do titular,
  incidente, segurança e retenção com orientação jurídica adequada;
- medir suporte, moderação, abuso de convites e responsabilidade pelos estornos;
- só então criar landing page, cobrança e painel administrativo amplo.

## 8. Próximo passo objetivo

Concluir o M2 sem alterar o histórico das `0015` e `0016`: `0017`
para convites/reentrada, limitador compartilhado e `create_group`; UI-A
depois da `0017`; `0018` **somente** para `rename_group`; UI-B depois da
`0018`; e um PR de faxina/review pós-marco. Arquivamento por RPC permanece
obrigatório antes da abertura pública (`25` §8.2 “Pendências pós-piloto”,
M2-D40). Depois do M2, preparar staging hospedado com autorização própria.
Antes do M3, executar a fatia do registro de operações de idempotência
(D63.5). O roteiro até o piloto e as especificações pré-marco estão na §5 e
em `27-piloto-minimo.md`.

As interfaces entram somente depois dos contratos e implementações
correspondentes, sem migration artificial de UI. A fase 1 registra documentos,
perguntas e checksum, sem criar essas migrations. Os gates de beta
podem avançar em paralelo, mas precisam estar concluídos antes do primeiro convite. Não
começar pelas telas: sem locks, RLS, capacidade e protocolo criptográfico provados, a
interface apenas esconderia dívidas técnicas mais caras.

**D63:** UI-A vem depois da `0017` e UI-B depois da `0018`; os gates se aplicam
ao primeiro convite do piloto. Nenhuma preparação de staging nesta PR autoriza
projeto Supabase remoto, deploy ou segredo.

### Preparação de staging — decisões de 06/10 e 10/10/2026

César executa o deploy manual de `28-staging.md`: Supabase Free em São Paulo
e Vercel Hobby no domínio gratuito, sem workflow de deploy nem credenciais
de ambiente por agentes. SMTP padrão somente para testes da equipe; próprio
antes de convidar alguém. Staging restrito ao César e dados fictícios.
A vida máxima de sessão de 90 dias não é garantida no Free; exceção humana
exclusiva do staging, sem mudar a retenção/local (`25` §8.1). Antes do primeiro
convite, Pro com limite ativo ou fatia que garanta a mesma propriedade.
Este gate soma-se aos demais, não autoriza o piloto de amigos ou uso real.
