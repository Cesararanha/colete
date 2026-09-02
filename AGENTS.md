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
- `docs/21-operacao-m1-a.md` — o que o marco atual já entregou de fato.
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
- **Nunca faça push direto em `main`** e nunca faça merge por conta própria.
  Todo trabalho entra por Pull Request.
- **Tabelas privadas de serviço nascem sem RLS**, por decisão registrada em
  `docs/14-convencoes-app.md` §5.2: a proteção vem de privilégios de schema, não
  de policies, porque `service_role` tem `BYPASSRLS`. Os testes afirmam isso
  explicitamente, como escolha. A regra **vale a partir da `0003`**, que é a
  migration em que ela foi escrita, depois do achado de fail-open do M0-B.
  `private.app_limits` e `private.allowed_proof_mime_types` nasceram antes disso,
  na `0002`, com `enable` + `force row level security` e zero policies. Elas são
  **dívida registrada na fatia 9** de `docs/16-roadmap.md` §3, não um
  contraexemplo da regra: migration commitada é imutável e a correção pertence à
  varredura final.
- **`service_role` não faz DML direto.** A `0004` revogou tudo em `public` e
  `private` e ajustou `alter default privileges`. Migrations novas não repetem
  a revogação — elas **provam** que as tabelas novas nascem sem privilégio.
- **Nenhum segredo no repositório.** Nenhuma chave HMAC no banco. Nenhuma PII,
  token, URL, path, Pix, nota ou motivo livre em coluna operacional, mensagem
  de erro ou log.

## 3. O manifesto de especificação

`docs/spec-manifest.sha256` é a baseline de **especificação**, não de tudo.

- **Estão no manifesto:** 22 entradas — `.gitignore`, `README.md`, os documentos
  normativos `docs/01` a `docs/18`, `docs/99-prompt-review.md` e
  `docs/99-prompt-review-externo.md`.
- **Ficam de fora, por decisão registrada:** os documentos operacionais
  `docs/19`, `docs/20` e `docs/21`, porque são registro do que aconteceu, não
  contrato congelado.

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
11. **Pare.** O merge é decisão humana.

## 5. Validação obrigatória antes de qualquer commit de fatia

```
npm run db:reset
npm run db:test
npm run db:test:idempotency
npm run verify:app
npm run scan:docs
npm run scan:secrets
npm run audit:high
git diff --check
```

Confirme também: o banco recria do zero somente pelas migrations; nenhum teste
deixou objeto ou registro residual; o worktree contém somente mudanças da
fatia; nenhum segredo no diff; nenhum serviço remoto foi acessado.

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

- qualquer decisão que altere um documento normativo (`docs/01`–`docs/18`);
- qualquer coisa que exija ampliar o escopo da fatia;
- qualquer falha de CI que você não entenda completamente;
- qualquer necessidade de segredo, projeto Supabase remoto, deploy ou push em
  `main`;
- qualquer divergência entre o que um documento normativo diz e o que o código
  faz — a divergência em si é o achado, e vale mais do que o conserto.
