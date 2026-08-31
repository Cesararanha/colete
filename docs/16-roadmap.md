# Colete — Roadmap executável (v2, pré-migration)

**25/08/2026.** O repositório ainda está na fase documental. O objetivo agora não é
continuar redesenhando o produto: é transformar as decisões fechadas nos documentos
`01`, `04` e `09`–`17` em migrations, testes e um beta PWA seguro.

## 1. Estado da definição

| Bloco | Artefato | Estado para iniciar migrations |
|---|---|---|
| Requisitos e decisões | `01-requisitos.md` · `09-pivo-produto.md` | D1–D62; revisão adversarial incorporada; mudança material exige atualizar ambos |
| Algoritmo | `04-algoritmo-sorteio.md` | v3 binária: PRNG/encoding/vetores, streaming exato e orçamento heurístico |
| Schema/RLS | `10-schema-db.md` | desenho revisto: idempotência transacional, FKs compostas, sagas externas e retenção física; SQL ainda não criado |
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
- [ ] **Antes da primeira migration:** criar primeiro commit de baseline, tag
      `spec-pre-migration-v1` e proteção de `main`; clone limpo precisa reproduzir documentos
      e checksums. Enquanto todos os arquivos estiverem untracked, migration permanece bloqueada.
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
- [ ] **Antes de convidar o beta:** aprovar formalmente RPO/RTO de comprovante em 24 h,
      implementar o export diário por allowlist e provar em restore que vencido/órfão não volta.
- [ ] **Antes de convidar o beta:** confirmar que o beta é pessoal/não comercial enquanto usar Vercel Hobby; cobrança
      ou uso por terceiros exige revisão de plano/provedor.

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
   fatias 3–8; `enable/force row level security` não espera esta fatia: cada tabela nasce
   com RLS ligada e default-deny na migration que a cria;
10. RPCs transacionais e jobs; por último, policies do Storage.

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
- nenhum `executing_uncommitted` pode dar commit; efeito Auth/Storage usa saga/outbox e teste
  de crash em cada fronteira;
- dump não permite enumerar payload, nota ou comprovante: HMAC de domínio/versão tem vetores;
- validador rejeita chave desconhecida/sensível em auditoria/notificação.
- scanner do catálogo encontra toda coluna JSON exatamente uma vez e toda FK composta rejeita
  combinações cruzadas mesmo por `service_role`.

## 4. Estratégia de testes

### Banco e concorrência

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
- export pronto/download/logout/exclusão/expiração remove artefato e não permite segundo download;
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

Criar a baseline Git e fechar os itens marcados para a primeira migration na seção 2; só
então iniciar B2. Os gates de
beta podem avançar em paralelo, mas precisam estar concluídos antes do primeiro convite.
A primeira entrega concreta é a migration de identidade/governança acompanhada de testes
RLS; a segunda é grupos/owner. Não começar
pelas telas de lista: sem identidade interna, ledger e autorização, a corrida apenas
solidifica dívidas técnicas mais caras.
