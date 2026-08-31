# Operação e evidências do M0-A

Status deste documento: operacional. Ele não altera requisitos de produto nem
substitui as fontes normativas de `01`, `04` e `09`–`17`.

## Toolchain fixada

| Componente | Versão exata | Motivo |
| --- | --- | --- |
| Node.js | `24.20.0` | linha LTS atual, fixada em `.nvmrc`, `.node-version` e `volta` |
| npm | `11.19.0` | package manager fixado em `package.json` e compatível com Node 24 |
| Expo SDK | `57.0.18` | patch estável da linha SDK 57 |
| React Native | `0.86.3` | versão da matriz oficial do Expo SDK 57 |
| React / React DOM | `19.2.3` | par exigido pela linha adotada |
| Expo Router | `57.0.17` | roteador oficial compatível com Expo 57 |
| React Native Web | `0.21.2` | implementação web compatível com a matriz do SDK |
| TypeScript | `6.0.3` | compilador estrito fixado, sem intervalo flutuante |
| Supabase CLI | `2.116.0` | dependência de desenvolvimento local fixada; nenhuma instalação global |

As dependências usam versões exatas e o `package-lock.json` é a autoridade da
instalação. O intervalo em `engines` admite apenas patches compatíveis da linha
Node 24/npm 11; a CI verifica as versões exatas antes de instalar.

Fontes oficiais consultadas:

- [Criar um projeto Expo](https://docs.expo.dev/get-started/create-a-project/)
- [Matriz de versões do Expo SDK](https://docs.expo.dev/versions/latest/)
- [Expo Router](https://docs.expo.dev/versions/v57.0.0/sdk/router/)
- [TypeScript no Expo](https://docs.expo.dev/guides/typescript/)
- [PWA com Expo](https://docs.expo.dev/guides/progressive-web-apps/)
- [Ciclo de releases do Node.js](https://nodejs.org/en/about/previous-releases)
- [TypeScript 6.0](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- [Supabase CLI local](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Workflow local do Supabase](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Segurança em GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)

## Comandos locais

Pré-requisitos: Node/npm nas versões fixadas e Docker Desktop em execução.

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build:web
npm run verify:pwa
npm run scan:docs
npm run scan:secrets
```

O banco local é descartável e não se conecta a um projeto remoto:

```sh
npm run db:start
npm run db:reset
npm run db:test
npm run db:stop
```

`db:reset` aplica `0001_bootstrap_security.sql` desde o zero. `db:test` executa
13 asserções pgTAP, incluindo bloqueio de acesso dos papéis cliente ao schema
privado, rejeição de contexto não autenticado e ausência de `EXECUTE` público
por padrão em novas funções.

## Fronteiras do scaffold

- O shell contém somente uma home e uma página de fundação operacional; as 25
  telas do produto não foram implementadas.
- O retorno de autenticação e o seletor de arquivo do smoke usam identidade e
  conteúdo explicitamente sintéticos. O arquivo não é enviado e somente seus
  metadados ficam em memória durante a sessão.
- Não existe persistência local de Pix, comprovante, nota ou dado financeiro.
- O service worker não armazena navegações, documentos, requisições com
  `Authorization`/cookies nem caminhos de auth, Storage, prova, Pix ou pagamento.
- Não há credencial, deploy, Pages, túnel público ou configuração de produção.
- Migrations `0002+`, tabelas de domínio, idempotência e concorrência pertencem ao
  M0-B e não estão neste escopo.

## CI e status checks

O workflow `M0-A validation` roda em Pull Requests e por acionamento manual, com
`contents: read`, credenciais do checkout não persistidas e sem secrets ou deploy.
As actions são fixadas por SHA imutável. Após os jobs aparecerem no GitHub, estes
são os nomes a cadastrar como checks obrigatórios:

| Check | Cobertura |
| --- | --- |
| `App quality` | lint, formato, TypeScript estrito e testes unitários |
| `PWA export` | export estático e política conservadora do PWA |
| `Database security` | banco do zero, migration 0001 e pgTAP |
| `Repository guardrails` | integridade documental e varredura de segredos |
| `PWA smoke` | Chromium móvel/largo, acessibilidade e fluxos sintéticos |

`Repository guardrails` também falha em advisories npm de severidade alta ou
crítica. A consulta de 31/08/2026 encontrou zero altas/críticas e dez moderadas,
todas derivadas de `uuid@7.0.3` via `xcode`/ferramentas do Expo. O advisory
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
atinge `v3`/`v5`/`v6`; o caminho transitivo observado usa somente `uuid.v4()`.
Como o npm oferece apenas um downgrade incompatível do Expo, nenhum override de
major foi forçado. A pendência deve ser removida quando o Expo atualizar `xcode`.

## Smoke automatizado

```sh
npx playwright install chromium
npm run build:web:smoke
npm run test:smoke:web
```

O Playwright cobre viewport móvel e larga, ausência de overflow horizontal,
navegação por teclado e foco, tema, redução de movimento, retorno sintético de
auth, seleção sintética de arquivo, violações críticas/sérias do axe e exclusão
de URLs sensíveis do Cache Storage.

Isso não comprova instalação nem safe areas em hardware real.

## Checklist físico obrigatório — ainda não aprovado

Use iPhone e Android na mesma rede da máquina. O endereço precisa ser HTTPS com
certificado confiável nos dois dispositivos e com o host/IP da LAN no SAN; HTTP
de LAN não é evidência válida de service worker. Nenhum certificado ou túnel é
criado pelo repositório.

1. Gere o build sintético: `npm run build:web:smoke`.
2. Sirva o diretório sem publicação externa:

   ```sh
   npx serve dist --listen tcp://0.0.0.0:4173 --no-clipboard \
     --ssl-cert /CAMINHO/ABSOLUTO/cert.pem \
     --ssl-key /CAMINHO/ABSOLUTO/key.pem
   ```

3. No iPhone, abra `https://HOST-LAN:4173` no Safari, use Compartilhar →
   Adicionar à Tela de Início, ative **Abrir como app web** e toque em Adicionar,
   conforme o [guia oficial da Apple](https://support.apple.com/en-ie/guide/iphone/iphea86e5236/ios).
4. No Android, abra o mesmo endereço no Chrome, use Mais → Instalar/criar atalho
   → Instalar, conforme o [guia oficial do Chrome](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en).
5. Em cada instalação, registre modelo, versão do sistema, navegador, data e uma
   captura ou vídeo curto para cada item abaixo:
   - inicia em janela standalone e exibe nome/ícone corretos;
   - home e Fundação navegam nos dois sentidos;
   - foco é visível com teclado físico e a ordem é lógica;
   - conteúdo não invade notch, Dynamic Island ou barras do sistema;
   - retrato, paisagem, largura estreita e texto ampliado não criam overflow;
   - alternância claro/escuro continua legível;
   - “Simular retorno de autenticação” mostra somente `synthetic-user-001`;
   - arquivo fictício mostra somente metadados e a mensagem de não persistência;
   - após publicar localmente um novo `CACHE_VERSION`, a interface oferece a
     atualização e só a aplica após ação do usuário;
   - DevTools/inspeção remota não mostra auth, Storage, prova, Pix ou pagamento
     dentro de Cache Storage.
6. Remova as duas instalações e encerre o servidor local.

O gate do smoke móvel só pode ser marcado como aprovado depois que essa evidência
física for anexada. Até lá, M0-B permanece bloqueado.
