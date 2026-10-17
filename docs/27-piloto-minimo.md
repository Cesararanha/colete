# Colete — mapa operacional da D63 para o piloto mínimo

**Atualizado em 30/09/2026 com D63-A–I.** Este mapa é operacional e fica fora do manifesto de especificação.
A autoridade das regras continua em `09` D1–D63, `04` e `01`/`10`–`17`.
A D63 muda o **momento** de entrega, não apaga os contratos das partes adiadas.
O estado entregue abaixo é o de `origin/main` em `9805ece`, após o merge
do #41. `0015` e `0016` foram implementadas; os contratos da `0017` e da
`0018` agora estão em `main`, mas essas migrations e suas operações ainda
não foram implementadas. A subseção “Pendências pós-piloto” de `25` §8.2
também está em `main` e conserva os gates anteriores à abertura pública.

**Legenda.** `JÁ ENTREGUE` exige migration/PR identificável; `PILOTO` integra o
ciclo decidido, ainda que não implementado; `PÓS-PILOTO` preserva o contrato
para antes da abertura pública ou evolução; `PERGUNTA` marcaria decisão ainda aberta; a extensão D63-D fecha
as sete linhas restantes. A última coluna distingue gate público obrigatório de evolução.
Cada linha cita a origem e a letra da D63 que determina o recorte. Uma tela ou
operação com estado entregue e partes ausentes tem ressalva na própria linha.

As respostas humanas D63-A–I estão em `09-pivo-produto.md` §D63. As regras
exatas ainda exigidas antes dos marcos de sorteio, racha e lista são registradas
abaixo, sem substituir contratos existentes por suposição.

## Telas de `11` — uma linha por tela

| Tela | Classificação | Base e regra da D63 | Gate público se adiada |
|---|---|---|---|
| 1 — Entrar | JÁ ENTREGUE | `docs/11-telas-v1.md:83`; D63 `docs/09-pivo-produto.md` §D63. D63.1: login necessário; M1-A, `0006` + UI-B1 | — |
| 2 — Criar conta | JÁ ENTREGUE | `docs/11-telas-v1.md:89`; D63 `docs/09-pivo-produto.md` §D63. D63.1: identidade do grupo; M1-A, `0006` + UI-B1 | — |
| 3 — Verificar código (OTP) | JÁ ENTREGUE | `docs/11-telas-v1.md:102`; D63 `docs/09-pivo-produto.md` §D63. D63.1: login por e-mail; M1-A, `0006` + UI-B1 | — |
| 4 — Esqueci minha senha | JÁ ENTREGUE | `docs/11-telas-v1.md:106`; D63 `docs/09-pivo-produto.md` §D63. D63.1: recuperação; M1-A, UI-B1 | — |
| 5 — Rachas — vazio | PILOTO | `docs/11-telas-v1.md:113`; D63 `docs/09-pivo-produto.md` §D63. D63.1: acesso ao primeiro racha | — |
| 6 — Rachas — lista | PILOTO | `docs/11-telas-v1.md:117`; D63 `docs/09-pivo-produto.md` §D63. D63.1: lista, vaga e fila; omitir estados de comprovante adiado | — |
| 7 — Detalhe do racha | PILOTO | `docs/11-telas-v1.md:137`; D63 `docs/09-pivo-produto.md` §D63. D63.1: ocupação e fila; disputa/apelação e prova ficam fora | — |
| 8 — Pagamento | PILOTO | `docs/11-telas-v1.md:161`; D63-G: instrução «pague ao organizador»; acerto externo e `mark_paid`, sem Pix no app. | — |
| 9 — Times publicados | PILOTO | `docs/11-telas-v1.md:175`; D63 `docs/09-pivo-produto.md` §D63. D63.1: composição publicada; sem nota pública | — |
| 10 — Grupos — lista | PILOTO | `docs/11-telas-v1.md:182`; D63 `docs/09-pivo-produto.md` §D63. D63.1: criar/entrar em grupo; UI-A do M2 | — |
| 11 — Detalhe do grupo | PILOTO | `docs/11-telas-v1.md:186`; D63 `docs/09-pivo-produto.md` §D63. D63.1: membros; contestação de nota é D63.2 | — |
| 12 — Entrar com código/link | PILOTO | `docs/11-telas-v1.md:195`; D63-F: link de grupo entra; convite avulso de não membro é evolução. | — |
| 13 — Perfil | JÁ ENTREGUE | `docs/11-telas-v1.md:216`; D63 `docs/09-pivo-produto.md` §D63. UI do perfil no PR #22 e controles de privacidade no PR #29; Google/foto/aceite real ainda têm gates | — |
| 14 — Preferências de alertas externos | PÓS-PILOTO | `docs/11-telas-v1.md:228`; D63 `docs/09-pivo-produto.md` §D63. D63.2: push/e-mail adiados | Evolução (D63-D) |
| 15 — Central de notificações | PÓS-PILOTO | `docs/11-telas-v1.md:239`; D63-B: sino in-app é evolução; telas da lista/fila/posição exibem estado atual. | Evolução |
| 16 — Criar grupo | PILOTO | `docs/11-telas-v1.md:247`; D63 `docs/09-pivo-produto.md` §D63. D63.1; `create_group` previsto na `0017` | — |
| 17 — Gestão de membros | PILOTO | `docs/11-telas-v1.md:251`; D63 `docs/09-pivo-produto.md` §D63. D63.1; RPCs da `0016` entregues, UI-B pendente | — |
| 18 — Criar/editar racha | PILOTO | `docs/11-telas-v1.md:261`; D63-E: criação e edição segura entram; recorrência é evolução. | — |
| 19 — Painel do organizador | PILOTO | `docs/11-telas-v1.md:292`; D63-E/F/G: `mark_paid`, adição/remoção manual, «a devolver»/«devolvido»; sem Pix no app. | — |
| 20 — Aprovar comprovante | PÓS-PILOTO | `docs/11-telas-v1.md:313`; D63 `docs/09-pivo-produto.md` §D63. D63.2: upload/análise adiados | Evolução (D63-D) |
| 21 — Avaliar jogadores | PILOTO | `docs/11-telas-v1.md:326`; D63-A: organizador atribui nota a cada jogador de linha para serpentina; detalhes exatos antes de M6. | — |
| 22 — Sortear e publicar | PILOTO | `docs/11-telas-v1.md:332`; D63-A: sequência A/B ilustra dois times; resultado guardado/reproduzível, com número de times e formato de persistência a especificar antes de M6. | — |
| 23 — Cancelar racha | PILOTO | `docs/11-telas-v1.md:345`; D63-E: cancelar entra no piloto; obrigação/devolução manuais seguem `13` §3.3 e §§2.6.1–2.9. | — |
| 24 — Convites do grupo | PILOTO | `docs/11-telas-v1.md:351`; D63 `docs/09-pivo-produto.md` §D63. D63.1: link; UI-A depois da `0017` | — |
| 25 — Configurações do grupo | PILOTO | `docs/11-telas-v1.md:369`; D63 `docs/09-pivo-produto.md` §D63. D63.1: UI-B após `0018`; arquivar por RPC está em `25` §8.2 | — |

## Operações de `13` — RPC, Edge, projeção e job

Cada operação nomeada tem uma linha. Assinaturas agrupadas no contrato foram
separadas aqui. “Entregue” se refere ao contrato executável da fatia citada;
controle de interface ou integração externa ainda pode estar pendente.

| Operação | Classificação | Base e regra da D63 | Gate público se adiada |
|---|---|---|---|
| `join_match` | PILOTO | `docs/13-contratos-funcoes.md:173`; D63 `docs/09-pivo-produto.md` §D63. D63.1 vaga atômica e fila | — |
| `leave_match` | PILOTO | `docs/13-contratos-funcoes.md:193`; D63 `docs/09-pivo-produto.md` §D63. D63.1 liberar vaga e preservar fila | — |
| `claim_open_slot` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:205`; D63-H: claims de pagamento do `13` dependem de T1 e são evolução; adaptar a fila sem T1 antes de M4. | Evolução |
| `get_payment_instructions` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:225`; D63-G: projeção sensível de Pix do `13` §1.3.1 é evolução; piloto exibe instrução genérica. | Evolução |
| `apply_payment_deadline` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:234`; D63-H: T1 automático é evolução e não remove quem o organizador esqueceu de marcar no piloto. | Evolução |
| `expire_slot_claims` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:245`; D63-H: claims de pagamento do `13` dependem de T1 e são evolução; adaptar a fila sem T1 antes de M4. | Evolução |
| `add_player` | PILOTO | `docs/13-contratos-funcoes.md:253`; D63-F: adição manual do membro pelo organizador, respeitando fila e bloqueio de publicação de `13` §1.6. | — |
| `remove_player` | PILOTO | `docs/13-contratos-funcoes.md:254`; D63-E/F: remoção manual, invalidação atômica dos times e `refund_due` quando houve pagamento real (`13` §1.6). | — |
| `create_proof_upload` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:283`; D63 `docs/09-pivo-produto.md` §D63. D63.2: upload adiado | Evolução (D63-D) |
| `PUT /proof-upload-sessions/:id/content` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:294`; D63 `docs/09-pivo-produto.md` §D63. D63.2: binário adiado | Evolução (D63-D) |
| `finalize_proof` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:304`; D63 `docs/09-pivo-produto.md` §D63. D63.2: finalização adiada | Evolução (D63-D) |
| `GET /proofs/:proof_id/content` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:320`; D63 `docs/09-pivo-produto.md` §D63. D63.2: stream da evidência adiado | Evolução (D63-D) |
| `delete_own_proof` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:329`; D63 `docs/09-pivo-produto.md` §D63. D63.2: ciclo de prova adiado | Evolução (D63-D) |
| `decide_proof` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:336`; D63 `docs/09-pivo-produto.md` §D63. D63.2: decisão de prova adiada | Evolução (D63-D) |
| `mark_paid` | PILOTO | `docs/13-contratos-funcoes.md:352`; D63 `docs/09-pivo-produto.md` §D63. D63.1: organizador marca pagamento manual | — |
| `record_canceled_match_payment` | PILOTO | `docs/13-contratos-funcoes.md:361`; D63-E: registra pagamento conhecido após cancelamento e cria obrigação única de devolução (`13` §2.6.1). | — |
| `mark_refund_due` | PILOTO | `docs/13-contratos-funcoes.md:369`; D63-E: marca manualmente «a devolver» sobre resolução real (`13` §2.7). | — |
| `mark_refunded` | PILOTO | `docs/13-contratos-funcoes.md:370`; D63-E: organizador declara manualmente «devolvido»; sem confirmação bancária (`13` §2.7). | — |
| `correct_refund` | PILOTO | `docs/13-contratos-funcoes.md:378`; D63-E: corrige somente horário/referência com auditoria e limites de `13` §2.8. | — |
| `unlock_price_after_refunds` | PILOTO | `docs/13-contratos-funcoes.md:385`; D63-E: edição de preço apenas após todas as devoluções e sem disputa, com nova versão de cobrança (`13` §§2.9, 3.2). | — |
| `open_financial_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:395`; D63-D (extensão): primeira instância financeira, parte da apelação financeira. | Obrigatório antes da abertura pública (D63-D, extensão) |
| `respond_financial_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:399`; D63-D (extensão): resposta da primeira instância financeira. | Obrigatório antes da abertura pública (D63-D, extensão) |
| `resolve_financial_dispute_first_instance` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:401`; D63-D (extensão): decisão da primeira instância financeira. | Obrigatório antes da abertura pública (D63-D, extensão) |
| `accept_financial_dispute_resolution` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:404`; D63 `docs/09-pivo-produto.md` §D63. D63.2: etapa da apelação financeira adiada | Obrigatório antes da abertura pública (D63-D) |
| `appeal_financial_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:407`; D63 `docs/09-pivo-produto.md` §D63. D63.2: apelação adiada | Obrigatório antes da abertura pública (D63-D) |
| `escalate_financial_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:410`; D63 `docs/09-pivo-produto.md` §D63. D63.2: caso Admin adiado | Obrigatório antes da abertura pública (D63-D) |
| `admin_resolve_financial_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:412`; D63 `docs/09-pivo-produto.md` §D63. D63.2: caso Admin adiado | Obrigatório antes da abertura pública (D63-D) |
| `finalize_unappealed_disputes` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:414`; D63 `docs/09-pivo-produto.md` §D63. D63.2: janela de apelação adiada | Obrigatório antes da abertura pública (D63-D) |
| `admin_assign_financial_case` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:438`; D63 `docs/09-pivo-produto.md` §D63. D63.2: caso Admin adiado | Obrigatório antes da abertura pública (D63-D) |
| `GET /admin-cases/:case_id/evidence` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:440`; D63-D: rota de prova depende de comprovante, que é evolução; não é necessária enquanto ele não for habilitado. | Caso Admin obrigatório antes da abertura pública; rota de prova quando comprovante for habilitado |
| `admin_decide_proof` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:443`; D63-D: decisão de prova depende de comprovante, que é evolução; não é necessária enquanto ele não for habilitado. | Caso Admin obrigatório antes da abertura pública; decisão de prova quando comprovante for habilitado |
| `admin_mark_refunded` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:444`; D63 `docs/09-pivo-produto.md` §D63. D63.2: caso Admin adiado | Obrigatório antes da abertura pública (D63-D) |
| `create_match` | PILOTO | `docs/13-contratos-funcoes.md:453`; D63 `docs/09-pivo-produto.md` §D63. D63.1: criar racha | — |
| `update_match` | PILOTO | `docs/13-contratos-funcoes.md:465`; D63-E: edição segura segundo locks de Pix, preço, data, prazos e publicação de `13` §3.2; adaptação do recorte antes de M3. | — |
| `cancel_match` | PILOTO | `docs/13-contratos-funcoes.md:512`; D63-E: cancelamento atômico de claims e obrigações `refund_due`; `13` §3.3; sem recorrência no piloto. | — |
| `advance_recurrence` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:531`; D63-E: recorrência é evolução. | Evolução |
| `update_recurrence` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:542`; D63-E: edição de série é evolução. | Evolução |
| `set_recurrence_active` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:543`; D63-E: ativação/desligamento de série é evolução. | Evolução |
| `set_rating` | PILOTO | `docs/13-contratos-funcoes.md:559`; D63-A: nota do organizador para jogador de linha; contrato exato da nota simples antes de M6. | — |
| `get_my_rating` | PILOTO | `docs/13-contratos-funcoes.md:568`; D63-A: leitura da nota do piloto; visibilidade e contrato exatos antes de M6. | — |
| `open_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:574`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `respond_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:577`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `resolve_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:579`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `escalate_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:584`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `POST /draw` | PILOTO | `docs/13-contratos-funcoes.md:587`; D63 `docs/09-pivo-produto.md` §D63. D63.1: sorteio, com algoritmo pendente A | — |
| `commit_draw` | PILOTO | `docs/13-contratos-funcoes.md:595`; D63 `docs/09-pivo-produto.md` §D63. D63.1: commit por revisão, algoritmo pendente A | — |
| `get_draw_proposal` | PILOTO | `docs/13-contratos-funcoes.md:605`; D63 `docs/09-pivo-produto.md` §D63. D63.1: proposta para publicação | — |
| `publish_draw` | PILOTO | `docs/13-contratos-funcoes.md:611`; D63 `docs/09-pivo-produto.md` §D63. D63.1: publicar times | — |
| `create_group` | PILOTO | `docs/13-contratos-funcoes.md:633`; D63 `docs/09-pivo-produto.md` §D63. D63.1: contrato da `0017` em `main`, ainda não implementado | — |
| `join_by_code` | PILOTO | `docs/13-contratos-funcoes.md:634`; D63 `docs/09-pivo-produto.md` §D63. D63.1: contrato da `0017` em `main`, ainda não implementado; M2 conserva código/link | — |
| `join_by_invite` | PILOTO | `docs/13-contratos-funcoes.md:634`; D63 `docs/09-pivo-produto.md` §D63. D63.1: entrar por link | — |
| `approve_member` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:635`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `remove_member` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:636`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `set_role` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:637`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `set_monthly` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:638`; D63 `docs/09-pivo-produto.md` §D63. Migration `0016_group_membership_rpcs.sql`; UI mensalista pendente | — |
| `set_ratings_visibility` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:639`; D63 `docs/09-pivo-produto.md` §D63. Migration `0016_group_membership_rpcs.sql` | — |
| `transfer_ownership` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:640`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `leave_group` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:641`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `create_match_invite` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:642`; D63-F: convite avulso de não membro é evolução. | Evolução |
| `accept_match_invite` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:643`; D63-F: aceite de convite avulso é evolução. | Evolução |
| `get_invite_share_link` | PILOTO | `docs/13-contratos-funcoes.md:649`; D63 `docs/09-pivo-produto.md` §D63. D63.1: compartilhar link, contrato ampliado em `main` pelo #41, ainda não implementado | — |
| `link_google_identity` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1042`; D63-I corrigida: Google é evolução; piloto usa e-mail e senha com os códigos de confirmação existentes. | Evolução |
| `accept_policies` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1045`; D63 `docs/09-pivo-produto.md` §D63. Migration `0006_identity_rpcs.sql`; catálogo real é gate pré-usuário | — |
| `request_data_export` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1085`; D63 `docs/09-pivo-produto.md` §D63. Migration `0013_data_export_delivery.sql` | — |
| `GET /data-exports/:id/content` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1091`; D63 `docs/09-pivo-produto.md` §D63. Migration `0013` e Edge data-exports | — |
| `delete_account` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1085`; D63 `docs/09-pivo-produto.md` §D63. Migrations `0012`/`0015` estenderam saga | — |
| `set_group_suspension` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1118`; D63-D (extensão): intervenção Admin de grupo. | Obrigatório antes da abertura pública (D63-D, extensão) |
| `set_profile_access` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1122`; D63-D (extensão): intervenção Admin de conta. | Obrigatório antes da abertura pública (D63-D, extensão) |
| `admin_transfer_ownership` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1126`; D63-D (extensão): transferência excepcional do caso Admin. | Obrigatório antes da abertura pública (D63-D, extensão) |
| `revoke_current_session` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1135`; D63 `docs/09-pivo-produto.md` §D63. Migration `0006_identity_rpcs.sql` | — |
| `update_profile` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1166`; D63 `docs/09-pivo-produto.md` §D63. Migration `0006_identity_rpcs.sql` | — |
| `complete_profile` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1201`; D63 `docs/09-pivo-produto.md` §D63. Migration `0006_identity_rpcs.sql` | — |
| `set_notification_preference` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1239`; D63 `docs/09-pivo-produto.md` §D63. D63.2: canais externos adiados | Evolução (D63-D) |
| `register_push_subscription` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1245`; D63 `docs/09-pivo-produto.md` §D63. D63.2: push adiado | Evolução (D63-D) |
| `revoke_push_subscription` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1249`; D63 `docs/09-pivo-produto.md` §D63. D63.2: push adiado | Evolução (D63-D) |
| `mark_notification_read` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1250`; D63-B: sino e leitura in-app são evolução. | Evolução |
| `reconcile_match` | PILOTO | `docs/13-contratos-funcoes.md:1258`; D63 `docs/09-pivo-produto.md` §D63. D63.1: vaga/fila precisam convergir | — |
| `reconcile_due_matches` | PILOTO | `docs/13-contratos-funcoes.md:1279`; D63 `docs/09-pivo-produto.md` §D63. D63.1: transições da lista vencidas | — |
| `dispatch_notifications` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1280`; D63-B: outbox/delivery de notificações ficam fora do piloto; WhatsApp é aviso humano. | Evolução |
| `expire_upload_sessions` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1281`; D63 `docs/09-pivo-produto.md` §D63. D63.2: upload adiado | Evolução (D63-D) |
| `purge_proofs` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1282`; D63 `docs/09-pivo-produto.md` §D63. D63.2: binário adiado | Evolução (D63-D) |
| `process_external_effects` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1283`; D63 `docs/09-pivo-produto.md` §D63. Migration `0011_worker_foundation.sql` | — |
| `expire_data_exports` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1284`; D63 `docs/09-pivo-produto.md` §D63. Migration `0013_data_export_delivery.sql` | — |
| `finalize_financial_appeal_windows` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1285`; D63 `docs/09-pivo-produto.md` §D63. D63.2: apelação adiada | Obrigatório antes da abertura pública (D63-D) |
| `expire_rating_dispute_sla` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:1286`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `purge_draw_private_artifacts` | PILOTO | `docs/13-contratos-funcoes.md:1287`; D63 `docs/09-pivo-produto.md` §D63. D63.1: retenção acompanha o sorteio | — |
| `purge_idempotency_outcomes` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1288`; D63 `docs/09-pivo-produto.md` §D63. Migration `0007_idempotency_retention.sql` | — |
| `apply_retention` | PILOTO | `docs/13-contratos-funcoes.md:1289`; D63 `docs/09-pivo-produto.md` §D63. D63.1: retenção das categorias criadas no piloto | — |
| `health_check_jobs` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1290`; D63 `docs/09-pivo-produto.md` §D63. Migration `0011_worker_foundation.sql` | — |
| `apply_due_transitions_locked` (primitiva interna) | PILOTO | `docs/13-contratos-funcoes.md:47`; D63-H: aplicar somente T0 e T2 com fila; adaptação de `13` §0 antes de M4. | — |
| `transfer_financial_authority` (primitiva interna) | PILOTO | `docs/13-contratos-funcoes.md:425`; D63-D corrigida: acompanha M5 e sustenta a exclusão de conta com pagamentos marcados; transfere autoridade ou retorna `FINANCIAL_SUBSTITUTE_REQUIRED`. | — |
| `finalize_deletion` (worker/RPC interna) | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1107`; migration `0012_account_deletion.sql`; D63 `docs/09-pivo-produto.md` §D63. | — |

## N1–N28 de `12` — cada evento, incluindo canal

**Os canais externos 📱/✉️ são pós-piloto; N26, N27 e N28 acompanham seus
gates pré-público, e os demais canais são evolução (D63-D). O sino in-app é
evolução (D63-B).** A classe da linha descreve o fato e seus canais; o app mostra
o estado atual na lista, fila e posição durante o piloto. WhatsApp é aviso
humano, sem dedupe/outbox nem afirmação de entrega pelo app. Os contratos de
`12` permanecem preservados. N27 é aviso de abertura de contestação
financeira (`docs/12-notificacoes.md:185`; `docs/13-contratos-funcoes.md:397`) e integra o gate pré-público D63-D.

| Evento | Classificação do fato in-app | Base e regra da D63 | Gate público se adiado |
|---|---|---|---|
| N1 | PÓS-PILOTO | `docs/12-notificacoes.md:23`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N2 | PÓS-PILOTO | `docs/12-notificacoes.md:24`; D63-B: fato in-app e canais externos ficam fora do piloto; H: causa mensalista/T1 também é evolução. | Evolução |
| N3 | PÓS-PILOTO | `docs/12-notificacoes.md:25`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N4 | PÓS-PILOTO | `docs/12-notificacoes.md:26`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N5 | PÓS-PILOTO | `docs/12-notificacoes.md:48`; D63-B: fato in-app e canais externos ficam fora do piloto; H: causa mensalista/T1 também é evolução. | Evolução |
| N6 | PÓS-PILOTO | `docs/12-notificacoes.md:49`; D63-B: fato in-app e canais externos ficam fora do piloto; H: causa mensalista/T1 também é evolução. | Evolução |
| N7 | PÓS-PILOTO | `docs/12-notificacoes.md:50`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N8 | PÓS-PILOTO | `docs/12-notificacoes.md:51`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N9 | PÓS-PILOTO | `docs/12-notificacoes.md:52`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N10 | PÓS-PILOTO | `docs/12-notificacoes.md:53`; D63 `docs/09-pivo-produto.md` §D63. D63.2: rejeição de comprovante. Canais externos: pós-piloto. | Evolução (D63-D) |
| N11 | PÓS-PILOTO | `docs/12-notificacoes.md:54`; D63 `docs/09-pivo-produto.md` §D63. D63.2: análise de comprovante. Canais externos: pós-piloto. | Evolução (D63-D) |
| N12 | PÓS-PILOTO | `docs/12-notificacoes.md:88`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N13 | PÓS-PILOTO | `docs/12-notificacoes.md:89`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N14 | PÓS-PILOTO | `docs/12-notificacoes.md:90`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N15 | PÓS-PILOTO | `docs/12-notificacoes.md:91`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N16 | PÓS-PILOTO | `docs/12-notificacoes.md:113`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N17 | PÓS-PILOTO | `docs/12-notificacoes.md:114`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N18 | PÓS-PILOTO | `docs/12-notificacoes.md:144`; D63 `docs/09-pivo-produto.md` §D63. D63.2: prova para analisar. Canais externos: pós-piloto. | Evolução (D63-D) |
| N19 | PÓS-PILOTO | `docs/12-notificacoes.md:145`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N20 | PÓS-PILOTO | `docs/12-notificacoes.md:146`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N21 | PÓS-PILOTO | `docs/12-notificacoes.md:147`; D63-B: fato in-app e canais externos ficam fora do piloto; E: causa recorrente é evolução. | Evolução |
| N22 | PÓS-PILOTO | `docs/12-notificacoes.md:167`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N23 | PÓS-PILOTO | `docs/12-notificacoes.md:168`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N24 | PÓS-PILOTO | `docs/12-notificacoes.md:115`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N25 | PÓS-PILOTO | `docs/12-notificacoes.md:116`; D63-B: fato in-app e canais externos ficam fora do piloto; estado atual fica na tela quando aplicável. | Evolução |
| N26 | PÓS-PILOTO | `docs/12-notificacoes.md:133`; D63-D corrigida: aviso acompanha `set_group_suspension` e `set_profile_access`, do caso Admin. | Obrigatório antes da abertura pública |
| N27 | PÓS-PILOTO | `docs/12-notificacoes.md:185`; `docs/13-contratos-funcoes.md:397`; D63-D (extensão): aviso de abertura de contestação financeira, que acompanha a primeira instância. | Obrigatório antes da abertura pública (D63-D, extensão) |
| N28 | PÓS-PILOTO | `docs/12-notificacoes.md:186`; D63-D corrigida: aviso acompanha resposta, apelação, escalada e decisão da disputa financeira. | Obrigatório antes da abertura pública |

## Sorteio de `04`

| Item | Classificação | Base e regra da D63 | Gate público se adiado |
|---|---|---|---|
| Sorteio e publicação de times | PILOTO | D63-A: sequência A/B ilustra dois times; resultado guardado/reproduzível, com número de times e formato de persistência a especificar antes de M6; publicação em `docs/13-contratos-funcoes.md:611`. | — |
| Algoritmo v3 binário (N≤12 exato, N>12 heurístico, encoding/PRNG/score/vetores/benchmark) | PÓS-PILOTO | `docs/04-algoritmo-sorteio.md:1`; D63-A: v3 de `04` preservada como evolução; piloto usa serpentina simples versionada. | Evolução |

## Marcos de `16`

A classe aqui descreve o recorte do marco, não muda o estado de suas fatias já
mergeadas. O roteiro em `16` fixa as fatias futuras; seus números de sessões
são **inferência**, não prazo aprovado. Telas e operações das partes adiadas
continuam nas tabelas acima.

| Marco | Classificação | Base e regra da D63 | Gate público se adiado |
|---|---|---|---|
| M0 — fundação | JÁ ENTREGUE | `docs/16-roadmap.md` §5; migrations `0001`–`0003`, registros `docs/19-operacao-m0-a.md:1` e `docs/20-operacao-m0-b.md:1`; D63 `docs/09-pivo-produto.md` §D63. Sentry é obrigatório antes do público por D63-C. | — |
| M1 — identidade | JÁ ENTREGUE | `docs/16-roadmap.md` §5; migrations `0004`–`0014`, `docs/21-operacao-m1-a.md:1` e `docs/23-operacao-m1-b.md:1`; D63 `docs/09-pivo-produto.md` §D63. Google é evolução (D63-I); aceite real ainda depende de gate. | — |
| M2 — grupos | PILOTO | `docs/16-roadmap.md` §5; D63 `docs/09-pivo-produto.md` §D63; `0015`/`0016` entregues, `0017`/`0018` e UI-A/UI-B pendentes. | — |
| M3 — racha | PILOTO | `docs/16-roadmap.md` §5; D63-E: criar, editar e cancelar com devolução manual; recorrência é evolução. | — |
| M4 — lista | PILOTO | `docs/16-roadmap.md` §5; D63-F/H: T0, fila, T2 e gestão manual; TP/T1 e mensalistas são evolução. | — |
| M5 — financeiro | PILOTO | `docs/16-roadmap.md` §5; D63-E/G: acerto externo, `mark_paid`, obrigação/devolução manual; primeira instância é pós-piloto obrigatória antes do público (D63-D, extensão). | — |
| M6 — times | PILOTO | `docs/16-roadmap.md` §5; D63-A: notas de linha e serpentina simples; sequência A/B ilustra dois times, número e formato de persistência pendentes antes do marco. | — |
| M7 — comunicação | PÓS-PILOTO | `docs/16-roadmap.md` §5; D63-B/D: sino e push/e-mail são evolução; WhatsApp leva avisos humanos no piloto. | Evolução |
| M8 — hardening | PILOTO | `docs/16-roadmap.md` §5; D63 `docs/09-pivo-produto.md` §D63: aplicar acessibilidade/segurança/restore ao escopo piloto; Sentry é gate pré-público D63-C, fora do piloto. | — |
| Beta controlado → piloto de amigos | PILOTO | `docs/16-roadmap.md` §5; D63 `docs/09-pivo-produto.md` §D63: um grupo percorre o ciclo mínimo; WhatsApp leva avisos. | — |

## Contratos a especificar antes dos marcos

- **Antes do M3 (D63-E/G/H):** definir o `config` do racha sem TP/T1/Pix no app
  e os patches admitidos no racha publicado. `13` §3.2 já proíbe mudança de Pix
  após T0, preço com pagamento real sem estorno integral e disputa ausente,
  mudança de data local, reabertura de prazo aplicado e edição após início.
  Alteração de times publicados exige invalidação atômica quando o contrato a
  prevê; o efeito de outros patches sobre publicação e a supressão/adaptação
  de N14/N15 sem outbox no piloto precisam ser especificados.
- **Antes do M4 (D63-F/H):** reconciliar `13` §§1.1–1.6 e §3.1 com T0/fila/T2
  sem TP/T1. Definir configuração, estados/locks, ordem de fila, entrada/saída,
  adição/remoção manual, reconciliação, deadlines/claims e edição de prazos;
  nenhum `pending` perde vaga apenas por falta de marcação de pagamento.
  A chamada a `get_payment_instructions` e os fatos N1/N4/N6–N8 do contrato
  completo não podem ser presumidos na variante sem Pix/T1/sino.
- **Antes do M5 (D63-E/G):** ligar `mark_paid`, pagamento conhecido após
  cancelamento, `refund_due` e `refunded` aos estados do piloto. `13` §§1.6,
  2.6–2.9 e 3.3 já fixam obrigação única, devolução declarada manualmente,
  trilha/auditoria e bloqueio de preço até devoluções completas; definir o
  que falta para racha publicado e sem comprovante/contestação inicial;
  `mark_paid` não emite N9 no piloto sem notificações in-app.
- **Antes do M6 (D63-A):** especificar empate de notas, número de times,
  seed, persistência, versão e testes do algoritmo simples reproduzível. A
  serpentina e a exclusão dos goleiros já foram decididas; `04` v3 fica íntegro.

## Contratos do #41 em `main` e pendências públicas

O #41 foi mergeado em `origin/main` (`9805ece`). `25` §8.2 “Pendências
pós-piloto” exige antes da abertura pública arquivamento por RPC/leitura
histórica, rotação/keyring de convite, dimensão por IP e os demais gates que
ela enumera. A `0018` contratada ali entrega somente `rename_group`.
As linhas PILOTO da tabela abaixo são contratos aprovados, ainda sem migration
ou operação implementada da `0017`/`0018`; o merge documental não as torna
JÁ ENTREGUE. Este mapa não altera as decisões do §8.2.

### Operações contratadas pelo #41 em `main`, ainda não implementadas

As linhas abaixo completam o censo dos contratos incorporados a `13` e da
subseção “Pendências pós-piloto” incorporada a `25` §8.2. As referências são
agora aos arquivos em `main`.

| Operação contratada | Classificação | Base e regra da D63 | Gate público se adiada |
|---|---|---|---|
| `check_and_debit_invite_attempt` | PILOTO | `docs/13-contratos-funcoes.md:720`; D63 `docs/09-pivo-produto.md` §D63: limitador de convite por perfil. | — |
| `preview_group_by_code` | PILOTO | `docs/13-contratos-funcoes.md:801`; D63 `docs/09-pivo-produto.md` §D63: preview sem consumo. | — |
| `preview_group_by_invite` | PILOTO | `docs/13-contratos-funcoes.md:802`; D63 `docs/09-pivo-produto.md` §D63: preview do link. | — |
| `get_my_pending_group_requests` | PILOTO | `docs/13-contratos-funcoes.md:830`; D63 `docs/09-pivo-produto.md` §D63: pedido próprio pendente. | — |
| `revoke_group_invite` | PILOTO | `docs/13-contratos-funcoes.md:971`; D63 `docs/09-pivo-produto.md` §D63: higiene do convite vivo. | — |
| `regenerate_group_invite` | PILOTO | `docs/13-contratos-funcoes.md:972`; D63 `docs/09-pivo-produto.md` §D63: invalida material anterior. | — |
| `issue_group_invite` | PILOTO | `docs/13-contratos-funcoes.md:973`; D63 `docs/09-pivo-produto.md` §D63: nova ocasião após terminal. | — |
| `rename_group` | PILOTO | `docs/13-contratos-funcoes.md:1013`; D63 `docs/09-pivo-produto.md` §D63: `0018` somente renomeia. | — |
| `archive_group` | PÓS-PILOTO | `docs/25-plano-m2.md:1749`; D63 `docs/09-pivo-produto.md` §D63: contrato preservado em `25` §8.2. | **Obrigatório antes da abertura pública** (M2-D40). |
| Rotação/keyring de convite entre versões | PÓS-PILOTO | `docs/25-plano-m2.md:1828`; D63 `docs/09-pivo-produto.md` §D63: v1 do piloto preserva contrato futuro. | **Obrigatório antes da abertura pública** (M2-D39). |
| Dimensão de IP e restore do limitador de convite | PÓS-PILOTO | `docs/25-plano-m2.md:1866`; D63 `docs/09-pivo-produto.md` §D63: perfil continua barreira no piloto. | **Obrigatório antes da abertura pública** (M2-D39). |

## Perguntas restantes após D63-D (extensão)

**Zero linhas `PERGUNTA`** no censo. A extensão de D63-D classifica as três
operações de primeira instância, as três intervenções Admin e N27 como
PÓS-PILOTO obrigatórias antes da abertura pública. N27 é aviso da disputa,
conforme `docs/12-notificacoes.md:185` e `docs/13-contratos-funcoes.md:397`.
As especificações técnicas pré-marco de A, E e H continuam pendentes.
Pela correção de 30/09, N26 e N28 acompanham os gates das funcionalidades
que os emitem; `transfer_financial_authority` integra o M5 do piloto.

## Pendência UI-B decidida em 03/10/2026

César decidiu que o controle de visibilidade das notas da tela 25 entra no M6,
junto com as notas, e fica ausente da UI-B do M2. `set_ratings_visibility`
permanece entregue na `0016`; sua autoridade e confirmação continuam no contrato.

## Staging — decisões humanas de 10/10 e 12/10/2026

Staging Supabase Free restrito ao César e contas fictícias. Vida máxima de sessão
de 90 dias não garantida: exceção aceita só aqui. Antes do primeiro convite,
Pro com limite ativo ou fatia independente de plano; JWT/rotação não substituem
a garantia (`25` §8.1; `28`). PWA publica automaticamente pela integração Git
Vercel a cada merge no main; previews desligados. Supabase continua manual pelo
César. Domínio final primeiro, duas origens na Edge depois, antes de usar app.

## Rachas v1 — modo apresentação, decisão humana de 12/10/2026

César autorizou um corte de demonstração do M3 para Desenvolvimento Mobile:
racha de grupo com início/fim, local/endereço, coordenadas opcionais, vagas e
valor por jogador; criação pelo gateway com request_id; leitura de membros
ativos e escrita por dono/organizador ativo. Lista, detalhe e criação modal,
GPS por expo-location e abertura no mapa. FlatList nas listas principais
(rachas, grupos e gestão de membros), por decisão humana de 15/10/2026;
coordenadas arredondadas a 4 casas decimais, gravadas só após confirmação.
A D63.5 foi adiada em 14/10/2026 (`25` §8.1): o corte usa o padrão
idempotente atual, e o registro de operações é obrigatório antes do piloto
com usuários reais.
A base visual pode vir do PR #25, sem importar dados fictícios nem suas
novas dependências. O piloto completo permanece no mapa acima.

Correções da revisão do #70. Leitura: `matches` não tem acesso direto de
nenhum papel; mora em `private`, sem RLS e sem grant (`14` §5.2), e o app lê
só por `get_match` e `list_my_matches` na Edge `groups`, com actor context
que recusa sessão revogada (401), como `get_group_members`. Não membro
recebe o mesmo NOT_FOUND para ID existente e inexistente. Mapa, decisão
humana de César de 15/10/2026: latitude e longitude podem ir ao Google Maps
somente quando a pessoa toca em "Abrir no Google Maps"; a URL é montada no
toque, leva só a busca pelo local (coordenadas ou endereço), sem ID de
racha, grupo ou pessoa, e abre com noopener e noreferrer na web. As
coordenadas continuam fora de logs, mensagens de erro e URLs do app.

**Depois da apresentação:** recorrência e modelos; Pix e configuração de
pagamento; goleiros; TP/T0/T1/T2, claims e reconciliação; inscrição, ocupação
real, fila e adição/remoção de jogadores; ledger, cobrança e devoluções;
publicação e sorteio; notificações; cancelamento e a matriz integral de
edição segura do piloto; rachas no export LGPD. A demonstração não afirma
essas entregas.

## Racha completo — modo apresentação, decisão humana de 15/10/2026

César autorizou, sobre os Rachas v1, presença, lista de espera e marcação
manual de pagamento, sem Fase 0. "Vou jogar" só para membro ativo e antes de
`starts_at`: com vaga entra confirmado, senão no fim da espera. Desistir vale
para confirmado ou espera até o início; a saída de um confirmado promove o
primeiro da espera na mesma transação; quem volta entra no fim. Dono ou
organizador ativo marca "pago" ou "não pago" só para confirmado, com autor e
horário gravados; o total é pagos × `field_price`, sem Pix, comprovante ou
valor digitado. O jogador vê só o próprio pagamento; a organização vê todos.
Respostas de César no mesmo dia, diante de três pontos que os documentos já
decidiam: a tabela fica em `private`, sem RLS e sem grant (`14` §5.2), lida
só por projeção via Edge; quem está marcado como pago não desiste
(`PAYMENT_ALREADY_REAL`, `13` §1.2) até a organização desmarcar; a saída do
grupo, inclusive por exclusão de conta, libera a vaga em racha futuro e
promove a espera (`10` §10), e racha já iniciado guarda a lista como
histórico, sem expor nome de conta excluída.

Descrição do racha, decisão humana de 16/10/2026: campo opcional no modal,
com contador, até 500 pontos de código depois de normalizado (NFC, espaços
colapsados, quebras de linha mantidas, no máximo uma linha em branco). O vazio
vira `null`; só espaços, controles e marcas bidi são recusados. A regra é a
mesma no formulário, na Edge e no banco (`private.normalize_match_description`,
`0022`); o detalhe mostra o texto puro, sem link ativo nem marcação, e a lista
não o carrega. Fica fora de desfecho idempotente, log e mensagem de erro.

**Depois:** sorteio; Pix e instrução de pagamento; editar e cancelar o
racha; notificações; organizador inscrever ou remover outros; goleiros e
`list_kind`; convidado avulso; mensalista e prioridade TP; T1/T2, claims e
reconciliação; obrigação de devolução (`refund_due`) para quem pagou e saiu
do grupo ou excluiu a conta, e o bloqueio financeiro da exclusão; exibir na
tela quem marcou o pagamento; inscrições no export LGPD; registro de
operações da D63.5 antes do piloto com usuários reais.

## Rachas: usabilidade — decisão humana de 17/10/2026

César pediu, depois de testar no celular: o detalhe do grupo mostra
"Próximos rachas" (cards do grupo, por data) e "Criar racha" só para dono e
organizador ativo, abrindo o modal com o grupo escolhido e sem seletor; a aba
Rachas vira "Agenda", com todos os próximos rachas e o nome do grupo em cada
card. "Nome do local" é texto livre. "Endereço" tem "Buscar": a Edge consulta
o Nominatim (Brasil, pt-BR, até 5 resultados), só no toque, com User-Agent do
Colete, no máximo 1 requisição por segundo para o app inteiro
(`private.geocode_throttle`, `0023`), cache curto em memória e atribuição
"© OpenStreetMap" nos resultados. A busca exige sessão válida e autoridade de
quem cria racha, não grava nem loga o texto buscado e não muda a CSP do app.
Escolher um resultado preenche o endereço e guarda latitude/longitude com 4
casas; digitar por cima descarta a posição. "Usar minha localização" sai da
criação; o detalhe ganha "Ver distância", calculada no aparelho, só quando o
racha tem coordenadas. Máscaras de data, horário e valor; erros por campo
(data anterior a hoje, início já passado, fim antes do início acima de 6 h;
até 6 h, o fim antes do início termina no dia seguinte, com aviso); foco no
primeiro campo inválido; "Criando…" durante o envio; erro do servidor no campo
ou no aviso do topo. Placar do detalhe só com a ocupação; data e horário em
texto no topo. Card no Placar premium: bloco de data estilo ingresso, horário,
local, grupo na Agenda e ocupação com barra e espera.

**Decisão de César (revisão do #72):** o servidor mantém até 12 h de
duração no banco e na Edge; o limite de 6 h vale só no formulário. Nenhuma
migration nova nem mudança de constante da Edge.

Busca de endereço, correções da revisão do #72. O portão reserva horários de
saída espaçados por 1,25 s (`0023`) e a Edge só chama o Nominatim até 250 ms
depois do horário reservado, medido no próprio relógio; resposta lenta do
portão ou despertar tardio abandona o horário e reserva outro. Assim duas
saídas distam no mínimo 1 s no app inteiro, com várias instâncias e atraso
entre o portão e a chamada. Corpo que falha no meio da leitura vira
"indisponível" e não entra no cache. O card empilha o bloco de data sobre o
conteúdo quando a largura útil é pequena.

## Ajustes do teste do César — decisão humana de 17/10/2026

Depois do teste no staging: busca de endereço com espaçamento que aceita a
ida e volta real da RPC (`0024`, horários a 2 s, saída até 1 s depois do
horário); primeiro acesso com o perfil completo; menos descrições embaixo
dos campos; topo das telas só com o título; "Sair da conta" no fim do Perfil,
com confirmação; depois de "Pedir para entrar", a pessoa vai para Grupos com
"Pedido enviado". Fotos de perfil e de racha continuam fora.
