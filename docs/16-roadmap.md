# Colete — Roadmap executável (v2, implementação incremental)

**31/08/2026.** O M0-A/M0-B já entregou localmente as migrations `0001`–`0003` e suas
evidências em `19`/`20`. O objetivo agora não é continuar redesenhando o produto: é executar
incrementalmente as decisões fechadas em `01`, `04` e `09`–`17`. O plano do M1-A abaixo ainda
não é implementação concluída.

## 1. Estado da definição

| Bloco | Artefato | Estado atual |
|---|---|---|
| Requisitos e decisões | `01-requisitos.md` · `09-pivo-produto.md` | D1–D62; revisão adversarial incorporada; mudança material exige atualizar ambos |
| Algoritmo | `04-algoritmo-sorteio.md` | v3 binária: PRNG/encoding/vetores, streaming exato e orçamento heurístico |
| Schema/RLS | `10-schema-db.md` | fundação `0001`–`0003` criada/testada; idempotência, RPCs e demais fatias seguem como plano incremental |
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
| M2, fatia 3 e antecipação de grupos/convites da fatia 10 | fundação, isolamento e extensão da exclusão; membership e titularidade; convites/HMAC e `create_group`; UI-A (telas 10, 11, 16 e 24) e UI-B (telas 12, 17 e 25), sem migration | `0015_group_foundation.sql` → `0016_group_membership_rpcs.sql` → `0017_group_invites.sql` → UI-A → UI-B, conforme o plano normativo `25` |
| B2 fatias 3–6 e partes restantes das fatias 7–10 | ordem nominal desta seção | a numerar quando cada fatia começar |

Permanecem na fatia 7 a auditoria tipada, o outbox N1–N28 com conteúdo separado,
`transition_markers` e os objetos de notificação que dependem das tabelas de domínio. Na
fatia 10 permanecem os RPCs e jobs de grupos, rachas, lista, financeiro, times e comunicação,
as reconciliações/retention que dependem desses domínios e as demais policies de Storage. O
M1-B antecipa apenas a parte de exportação e exclusão de identidade exigida antes do beta.

As quatro linhas `0004`–`0007` estão **executadas**: as migrations existem, com evidência
operacional em `21`. As RPCs internas de identidade, o catálogo, o expurgo do livro de
idempotência e a Edge Function do gateway já existem; o rate limit produtivo, o seed de
políticas e o agendamento dos jobs continuam sem implementação. `0001`–`0003` têm evidência
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

### Algoritmo v3

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
cancelamento/estorno/contestação e exclusão bloqueada por caso. Cada marco faz teste manual por teclado e leitor de tela; M8 é
auditoria final, não a primeira vez que acessibilidade aparece.

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
possa apresentar ou aceitar. O Google entra na fatia operacional que configura e verifica o
provedor e os redirects no projeto remoto, nos três alvos. Até cada contrato estar disponível
e testado, a interface não renderiza botão oculto ou desabilitado prometendo trabalho futuro.

| Marco | Conteúdo | Pronto quando |
|---|---|---|
| **M0 — fundação** | repo do app, Expo Web/PWA, TypeScript, CI, Supabase dev, harness de migrations + fatias B2 1–2, Sentry sanitizado, tokens AA | pipeline verde; fatia atual do banco recria do zero; PWA abre por teclado; redaction e backup de teste funcionam |
| **M1 — identidade** | e-mail/OTP/Google, aceite, sessão revogada, export governado e saga de exclusão | JWT revogado/deletion_pending não acessa; crash externo retoma; export expira/purga |
| **M2 — grupos** | grupos, reentrada, owner, papéis, convites nonce/versão/HMAC, transferência | recompartilha/rotaciona; dump não forja; RLS impede acesso cruzado |
| **M3 — racha** | criar/editar, segredos Pix separados, TP/T0/T1/T2, série versionada | desligar×advance não gera inesperado; Pix purga sem corromper racha; retry não duplica |
| **M4 — lista** | lista atômica, fila tier/seq, T1, claims 30/10 min, T2, reconciliação e saúde dos jobs | testes de corrida passam; nenhum pagamento é orientado sem reserva válida; falha de job alerta |
| **M5 — financeiro** | grafo composto, stream Edge, resolução, estorno, primeira decisão/apelação, caso Admin, purge/backup | insert cruzado falha; URL assinada inexiste; corridas têm uma resolução; binário some em 7d |
| **M6 — times** | notas/contestação, algoritmo v3, commit por revisão, draft acessível, composição sem nota | target de nota/purge exato; draft inválido não publica; vetores/benchmark/purge passam |
| **M7 — comunicação** | sino, outbox N1–N28, N1/N13 fixas, push, e-mail, payloads tipados e retry/dead-letter | N13 único controla duas instâncias; payload sensível falha; reprocessamento não duplica evento lógico |
| **M8 — hardening** | temas, tela larga, axe/reflow, performance, recuperação, runbooks e revisão de segurança | checklist `15` completo; teste de restauração; pentest manual de RLS/storage; zero PII nos erros/Sentry |
| **Beta controlado** | um racha real com WhatsApp apenas como contingência | ciclo inteiro concluído; incidentes e intervenções manuais registrados; retrospectiva decide ajustes |

## 6. Beta e rollback

1. Convidar um grupo pequeno; não importar histórico desnecessário.
2. Manter canal de contingência, mas declarar qual sistema é autoridade para vaga e
   pagamento. Se o app falhar, o organizador congela novas entradas e usa o painel de
   reconciliação antes de migrar para a lista manual.
3. Registrar tempos de análise, claims expiradas, notificações falhas, reconciliações e
   estornos; não usar nota privada em analytics.
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

Executar o plano do M2 em `25-plano-m2.md`: fundação/isolamento e extensão da exclusão na
`0015`, membership/titularidade na `0016` e convites/reentrada/HMAC e `create_group` na
`0017`. As telas 10, 11, 16 e 24 (UI-A) e 12, 17 e 25 (UI-B) entram somente depois desses
contratos, sem migration artificial. Os gates de beta
podem avançar em paralelo, mas precisam estar concluídos antes do primeiro convite. Não
começar pelas telas: sem locks, RLS, capacidade e protocolo criptográfico provados, a
interface apenas esconderia dívidas técnicas mais caras.
