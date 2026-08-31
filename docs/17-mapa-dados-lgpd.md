# Colete — Mapa canônico de dados, retenção e LGPD (pré-migration)

**Autoridade normativa para inventário, finalidade, retenção, expurgo e restauração.**
Este mapa fecha o gate documental anterior à primeira migration. Ele não é parecer
jurídico: as bases legais abaixo são **hipóteses candidatas a validar com profissional
qualificado antes do beta público**.

Fontes relacionadas: `01-requisitos.md` · `10-schema-db.md` ·
`13-contratos-funcoes.md` · `14-convencoes-app.md`.

## 1. Papéis e princípios

- No grupo, o organizador define finalidade e uso dos dados do racha e é o controlador
  operacional dessa relação. César/operação do Colete precisa validar se atua como
  operador, controlador independente ou controlador conjunto em cada fluxo.
- Supabase, provedor de e-mail, push, observabilidade e hospedagem são operadores ou
  suboperadores a documentar em registro próprio, com região e termos vigentes.
- Minimização vale também para derivados, logs, backups, cache, notificações e JSON.
- Retenção conta a partir do evento definido nesta página, não da data de inserção por
  conveniência. Contestação aberta suspende apenas o expurgo financeiro indicado; nunca
  prolonga o binário do comprovante além de sete dias.
- Toda rotina de expurgo é idempotente, registra contagens em `retention_runs` e não
  recria dado já purgado. Exceções precisam de caso, fundamento, escopo e prazo.

## 2. Inventário fechado

| Categoria e campos autorizados | Finalidade e hipótese de base legal a validar | Controlador / operador | Acesso e armazenamento | Retenção e evento inicial | Expurgo físico e exceção |
|---|---|---|---|---|---|
| **Auth, sessões revogadas e saga de exclusão:** identificador do provedor, e-mail verificado, credencial gerida, `session_id`, pedido/status/tentativa/erro normalizado | Autenticar, revogar autoridade imediatamente e concluir exclusão externa; execução de contrato, segurança e exercício de direitos, a validar | Papel do Colete a validar / Supabase Auth | Titular vê status mínimo; worker restrito vê Auth ID. `deletion_pending` nega domínio mesmo com JWT antigo | Auth até exclusão. Session denylist até `exp`; saga identificável até conclusão + 90 dias operacionais | Worker limpa ownership, apaga Auth e finaliza desidentificação com retry. Redigir Auth ID/erros ao concluir; não exportar credencial |
| **Perfil:** `id`, nome, apelido, foto, posição, pé, camisa, status | Identificar participantes e operar o racha; execução de contrato, a validar | Grupo e Colete, papéis a validar / Supabase e hospedagem | Membros dos grupos conforme RLS; banco e bucket controlado | Enquanto conta ativa; na exclusão, desidentificação imediata; foto removida | `auth_user_id=null`, nome aleatório não reversível, demais atributos pessoais `null`; `id` técnico permanece sem tabela reversa |
| **Grupos, memberships e convites:** nome/foto do grupo, papel, estado, mensalista, digests, uso | Administrar acesso e capacidade; execução de contrato e segurança, a validar | Dono do grupo / Colete e Supabase | Membros ou funções autorizadas; digests nunca retornam | Membership ativa; removida por 12 meses. Convite até revogação/expiração + 30 dias | Apagar convite/digest e links de membro removido após prazo; manter contagens agregadas sem perfil |
| **Rachas e participação:** agenda, local, capacidades, estado, perfil participante, lista, timestamps | Formar a lista e provar operações; execução de contrato, a validar | Grupo / Colete e Supabase | Grupo; banco | Racha por 24 meses após terminal; composição publicada pode permanecer sem nota/identidade apagada | Apagar convites, claims e detalhes transitórios; desidentificar vínculo quando o perfil for excluído; manter fatos financeiros conforme linha própria |
| **Convidado avulso:** nome de exibição, vínculo temporário, quem adicionou | Permitir exceção auditada à lista; execução de contrato, a validar | Grupo / Colete e Supabase | Participantes daquele racha | Até 12 meses após o racha terminal | Substituir nome por rótulo aleatório e remover vínculo reversível; composição pode permanecer desidentificada |
| **Pix de racha/série:** `match_payment_secrets`/`recurrence_payment_secrets`, estado, tipo, cifra, last4, recebedor, versão, `purged_at` | Exibir instrução e materializar ocorrências futuras; execução de contrato, a validar | Organizador / Colete e Supabase | Somente participante com relação ativa e função autorizada; banco cifrado; JSON nunca guarda Pix | Racha: ciclos fechados + 90 dias. Série: enquanto ativa; após desligar e último ciclo fechar + 90 dias | Estado `purged`, anula cifra/nome/cidade e marca data; racha/série continuam íntegros. Last4/tipo apenas no ledger mínimo. Contestação não reabre segredo |
| **Sessão e binário de comprovante:** caminho interno, MIME, bytes, tamanho, tempos | Permitir revisão humana de pagamento; execução de contrato e exercício regular de direitos, a validar | Organizador / Colete, Supabase Storage | Titular e autoridade do mesmo grafo; Edge faz stream autenticado sem redirect/cache; cliente nunca recebe signed URL/path | Órfão: 24 h. Finalizado: até `ends_at+7d` ou `canceled_at+7d` | Excluir objeto/path/metadados; **sem extensão por disputa ou suspensão**; backup cifrado também deve excluir ao vencer. Cópia já baixada fica fora do controle técnico |
| **Fingerprint do comprovante:** `HMAC-SHA-256(v, domain, group_id, sha256_transient)` e versão | Sinalizar binário idêntico no mesmo grupo, nunca decidir fraude; legítimo interesse antifraude, a validar | Grupo / Colete e cofre de chaves | Somente função retorna boolean; banco nunca expõe valor | Mesmo prazo do binário: no máximo 7 dias após fim/cancelamento | Apagar fingerprint e versão; SHA-256 bruto existe só na memória do finalizador. Grupos diferentes produzem valores diferentes |
| **Ciclos, resoluções, eventos e estornos:** valor, versão de cobrança, estado, resolução única, horários, referência limitada | Registrar obrigação e declaração financeira sem processar Pix; execução de contrato e exercício de direitos, a validar | Grupo / Colete e Supabase | Partes e organizadores; Admin só em caso financeiro explícito | 24 meses após fechamento; enquanto disputa/caso aberto, o prazo fica suspenso | Apagar referência livre após 90 dias; ao fim, desidentificar partes e manter valores/estados agregados quando necessários |
| **Contestações, apelações e casos financeiros:** autor, FKs compostas de grupo/racha/ciclo/evento, motivo/resposta, SLA, primeira decisão, janela, apelação única, decisão final, autoridade | Dar contraditório e continuidade quando o organizador falta; execução de contrato e exercício de direitos, a validar | Grupo e Colete em papel excepcional a validar / Supabase | Partes; organizador elegível; Admin apenas no caso atribuído e auditado | Enquanto estado não final; depois, 24 meses da decisão final/último evento | Apagar texto livre/vínculo ao fim; manter resultado agregado. Não prolonga comprovante. Preço fica travado durante janela/apelação |
| **Notas, histórico e contestação de nota:** estrelas, versão, avaliador, alvo exato, motivo/resposta, SLA, decisão/eventos | Balancear times e permitir acesso/correção; execução de contrato ou legítimo interesse, a validar | Grupo / Colete e Supabase | Organizador; titular **sempre** vê a própria versão durante retenção, mesmo removido; política controla apenas terceiros | Nota atual enquanto aplicável; histórico 12 meses após saída/exclusão/última participação; disputa enquanto aberta | Apagar linhas/caches no prazo. Disputa suspende somente `rating_history_id` alvo; resolução recompõe prazo. Nunca entra na trilha pública com valor |
| **Sorteio privado:** entrada normalizada, versão, PRNG, seed, HMAC, score racional, orçamento e métricas | Reproduzir tecnicamente e diagnosticar o algoritmo; legítimo interesse em auditabilidade, a validar | Grupo / Colete e Supabase | Função server-side e operação autorizada; participantes recebem projeção sem notas | 12 meses após publicação ou invalidação | Apagar entrada, seed, HMAC, score e métricas privadas; manter versão, identificador opaco e composição publicada |
| **Composição publicada:** publicação, times, perfil e posição | Mostrar o resultado e histórico do jogo; execução de contrato, a validar | Grupo / Colete e Supabase | Participantes do racha | 24 meses; depois pode permanecer apenas desidentificada/agregada | Apagar `team_rating_snapshots` em 12 meses; composição restante não guarda estrelas. Perfil excluído vira rótulo desidentificado |
| **Auditoria pública de racha/grupo:** tipo fechado, ator/objeto separados, payload tipado | Tornar intervenções visíveis; legítimo interesse e execução de contrato, a validar | Grupo / Colete e Supabase | Participantes autorizados; payload sem Pix, prova, nota, motivo livre ou token | Identificável por 24 meses após evento terminal/saída; agregado pode permanecer | Rotina privilegiada remove links de identidade e registra a redação; evento e payload permitido permanecem append-only |
| **Auditoria administrativa e acessos:** Admin, ação, alvo, razão, IP técnico, horários | Responsabilização e segurança; legítimo interesse e exercício de direitos, a validar | Colete / Supabase e observabilidade | Operação restrita; nunca grupo em geral | 24 meses da ação ou resolução do caso | Pseudonimizar IP e perfis ao fim; preservar estatística não reversível |
| **Notificações, conteúdo e entregas:** fato/tipo/destinatário, payload tipado separado, canal, estado, erro | Informar mudanças e provar entrega; execução de contrato, a validar | Colete / push, e-mail e Supabase | Destinatário e operação mínima | `notification_contents`: 90 dias; fato mínimo e deliveries: 12 meses | Apagar a linha de conteúdo, não usar `{}`; delivery pendente vira dead antes. Preferência opcional suprime push/e-mail, nunca o fato in-app |
| **Push:** endpoint/token, plataforma, chave pública, `profile_id`, última atividade | Entrega de alertas solicitados; consentimento/permissão e execução de contrato, a validar | Colete / provedor push | Titular e despachante | Até revogação, logout global, erro permanente ou 90 dias sem uso | Apagar assinatura/token; nunca copiar para logs ou backup de diagnóstico |
| **Idempotência:** ator, operação, `request_id`, JCS/canonical/key version, HMAC, estado commitado, referência/outcome seguro | Evitar duplicidade transacional; legítimo interesse em integridade, a validar | Colete / Supabase | Funções internas; `executing_uncommitted` nunca é visível/commitado | Resultado: 30 dias; tombstone/HMAC: 24 meses | Aos 30 dias apagar outcome; aos 24 meses linha. Efeito externo usa `external_effects`, não o registro de mutação |
| **Logs técnicos, Sentry e jobs:** versão, rota normalizada, erro, marker, contagens, duração, request/correlation ID | Operação, recuperação e segurança; legítimo interesse, a validar | Colete / fornecedores contratados | Operação; sem payload de negócio | Logs/Sentry 90 dias; `job_runs` 12 meses; incidente aberto suspende só eventos selecionados | Expurgo no fornecedor e banco; nunca registrar Pix, tokens, comprovante, HMAC, nota ou motivo livre |
| **Aceites, pedidos e exportações do titular:** versão, pedido/resposta, export ID/status/path/digest/expiração/download | Demonstrar aceite e atender direitos; obrigação legal/exercício de direitos, a validar | Colete / Supabase, bucket privado e suporte | Titular reautenticado e worker; ZIP v1 allowlist, sem segredo/prova/PII alheia | Aceite: conta + 5 anos, a validar; pedido: 5 anos, a validar; arquivo export: até 24 h ou primeira tentativa autorizada | Row lock consome one-shot antes do stream, sem signed URL/cache; falha de rede exige novo export; excluir objeto antes de path/digest; exclusão de conta cancela export primeiro |
| **Backups e manifestos:** dumps cifrados, inventário, checksums, exclusões, fotos e provas finalizadas ainda válidas | Recuperação de desastre; legítimo interesse em disponibilidade, a validar | Colete / armazenamento escolhido | Operação restrita, chave separada | Dumps: 30 dias; prova em backup nunca além de `purge_after`; manifestos/restore: 12 meses | RPO de prova 24 h, RTO 24 h, ambos sujeitos a aceite. Órfãos excluídos. Restore descarta prova vencida e reaplica exclusões antes do tráfego |

Nenhuma nova coluna, chave JSON, fornecedor ou réplica entra em produção sem ser
classificada nesta tabela ou em versão posterior aprovada deste documento.

## 3. JSON e derivados autorizados

JSON não é escape do inventário. Chaves desconhecidas são rejeitadas no servidor.

| Campo | Chaves permitidas | Limites / proibidos |
|---|---|---|
| `recurrences.rule` | `frequency`, `interval`, `weekdays`, `local_time`, `timezone`, `offset_policy`, `starts_on`, `ends_on` | Sem texto livre; arrays ≤ 7; enum/versionamento fechado |
| `recurrences.template` | `duration_minutes`, `location_name`, `location_address`, `field_slots`, `goalkeeper_slots`, `field_price`, `goalkeeper_price`, `priority_minutes`, `payment_due_minutes`, `closes_minutes` | Endereço ≤ 300 caracteres; Pix fica em colunas cifradas, nunca neste JSON |
| `draw_private_artifacts.input` | `player_ids`, `ratings`, `team_count`, `algorithm_version`, `rating_cutoffs` | IDs/ratings em arrays paralelos ≤ 30; privado; expurgo em 12 meses |
| `draw_private_artifacts.score` | `components`, cada qual com `num` e `den` decimais canônicos | Exatamente seis componentes; sem float, nome ou nota por pessoa |
| `draw_private_artifacts.private_result` | `teams`; cada time tem `team_number`, `player_ids`, `average_num`, `average_den` | 2–10 times; cada profile exatamente uma vez, ≤30; sem nome, e-mail ou campo desconhecido; 12 meses |
| `idempotency_records.outcome` | Esquema fechado por operação: IDs estáveis e `logical_result` do efeito | Proibidos estado/prazo/posição mutável de claim/sessão, capacidade, Pix, token/URL/path, nota, input/score, prova, fingerprint, motivo livre e PII; estado atual é projeção fresca |
| `audit_log.public_payload` / `group_audit_log.public_payload` | Somente esquema tipado por evento de `10-schema-db.md` | ≤ 1 KiB; sem chaves desconhecidas nem payload arbitrário do cliente |
| `push_subscriptions.payload` | `webpush`: `endpoint`, `p256dh`, `auth`; `expo`: `token`, `platform` | Endpoint ≤2048; chaves/tokens base64url/formatos estritos; criptografado/restrito; nunca log/export/diagnóstico |
| `notification_contents.payload` | Somente schema tipado por N1–N28 de `12-notificacoes.md`; exibição mínima apenas nos tipos enumerados | Sem segredo, prova, Pix, nota, fingerprint, token ou motivo livre; purge físico 90 dias |
| `job_runs.summary` | `scanned`, `changed`, `skipped`, `failed`, `stale`, `duration_ms`, `cursor` | Inteiros não negativos; `cursor` opaco ≤ 200; sem IDs pessoais em lista |

Migration inclui teste que consulta `information_schema.columns`/catálogo para todas as
colunas `json|jsonb` dos schemas da aplicação e exige correspondência 1:1 nesta tabela e em
um validador registrado. Assim coluna nova falha no CI, inclusive sob migration futura.

Derivados não enumerados — thumbnail, cache offline, busca, analytics ou
vetor — são proibidos até atualização explícita deste mapa.

`data_exports` é a única exportação permitida: artefato ZIP, não JSON em tabela, com manifesto
`colete-export-v1` e allowlist das linhas do inventário. Nenhum cache offline do arquivo.

## 4. Execução do expurgo

1. `purge_orphan_uploads` remove objetos/sessões não finalizados com mais de 24 h.
2. `purge_proof_binaries` usa `purge_after`, apaga o objeto, zera caminho/fingerprint e
   marca `binary_purged_at`; falha mantém retry e alerta, nunca apenas `purged=true`.
3. `purge_draw_private_artifacts` apaga artefato privado e snapshots de estrelas após
   12 meses, sem apagar `team_members`.
4. `purge_expired_idempotency_outcomes` faz `completed → payload_expired`, zera o JSON
   após 30 dias e preserva o tombstone até 24 meses.
5. `purge_notification_contents` primeiro mata deliveries não terminais e depois apaga
   conteúdo vencido, preservando fato/delivery; não substitui por `{}`.
6. `expire_data_exports`, `purge_removed_memberships`, `purge_ratings` e
   `deidentify_audits` aplicam as linhas acima. Disputa de nota faz anti-join pelo
   `rating_history_id` exato, nunca pelo grupo inteiro.
7. Cada execução grava somente nome da política, janela, contagens, falhas e duração em
   `retention_runs`; um alarme dispara quando o item mais atrasado excede 24 h.

`legal_holds` não é uma flag genérica. Exige categoria, registro, caso/disputa, motivo,
autoridade, início e expiração. Não pode selecionar binário/fingerprint de comprovante,
sessão de Auth, token ou push. A expiração reentra automaticamente na fila de expurgo.

## 5. Backup, restauração e exclusão

- O runbook executável está em `14-convencoes-app.md`. Dump de banco, histórico de
  migrations, configuração e objetos de Storage são artefatos separados.
- Fotos de perfil/grupo e comprovantes **finalizados** com `purge_after` futuro entram em
  inventários cifrados separados. Órfãos/sessões não finalizadas e exports temporários não
  entram. RPO documental de prova é 24 h; perda dentro da janela marca
  `evidence_unavailable` e exige confirmação posterior. Esse RPO/RTO precisa de aceite formal
  antes do beta.
- Cada backup tem manifesto de tabelas, buckets, objetos, checksums, versão de schema,
  data e exclusões. Chave de criptografia fica fora do snapshot.
- Pedidos de exclusão posteriores ao snapshot entram num manifesto cumulativo. Antes de
  qualquer ambiente restaurado receber acesso, a rotina reaplica desidentificações,
  expurgos vencidos e esse manifesto; só então valida RLS e libera tráfego.
- Antes do restore copiar prova, cruza objeto com a linha restaurada e exige
  `binary_purged_at is null` e `purge_after > restore_cutoff`; o restante é descartado. Depois
  reaplica manifesto de exclusões/purge e só então libera. Restore trimestral prova integridade,
  RPO/RTO e que prova vencida, export e órfão não reaparecem.

## 6. Gates ainda externos

- Validar papéis de controlador/operador, bases legais candidatas e prazos regulatórios
  com profissional qualificado.
- Registrar região, subprocessadores, contatos e acordos dos fornecedores efetivamente
  contratados.
- Aprovar textos de transparência, resposta a incidente e canal alternativo para pessoa
  suspensa antes do beta público.
