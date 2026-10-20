# Instruções de execução — Colete

Este arquivo é lido automaticamente por agentes de IA que abrem este repositório.
Ele define **como trabalhar aqui**. Leia-o inteiro antes da primeira ação.

## 1. Descubra o estado antes de qualquer coisa

Nunca presuma onde o trabalho parou. Execute e leia:

```
git status --short --branch
git log --oneline --decorate -10
ls supabase/migrations/
gh pr list --state open
```

Depois leia, nesta ordem:

- `docs/16-roadmap.md` §3 — o mapa fatia→migration. É a fila de trabalho.
- `docs/25-plano-m2.md` — o plano normativo do M2: fatias, ordem de locks,
  critérios de saída, decisões M2-D* e gates humanos.
- `docs/26-operacao-m2.md` — o que cada fatia do M2 entregou de fato, com os
  números medidos e as contraprovas.
- `docs/23-operacao-m1-b.md` — o que o M1-B entregou de fato, com os defeitos
  achados depois de cada fatia.
- `docs/22-plano-m1-b.md` — o plano normativo do M1-B, base da saga de exclusão,
  do worker e do export que o M2 estende.
- `docs/21-operacao-m1-a.md` — o que o M1-A entregou de fato.
- `docs/19-operacao-m0-a.md` e `docs/20-operacao-m0-b.md` — marcos anteriores.

A verdade sobre o estado está no git e nesses documentos, nunca na memória de
uma conversa anterior.

## 2. Regras invioláveis

- **Migrations são imutáveis depois de commitadas.** Todo estado novo entra na
  próxima migration numerada. Nunca edite `0001`–`000N` já entregues.
- **Não altere requisitos nem as decisões D1–D62** (`docs/09-pivo-produto.md`).
- **O banco recria do zero somente por migrations.** Nada de alteração manual
  via Studio, DBeaver ou psql que precise sobreviver a um `db:reset`.
- **Uma fatia por vez.** O escopo de cada fatia está em `docs/16-roadmap.md` §3.
  Se concluir a fatia atual exigir decidir algo de outra fatia, **pare e
  reporte o bloqueio** em vez de ampliar o escopo.
- **Nunca faça push direto em `main`.** Todo trabalho entra por Pull Request.
  Sobre quando você pode mergear, veja §4.11.
- **Tabelas privadas de serviço nascem sem RLS**, por decisão registrada em
  `docs/14-convencoes-app.md` §5.2: a proteção vem de privilégios de schema, não
  de policies, porque `service_role` tem `BYPASSRLS`. Os testes afirmam isso
  explicitamente, como escolha. A regra **vale a partir da `0003`**, que é a
  migration em que ela foi escrita, depois do achado de fail-open do M0-B.
  `private.app_limits` e `private.allowed_proof_mime_types` nasceram antes disso,
  na `0002`, com `enable` + `force row level security` e zero policies. Elas são
  o caso histórico que motivou a dívida registrada na fatia 9 de
  `docs/16-roadmap.md` §3, não um contraexemplo da regra: migration commitada é
  imutável, e a `0008` saldou a dívida de forma append-only, removendo `force` e
  desligando RLS nas duas tabelas.
- **`service_role` não faz DML direto.** A `0004` revogou tudo em `public` e
  `private` e ajustou `alter default privileges`. Migrations novas não repetem
  a revogação — elas **provam** que as tabelas novas nascem sem privilégio.
- **Asserção que nunca commita não prova trigger diferido.** Constraint
  `DEFERRABLE` e qualquer garantia que dispare no commit precisam de teste que
  commite de verdade sob o papel relevante.
- **Asserção que também passaria com o comportamento errado não prova nada.**
  Antes de aceitar um teste, faça a contraprova mental ou executável: ele precisa
  falhar com a implementação defeituosa. Dois casos reais deste projeto são o
  trigger diferido escondido pelo rollback automático do pgTAP e o escopo global
  do logout escondido pela vida ainda válida do access token em outra sessão.
- **Nenhum segredo no repositório.** Nenhuma chave HMAC no banco. Nenhuma PII,
  token, URL, path, Pix, nota ou motivo livre em coluna operacional, mensagem
  de erro ou log.

## 3. O manifesto de especificação

`docs/spec-manifest.sha256` é a baseline de **especificação**, não de tudo.

- **Estão no manifesto:** 24 entradas — `.gitignore`, `README.md`, os documentos
  normativos `docs/01` a `docs/18`, os planos normativos `docs/22` e `docs/25`,
  `docs/99-prompt-review.md` e `docs/99-prompt-review-externo.md`.
- **Ficam de fora, por decisão registrada:** os documentos operacionais
  `docs/19`, `docs/20`, `docs/21`, `docs/23` e `docs/26`, porque são registro
  do que aconteceu, não contrato congelado; `docs/24`, registro de entrega
  acadêmica que vive fora de `main`; e `docs/27`, mapa operacional da D63.

Se você alterar um arquivo que está no manifesto, recalcule o checksum dele.
`npm run scan:docs` é o teste disso e precisa passar.

## 4. Protocolo de uma fatia

1. `git checkout main && git pull` — comece sempre de `main` atualizada.
2. Crie uma branch nomeada pela fatia, por exemplo
   `feat/m1-a-operational-runs`.
3. Leia os documentos normativos que a fatia toca **antes** de escrever
   qualquer linha. Não comece pelo formato do arquivo; comece pelo contrato.
4. Implemente somente a fatia.
5. Escreva os testes pgTAP na mesma fatia. Um teste que passa por causa de
   `BYPASSRLS` do papel `postgres` não prova nada — use papel-sonda negativo.
6. Rode a validação completa (seção 5).
7. Atualize a documentação operacional do marco com **números reais medidos**,
   nunca estimados nem copiados de execução anterior.
8. Um único commit, mensagem no imperativo, sem escopo além da fatia.
9. `git push -u origin <branch>` e abra um **Pull Request draft**.
10. Espere os cinco jobs da CI e reporte o status de cada um.
11. **Política de merge.**
    - Você pode mergear um Pull Request produzido por outra sessão depois de revisá-lo
      criticamente contra os documentos normativos e confirmar que os cinco jobs da CI
      estão verdes. Pull Requests do Dependabot contam como trabalho de outra parte.
    - Você nunca mergeia um Pull Request que escreveu nesta mesma sessão: deixe-o em draft
      para revisão independente.
    - Mesmo escrito por outra sessão, todo Pull Request que altera `docs/01`–`docs/18`,
      `docs/22`, `docs/25` ou
      depende de uma decisão que você não pôde tomar deve parar para decisão humana.
    - A separação é deliberada: quem escreve já concluiu que o trabalho está certo, e todos
      os defeitos encontrados neste projeto foram descobertos por uma sessão diferente da
      que escreveu o código.

### 4.12 Cerimônia de revisão por risco (D63, generalização da M2-D41)

Classifique a fatia pelo que ela **toca**, inclusive leitura, escrita, projeção,
transporte e migração de vaga/capacidade/fila, dinheiro/ledger/Pix,
login/sessão/credencial ou dado pessoal/LGPD. Segredo é objeto protegido,
não uma quinta classe de risco. PR só de documentos que altera contratos
desses domínios recebe a mesma classificação. Essas classes são risco alto. Para qualquer
uma dessas classes, faça uma revisão completa por sessão independente e, se
houver correção a conferir, uma conferência no fluxo normal: até duas rodadas.
Se a conferência encontrar um P1 novo, há uma rodada extra de correção e uma
conferência restrita a esse P1; P2 e P3 de documento podem ser conferidos pelo
planejador direto no repositório.
Fatia que não toca nenhuma dessas classes recebe uma revisão. Achado que
cruza a fronteira reclassifica a fatia. Quem escreve corrige os achados; quem
revisa não corrige a própria revisão. Preserve contraprovas, suíte e gates da
fatia: reduzir rodadas não reduz a prova necessária. Cerimônias de fatias já
entregues não são refeitas retroativamente.

**Prática recomendada:** Codex como autor e Claude Code como revisor, em
sessões distintas. Outras combinações independentes são válidas. A separação
autor/revisor e a política de merge do §4.11 continuam obrigatórias.

## 5. Validação obrigatória antes de qualquer commit de fatia

```
npm run db:reset
npm run db:test
npm run db:test:idempotency
npm run db:test:gateway
npm run db:test:cors
npm run db:test:worker
npm run db:test:deletion
npm run db:test:export
npm run db:test:invites
npm run db:test:groups
npm run db:test:membership
npm run db:test:rename
npm run db:test:group-deletion
npm run db:test:photos
npm run db:test:members
npm run db:test:matches
npm run db:test:match-players
npm run db:test:ratings
npm run db:test:geocode
npm run build:web:auth-e2e && npm run test:auth:web && npm run test:privacy:web
npm run test:cors:web
npm run test:groups:web # UI-A, UI-B e ajustes do teste: Auth, Edge e Postgres locais reais
npm run test:matches:web # Rachas v1, Racha completo e usabilidade: Agenda, modal, busca de endereço, distância, presença, espera e pagamento
npm run test:qr:web # QR real com câmera simulada, Chromium e WebKit
npm run build:web:smoke && npm run test:smoke:web
npm run verify:app
npm run scan:docs
npm run scan:secrets
npm run test:audit
npm run test:staging
npm run audit:high
git diff --check
```

**Auditoria de dependências — decisão humana de 07/10/2026.** `audit:high`
é obrigatório e precisa terminar com exit 0 quando a fatia altera, em qualquer
pasta, `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `.npmrc`,
`.nvmrc`, `.node-version`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `deno.json`,
`deno.jsonc`, `import_map.json`, `deno.lock`, `audit-exceptions.json`,
`scripts/audit-high.mjs`, `scripts/test-audit-high.mjs`, `scripts/audit-needed.mjs`,
`scripts/test-audit-needed.mjs`, `scripts/fixtures/audit-*`, `patches/**`,
`.github/workflows/**` ou `.github/actions/**`. Os nomes de arquivo valem em
qualquer pasta; os caminhos estruturados também valem sob subpastas.
A comparação usa o caminho inteiro em minúsculas. Link simbólico protegido no
head (inclusive herdado ou apontando para fora), ou diferença/árvore indisponível
exige auditoria. Pela decisão humana de 09/10/2026, PR com base diferente de
`main` reprova `Repository guardrails`; a guarda fica somente no workflow.
O workflow executa somente a cópia do seletor do SHA da base do evento; se ela
não existir ou não puder ser obtida, exige auditoria sem executar o seletor do PR.
São detalhes de 08/10/2026, ajustados pela decisão humana de 09/10/2026,
da decisão de 07/10/2026. Os limites aceitos estão em `docs/23`.
Nos demais casos, execute o comando e relate o resultado, mas um alerta de
auditoria não bloqueia a fatia. `test:audit` roda sempre.
Na CI, os cinco jobs continuam em todo PR; somente o passo de `audit:high`
é condicional. O procedimento diário, a rodada quinzenal e as exceções datadas
estão em `docs/23`.

Todo harness novo de fatia entra no `package.json`, neste bloco e no job
`database-security` do workflow no mesmo commit que o cria.

Confirme também: o banco recria do zero somente pelas migrations; nenhum teste
deixou objeto ou registro residual; o worktree contém somente mudanças da
fatia; nenhum segredo no diff; nenhum projeto Supabase remoto, deploy ou serviço
de produção foi acessado.

**O que "remoto" proíbe, e o que não proíbe.** A regra protege contra projeto
Supabase remoto, deploy, segredo real e qualquer serviço de produção. Ela não
proíbe o registry público de pacotes nem o GitHub: o `npm run audit:high` desta
mesma seção não tem modo offline, e a §4.9 e a §4.10 exigem publicar a branch e
acompanhar a CI. Baixar imagem Docker fixada, consultar o registry para auditoria
e publicar branch ou ler CI são parte do fluxo normal de uma fatia. O que
continua proibido está enumerado na §8.

## 6. Se você for interrompido no meio de uma fatia

Esta é a regra mais importante deste arquivo. Trabalho não commitado é trabalho
perdido — já aconteceu neste projeto e custou uma sessão inteira.

**Commite e publique cedo, mesmo incompleto.** Numa branch de fatia, ninguém
depende do seu histórico intermediário.

Se perceber que vai parar antes de terminar (limite de tokens, erro que não
consegue resolver, bloqueio de escopo):

1. `git add -A`
2. Commite com prefixo `wip:` e uma mensagem que diga **o que falta**, não o
   que foi feito. Exemplo:
   `wip: 0005 tables done, summary validator and JSON census pending`
3. `git push -u origin <branch>`
4. Reporte, em texto: o que está pronto, o que falta, qual foi o último comando
   que rodou e com que resultado, e qual decisão você não conseguiu tomar.

Um `wip:` publicado é recuperável por qualquer agente. Um worktree sujo numa
máquina não é.

## 7. Se você está retomando trabalho de outro agente

1. Execute a seção 1.
2. Se existir branch com commit `wip:`, leia a mensagem dele — ela diz o que
   falta.
3. Se o worktree estiver sujo, **não recomece do zero**. Leia o diff, entenda o
   que já existe e continue de onde está.
4. Rode a validação da seção 5 antes de acreditar em qualquer coisa. O relato
   da sessão anterior pode estar desatualizado; a suíte, não.
5. Antes de fechar a fatia, apague os commits `wip:` refazendo o histórico num
   único commit limpo (`git reset --soft` até a base e commite de novo).

## 8. Quando parar e perguntar

Pare e reporte, sem tentar resolver sozinho:

- qualquer decisão que altere um documento normativo (`docs/01`–`docs/18`, `docs/22`
  ou `docs/25`);
- qualquer coisa que exija ampliar o escopo da fatia;
- qualquer falha de CI que você não entenda completamente;
- qualquer necessidade de segredo, projeto Supabase remoto, deploy ou push em
  `main`;
- qualquer divergência entre o que um documento normativo diz e o que o código
  faz — a divergência em si é o achado, e vale mais do que o conserto.

A auditoria local segue §5: quando a fatia não altera os arquivos ali listados,
um alerta de `audit:high` é relatado e não exige parar. Quando altera, exit 0
continua obrigatório; alerta novo ou exceção que dependa de decisão humana
segue este gate. A execução diária segue o procedimento de `docs/23`:
critical no mesmo dia; high na rodada quinzenal.
