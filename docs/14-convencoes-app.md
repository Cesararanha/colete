# Colete — Convenções do app e decisões de projeto (v2, implementação incremental)

31/08/2026. Convenções normativas para a implementação incremental.

## 1. Um repositório, três alvos

```
colete/
├── app/                      # rotas (Expo Router — arquivo = rota = deep link)
│   ├── (auth)/               # login, signup, otp, forgot
│   ├── (tabs)/
│   │   ├── rachas/           # index, [matchId]/, [matchId]/teams, [matchId]/pay
│   │   ├── grupos/           # index, [groupId]/, [groupId]/members, new-match…
│   │   └── perfil/
│   └── _layout.tsx           # tabs ↔ navegação lateral em tela larga
├── src/
│   ├── features/             # por domínio: matches/ groups/ payments/ ratings/
│   │                         #   draw/ notifications/ — hooks + componentes do domínio
│   ├── components/ui/        # base: Button, Card, Field, Badge, EmptyState, Skeleton…
│   ├── lib/                  # supabase.ts · api.ts · errors.ts · format.ts · i18n/
│   └── theme/                # tokens: cores (claro/escuro, AA), tipografia, espaços
├── supabase/
│   ├── migrations/           # SQL numerado — a única fonte do schema
│   ├── functions/            # gateway mutável, draw e adaptadores de e-mail/push
│   └── tests/                # pgTAP / testes de integração (corrida por vaga)
└── e2e/                      # fluxos críticos
```

Regra de dependência: `app/` (rotas) → `features/` → `components/ui/` + `lib/`.
Componente de UI base não conhece domínio; feature não conhece rota.

## 2. Estado e dados

| Coisa | Ferramenta | Regra |
|---|---|---|
| Dados do servidor | **TanStack Query (React Query)** | única fonte de cache; invalidação por chave após cada mutação |
| Estado local de UI | **Zustand** (mínimo) | só o que não é do servidor (ex.: rascunho de racha — persistido sem Pix/token/PII financeira) |
| Formulários | **react-hook-form + zod** | schemas zod compartilhados entre validação de tela e payload |
| Tipos do banco | `supabase gen types` | gerados, nunca escritos à mão |

**Proibido:** Redux/MobX (peso sem ganho aqui) · atualização otimista em qualquer ação
de corrida (`join_match`, `claim_open_slot`, `finalize_proof`) — regra de produto: falha
honesta + retry. O contador local é indicativo; a resposta do servidor é autoridade.

Cache de Query não é persistido no beta. Pix completo, path/bytes de comprovante, artefato de
export e nota privada nunca vão para `localStorage`, AsyncStorage ou Zustand persistido. Prova
não usa signed URL/token no cliente; Edge autenticada faz upload/stream com `private,no-store`.

## 3. Camada de API — o contrato vira código

- Componente **nunca** chama `supabase` direto. Tudo passa por `lib/api.ts`.
- Leitura usa apenas projeção/RPC de leitura autorizada e continua sujeita a RLS. Toda
  **mutação**, desde o M1-A, chama exclusivamente a Edge Function da operação; o cliente não
  chama a RPC Postgres mutável.
- `lib/api.ts`:
  1. cria um `request_id` por intenção mutável, persiste enquanto houver retry e nunca
     reaproveita a chave em outro payload;
  2. envia à Edge somente `request_id` e entrada de negócio; nas quatro mutações do M1-A não
     aceita `input_hmac`, `hash_key_version`, `auth_user_id`, `profile_id`, `session_id` nem
     ator. Um ID de perfil enumerado em contrato posterior pode identificar o alvo, nunca o
     chamador;
  3. converte o envelope em `AppError { code, message, current? }`, com `ErrorCode`
     gerado/validado contra `13-contratos-funcoes.md`;
  4. loga no Sentry só o inesperado, depois da sanitização descrita abaixo.
     **D63-C:** esta etapa se aplica após instalar Sentry, obrigatório antes da
     abertura pública; no piloto, falhas inesperadas ficam em operação sanitizada.
- A Edge valida o JWT, extrai identidade/sessão das claims verificadas, aplica rate limit,
  normaliza/JCS, calcula o HMAC com chave do cofre e chama somente a RPC interna estreita pelo
  cliente com secret key. Ela não expõe API administrativa genérica nem escreve livremente em
  tabelas.
- A UI decide o comportamento pelo `code`; a `message` do servidor é o texto fallback.
- O objeto de comando nasce com `request_id` e o conserva em retry automático/manual da
  mesma intenção. Retry automático só ocorre em falha de transporte/5xx e nunca em erro de
  negócio; uma nova ação consciente recebe outra chave.
- `lib/api.ts` não aceita `storage_path`/token: upload começa em `create_proof_upload`, envia
  para `PUT /proof-upload-sessions/:id/content` e só termina após `finalize_proof`.
- Strings de interface: **pt-BR centralizado** em `lib/i18n/pt.ts` (requisito) — nenhuma
  string solta em componente.

## 4. Código e Git

- Código, commits, branches e PRs **em inglês** (requisito). Conventional Commits
  (`feat:`, `fix:`, `chore:`…). `main` protegida; branch por tarefa; PR mesmo sozinho —
  é o registro de decisão.
- **Glossário domínio → código** (para o código inteiro falar uma língua só):

| Domínio (PT) | No código |
|---|---|
| racha | `match` |
| grupo | `group` |
| titular | `starter` |
| reserva / espera | `waitlist` |
| goleiro | `goalkeeper` (`gk`) |
| mensalista | `monthly` |
| sorteio | `draw` |
| trilha de auditoria | `audit log` |
| comprovante | `proof` |
| estrela/nota | `rating` |

- Lint: ESLint + Prettier + `eslint-plugin-react-native-a11y` (acessibilidade no lint).
- **CI (GitHub Actions) desde o M0:** typecheck + lint + testes unitários em todo PR;
  testes de banco (corrida) em PR que toque `supabase/`.

## 5. Ambientes e operação

| Item | Decisão |
|---|---|
| Supabase | 2 projetos inicialmente no Free: `colete-dev` e `colete-prod`, sujeitos a limites/pausa; migrations por CLI — nunca mudança manual no Studio em prod |
| Chaves de API | cliente usa somente publishable key (`sb_publishable_...`) e JWT do usuário; secret key (`sb_secret_...`) fica somente na Edge/worker e nunca em bundle, browser, app, URL ou log. Código novo não embute chaves legacy |
| Segredos | `.env` local + secrets do GitHub/EAS; nada no repositório |
| Origem pública de convite | `INVITE_SHARE_URL_BASE` fornece a origem pública por ambiente. Fora do ambiente local é obrigatória, HTTPS e sem path, query, fragmento ou credenciais; a Edge monta `/join#token=…` e falha fechada se ausente ou inválida. O domínio real é definido no staging. Somente `npm run db:start` define `COLETE_LOCAL_STACK=true`, permitindo a rota HTTP de fixture em loopback. Nunca deriva a origem de headers do cliente. |
| HMAC | chaves versionadas e separadas para idempotência, convites, snapshot e fingerprint; idempotência v1 usa schema+JCS/RFC 8785 e vetor dourado; a Edge calcula, a RPC só valida formato/versão e compara replay; chave nunca fica no cliente/banco/configuração SQL/log; versões antigas ficam no cofre só pela retenção dependente |
| Auth e e-mail | e-mail e senha no piloto, com os códigos de confirmação existentes; Google é evolução (D63-I corrigida); [SMTP próprio](https://supabase.com/docs/guides/auth/auth-smtp) antes de convidar usuários; Apple só no app nativo |
| Sentry | fora do piloto; instalação obrigatória antes da abertura pública (D63-C), com release por commit e `beforeSend` que remove token, e-mail, telefone, chave Pix, comprovante, payload de notificação e nota |
| Jobs | `job_runs`, markers e alerta de atraso; ação protegida de reconciliação no painel. Cron/ping é redundância, não garantia de disponibilidade |
| Backup | runbook 5.1 diário para cumprir RPO de prova 24 h: roles/schema/data/histórico/config/Storage separados, manifesto, cifra, rotação de 30 dias e restore trimestral; reaplica exclusões |
| Service worker | no piloto, shell/versionamento controlado; nenhum cache de Pix, comprovante ou resposta autenticada; web push é evolução (D63-B/D), sem cache agressivo de detalhe |
| Web security | CSP/headers + `Referrer-Policy: no-referrer`; token de convite em fragmento trocado por POST; allowlist exata de OAuth; rate limit de auth/convite; SPF/DKIM/DMARC |

### 5.1 Runbook executável de backup e restore

Fontes oficiais verificadas: [referência de `supabase db dump`](https://supabase.com/docs/reference/cli/supabase-db-dump),
[backup/restore via CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
e [Database Backups](https://supabase.com/docs/guides/platform/backups). A documentação da
plataforma deixa explícito que backup do banco contém metadados de Storage, **não os objetos**.

As decisões de acesso/exclusão também seguem as limitações publicadas: signed URLs continuam
válidas até expirar e não são revogadas por rotação Auth
([Serving assets](https://supabase.com/docs/guides/storage/serving/downloads)); excluir usuário
não invalida JWT já emitido imediatamente e falha enquanto ele possuir objetos Storage
([User Management](https://supabase.com/docs/guides/auth/managing-user-data)). Todo JWT de
usuário inclui `session_id`, que pode ser validado para corte forte
([User sessions](https://supabase.com/docs/guides/auth/sessions)). Por isso prova
usa stream autenticado e exclusão começa por tombstone/saga, não por promessa de atomicidade
entre serviços.

Pré-condições: CLI/Postgres fixados em versões registradas no manifesto; Docker disponível;
URL de sessão/direct pooler percent-encoded; diretório novo com permissão restrita; segredo
fornecido pelo cofre e nunca gravado no comando/log. Os comandos de dump são separados:

```sh
supabase db dump --db-url "$SOURCE_DATABASE_URL" -f roles.sql --role-only
supabase db dump --db-url "$SOURCE_DATABASE_URL" -f schema.sql
supabase db dump --db-url "$SOURCE_DATABASE_URL" -f data.sql --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
supabase db dump --db-url "$SOURCE_DATABASE_URL" -f history_schema.sql --schema supabase_migrations
supabase db dump --db-url "$SOURCE_DATABASE_URL" -f history_data.sql --use-copy --data-only --schema supabase_migrations
```

Configuração é outro artefato: commit da versão de `supabase/config.toml`; lista de
extensions, publications, Auth/OAuth/SMTP/redirects, cron, buckets/policies, Edge Functions,
região e nomes de secrets (nunca valores). Mudanças próprias em `auth`/`storage` são
comparadas e revisadas separadamente, como orienta a fonte oficial:

```sh
supabase link --project-ref "$SOURCE_PROJECT_REF"
supabase db diff --linked --schema auth,storage --output auth_storage_changes.sql
supabase functions list --project-ref "$SOURCE_PROJECT_REF"
supabase secrets list --project-ref "$SOURCE_PROJECT_REF"
```

Objetos: o backup diário inclui `avatars`, `group-photos` e somente `payment-proofs`
**finalizados**, ainda não purgados e com `purge_after > backup_started_at`. Órfãos, sessões
não finalizadas e `data-exports` ficam fora. Antes da cópia gera-se inventário
`path,purge_after,size,etag/checksum,last_modified`; paths de prova obedecem regex fechada
`proofs/<uuid>/<uuid>`, sem vírgula/quebra de linha. Depois confere-se contagem/bytes/checksum.
Os comandos de Storage são experimentais e sua versão fica no manifesto:

```sh
supabase storage ls "ss:///avatars" --recursive --experimental --linked
supabase storage cp "ss:///avatars" "./storage/avatars" --recursive --experimental --linked
supabase storage ls "ss:///group-photos" --recursive --experimental --linked
supabase storage cp "ss:///group-photos" "./storage/group-photos" --recursive --experimental --linked
psql "$SOURCE_DATABASE_URL" --csv --command \
  "select storage_path,purge_after from payment_proofs where binary_purged_at is null and storage_path is not null and purge_after > :'backup_started_at' order by storage_path" \
  --set backup_started_at="$BACKUP_STARTED_AT" --output proof-allowlist.csv
# Para cada path validado do CSV, copiar exatamente aquele objeto de payment-proofs;
# o script versionado falha se existir cópia sem linha na allowlist ou faltar objeto esperado.
```

O diretório completo recebe manifesto com checksums SHA-256 dos artefatos, versões, data,
projeto, exclusões, RPO alvo **24 h**, RTO alvo **24 h** e contagens; depois é cifrado autenticadamente com chave separada e enviado
para conta/provedor diferente de produção. Snapshot em claro é destruído de forma segura;
rotação: 30 dias. O manifesto cumulativo de exclusões fica cifrado pelo prazo do backup.

Restore acontece em projeto isolado/sem tráfego. Banco e histórico são restaurados em
transações separadas conforme a fonte oficial:

```sh
psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql --command 'SET session_replication_role = replica' --file data.sql --dbname "$RESTORE_DATABASE_URL"
psql --single-transaction --variable ON_ERROR_STOP=1 --file history_schema.sql --file history_data.sql --dbname "$RESTORE_DATABASE_URL"
```

Depois: aplicar/revisar `auth_storage_changes.sql`; configurar Auth/SMTP/OAuth/redirects,
extensions, publications, cron, secrets e Functions a partir do inventário; recriar buckets/
policies; restaurar fotos e depois somente provas que passarem pela allowlist restaurada:

```sh
supabase link --project-ref "$RESTORE_PROJECT_REF"
supabase storage cp "./storage/avatars" "ss:///avatars" --recursive --experimental --linked
supabase storage cp "./storage/group-photos" "ss:///group-photos" --recursive --experimental --linked
# Gerar restore-proof-allowlist.csv do banco restaurado exigindo binary_purged_at is null e
# purge_after > restore_cutoff; copiar só a interseção com proof-allowlist.csv do backup.
```

Antes de liberar: rodar migrations pendentes; reaplicar manifesto de exclusões e todos os
purges vencidos; remover qualquer prova fora da interseção; marcar prova ativa sem objeto como
`evidence_unavailable`; validar Auth/relogin, FKs compostas, RLS negativa, funções, cron,
outbox, contagens/checksums de fotos/provas e ausência de órfãos/exports/provas vencidas. Só
então trocar tráfego. Restore trimestral registra RPO/RTO,
resultado e correções; sem restore aprovado, o backup não conta como gate cumprido.

### 5.2 Onde cada tabela mora

Regra fechada, decidida depois de um defeito real no M0-B registrado em
`20-operacao-m0-b.md`:

- **Tabela que nenhum papel cliente lê fica em `private`, sem grants e sem RLS.**
  Denylist de sessão, outbox, `job_runs`, `idempotency_records`, `external_effects`,
  `transition_markers`, artefatos privados do sorteio, configuração operacional. A
  proteção é a ausência de `usage` no schema e a ausência de grant.
- **`public` + `enable`/`force row level security` + policy é só para tabela com
  leitura direta autorizada** a `anon` ou `authenticated`. Se existe policy, existe
  leitor legítimo; se não existe leitor, a tabela não pertence a `public`.

O motivo não é organização, é corretude. `force row level security` aplica RLS
**inclusive ao dono da tabela**. Uma tabela em `public` com `force` e zero policies
parece máximo rigor e é o contrário: uma função `security definer` cujo dono não
tenha `BYPASSRLS` lê zero linhas dela. Para uma tabela consultada como negação —
denylist, lease, marker de idempotência — ler zero linhas significa "nada proibido",
e a checagem falha aberta em vez de fechada.

Depender de `BYPASSRLS` para corrigir isso é depender de um atributo de papel que
nenhum teste cobre por padrão, porque a suíte pgTAP roda como `postgres`, que o tem.
Toda asserção de isolamento precisa trocar de papel explicitamente, e toda tabela
consultada como negação precisa de uma asserção feita a partir de um papel **sem**
`BYPASSRLS`.

### 5.3 Gateway exclusivo do M1-A

Fontes oficiais Supabase verificadas em **31/08/2026**:

- [Securing Edge Functions](https://supabase.com/docs/guides/functions/auth): a Edge valida a
  credencial do usuário e disponibiliza claims verificadas; o cliente administrativo é um
  caminho distinto e privilegiado;
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security):
  grants e policies são controles separados, e o papel administrativo ignora RLS;
- [Database Functions](https://supabase.com/docs/guides/database/functions): funções recebem
  `EXECUTE` por padrão, portanto as migrations revogam `public`, `anon` e `authenticated` e
  concedem nominalmente apenas o necessário;
- [Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys):
  publishable keys são próprias para componentes públicos; secret keys são exclusivas de
  backend, têm acesso elevado e não podem ser expostas.

A secret key autentica o componente, não o usuário final. Por isso a RPC interna não usa
`auth.uid()` como prova do ator: recebe da Edge `actor_auth_user_id`/`actor_session_id`
extraídos das claims e resolve/revalida o domínio no banco. A migration revoga execução dos
papéis cliente e limita DML direto do papel administrativo nas tabelas do M1-A; a Edge recebe
somente os endpoints/RPCs nomeados. `security definer`, quando necessário, fixa `search_path`
e qualifica cada objeto.

## 6. Hospedagem e administração

1. **PWA no beta pessoal:** Vercel Hobby pode servir o export estático com domínio e
   headers controlados. O plano Hobby é restrito a uso pessoal/não comercial; antes de
   cobrar, operar para terceiros ou formar equipe, existe um gate de plano/provedor.
   Fonte verificada: [Vercel Hobby Plan](https://vercel.com/docs/plans/hobby).
2. **Supabase Free não é SLA:** projetos de baixa atividade podem ser pausados; requests
   artificiais não viram garantia contratual. Antes do beta público, documentar como
   restaurar e decidir o gatilho de upgrade. Fontes: [Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
   e [Production Checklist](https://supabase.com/docs/guides/deployment/going-into-prod).
3. **Admin sem painel geral no beta.** Operações excepcionais passam por funções
   preparadas e autorizadas (`security definer` com `search_path` fixo), nunca por
   update ad hoc. Caso financeiro é atribuído antes do acesso e expõe projeção mínima;
   `correct_refund` só corrige metadata de evento existente. Cada atribuição, acesso a
   evidência e decisão exige motivo, log e N28. O Studio não é atalho para navegar dados;
   painel amplo só nasce se houver escala e novo desenho de autorização.
4. **Backup do Free é responsabilidade do produto:** a plataforma recomenda dump
   regular e backup externo para o plano gratuito. O artefato não fica indefinidamente
   no GitHub Actions e não inclui storage por mágica. Fonte: [Database Backups](https://supabase.com/docs/guides/platform/backups).
5. **Push tem dois adaptadores:** Web Push para o PWA instalado no iOS/iPadOS 16.4+ e
   para navegadores compatíveis; Expo Push entra só nos builds nativos. Fontes oficiais:
   [WebKit — Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
   e [Expo — push notification services](https://docs.expo.dev/guides/using-push-notifications-services/).
