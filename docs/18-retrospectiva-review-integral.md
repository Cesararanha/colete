# Colete — Retrospectiva da revisão integral (26–27/08/2026)

> **REGISTRO DE REVISÃO — NÃO É FONTE NORMATIVA.** As regras executáveis permanecem em
> `01`, `04` e `09`–`17`. Este arquivo explica por que a rodada anterior falhou e liga cada
> achado à correção canônica.

## 1. Por que bloqueadores passaram na revisão anterior

A falha foi metodológica e é atribuível à revisão, não à falta de clareza do pedido:

1. **Ancoragem nos 13 achados conhecidos.** A revisão verificou se os itens solicitados
   apareciam nos documentos, mas não reiniciou a modelagem do zero para procurar classes novas
   de falha.
2. **Consistência textual tratada como executabilidade.** Contar D/N/telas/erros, validar
   links/tabelas e encontrar uma descrição de lock/retention provou estrutura, não que o
   PostgreSQL ou serviços externos conseguissem realizar aquela descrição.
3. **Fronteira transacional não simulada.** Não foi desenhada a linha de commit da
   idempotência. Assim, “placeholder observável” e “mesma transação atômica” foram aceitos
   juntos, embora dependessem de visibilidade de escrita não commitada.
4. **FKs foram avaliadas isoladamente.** A revisão confirmou referências existentes sem
   montar a matriz adversarial grupo×racha×ciclo×prova×evento×disputa×caso; por isso não viu
   que IDs válidos separadamente formavam grafos cruzados inválidos.
5. **Auth/Storage foram abstraídos como banco.** Exclusão, URL assinada, ownership, JWT antigo,
   export e backup foram lidos como passos de uma operação, sem crash injection entre chamadas
   externas ou análise do bearer já emitido.
6. **Promessas de UX não foram reconstruídas como máquinas de estado.** Apelação, edição/
   desligamento de recorrência, contestação de nota, reentrada e draft de times tinham textos,
   mas não todas as entidades, transições, cardinalidades e operações.
7. **A validação mecânica produziu confiança excessiva.** O resultado “0 problemas” dizia
   respeito ao scanner executado; foi comunicado de modo amplo demais, como se cobrisse
   semântica transacional, integridade relacional e ciclo de vida externo.

## 2. Mudança obrigatória no método

Revisões seguintes precisam executar cinco passagens independentes antes de afirmar que a
especificação está pronta:

1. inventário e consistência mecânica;
2. reconstrução de cada máquina de estados;
3. matriz de integridade referencial com inserts cruzados;
4. linha de commit/crash injection para banco e cada serviço externo;
5. jornada ponta a ponta comparando requisito, schema, contrato, tela, notificação, retenção,
   teste e gate operacional.

“Descrito”, “garantido por constraint” e “testado” passam a ser estados diferentes. Ausência
de migration continua sendo “verificável apenas na especificação”, nunca prova executável.

## 3. Rastreabilidade dos achados

| Achado | Conclusão | Correção canônica |
|---|---|---|
| P1-01 idempotência contraditória | Procede | D46; `10` §9; `13` §0: uma transação, estado intermediário não commitável, sem lease/takeover; saga para externo |
| P1-02 canonicalização ausente | Procede | D47; JCS/RFC 8785, normalização v1, domínio por operação, versões e vetor dourado |
| P1-03 `join_match` inverte locks | Procede | D37; locks perfil→grupo→membership→racha e teste remoção×join |
| P1-04 convite irreconstruível | Procede | D49; `public_nonce`, `token_version`, encoding e HMAC por domínio em ambos os convites |
| P1-05 cancelamento sem evento | Procede | D62; `match_canceled` no enum/schema e exactly-once na transação |
| P1-06 apelação inexistente | Procede | D34; primeira instância, janela de 7 dias, apelação unique, caso e decisão final Admin |
| P1-07 recorrência incompleta | Procede | D24/D50; autoridade, versões, Pix separado, RPCs e corrida desligar×avançar |
| P1-08 prova fora do grupo do ciclo | Procede | D48; FKs compostas de grupo/racha/ciclo/sessão/prova |
| P1-09 disputa/caso fora do grafo | Procede | D48; FKs compostas até evento/disputa/apelação/caso e matriz service-role negativa |
| P1-10 bearer de evidência residual | Procede | D51; upload/stream Edge autenticado, sem signed URL/redirect/cache; limitação de cópia local explícita |
| P1-11 exclusão não atômica | Procede | D52; `deletion_requests`, `deletion_pending`, limpeza ownership, Auth retry e finalize |
| P1-12 export proibido pelo mapa | Procede | D53; `data_exports`, ZIP v1 allowlist, reauth, one-shot, 24 h e purge |
| P1-13 JSON incompleto | Procede | D61; inventário de todas as colunas JSON e scanner 1:1 no CI |
| P1-14 contestação de nota sem alvo | Procede | D54; FK para versão de `rating_history`, SLA/eventos e hold somente do alvo |
| P2-15 Pix sem tombstone | Procede | D60; segredos de racha/série `active\|purged`, cifra anulável e `purged_at` |
| P2-16 perda total de provas no backup | Procede | D44 revisada; prova finalizada válida entra cifrada, RPO/RTO 24 h sujeitos a aceite |
| P2-17 preferência contraditória | Procede | D55; preferência controla externo, sino sempre; N13 agrupa apenas deliveries externas |
| P2-18 retenção pai/delivery | Procede | D56; `notification_contents` 90 d separado do fato/delivery 12 m |
| P2-19 N26 sem alvo renderizável | Procede | payload exige `target_display_name` tipado e limitado |
| P2-20 mover cria tamanhos inválidos | Procede | D57; draft local pode ser inválido, commit final valida e audita `manual_move` |
| P2-21 própria nota contraditória | Procede | D58; titular sempre vê a própria durante retenção; política controla terceiros |
| P2-22 reentrada indefinida | Procede | D59; `removed→pending` só por novo convite/aprovação, sem banimento implícito |
| P2-23 baseline Git ausente | Procede e permanece gate operacional | `16` bloqueia primeira migration até commit/tag/checksum; esta revisão não cria commit sem autorização explícita |
| P3-24 históricos confundíveis | Procede | banners “HISTÓRICO/NÃO NORMATIVO” em `02`, `03`, `05`–`08` e “FERRAMENTA” em `99*` |

## 4. Falhas adicionais encontradas na correção

A nova passagem não ficou limitada ao relatório recebido. Ela encontrou e corrigiu mais dois
defeitos semânticos na própria proposta de remediação:

| ID interno | Defeito encontrado | Correção canônica |
|---|---|---|
| R-01 | O `on delete set null` de Auth violaria o `check` antigo de `profiles`, fazendo a saga de exclusão falhar antes da desidentificação | `profiles` agora distingue `active`, `deletion_pending` e `deleted`; o vínculo Auth só pode ficar nulo nos dois últimos, e a finalização é idempotente |
| R-02 | Cancelamento de ocorrência recorrente podia adquirir `match` antes de `recurrence`, invertendo a ordem usada pelo avanço da série | Todas as primitivas relacionadas travam `group→recurrence→match`; o teste concorrente `deactivate×advance` é gate |
| R-03 | D19 ainda prometia token curto de Storage, contrariando D51 e os contratos Edge | D19 agora envia bytes somente à Edge autenticada; nenhum token/path é entregue ao cliente |
| R-04 | O payload N28 aceitava só `open/responded/resolved` e não representava a nova máquina de apelação | N28 agora enumera todos os estados e tipos de atualização da disputa |
| R-05 | Templates estritos de N12, N25 e N27 usavam dia/ator/nome ausentes; N28 exigia disputa até para correção ou transferência sem disputa | Payloads ganharam campos renderizáveis e N28 virou união discriminada por tipo de atualização |
| R-06 | “Download one-shot” não dizia qual chamada simultânea vencia nem o que ocorria se a rede caísse | Row lock consome uma tentativa antes do stream; falha exige novo export e reconciliação garante purge |
| R-07 | A contestação apontava para o histórico, mas a nota atual não apontava para sua versão e a correção resolvida não guardava a nova versão | `ratings.current_history_id` e `corrected_rating_history_id` ganharam FKs compostas e trigger diferido |

## 5. Limite desta correção

Os documentos agora especificam os mecanismos, mas ainda não existem migrations, funções,
policies, jobs ou testes executáveis. Portanto:

- vetor/canonicalização podem ser verificados documentalmente;
- constraints e RLS só estarão garantidas quando migrations/pgTAP existirem;
- sagas só estarão garantidas após crash injection real;
- backup só conta após export diário e restore isolado;
- primeira migration continua bloqueada pelo gate de baseline Git e demais itens de `16`.

## 6. Evidência da validação final

Após as correções, scanners independentes confirmaram:

- 21 arquivos Markdown; links locais existentes, tabelas consistentes e fences balanceados;
- D1–D62 sem lacuna; N1–N28 exatamente uma vez no catálogo e uma no schema de payload;
- 25 telas numeradas; 108 erros no catálogo sem uso funcional órfão;
- 11 colunas físicas `json/jsonb`, todas presentes no mapa fechado;
- vetor HMAC idempotente reproduzido byte a byte;
- vetores v3 de `nextU64`, `nextInt`, shuffle e HMAC da entrada reproduzidos;
- rastreabilidade completa dos 24 achados externos e dos sete adicionais R-01–R-07.

Esses resultados provam consistência documental, não implementação. O Git continua sem commit
e o repositório continua sem migrations, código ou testes executáveis; portanto nenhum item
marcado como constraint, RLS, saga ou concorrência foi promovido indevidamente a “garantido”.
