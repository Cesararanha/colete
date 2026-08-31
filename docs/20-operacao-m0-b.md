# Operação e evidências do M0-B

Status deste documento: operacional. Ele não altera requisitos de produto nem
substitui as fontes normativas de `01`, `04` e `09`–`17`. Continua de
`19-operacao-m0-a.md`.

O M0-B entrega as fatias 1 e 2 do B2 da seção 3 de `16-roadmap.md`: tabelas,
constraints, RLS, policies e helpers. Nenhuma RPC entra aqui.

## O que cada fatia entregou

### Fatia 1 — `0002_identity_foundation.sql`

| Objeto | Origem |
| --- | --- |
| `pgcrypto` no schema `extensions` | `13` §0.1 e §5 |
| `private.app_limits` e `private.allowed_proof_mime_types` | gate da §2 de `16` |
| `public.profiles` | `10` §2 |
| `private.current_session_id()` | `10` §2 |
| `private.current_profile_id()` | `13` §0, regra 7 |
| `private.require_profile_id()` | `10` §11 |
| `private.require_active_profile()` | `10` §11 e `13` §5.4 |
| policy `profiles_select_own` | tabela de RLS de `10` §11 |

### Fatia 2 — `0003_privacy_and_deletion.sql`

| Objeto | Origem |
| --- | --- |
| `public.policy_acceptances` | `10` §2 e `13` §5.2 |
| `public.privacy_requests` | `10` §2 e `13` §5.3 |
| `public.revoked_auth_sessions` | `10` §2 |
| `public.deletion_requests` | `10` §2 e `13` §5.3 |
| `public.data_exports` | `10` §2, `13` §5.3 e `17` §2 |
| `private.is_session_revoked()` | `10` §2 |
| `private.require_domain_authority()` | `10` §11 |
| quatro policies de leitura própria | tabela de RLS de `10` §11 |

`npm run db:test` executa 199 asserções pgTAP em três arquivos: 13 do M0-A, 86 da
fatia 1 e 100 da fatia 2.

## Decisões que precisam ficar registradas

### RLS nasce ligada, não espera a fatia 9

Toda tabela é criada com `enable row level security` e `force row level security`
na mesma migration que a cria, com default-deny. A fatia 9 do roadmap foi
reescrita para o que ela passa a ser de fato: varredura final de revogação e
policies das tabelas das fatias 3–8. Sem isso não existiria janela alguma em que
uma tabela existe sem proteção — e é justamente essa janela que o texto anterior
deixava aberta.

Nenhuma policy de `insert`, `update` ou `delete` foi criada em nenhuma tabela.
`authenticated` recebe apenas `select`, e só nas tabelas cuja leitura própria a
tabela de RLS de `10` §11 autoriza. `revoked_auth_sessions` não recebe grant
nenhum: é tabela de serviço, e a projeção agregada que o titular pode ver chega
com a fatia de RPCs.

### `session_id`: verificado, não presumido

Claim confirmada empiricamente em 31/08/2026 contra o GoTrue local, e não apenas
lida em documentação:

- GoTrue `v2.196.0` (`GET /auth/v1/health`), imagem `public.ecr.aws/supabase/gotrue:v2.196.0`;
- claims do access token: `aal`, `amr`, `app_metadata`, `aud`, `email`, `exp`,
  `iat`, `is_anonymous`, `iss`, `phone`, `role`, `session_id`, `sub`, `user_metadata`;
- `session_id` presente e no formato UUID.

É contrato externo e pode mudar com a versão do GoTrue. Se
`private.current_session_id()` passar a devolver `null` para sessões válidas
depois de uma atualização, o nome da claim é o primeiro lugar a conferir. A
asserção de fail-closed abaixo transforma essa quebra em negação, não em
autorização acidental.

### `is_session_revoked()` falha fechado

Token sem `session_id` é token cuja revogação não pode ser verificada, e em
caminho privilegiado ausência de claim é negação, não liberação. A função devolve
`true` nesse caso, e existe asserção pgTAP dedicada.

`require_domain_authority()` reporta sessão revogada como `UNAUTHENTICATED`.
Nenhum código novo foi inventado: `13` §8 é a autoridade única do catálogo de
erros e não tem código para esse caso; além disso, a credencial de fato deixou de
valer e o cliente precisa autenticar de novo.

### `deletion_requests.auth_user_id` sem FK

Deliberado. A saga precisa sobreviver ao usuário do Auth que ela está apagando, e
é o único lugar onde esse identificador vive até a etapa de Auth terminar. A
constraint de conclusão torna as duas metades inseparáveis: saga `completed` não
pode continuar segurando identificador.

### `pgcrypto` e o vetor dourado

`pgcrypto` entra na fatia 1 porque a fatia 1 é a das extensões, e porque o HMAC de
idempotência (`13` §0.1) e o MAC de convite (`13` §5) dependem dele. A chave
**nunca** fica no banco: ela viaja como parâmetro da chamada, vinda do cofre pela
Edge Function, e não é persistida nem registrada em log — é essa linha que separa
"compatível com `14` §5" de violação.

O vetor dourado de `13` §0.1 virou asserção pgTAP: chave de teste `00..1f`,
operação `join_match`, JCS do documento, resultado
`5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4`. Foi conferido
nos dois runtimes antes de virar teste — Node e `extensions.hmac` produzem o mesmo
digest. Uma segunda asserção remove os separadores `0x00` e exige digest
diferente, provando que a separação de domínio é real e não decorativa. Se SQL e
TypeScript divergirem, isso falha agora, e não na fatia 7 com o outbox em cima.

## Valores de calibragem inicial

Fecham o gate da §2 de `16-roadmap.md`. **São valores iniciais, a revisar no
piloto**, não invariantes.

| Chave | Valor | Unidade | Origem do número |
| --- | --- | --- | --- |
| `proof_max_bytes` | `10485760` | bytes | folga sobre screenshot de banco em celular moderno, sem virar vetor de abuso |
| `claim_cooldown_seconds` | `300` | segundos | lista se move em minutos; castigo longo demais pune desistência legítima |
| `notification_dispatch_max_attempts` | `6` | tentativas | `13` §6 exige limite antes de dead-letter |
| `notification_dispatch_backoff_base_seconds` | `60` | segundos | ~1 h de janela com crescimento exponencial |
| `notification_dispatch_backoff_cap_seconds` | `3600` | segundos | teto do backoff |

`claim_cooldown_seconds` é o **intervalo mínimo até a mesma pessoa poder reservar
outra vaga** depois de liberar ou perder uma. Não é a duração da reserva: essa
fica em `slot_claims.expires_at` e vale 10 min para `open_slot`, conforme `13`
§1.3. A ambiguidade foi conferida em `13` §1.3 antes de fixar o número —
`CLAIM_ACTIVE` e `CLAIM_COOLDOWN` são erros distintos justamente porque tratam de
coisas distintas.

A allowlist de MIME é literal de `13` §2.1: `image/jpeg`, `image/png`,
`image/webp`, `application/pdf`.

**Custo de mudar hoje:** uma migration. Isso é aceitável agora. Quando existir
painel administrativo, mudar esses valores tem de virar update com auditoria e
motivo, não migration — a tabela já está preparada para isso, o que falta é a
função administrativa e a trilha.

As duas tabelas usam colunas tipadas, nunca `jsonb`. `17` §3 exige que toda coluna
JSON dos schemas da aplicação apareça exatamente uma vez na tabela de chaves
autorizadas; uma coluna `value jsonb` de configuração quebraria esse scanner por
construção.

`private.app_limits` foi classificada em `17` §2 mesmo sem conter dado pessoal. A
regra do inventário é incondicional de propósito: a primeira exceção
"essa tabela não tem dado pessoal, então não classifico" é o precedente que mata o
scanner, e a segunda exceção vem com dado pessoal dentro.

## O que ficou de fora, e por quê

- **RPCs.** `accept_policies`, `request_data_export`, `revoke_current_session` e
  `delete_account` são da fatia de RPCs. Toda mutação precisa conquistar uma chave
  idempotente transacional antes de produzir efeito (`13` §0, regra 2), e
  `idempotency_records` é da fatia 7. Escrevê-las agora arrastaria a fatia 7 para
  dentro do M0-B.
- **`public_profiles` e demais projeções.** Dependem de grupos e participação
  (fatias 3+). Enquanto não existirem, o cliente lê apenas o próprio perfil.
- **Jobs de retenção.** `expire_data_exports`, limpeza de
  `revoked_auth_sessions` vencidas e `apply_retention` são da fatia de jobs. As
  tabelas já carregam as colunas que esses jobs vão usar.
- **Trilha de auditoria.** `audit_log` é da fatia 7. Nenhum evento de aceite,
  revogação ou exclusão é registrado ainda.
- **Trigger de imutabilidade.** Fatia 8. Hoje a imutabilidade de ledger e
  auditoria é garantida pela ausência de grant e de policy de escrita, não por
  trigger.
- **Storage.** Buckets e policies são a última fatia. `data_exports.storage_path`
  existe como coluna, mas nenhum bucket foi criado.

## Comandos locais

Pré-requisitos: Node/npm nas versões fixadas em `19-operacao-m0-a.md` e Docker
Desktop em execução.

```sh
npm run db:start
npm run db:reset
npm run db:test
npm run verify:app
npm run db:stop
```

`npm run db:reset` recria o banco somente pelas migrations `0001`, `0002` e
`0003`, sem seed de domínio.

## CI

O workflow `M0-A validation` já tem o job `Database security`, que roda
`db:start`, `db:reset` e `db:test`. As migrations e os testes novos entram nesse
job sem alteração de configuração. O nome do workflow foi mantido de propósito:
renomeá-lo invalidaria os status checks obrigatórios já configurados em `main`.
A renomeação é item de arrumação para quando os checks obrigatórios forem
revisados.

## Dívidas em aberto ao fim do M0-B

1. **Teste em aparelho físico** — dispensado em 31/08/2026 conforme
   `19-operacao-m0-a.md`; continua em aberto e não bloqueia as fatias 3+.
2. **Nome do workflow de CI** desalinhado do marco atual.
3. **Calibragem** dos cinco valores acima, a revisar com dados do piloto.
4. **Validação jurídica** de papéis, bases legais e prazos — gate de `16` §2,
   ainda aberto e anterior ao convite do beta.
