# Staging hospedado — roteiro executado somente pelo César

## 1. Escopo, decisões e limite

Este roteiro prepara um ambiente separado; não é autorização para convidar
usuários. Agentes não acessam Supabase/Vercel reais, não manipulam credenciais
e não executam os comandos remotos abaixo. Todos são para o Terminal de César.
Valores em exemplos são fictícios; não copiar fixtures públicas para o staging.

Decisão humana de 06/10/2026: Supabase Free em São Paulo, Vercel Hobby no endereço
estável gratuito `*.vercel.app`, domínio próprio depois, deploy manual sem workflow
de deploy, confirmação padrão somente para a equipe. SMTP próprio antes de convidar.
O CORS do PR #59 já está no main; não há mudança de comportamento do app nesta fatia.

**Decisão humana de 10/10/2026 (César, AGENTS §8):** staging usado exclusivamente
pelo César e contas de teste com dados fictícios. Free não garante vida máxima de
sessão de 90 dias. Essa lacuna é aceita somente aqui. O prazo de retenção das
revogações permanece 7776000s; não fingir garantia com JWT mais curto. Antes do
primeiro convite: Pro e limite de 90 dias ativo no painel, ou fatia separada que
garanta a propriedade sem depender do plano. Nenhum convite ao grupo enquanto isso faltar.
Fonte do limite de plano: [User sessions](https://supabase.com/docs/guides/auth/sessions).

## 2. Inventário por nome

As referências são arquivos do repositório, relativos à raiz. O inventário cobre
variáveis efetivamente lidas pelos quatro entrypoints; opções desativadas de
Studio/OAuth/SMS/S3 no config local não são secrets exigidos pelo app.

| Nome | Onde é lido | Onde configurar | Quem | Formato / falta |
| --- | --- | --- | --- | --- |
| `SUPABASE_URL` | `_shared/edge-gateway.ts:52`, `data-exports/index.ts:15`, `worker/index.ts:148` | Edge, fornecida pela plataforma | Supabase; César confere | Origem do projeto; falta impede Auth/RPC/worker. |
| `SUPABASE_PUBLISHABLE_KEY` / fallback `SUPABASE_ANON_KEY` | `_shared/edge-gateway.ts:55`, `data-exports/index.ts:16` | Edge, variáveis da plataforma | Supabase; César confere | Chave publicável ou anon legada da plataforma; sem ambas o handler não inicia. Não setar nomes reservados manualmente. |
| `SUPABASE_SECRET_KEY` / fallback `SUPABASE_SERVICE_ROLE_KEY` | `_shared/edge-gateway.ts:58`, `data-exports/index.ts:17`, `worker/index.ts:149–150` | Somente Edge, variáveis da plataforma | Supabase; César confere | Credencial backend; nunca Vercel/app. Worker prefere JWT service_role para provedores Auth/Storage se disponível. Sem ambas não executa RPCs. |
| `IDEMPOTENCY_HMAC_KEY_V1` | `_shared/hmac.ts:87`, `_shared/edge-gateway.ts:60` | Edge secrets | César, custódia privada | Chave própria de 32 bytes em 64 caracteres hex; resolução por versão. Falta impede operações idempotentes. Não colocar no Vault/banco. |
| `INVITE_HMAC_KEY_V1` | `_shared/invite-gateway.ts:452` | Edge secrets | César; dono da custódia aprovado antes do deploy | Exatamente 32 bytes, base64url canônico sem padding (43 caracteres); falta/forma inválida impede convites. Chave distinta da idempotência; nunca no banco. |
| `INVITE_SHARE_URL_BASE` | `_shared/edge-gateway.ts:205` | Edge secrets, antes de publicar app | César | Origem estável HTTPS `https://app-ficticio.vercel.app`, sem barra final/path/query/fragmento/credenciais; falta/erro impede emitir convite. |
| `APP_ALLOWED_ORIGINS` | `_shared/browser-cors.ts:25` | Edge secrets, antes de publicar app | César | Lista por vírgula de origens HTTPS exatas. Espaços em volta de cada item removidos; vazio, espaço interno ou item inválido invalidam tudo. No staging: o endereço estável do app `*.vercel.app`, sem barra final. Ausente: app abre, mas ações do navegador nas Edge não funcionam. Sem wildcard nem origem automática de previews. |
| `COLETE_LOCAL_STACK` | `_shared/browser-cors.ts:27`, `_shared/edge-gateway.ts:207` | Somente fixture local/CI | Harness local | Nunca `true` no staging; só local permite HTTP loopback. Deixar ausente. |
| `WORKER_CRON_SECRET` | `worker/index.ts:135` | Edge secrets e Vault `worker_cron_secret` | César | Valor aleatório próprio, idêntico nos dois destinos; falta impede worker, divergência dá 401. |
| `worker_project_url` | migration `0014:146` | Vault | César | URL do projeto HTTPS; falta impede despacho cron. |
| `worker_publishable_key` | migration `0014:148` | Vault | César | A chave publicável do mesmo projeto; falta impede despacho. |
| `worker_cron_secret` | migration `0014:150` | Vault | César | Igual a WORKER_CRON_SECRET; falta impede despacho/autenticação. |
| `EXPO_PUBLIC_SUPABASE_URL` | `src/lib/supabase.ts:10`, gerador de headers | Vercel, ambiente do deployment | César | Origem HTTPS do projeto. Falta impede cliente e build staging; gera HTTPS/WSS da CSP. |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `src/lib/supabase.ts:11` | Vercel, ambiente do deployment | César | `sb_publishable_…`; nunca secret/service_role. Falta impede cliente/build. É pública e entra no bundle. |
| `EXPO_PUBLIC_SMOKE_MODE` | `src/lib/runtime.ts:3` | Vercel | César | Ausente ou `false`; `true` usa fixtures. Build staging rejeita `true`. |
| `STAGING_APP_ORIGIN` | `scripts/staging-check.mjs` | Ambiente do Terminal, só para checker | César | Origem estável HTTPS exata, sem barra final; obrigatória. |

A documentação atual da plataforma também descreve chaves plurais em JSON
`SUPABASE_PUBLISHABLE_KEYS`/`SUPABASE_SECRET_KEYS`; o código não as lê. Não renomear
variáveis nem alterar código. Os fallbacks legados acima precisam estar disponíveis.
Se faltarem, **PERGUNTA:** interromper deploy e relatar a configuração da plataforma,
sem copiar credenciais em chat. Fonte: [Edge secrets](https://supabase.com/docs/guides/functions/secrets).

### Auth: valores do contrato e configuração possível no Free

Fonte: `supabase/config.toml`, blocos `[auth]`, `[auth.email]`, `[auth.sessions]`,
`src/lib/supabase.ts:26–32`, `0002_identity_foundation.sql:48` e
`scripts/verify-auth-config.mjs`. O toml local não aplica automaticamente todos os
valores no projeto hospedado; César confere cada item no painel Auth Settings.

| Configuração | Onde | Quem | Valor e consequência |
| --- | --- | --- | --- |
| `site_url` | Auth / URL Configuration | César | Origem estável HTTPS do app; erro manda links para destino errado. |
| `additional_redirect_urls` | Auth / URL Configuration | César | URLs exatas necessárias do app; sem wildcard, previews ou localhost. Não habilitar OAuth nesta fatia. |
| `enable_signup`, `auth.email.enable_signup` | Auth / Providers / Email | César | Ativos para contas fictícias de teste; SMS/anonymous/manual linking desativados. |
| `enable_confirmations` | Auth / Email | César | Ativo; login antes de confirmar é recusado. |
| `double_confirm_changes` | Auth / Email | César | Ativo; confirmação nos dois endereços na troca. |
| `minimum_password_length`, `password_requirements` | Auth / Password Security | César | Mínimo 8, sem exigência adicional de caracteres no contrato local. |
| `secure_password_change` | Auth / Email | César | `false`, igual à configuração atual; não criar decisão de endurecimento aqui. |
| `jwt_expiry` | Auth / JWT settings | César | 3600s; limita access token, **não a vida da sessão**. |
| `enable_refresh_token_rotation` | Auth / Sessions | César | Ativo; refresh de uso único com rotação. |
| `refresh_token_reuse_interval` | Auth / Sessions | César | 10s; detecção de reuso com intervalo tolerado de 10s. Não desativar proteção. |
| `auth.sessions.timebox` | Auth / Sessions, Pro ou superior | César após gate humano | **Não garantido no Free.** Contrato local 2160h/90 dias, sincronizado com 7776000s do banco; exceção somente staging fictício. |
| `otp_length`, `otp_expiry` | Auth / Email | César | Código 6 dígitos, 3600s. Templates de confirmação e recuperação usam `.Token`, como em `supabase/templates/`. |
| `max_frequency`, `auth.rate_limit.*` | Auth / Rate Limits | César | `1s` é fixture local, não promessa de quota hospedada. Ler limite efetivo do painel antes do smoke; envio padrão é restrito à equipe e limitado. Não contornar throttling. |
| SMTP próprio | Auth / SMTP | César e responsável pelo domínio | Não configurado neste staging; obrigatório antes de convidar, com SPF/DKIM/DMARC. Falta impede uso com o grupo. |

Rotação/reuso e expiração JWT existem no Free, mas não limitam a sessão inteira:
refresh pode continuar emitindo tokens com o mesmo session_id. Isso deixa a lacuna
de `13` §5.5; a guarda local verde não certifica o hosted.

## 3. Custódia: nunca colar

Nunca colar em chat, issue, PR, commit, screenshot ou log: senha do banco,
service_role/secret key, token de login da CLI, HMAC, cron secret, JWT/refresh,
senha, OTP, convite, e-mail, IP, nomes reais, dados pessoais, dump ou `.env`.
Mesmo URL/chave pública identificam o projeto: exemplos do repositório são fictícios.

César guarda credenciais no gerenciador privado de senhas. HMAC somente Edge secrets
e cópia de recuperação cifrada fora do repo; chave de cifra separada. Vault recebe
só os três nomes do worker, nunca HMAC. O arquivo temporário de secrets fica fora
do repo, permissão 0600, e é removido após uso. Não usar `set -x`, `tee`, gravação
 de terminal ou argumentos com valores secretos. Confirmar dono da custódia e
restauração de INVITE_HMAC_KEY_V1 antes de gerar a primeira chave (`25` §8.2.2).

Os comandos de geração abaixo são **somente para César**, não foram executados
pelo agente. Gravá-los em arquivos privados fora do repo, sem imprimir valores:

```sh
umask 077
```

```sh
openssl rand -hex 32 > "$PRIVATE_CONFIG_DIR/idempotency-hmac"
```

Resultado: 64 caracteres hex em arquivo privado; não copiar fixture local.

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$PRIVATE_CONFIG_DIR/invite-hmac"
```

Resultado: 43 caracteres base64url sem padding, chave distinta.

```sh
openssl rand -hex 32 > "$PRIVATE_CONFIG_DIR/worker-cron"
```

Resultado: secret independente; César transfere privadamente para Edge e Vault.
Não executar antes de definir diretório privado existente e custódia.

## 4. Deploy manual, de cima para baixo

Cada etapa ocorre só no ambiente novo de staging. Se destino/garantia divergir,
parar. Nunca apontar o staging para produção ou executar reset remoto.

### 4.1 Preparar projetos e nomes estáveis

César cria projeto Supabase **Free**, região **São Paulo**, com senha privada.
No painel Database, executar apenas a consulta de versão abaixo:

```sql
show server_version;
```

Esperado: PostgreSQL major 17, compatível com `supabase/config.toml`. Registrar
somente versão; divergência vira PERGUNTA, sem mudar migrations.
PostgREST precisa ser >=16.3 (`23`, checagem antes do deploy): conferir versão
OpenAPI `info.version` no checker. Se inferior, não publicar nem presumir que Pro
resolva; perguntar sobre atualização da plataforma.

Criar projeto Vercel Hobby como configuração, ainda **sem publicar**. Escolher nome
estável e anotar sua origem HTTPS sem barra final; domínio gratuito é a origem do
app. Previews não entram automaticamente em CORS, Auth ou links.

### 4.2 Preparar checkout e CLI

César usa checkout limpo do commit revisado. Instalar as versões fixadas:

```sh
npm ci
```

Esperado: lockfile intacto; nenhuma atualização automática de dependência.

```sh
npx supabase login
```

Somente César; autenticação no Terminal privado, nenhum token no repo/log.

```sh
npx supabase link --project-ref "$STAGING_PROJECT_REF"
```

Esperado: vínculo exclusivo com staging. César confere referência no painel antes
de seguir; senha do banco só no prompt privado. Não passar segredo em argumento.

```sh
npx supabase migration list --linked
```

Esperado: projeto novo, migrations locais 0001–0020 e nenhuma história divergente.

```sh
npx supabase db push --linked --dry-run
```

Esperado: somente 0001–0020, sem seed nem SQL adicional. Se divergir, parar.

```sh
npx supabase db push --linked
```

Esperado: aplicação sequencial das migrations imutáveis, agendas e privilégios.
Não usar db reset remoto, Studio para mudar schema, ou migration editada.
No painel API, manter apenas os schemas public e graphql_public expostos,
sem private. Conferir Storage buckets criados pelas migrations, privados; não torná-los públicos.

### 4.3 Auth no painel

Aplicar a tabela da seção 2. URL do site/redirects do app estável; confirmação ativa;
templates de confirmação/recuperação copiados dos arquivos versionados e com código
OTP, não link de sessão como substituto. Sem OAuth, SMS ou login anônimo.
JWT 3600s, rotação ligada, reuso tolerado 10s. **O Free não configura a garantia de
90 dias: registrar a lacuna, não marcar timebox como aplicado.** O projeto continua
restrito a César e dados fictícios. Antes de convidar, resolver a seção 6.

### 4.4 Secrets antes do app e publicação das funções

César monta arquivo privado 0600 contendo somente:
IDEMPOTENCY_HMAC_KEY_V1, INVITE_HMAC_KEY_V1, WORKER_CRON_SECRET,
INVITE_SHARE_URL_BASE e APP_ALLOWED_ORIGINS. As duas origens apontam para o endereço
estável HTTPS do app, sem barra final. Não incluir COLETE_LOCAL_STACK nem variáveis
reservadas SUPABASE_. Conferir presença dos fallbacks fornecidos pela plataforma.

```sh
npx supabase secrets set --env-file "$STAGING_EDGE_ENV_FILE" --project-ref "$STAGING_PROJECT_REF"
```

Esperado: nomes configurados; nenhum valor registrado. APP_ALLOWED_ORIGINS é gravada
junto aos secrets **antes de publicar o app**. Remover privadamente o temporário.

```sh
npx supabase functions deploy identity --project-ref "$STAGING_PROJECT_REF"
```

Esperado: gateway publica com `verify_jwt=false` de config.toml; ele próprio verifica
a sessão e responde preflight. Não ligar verificação da plataforma por fora.

```sh
npx supabase functions deploy groups --project-ref "$STAGING_PROJECT_REF"
```

Esperado: mesmo contrato Auth/CORS de identity.

```sh
npx supabase functions deploy data-exports --project-ref "$STAGING_PROJECT_REF"
```

Esperado: download protegido pelo handler; nenhuma URL assinada pública.

```sh
npx supabase functions deploy worker --project-ref "$STAGING_PROJECT_REF"
```

Esperado: verify_jwt=false, autenticação própria por WORKER_CRON_SECRET, sem CORS.

### 4.5 Vault e agendas

No painel Vault, César grava `worker_project_url`, `worker_publishable_key` e
`worker_cron_secret`, com o cron secret idêntico ao da Edge. Não consultar
vault.decrypted_secrets para conferir nem mostrar valores. Conferir nomes somente.
As migrations já agendam; não criar agendas duplicadas.

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Esperado, agendas ativas (UTC): process_external_effects cada minuto;
health_check_jobs a cada 5 minutos; purge_expired_revoked_sessions minuto 17 de
cada hora; purge_expired_idempotency_outcomes 03:23; purge_completed_deletion_requests
03:43; expire_data_exports minuto 7 de cada hora; purge_removed_memberships e
purge_terminal_group_invites 03:53; purge_invite_rate_limits cada minuto.
Nomes prefixados `colete_v1_`. Fontes: 0011,0012,0013,0016,0017; 0014 atualiza o
despacho e os três secrets. Conferir contagens/status de job_runs sem payload,
credencial ou mensagem livre; ausência de execução/efeitos dead bloqueia smoke.

### 4.6 Publicar PWA

No projeto Vercel, configurar `EXPO_PUBLIC_SUPABASE_URL` e
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` do staging; SMOKE_MODE ausente/false.
Framework Other, Node 24, install `npm ci`, build `npm run build:web:staging`.
Sem override de output directory: Build Output API gera `.vercel/output/static`
e `.vercel/output/config.json`. O `vercel.json` versionado define o build.
Não usar valor fixo de projeto em headers versionados. Sem workflow GitHub de deploy.
César só publica depois de Auth, secrets, funções e Vault conferidos.

Resultado esperado: HTTPS na origem estável, fallback Expo Router para navegação,
CSP gerada a partir da URL de build e hashes dos scripts inline de todos os HTML;
HTML/SW/manifest `no-store`, assets hashados `immutable`. Uma mudança de URL pública
exige rebuild, não basta editar a variável depois do export.
Fonte: [Vercel Build Output API](https://vercel.com/docs/build-output-api/configuration).

### 4.7 Conferência somente leitura

César fornece no seu Terminal EXPO_PUBLIC_SUPABASE_URL e chave publicável,
STAGING_APP_ORIGIN e INVITE_SHARE_URL_BASE. Só origens HTTPS exatas, sem barra
final; as duas últimas iguais. Nunca chave administrativa. Rodar:

```sh
npm run staging:check
```

Esperado: uma linha OK por checagem e exit 0. FAIL/exit 1 bloqueia o smoke até
entender a causa. O checker não imprime corpos de respostas, URLs ou valores.
Verifica OpenAPI/versão, ausência de RPCs sensíveis no esquema anônimo, recusa de
tabelas sensíveis, 401 real de identity/groups/data-exports sem sessão, CORS da
origem do app, worker sem credencial cron recusado e sem CORS, e ausência de qualquer header CORS para origem negada (preflight e
resposta real), HTTPS do share base, headers/CSP/cache/SW/manifest.

**Limites:** sem service_role, não verifica configuração privada de Auth/Vault,
vida máxima de sessão, versão PostgreSQL, agendas, dados, custódia, SMTP ou restore.
A reflexão OpenAPI depende da configuração padrão de privilégios do PostgREST;
não substitui pgTAP. Não executa RPC de mutação nem cria usuário; POSTs Edge sem
sessão devem ser recusados antes de atingir domínio. O operador confere também
os gates abaixo. Provas locais não atestam o ambiente hospedado.

## 5. Smoke manual em celular (só contas fictícias)

Usar celular real e segundo aparelho/contexto, sem screenshot com dados/convites.
Instalar PWA e testar também navegação direta e retorno após reload.

| Passo | Resultado esperado |
| --- | --- |
| Abrir app HTTPS | Shell carregado; console sem CSP; build não usa painel sintético. |
| Cadastrar conta fictícia da equipe | Solicita confirmação; nenhuma sessão privilegiada antes do código. |
| Ler e digitar código no aparelho | Confirma e abre perfil; não copiar OTP em evidência. |
| Login e perfil | Login real, perfil próprio, políticas exigidas quando catálogo existir. |
| Criar grupo com nome fictício | Grupo visível só aos autorizados; dono indicado. |
| Criar convite e abrir em segundo aparelho | Link no endereço do app; token em fragmento removido antes do app/observabilidade; pedido de entrada. Não publicar/copiar link. |
| Aprovar com conta dona | Pedido muda para membro ativo; acesso só depois da aprovação. |
| Lista de membros | Papel e estado corretos, dados mínimos; sem e-mail/chave/metadata privada. |
| Renomear grupo como dono | Nome novo após recarga; membro sem autoridade não ganha controle. |
| Transferir propriedade | Confirmação explícita; novo dono tem controle e antigo perde os controles de dono. |
| Logout, voltar e recarregar | Dados privados e controles somem; outra conta não recebe cache da anterior. A lacuna de duração máxima do Free permanece conhecida. |
| Offline/atualização PWA | Não recuperar HTML/dados autenticados de cache; só assets públicos permitidos. |

Registrar apenas passo, OK/FAIL, versão do build, aparelho e data, sem dados livres.
Não executar smoke com pessoas reais para preencher um gate ainda aberto.

## 6. Antes de convidar alguém — todos bloqueantes

- [ ] **Sessão 90 dias:** assinar Pro e ligar limite de 90 dias no painel, conferindo
  sincronismo com 7776000s; ou entregar/revisar fatia independente de plano que
  preserve a propriedade. Decisão antes do primeiro convite (`25` §8.1, decisão
  humana 10/10; `13` §5.5). A exceção do staging termina aqui.
- [ ] PostgREST >=16.3 e PostgreSQL compatível; checker e smoke hosted aprovados,
  CORS da origem estável, CSP sem violações (`23`, checagem antes do deploy; `14`).
- [ ] SMTP próprio, provedor/remetente e SPF/DKIM/DMARC validados; envio padrão
  não atende o grupo (`16` §2; `25` §8.1, decisão 06/10).
- [ ] Custódia de INVITE_HMAC_KEY_V1 aprovada antes do primeiro deploy; dono de
  rotação/recuperação definido (`25` §8.2.2); demais credenciais protegidas.
- [ ] Responsável operacional e canal para abuso de convite, efeito dead, grupo
  suspenso, exclusão bloqueada e incidente (`25` §8.2.5; `16` §5–6).
- [ ] Jurídico aprova papéis, bases legais, prazos e subprocessadores reais,
  memberships/convites/fotos; catálogo terms+privacy completo, digests reais e
  textos publicados (`16` §2; `17`; `25` §8.2.4).
- [ ] Destino externo/chave de backup, primeiro restore isolado e manifesto de
  exclusões aprovados antes de dado real; RPO/RTO 24h aceitos e restore trimestral
  planejado (`14` §5.1; `16` §2; `25` §8.2). Free não promete backup gerenciado.
- [ ] Evidência manual única de acessibilidade em hardware real e smoke com
  WhatsApp, teclado/leitor de tela e segurança aprovados (`25` M2-D43/§8.2;
  `16` gate piloto; `15` checklist).
- [ ] Escopo do piloto completo conforme `16` §5 e `27`; staging de M2 não
  substitui marcos ainda não entregues. Uso pessoal/não comercial enquanto Hobby;
  decisão de plano antes de operar para terceiros/cobrar (`16` §7).
- [ ] Estratégia SW sem cache sensível confirmada; VAPID só quando push entrar;
  Sentry antes de abertura pública, não exigido no piloto (`16` §2/§5, D63).
- [ ] **Condicional, antes de habilitar dimensão IP:** teste hosted de X-Forwarded-For
  forjado, IP da conexão como último item, sem persistir IP; repetir antes de cada
  deploy após habilitar a dimensão. Hoje é pós-piloto, não implementado nem
  garantido por esta preparação (`25` §8.2, pendências pós-piloto).

Nada nesta lista está marcado como cumprido por um teste local ou por este PR.

## 7. Como desfazer

César interrompe acesso ao app (despublicar deployment ou remover projeto Vercel)
e pausa as agendas do staging antes de encerrar o projeto. Fazer só no projeto
isolado; não editar migrations nem apagar produção. Preservar registro sanitizado
sem valores e respeitar política de retenção mesmo em backup.

Se há credencial exposta: revogar imediatamente a credencial afetada no fornecedor,
rotacionar consumidores e invalidar sessões quando cabível. HMAC de convite exige
cerimônia/revisão própria: não trocar à força sem analisar convites válidos/versões;
com apenas dados fictícios, descartar ambiente e recriar por migrations pode ser
mais simples. Cron secret precisa trocar nos dois destinos em janela controlada.
Publishable key não é segredo, mas revogar após ambiente encerrado evita uso residual.

Antes de apagar Supabase, César confere referência de staging e descarte autorizado
no painel; revoga chaves/CLI pessoal se necessário, remove variáveis Vercel e arquivos
privados temporários. Exclusão definitiva não é rollback reversível. Para retomada,
criar staging novo e repetir o roteiro; não restaurar credenciais esquecidas.

## 8. Evidência e PERGUNTAS

A prova de CSP usa o export e um servidor HTTP local com os mesmos headers gerados.
No local, connect-src usa a origem exata do Supabase loopback e, exclusivamente
para os E2Es de CORS, a porta exata do runtime Edge direto registrada pelo harness.
Não há wildcard, proxy, resposta falsa ou Kong nesse caminho. Deploy não aceita
origens de fixture: usa só HTTPS/WSS de EXPO_PUBLIC_SUPABASE_URL.

PERGUNTAS operacionais permanecem para César antes dos respectivos gates: quem
assume custódia/plantão, qual SMTP/destino de backup, aprovação jurídica e qual
saída para garantir sessão antes do convite. Não requerem que o agente acesse
credenciais nem ambiente real. Qualquer outra incompatibilidade de plano/garantia
interrompe a execução antes de propor exceção ou mudar código.

**Diagnóstico inicial da CSP (antes de jitless):** strictStyles=true registrou 5 violações de estilo
e 1 script-src/eval; strictStyles=false eliminou as 5 de estilo, mas manteve
1 script-src/eval. O bundle entry-97813b8b7cf6c203a56abb0ee0fe3b65.js:867
executa a sonda Zod allowsEval com new Function(""). Fonte original:
node_modules/zod/v4/core/util.js:148–159. Capturar o erro não elimina o evento CSP.
A versão atual suporta globalConfig.jitless para evitar a sonda, e a decisão técnica abaixo autoriza ativá-lo antes de criar os schemas.

**Decisão técnica de 10/10/2026:** Zod jitless foi autorizado neste PR, em
commit isolado. Módulo único antes dos schemas, com teste de ordem, espião
Function e contraprova sem configuração. Isso encerra a PERGUNTA de código.
As Edge Functions e os testes existentes de schemas permanecem intactos.

O SDK usado apenas pela prova de refresh do browser é servido como fixture
externa da mesma origem no servidor local; não há script inline de teste
nem exceção de script-src. Contextos adicionais do teste de Auth recebem
as mesmas guardas de CSP/Function. Essa fixture não entra no output Vercel.

Resultados locais medidos e links PR/CI são registrados no progresso da preparação;
a política final medida pertence a `14` §5.5. Nenhum deploy foi executado pelo agente.


**Fechamento local medido em 11/10/2026:** AGENTS §5 aprovado, 1259 asserções
pgTAP/19 arquivos e todos os harnesses de commit/HTTP/concorrência; 253 testes
unitários/26 arquivos; checker staging 33/33. Navegadores: Auth 8, privacy 4,
grupos 62, CORS direto 4 e smoke 6 aprovados, zero violações CSP/console e zero
chamadas Function em todos os contextos; seis skips preexistentes de Auth/privacy.
Sem novo skip, retry, timeout ampliado ou asserção alterada. As quatro
contraprovas de CORS passam no harness direto sem Kong.

A primeira suíte de grupos falhou na semeadura local: dois 500 do runtime
WorkerAlreadyRetired e um login cancelado sem resposta. Diagnóstico autorizado:
cada caso passou 5/5 isolado; suíte de grupos inteira adicional 62/62. Nenhuma
correção em código de produção/teste, container ou limite. Causa específica do
login permanece inferência de atraso local; não há amostra histórica de memória.
Detalhes, classificação VERIFICADO/INFERÊNCIA e logs/traces sanitizados:
`~/colete-noite/staging/diagnostico-semeadura.md`.

Censo final: 54 tabelas, auth.users=0 antes e depois, zero papéis-sonda e resíduos
de domínio/operação/Storage. audit:high exit 0 sem novo alerta além das duas
exceções preexistentes; nenhuma exceção/dependência/override/versão alterada.
package.json mudou somente scripts; package-lock.json idêntico a origin/main
por cmp. O PR exige auditoria porque toca package.json e validation.yml.
Export de staging também gerado localmente com domínio .invalid e chave fictícia;
Build Output API v3, headers e overrides das 21 rotas exportadas. Nenhum deploy
ou certificação de configuração hospedada foi realizado.
