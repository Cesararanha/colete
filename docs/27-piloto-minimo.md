# Colete — mapa operacional da D63 para o piloto mínimo

**Atualizado em 30/09/2026 com D63-A–I; estado entregue revisto em 28/10/2026.** Este mapa é operacional e fica fora do manifesto de especificação.
A autoridade das regras continua em `09` D1–D63, `04` e `01`/`10`–`17`.
A D63 muda o **momento** de entrega, não apaga os contratos das partes adiadas.
O estado entregue abaixo é o de `origin/main` em `2a97d39`, após o merge
do #88: migrations `0001`–`0032` (não existe `0025`). Boa parte do que entrou
depois do #41 é corte "modo apresentação" de um contrato maior (seções de
decisão humana no fim deste mapa); nessas linhas, `JÁ ENTREGUE` vem com a
ressalva do que falta. O que ainda falta para fechar o piloto são as linhas
PILOTO deste mapa e o registro de operações de idempotência (D63.5,
obrigatório antes do piloto com usuários reais, `25` §8.1). A subseção
“Pendências pós-piloto” de `25` §8.2 conserva os gates anteriores à
abertura pública.

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
| 5 — Rachas — vazio | JÁ ENTREGUE | `docs/11-telas-v1.md:113`; D63 `docs/09-pivo-produto.md` §D63. D63.1: acesso ao primeiro racha. Entregue como a Agenda vazia: `0021`/#70 e #72. | — |
| 6 — Rachas — lista | JÁ ENTREGUE | `docs/11-telas-v1.md:117`; D63 `docs/09-pivo-produto.md` §D63. D63.1: lista, vaga e fila; omitir estados de comprovante adiado. Entregue como a Agenda (próximos rachas de todos os grupos, filtros "Vou jogar" e "Com vaga"): `0021`/#70, #72, #74, #84. Ressalva: sem estados de comprovante, TP ou T1. | — |
| 7 — Detalhe do racha | JÁ ENTREGUE | `docs/11-telas-v1.md:137`; D63 `docs/09-pivo-produto.md` §D63. D63.1: ocupação e fila; disputa/apelação e prova ficam fora. Entregue: `0021`/#70, `0022`/#71 (presença, espera e pagamento marcado), `0028`/#79, `0032`/#82, fuso do racha no #88. Ressalva: sem devolução (`record_canceled_match_payment`, `mark_refund_due` e `mark_refunded`, linhas PILOTO abaixo) nem adição/remoção pelo organizador (`add_player`/`remove_player`); claim e T1 são PÓS-PILOTO pela D63-H, e o T2 segue PILOTO em `apply_due_transitions_locked`. | — |
| 8 — Pagamento | PILOTO | `docs/11-telas-v1.md:161`; D63-G: instrução «pague ao organizador»; acerto externo e `mark_paid`, sem Pix no app. Parcial: a marcação manual entrou como `set_match_payment` (`0022`/#71) e o jogador vê o próprio estado; a instrução «pague ao organizador» segue pendente. | — |
| 9 — Times publicados | JÁ ENTREGUE | `docs/11-telas-v1.md:175`; D63 `docs/09-pivo-produto.md` §D63. D63.1: composição publicada; sem nota pública. Entregue na seção "Times" do detalhe: `0032`/#82. Ressalva: o sorteio já vale como publicado, sem proposta nem ajuste manual (`13` §4.4). | — |
| 10 — Grupos — lista | JÁ ENTREGUE | `docs/11-telas-v1.md:182`; D63 `docs/09-pivo-produto.md` §D63. D63.1: criar/entrar em grupo; UI-A do M2. Entregue: UI-A #50; ícone, cor e foto do grupo #77/#81. | — |
| 11 — Detalhe do grupo | JÁ ENTREGUE | `docs/11-telas-v1.md:186`; D63 `docs/09-pivo-produto.md` §D63. D63.1: membros; contestação de nota é D63.2. Entregue: UI-A #50, membros por `get_group_members` (`0019`/#52), próximos rachas do grupo #72. | — |
| 12 — Entrar com código/link | JÁ ENTREGUE | `docs/11-telas-v1.md:195`; D63-F: link de grupo entra; convite avulso de não membro é evolução. Entregue: UI-A #50, QR #69, página do convite antes de pedir (`0026`/#76). | — |
| 13 — Perfil | JÁ ENTREGUE | `docs/11-telas-v1.md:216`; D63 `docs/09-pivo-produto.md` §D63. UI do perfil no PR #22 e controles de privacidade no PR #29; Google/foto/aceite real ainda têm gates | — |
| 14 — Preferências de alertas externos | PÓS-PILOTO | `docs/11-telas-v1.md:228`; D63 `docs/09-pivo-produto.md` §D63. D63.2: push/e-mail adiados | Evolução (D63-D) |
| 15 — Central de notificações | PÓS-PILOTO | `docs/11-telas-v1.md:239`; D63-B: sino in-app é evolução; telas da lista/fila/posição exibem estado atual. | Evolução |
| 16 — Criar grupo | JÁ ENTREGUE | `docs/11-telas-v1.md:247`; D63 `docs/09-pivo-produto.md` §D63. D63.1. Entregue: `create_group` (`0017`/#45) e UI-A #50. | — |
| 17 — Gestão de membros | JÁ ENTREGUE | `docs/11-telas-v1.md:251`; D63 `docs/09-pivo-produto.md` §D63. D63.1. Entregue: UI-B #54. | — |
| 18 — Criar/editar racha | JÁ ENTREGUE | `docs/11-telas-v1.md:261`; D63-E: criação e edição segura entram; recorrência é evolução. Entregue: criar `0021`/#70, usabilidade #72, editar `0028`/#79, fuso do racha #88. Ressalva: sem as travas de edição segura de `13` §3.2, recorrência, Pix, goleiros nem horários T0/T1/T2. | — |
| 19 — Painel do organizador | PILOTO | `docs/11-telas-v1.md:292`; D63-E/F/G: `mark_paid`, adição/remoção manual, «a devolver»/«devolvido»; sem Pix no app. Parcial: pagamento marcado (`0022`/#71), sortear (`0032`/#82), avaliar (`0031`/#83) e cancelar (`0028`/#79) entregues; adição/remoção manual (`add_player`/`remove_player`) e «a devolver»/«devolvido» (`mark_refund_due`/`mark_refunded`) seguem PILOTO. | — |
| 20 — Aprovar comprovante | PÓS-PILOTO | `docs/11-telas-v1.md:313`; D63 `docs/09-pivo-produto.md` §D63. D63.2: upload/análise adiados | Evolução (D63-D) |
| 21 — Avaliar jogadores | JÁ ENTREGUE | `docs/11-telas-v1.md:326`; D63-A: organizador atribui nota a cada jogador de linha para serpentina; detalhes exatos antes de M6. Entregue: `0031`/#83. | — |
| 22 — Sortear e publicar | JÁ ENTREGUE | `docs/11-telas-v1.md:332`; D63-A: sequência A/B ilustra dois times; resultado guardado/reproduzível, com número de times e formato de persistência a especificar antes de M6. Entregue: `0032`/#82. Ressalva: sortear já publica, sem proposta, ajuste manual nem trilha pública. | — |
| 23 — Cancelar racha | JÁ ENTREGUE | `docs/11-telas-v1.md:345`; D63-E: cancelar entra no piloto; obrigação/devolução manuais seguem `13` §3.3 e §§2.6.1–2.9. Entregue: `0028`/#79. Ressalva: sem motivo e sem obrigação «a devolver» de quem pagou (`mark_refund_due`, linha PILOTO). | — |
| 24 — Convites do grupo | JÁ ENTREGUE | `docs/11-telas-v1.md:351`; D63 `docs/09-pivo-produto.md` §D63. D63.1: link. Entregue: `0017`/#45, UI-A #50, QR #69. | — |
| 25 — Configurações do grupo | JÁ ENTREGUE | `docs/11-telas-v1.md:369`; D63 `docs/09-pivo-produto.md` §D63. D63.1: arquivar por RPC está em `25` §8.2. Entregue: UI-B #54, renomear (`0018`/#46), ícone e cor (`0027`/#77), foto (`0030`/#81), apagar (`0029`/#80). Ressalva: arquivar segue em `25` §8.2. | — |

## Operações de `13` — RPC, Edge, projeção e job

Cada operação nomeada tem uma linha. Assinaturas agrupadas no contrato foram
separadas aqui. “Entregue” se refere ao contrato executável da fatia citada;
controle de interface ou integração externa ainda pode estar pendente.

| Operação | Classificação | Base e regra da D63 | Gate público se adiada |
|---|---|---|---|
| `join_match` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:173`; D63 `docs/09-pivo-produto.md` §D63. D63.1 vaga atômica e fila. Entregue em corte: `0022`/#71. Ressalva: só lista de linha, sem `list_kind`, TP, T1 nem claim. | — |
| `leave_match` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:193`; D63 `docs/09-pivo-produto.md` §D63. D63.1 liberar vaga e preservar fila. Entregue em corte: `0022`/#71. Ressalva: sem T1, claim nem N4/N8. | — |
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
| `mark_paid` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:352`; D63 `docs/09-pivo-produto.md` §D63. D63.1: organizador marca pagamento manual. Entregue em corte como `set_match_payment`: `0022`/#71. Ressalva: booleano reversível, sem resolução única, valor nem N9; o livro de pagamentos de `10` (ciclos, resoluções e eventos) segue pendente. | — |
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
| `create_match` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:453`; D63 `docs/09-pivo-produto.md` §D63. D63.1: criar racha. Entregue em corte: `0021`/#70, descrição em `0022`/#71. Ressalva: config sem TP/T1/T2, Pix, goleiros nem recorrência. | — |
| `update_match` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:465`; D63-E: edição segura segundo locks de Pix, preço, data, prazos e publicação de `13` §3.2; adaptação do recorte antes de M3. Entregue em corte: `0028`/#79 (`13` §3.3.1). Ressalva: sem as travas de `13` §3.2 (`PRICE_LOCKED`, `DATE_LOCKED` e as demais). | — |
| `cancel_match` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:512`; D63-E: cancelamento atômico de claims e obrigações `refund_due`; `13` §3.3; sem recorrência no piloto. Entregue em corte: `0028`/#79 (`13` §3.3.1). Ressalva: sem motivo nem obrigações `refund_due` (`mark_refund_due`, linha PILOTO acima). | — |
| `advance_recurrence` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:531`; D63-E: recorrência é evolução. | Evolução |
| `update_recurrence` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:542`; D63-E: edição de série é evolução. | Evolução |
| `set_recurrence_active` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:543`; D63-E: ativação/desligamento de série é evolução. | Evolução |
| `set_rating` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:559`; D63-A: nota do organizador para jogador de linha; contrato exato da nota simples fechado em `13` §4.1.2 e entregue pela `0031` (19/10/2026). Entregue: `0031`/#83. | — |
| `get_my_rating` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:568`; D63-A: leitura da nota do piloto; visibilidade e contrato fechados em `13` §4.1.2 e entregues pela `0031` (19/10/2026), com `get_group_ratings`. Entregue: `0031`/#83. | — |
| `open_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:574`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `respond_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:577`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `resolve_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:579`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `escalate_rating_dispute` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:584`; D63 `docs/09-pivo-produto.md` §D63. D63.2: contestação de nota adiada | Obrigatório antes da abertura pública (D63-D) |
| `POST /draw` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:587`; D63 `docs/09-pivo-produto.md` §D63. D63.1: sorteio, com algoritmo pendente A. Entregue em corte como `draw_teams`: `0032`/#82 (`13` §4.4). | — |
| `commit_draw` | PILOTO | `docs/13-contratos-funcoes.md:595`; D63 `docs/09-pivo-produto.md` §D63. D63.1: commit por revisão, algoritmo pendente A | — |
| `get_draw_proposal` | PILOTO | `docs/13-contratos-funcoes.md:605`; D63 `docs/09-pivo-produto.md` §D63. D63.1: proposta para publicação | — |
| `publish_draw` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:611`; D63 `docs/09-pivo-produto.md` §D63. D63.1: publicar times. Entregue junto com o sorteio em `draw_teams` (`0032`/#82): o sorteio já vale como publicado. | — |
| `create_group` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:633`; D63 `docs/09-pivo-produto.md` §D63. D63.1. Entregue: `0017`/#45. | — |
| `join_by_code` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:634`; D63 `docs/09-pivo-produto.md` §D63. D63.1: M2 conserva código/link. Entregue: `0017`/#45; prévia do grupo em `0026`/#76. | — |
| `join_by_invite` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:634`; D63 `docs/09-pivo-produto.md` §D63. D63.1: entrar por link. Entregue: `0017`/#45; prévia do grupo em `0026`/#76. | — |
| `approve_member` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:635`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `remove_member` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:636`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `set_role` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:637`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `set_monthly` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:638`; D63 `docs/09-pivo-produto.md` §D63. Migration `0016_group_membership_rpcs.sql`; UI mensalista pendente | — |
| `set_ratings_visibility` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:639`; D63 `docs/09-pivo-produto.md` §D63. Migration `0016_group_membership_rpcs.sql` | — |
| `transfer_ownership` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:640`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `leave_group` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:641`; D63 `docs/09-pivo-produto.md` §D63. D63.1, migration `0016_group_membership_rpcs.sql` | — |
| `create_match_invite` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:642`; D63-F: convite avulso de não membro é evolução. | Evolução |
| `accept_match_invite` | PÓS-PILOTO | `docs/13-contratos-funcoes.md:643`; D63-F: aceite de convite avulso é evolução. | Evolução |
| `get_invite_share_link` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:649`; D63 `docs/09-pivo-produto.md` §D63. D63.1: compartilhar link, contrato ampliado em `main` pelo #41. Entregue: `0017`/#45. | — |
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

**Entregues sem linha neste mapa** (contratos de `13` §§4.1.2, 4.4, 5.0 e 7 e
cortes do modo apresentação): `get_group_members` (`0019`/#52);
`mark_invite_attempt_success` e os jobs `purge_invite_rate_limits` e
`purge_terminal_group_invites` (`0017`/#45); `set_group_appearance`
(`0027`/#77); `delete_group` (`0029`/#80); `begin_photo_upload`,
`set_profile_photo`, `remove_profile_photo`, `set_group_photo`,
`remove_group_photo`, as projeções `get_photo_upload_target` e
`get_visible_photos` e o job `reclaim_photo_uploads` (`0030`/#81);
`get_group_ratings` e o job `purge_ratings` (`0031`/#83); `get_match_teams`
(`0032`/#82); as leituras `get_match`, `list_my_matches`,
`get_matches_occupancy` e `get_match_roster` (`0021`/#70, `0022`/#71); e a
busca de endereço `search_address` na Edge (portão em `0023`/#72 e `0024`/#73,
LocationIQ no #75). As operações da `0017` e da `0018` que têm linha própria
estão na seção do #41, abaixo.

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
| Sorteio e publicação de times | JÁ ENTREGUE | D63-A: sequência A/B ilustra dois times; resultado guardado/reproduzível, com número de times e formato de persistência a especificar antes de M6; publicação em `docs/13-contratos-funcoes.md:611`. Entregue: `0032`/#82 (serpentina `snake-v1`, 2 a 4 times). Ressalva: sem proposta nem ajuste manual (`commit_draw`, `get_draw_proposal`) e sem o expurgo dos artefatos (`purge_draw_private_artifacts`). | — |
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
| M2 — grupos | JÁ ENTREGUE | `docs/16-roadmap.md` §5; D63 `docs/09-pivo-produto.md` §D63. Entregue: `0015`–`0020` (#36, #40, #45, #46, #52, #57), UI-A #50, UI-B #54 e faxinas #56/#57. Ressalva: rotação, limitador por IP e arquivamento seguem em `25` §8.2. | — |
| M3 — racha | PILOTO | `docs/16-roadmap.md` §5; D63-E: criar, editar e cancelar com devolução manual; recorrência é evolução. Parcial: criar, editar e cancelar em corte (`0021`/#70, `0028`/#79); faltam as travas de `13` §3.2 e a devolução (`mark_refund_due`/`mark_refunded`). | — |
| M4 — lista | PILOTO | `docs/16-roadmap.md` §5; D63-F/H: T0, fila, T2 e gestão manual; TP/T1 e mensalistas são evolução. Parcial: vaga atômica e espera em corte (`0022`/#71), sem T0/T2; adição/remoção manual (`add_player`/`remove_player`) segue PILOTO. | — |
| M5 — financeiro | PILOTO | `docs/16-roadmap.md` §5; D63-E/G: acerto externo, `mark_paid`, obrigação/devolução manual; primeira instância é pós-piloto obrigatória antes do público (D63-D, extensão). Parcial: marcação manual em corte (`0022`/#71); faltam a instrução «pague ao organizador», a devolução manual (`mark_refund_due`/`mark_refunded`), `transfer_financial_authority` e o bloqueio da exclusão de conta com pagamento marcado. | — |
| M6 — times | JÁ ENTREGUE | `docs/16-roadmap.md` §5; D63-A: notas de linha e serpentina simples; sequência A/B ilustra dois times, número e formato de persistência pendentes antes do marco. Entregue: notas `0031`/#83 e sorteio `0032`/#82. Ressalva: proposta e ajuste manual (`commit_draw`, `get_draw_proposal`), trilha pública do sorteio, lista de goleiros e o expurgo dos artefatos (`purge_draw_private_artifacts`) seguem PILOTO. | — |
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
  O contrato exato da nota simples foi fechado em 19/10/2026 (seção "Notas dos
  jogadores" abaixo e `13` §4.1.2), e o do sorteio no mesmo dia (seção "Sorteio
  de times" e `13` §4.4): empate por UUID, 2 a 4 times com tamanhos de `04`
  §1, sem semente, `snake-v1` guardada com a versão da nota.

## Contratos do #41 em `main` e pendências públicas

O #41 foi mergeado em `origin/main` (`9805ece`). `25` §8.2 “Pendências
pós-piloto” exige antes da abertura pública arquivamento por RPC/leitura
histórica, rotação/keyring de convite, dimensão por IP e os demais gates que
ela enumera. A `0018` contratada ali entrega somente `rename_group`.
As oito primeiras linhas da tabela abaixo foram entregues depois, pela
`0017` (#45) e pela `0018` (#46); as três últimas continuam PÓS-PILOTO. Este
mapa não altera as decisões do §8.2.

### Operações contratadas pelo #41 em `main`

As linhas abaixo completam o censo dos contratos incorporados a `13` e da
subseção “Pendências pós-piloto” incorporada a `25` §8.2. As referências são
agora aos arquivos em `main`.

| Operação contratada | Classificação | Base e regra da D63 | Gate público se adiada |
|---|---|---|---|
| `check_and_debit_invite_attempt` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:720`; D63 `docs/09-pivo-produto.md` §D63: limitador de convite por perfil. Entregue: `0017`/#45. | — |
| `preview_group_by_code` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:801`; D63 `docs/09-pivo-produto.md` §D63: preview sem consumo. Entregue: `0017`/#45; prévia redefinida em `0026`/#76. | — |
| `preview_group_by_invite` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:802`; D63 `docs/09-pivo-produto.md` §D63: preview do link. Entregue: `0017`/#45; prévia redefinida em `0026`/#76. | — |
| `get_my_pending_group_requests` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:830`; D63 `docs/09-pivo-produto.md` §D63: pedido próprio pendente. Entregue: `0017`/#45. | — |
| `revoke_group_invite` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:971`; D63 `docs/09-pivo-produto.md` §D63: higiene do convite vivo. Entregue: `0017`/#45. | — |
| `regenerate_group_invite` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:972`; D63 `docs/09-pivo-produto.md` §D63: invalida material anterior. Entregue: `0017`/#45. | — |
| `issue_group_invite` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:973`; D63 `docs/09-pivo-produto.md` §D63: nova ocasião após terminal. Entregue: `0017`/#45. | — |
| `rename_group` | JÁ ENTREGUE | `docs/13-contratos-funcoes.md:1013`; D63 `docs/09-pivo-produto.md` §D63: `0018` somente renomeia. Entregue: `0018`/#46. | — |
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

**Depois:** sorteio; Pix e instrução de pagamento; notificações; organizador inscrever ou remover outros; goleiros e
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
o LocationIQ, com dados do OpenStreetMap (Brasil, pt-BR, até 5 resultados),
só no toque, com User-Agent do Colete, no máximo 1 requisição por segundo
para o app inteiro (`private.geocode_throttle`, `0023`), cache curto em
memória e atribuição "© OpenStreetMap" nos resultados. O LocationIQ
substituiu o Nominatim por decisão de César de 18/10/2026, depois que o
Nominatim recusou os IPs do Supabase: plano grátis (5.000 buscas por dia, 2
por segundo), chave no segredo `LOCATIONIQ_API_KEY` da Edge (sem ela a busca
fica indisponível) e o crédito "Search by LocationIQ.com", com link, junto dos
resultados. A busca exige sessão válida e autoridade de quem cria racha, não grava nem loga o texto buscado e não muda a CSP do app.
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

## Página do convite — decisão humana de 18/10/2026

Itens 3 e 4 do feedback do teste. Quem tem um código, um QR ou um link vê a
página do grupo antes de pedir para entrar: ícone (por enquanto a bola
padrão), nome, membros ativos e nome de exibição do dono. Membro vê "Abrir
grupo"; pedido pendente vê "Aguardando aprovação"; grupo cheio ou cota
pessoal vê a mensagem atual. Os três caminhos levam à mesma página e, sem
sessão, o link entra e volta a ela. Depois de pedir, continua indo para
Grupos com "Pedido enviado".

A `0026` redefine só o corpo privado da prévia, com as mesmas RPCs públicas,
grants, locks e limitador de 20 tentativas por hora da `0017`. Código
inexistente, revogado, expirado ou esgotado tem a mesma resposta genérica na
prévia; o resgate continua distinguindo as causas (M2-D42), pelo mesmo
orçamento. A prévia nunca devolve lista de membros, IDs de terceiros, e-mail
ou dado de racha; a Edge projeta só os seis campos do contrato (`13` §5.0.2).

## Ícone e cor do grupo — decisão humana de 18/10/2026

O dono escolhe o ícone e a cor do grupo entre oito ícones e seis cores da
prévia aprovada (`0027`, `set_group_appearance` no gateway `groups`, contrato
em `13` §5.0.7). Organizador e jogador recebem `OWNER_ONLY`. Lista de grupos,
detalhe, cartões da Agenda, detalhe do racha, Criar racha com grupo fixo e a
página do convite mostram a escolha: a prévia da `0026` ganha `group_icon` e
`group_color`, e a Edge projeta os oito campos. Todo grupo começa como bola
azul. Foto de grupo continua fora.

## Fotos de perfil e do grupo — decisão humana de 19/10/2026

Item 6 do feedback do teste (`0030`, contrato em `13` §5.0.9). No Perfil,
tocar no avatar grande abre "Trocar foto" e "Remover foto"; no nativo, a
escolha é pela galeria ou pela câmera, e no PWA pelo seletor de arquivo. Na
tela "Ícone do grupo", só o dono tem o bloco "Foto do grupo", com "Escolher
foto" e "Remover foto". A foto aparece no lugar das iniciais ou do ícone na
lista de grupos, no detalhe, nos membros, nos cartões da Agenda e no racha; a
página do convite continua com o ícone e a cor. O app reduz a 512 px e
recodifica em JPEG antes de enviar, e o servidor recusa o que vier com Exif.

## Editar e cancelar racha — decisão humana de 18/10/2026

Item 10 do feedback do teste. No detalhe do racha, quem pode criar racha no
grupo (dono ou organizador ativo) vê "Editar" no canto de cima, que abre o
formulário de criar preenchido, e "Cancelar racha" no fim da tela, com a
confirmação na própria tela ("Cancelar racha de <data>?"). Jogador, ex-membro
e quem não é membro recebem a recusa padrão, inclusive chamando a Edge
direto (`0028`, `update_match` e `cancel_match`, contrato em `13` §3.3.1).
A edição segue as regras do criar (12 h no servidor, virada de dia até 6 h no
formulário) e a busca do LocationIQ; vagas não ficam abaixo dos confirmados
("Já há N confirmados") e, se sobem, a espera é promovida em ordem; o preço
muda e as marcações de pago ficam. Um racha em andamento pode ter o resto
editado mantendo início e fim. O cancelamento é definitivo: o racha continua
na Agenda e no detalhe com o chip vermelho "Cancelado", a lista fica como
histórico, e "Vou jogar", "Desistir", a espera e o pagamento fecham no
servidor e na tela. Sem push nem e-mail. Racha terminado não é editado nem
cancelado.

**Depois:** motivo e nota do cancelamento, notificação N14/N15, estorno
(`refund_due`) de quem pagou, `revision`, a matriz de recomputação e as
travas de `13` §3.2 (`DATE_LOCKED`, `PRICE_LOCKED` e as demais).

## Apagar grupo — decisão humana de 19/10/2026

Item 1 do feedback do teste. No fim de Configurações do grupo, só o dono vê
"Apagar grupo", como ação destrutiva; a confirmação abre na própria tela
("Apagar <nome>?", "Ninguém mais vai acessar o grupo e os rachas futuros
serão cancelados.") e o botão só libera depois de digitar o nome do grupo.
Depois, o app vai para Grupos com "Grupo apagado.". Organizador, jogador,
ex-membro e quem não é membro recebem a recusa padrão, inclusive chamando a
Edge direto (`0029`, `delete_group`, contrato em `13` §5.0.8). É definitivo:
os rachas que não terminaram são cancelados, os convites revogados e os
pedidos pendentes encerrados; o grupo some da lista e da Agenda de todos, e
detalhe, racha, convites, membros e configurações respondem como a um grupo
que não existe. Quem estiver com uma tela do grupo aberta, ao atualizar, vê
"Grupo não encontrado." em Grupos. As participações deixam de contar no
limite de 5 grupos ativos. Os dados ficam no banco para a exportação e a
retenção.

**Depois:** `archive_group` com leitura histórica (`25` §8.2), notificação aos
membros e estorno de quem já pagou um racha cancelado.

## Notas dos jogadores — decisão humana de 19/10/2026

M6 do piloto, antes do sorteio (D63-A; `0031`, contrato da nota simples em
`13` §4.1.2). Os sete pontos que os documentos deixavam em aberto foram
decididos por César assim:

1. Avalia o dono ou um organizador ativo.
2. A autoavaliação é permitida e fica no histórico.
3. Repetir o valor não muda nada nem grava versão; não existe remover nota,
   só alterar.
4. A tela mostra a nota atual com quem mudou por último e quando; o histórico
   completo fica para a contestação.
5. A trilha pública ("alterada no dia do racha") fica para depois, junto com
   a contestação.
6. O expurgo `purge_ratings` entra agora; a nota na exportação do titular fica
   para depois.
7. Telas: "Minha nota" no detalhe do grupo para todos; "Avaliar jogadores"
   (tela 21) para dono e organizador, com quem está sem nota no topo; as notas
   dos demais na lista de membros quando a visibilidade é "membros";
   visibilidade em Configurações, só para o dono, com confirmação; "N sem
   nota" no detalhe do racha, só para a organização.

Escala de 1 a 5, sem valor padrão: quem não tem nota aparece como "Sem nota",
e o sorteio, quando entrar, não roda sem ela (`01` §5.6). Sem a lista de
goleiros do racha (D8), todo membro conta como jogador de linha. Privadas por
padrão; o titular sempre vê a própria, também depois de sair do grupo,
durante a retenção. Grupo apagado não aceita nem mostra nota.

**Depois:** contestação de nota (D63-D), trilha `rating_changed_matchday`,
N20 e N24, a nota na exportação do titular e a tela da própria nota para quem
já saiu do grupo (o contrato já a devolve por `get_my_rating`).
## Sorteio de times — decisões humanas de 19/10/2026

No detalhe do racha, depois de "Confirmados", a seção "Times" (`0032`,
`draw_teams` e `get_match_teams`, contrato em `13` §4.4). O dono ou o
organizador ativo escolhe 2, 3 ou 4 times e toca "Sortear times"; o sorteio
roda no servidor, num racha que não terminou nem foi cancelado, com pelo menos
2 confirmados por time e todos com nota (a organização vê "N sem nota" no
racha, PR das notas).

O algoritmo é o da D63-A: a serpentina por nota (`snake-v1`). Os confirmados
são ordenados por nota, do maior para o menor, e no empate pelo UUID; o 1º vai
para o Time A, o 2º e o 3º para o B, o 4º e o 5º para o A, e assim por diante,
repetindo os extremos e pulando o time que já está cheio. Os tamanhos são os de
`04` §1: quem sobra fica nos primeiros times, e a tela pede antes a
confirmação de que a média por jogador não compensa jogar com uma pessoa a
menos (`01` §5.7). Não há semente: as mesmas notas dão os mesmos times, e o
sorteio guarda a versão do algoritmo e a versão da nota de cada um, para ser
reproduzível enquanto a retenção as conserva. Goleiro segue o D8: sem a lista
de goleiros do racha, todo confirmado é jogador de linha, e a posição do
perfil é só informativa.

Só o último sorteio vale: "Sortear de novo" pede confirmação na tela ("Os
times atuais serão substituídos"). Todo membro ativo vê os times, cada um com
nome e cor de colete (Time A âmbar, B azul, C verde, D rosa) e os jogadores,
por nome, com foto ou iniciais e posição; nunca as notas. Se a lista de
confirmados muda depois do sorteio, aparece "Times desatualizados": quem saiu
some, quem entrou fica em "Sem time"; uma nota alterada também os desatualiza,
só para a organização. Racha cancelado e grupo apagado não mostram times e
recusam o sorteio. Jogador, ex-membro e quem não é membro recebem a recusa
padrão, inclusive chamando a Edge direto.

**Depois:** o algoritmo v3 de `04` (evolução), proposta e ajuste manual
(`13` §4.3), trilha pública do sorteio, a lista de goleiros (`list_kind`),
notificação N12 e os times na exportação LGPD.
