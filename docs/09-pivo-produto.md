# Colete — Pivô de produto e registro de decisões (25/08/2026; D63 em 29/09/2026)

**Decisão de César em 25/08:** o projeto deixa de ser entrega de faculdade neste momento.
Prazos acadêmicos e pesquisa de UX saem do caminho crítico. O objetivo agora é
**produto real**: rodar no grupo de amigos e, se der certo, vender a ideia no futuro.
**Acessibilidade continua requisito de primeira classe** (reafirmado duas vezes).

As decisões abaixo já estão **consolidadas** em `01-requisitos.md` e
`04-algoritmo-sorteio.md` (algoritmo v3). Este documento é o registro de por quê.

---

## Decisões consolidadas

| # | Decisão |
|---|---|
| D1 | **Faculdade fora do escopo por ora** — critérios do professor e entregáveis de UX deixam de guiar o projeto. |
| D2 | **Recorrência:** próximo racha nasce quando o atual atinge estado **terminal** (`realizado` OU `cancelado`). |
| D3 | **Mensalista × trava de valor:** pagamento presumido **não** trava o valor; só o primeiro pagamento **real** aprovado trava. |
| D4 | **Mensalista é opcional por grupo** (toggle, padrão desligado). |
| D5 | **Sorteio e trilha rodam server-side** (Edge Function + commit transacional por revisão; sem estimativa artificial de um dia). |
| D6 | **"5 grupos ativos"** = cinco memberships ativas em grupos não arquivados; grupo próprio conta, pendente não. Transferência excepcional pelo Admin é logada. |
| D7 | **Trilha × nota privada:** trilha registra *que* houve alteração, nunca os valores. Ela torna operações observáveis, mas não é prova pública da correção da nota nem permite reproduzir o sorteio sem expor dado pessoal. |
| D8 | **Goleiro — modelo único:** goleiro pertence ao gol, **nunca entra no sorteio**. Organizador cria a lista de goleiros com a quantidade que quiser e define **se goleiro paga e quanto** (pode diferir da linha). Modo Sorteado removido. Campo "Sou goleiro" removido do perfil (não tinha função). Nota de goleiro opcional, nunca trava sorteio. |
| D9 | **Posições não entram no sorteio na v1** — posição preferida é informativa (aparece no cartão do time). Balanceamento por posição: possível v2, como restrição suave. |
| D10 | **Ciclo da lista T0/T1/T2 aprovado**, com horários editáveis **só antes do respectivo marker** e UX simples: tempos relativos ao jogo, padrões T1 = 3h/T2 = 1h, promovido = 30 min, ajuste fino recolhido e frase-resumo. O jogador só vê prazo absoluto + contagem. |
| D11 | **Análise tem SLA de 2h, mas nunca expira antes de T1:** deadline = `max(finalização+2h, T1)`. Ao expirar, jogador entra no tier prioritário com prova pendente; decisão é humana e aprovação tardia nunca desaloja starter válido. |
| D12 | **Vínculo de identidade é explícito:** no beta, Google só é ligado dentro de sessão recente e conflito de e-mail nunca mescla perfis silenciosamente. Apple e o caso Hide My Email ficam para a fase nativa, com o mesmo princípio. |
| D13 | **Notificações por outbox multi-canal:** tabela `notifications` + Edge Function despachante → Web Push (VAPID) no PWA, Expo Push nos builds nativos futuros, sino in-app sempre, e-mail nos eventos críticos. iOS: push só com PWA instalado (16.4+) → onboarding com prompt de instalação. |
| D14 | **Comprovante não promete antifraude no beta:** sem IA/OCR ou selo “dados conferem”. O SHA-256 bruto existe apenas durante a finalização; o banco guarda um fingerprint HMAC versionado e separado por grupo, usado só para devolver `duplicate_signal`. Verificação real exige Pix dinâmico via PSP/webhook em fase futura. |
| D15 | **Auth no iOS PWA:** verificação por **código OTP digitável**, não por link. O PWA não depende de estado criado no Safari para concluir a confirmação. |
| D16 | **T0 tem um significado único:** T0 é a abertura geral. Se houver prioridade mensalista, `priority_opens_at = T0 − janela`; a fase de inscrições começa nesse instante, mas não-mensalistas só entram em T0. |
| D17 | **Pós-T1 não existe “pague e torça”:** a vaga é reservada antes de abrir o banco. Reserva promovido mantém 30 min; vaga sem fila usa `claim_open_slot`, com reserva de 10 min. Adição comum de membro só ocorre após T2; convidado avulso é exceção auditada e limitada à capacidade. O texto “pagar garante” foi removido. |
| D18 | **Fila tem estado próprio:** `joined_at` é histórico; ordem usa `queue_tier + queue_seq`. Demovido em T1 recebe nova sequência no fim; comprovante expirado recebe prioridade de análise sem expulsar titular válido. |
| D19 | **Upload é sessão em duas etapas:** servidor cria sessão/caminho estável; o cliente envia os bytes à Edge autenticada, que revalida a sessão e escreve no Storage sem devolver token/path; depois o servidor finaliza. Objetos órfãos expiram. OCR saiu do beta; fingerprint é sinal, nunca prova. |
| D20 | **Idempotência explícita:** toda mutação iniciada por usuário recebe `request_id`; mutações de banco usam uma única transação e uma chave única adquirida antes do domínio. O registro intermediário nunca é commitado nem observável: concorrentes esperam o vencedor e leem `completed`, ou o primeiro rollback permite que outro execute. A resposta segura dura 30 dias, o HMAC/tombstone 24 meses e credenciais/projeções sensíveis são sempre reconstruídas após autorização. Efeitos externos usam saga/outbox própria, nunca lease da mutação. |
| D21 | **Pagamento é ledger:** “a devolver” e “devolvido” são fatos diferentes. Preço só destrava após todos constarem `refunded`; isso é declaração auditada do organizador, não confirmação bancária, e o jogador pode contestar. |
| D22 | **Identidade histórica desacoplada do Auth:** `profiles.id` é interno; `auth_user_id` pode virar `null` após exclusão. Assim o Auth é apagado e o histórico pode ser desidentificado sem quebrar FKs. |
| D23 | **Notas privadas não ficam em tabelas públicas:** resultado do sorteio e snapshots de estrela são privados; participantes recebem views sem nota. RLS é default-deny e tabelas críticas não aceitam escrita direta. |
| D24 | **Recorrência exatamente uma vez:** ocorrência tem chave determinística única; série, regra, template e configuração Pix são versionados. Avanço trava e revalida `active`, versão e segredo; desligar concorrentemente também cancela a ocorrência futura ainda intocada, de modo que o estado final não deixa geração inesperada. |
| D25 | **Uma fonte de titularidade:** `groups.owner_id` é a autoridade; `group_members.role` contém apenas `organizer` e `player`. Ações excepcionais do Admin entram em log global append-only. |
| D26 | **Beta PWA cabe no orçamento:** SMTP externo é dependência de M0/M1. Login Apple e vínculo Apple ficam para a fase nativa/lojas; Google e e-mail permanecem no beta. Vercel Hobby só no uso pessoal, nunca na operação comercial. |
| D27 | **Notificação é at-least-once:** outbox tem `dedupe_key` única e entregas separadas por destino/canal (inclusive cada dispositivo). Preferência é por evento agrupado em categoria; eventos transacionais declarados obrigatórios não podem ser desligados. |
| D28 | **Algoritmo v3:** para N≤12, busca exata; acima disso, partições realmente aleatórias + busca local com trocas 1↔1 e 2↔2. Score inclui dispersão de todas as médias; PRNG e versão são registrados. |
| D29 | **Operação temporal recuperável:** cron é o acionador normal, mas toda transição é reconciliável e idempotente; há ledger de execução, alerta de atraso e ação segura “Reconciliar agora”. |
| D30 | **Chave Pix trava em T0:** depois da abertura geral não muda. BR Code guarda nome e cidade do recebedor; correção pós-T0 exige cancelar e criar outro racha. |
| D31 | **Goleiro isento tem estado explícito:** ciclo `payment_cycles.status='exempt'`, projetado como `payment_status='exempt'`; nunca bloqueia sorteio. |
| D32 | **Governança LGPD entra antes do beta:** aceite versionado, canal do titular, papéis de controlador/operador, retenção por categoria, resposta a incidente e contestação de nota. |
| D33 | **Ciclo é a autoridade financeira:** cada versão de preço cria `payment_cycle`; exatamente uma resolução aceita (`proof_approved` ou `marked_paid`) pode existir por ciclo. Prova em análise e resolução externa são encerradas atomicamente, nunca coexistem como pagamentos aceitos. |
| D34 | **Contestação financeira é entidade de primeira classe:** aponta por FKs compostas para ciclo e evento do mesmo grupo/racha, tem contraditório, SLA, trilha append-only, decisão de primeira instância e uma apelação do autor em sete dias. O preço fica travado durante a janela e a apelação; decisão final administrativa encerra o fluxo. |
| D35 | **Ausência da autoridade não abandona finanças:** suspensão urgente revoga sessões depois de transferir casos a organizador ativo elegível; se não houver, abre caso administrativo explícito. Admin recebe acesso mínimo, temporário e auditado ao caso, sem virar membro nem navegar o grupo. |
| D36 | **Exclusão voluntária preserva contraditório:** pedido fica bloqueado quando a pessoa é autoridade ou parte indispensável de caso financeiro aberto e não há substituto/canal seguro. Havendo substituto, a transferência precede a desidentificação. |
| D37 | **Locks têm ordem global:** idempotência transacional → perfis → grupos → memberships → recorrências → rachas → convites → participantes/claims → ciclos → sessões/provas → resoluções/estornos/contestações/casos; lotes usam UUID crescente. `join_match` segue a ordem inteira e revalida membership sob lock. Cotas de 5/100 e usos de convite são revalidados sob o lock-pai. |
| D38 | **Retenção tem mapa físico canônico:** `17-mapa-dados-lgpd.md` inventaria campos, propósito, hipótese de base legal, papéis, acesso, armazenamento, derivados, evento de retenção, purge, exceções e backup. Binário/fingerprint não ganham extensão por disputa. |
| D39 | **Sorteio separa composição de nota:** entrada, seed, HMAC, score e snapshots privados expiram em 12 meses; a composição publicada continua sem estrelas. JSON não cria categoria de dado fora do mapa. |
| D40 | **Mudança temporal recompõe derivados, não o passado:** uma matriz normativa define T1/T2/início/fim/local/preço, claims, provas, purge e markers. Jobs antigos viram `skipped_stale`; notificação já enviada permanece e mudança material gera N14. |
| D41 | **Algoritmo v3 é especificação binária:** UUID, enumeração, movimentos, empates, `nextInt`, xoshiro256**, endianness, larguras, HMAC, `canonical_key` e score racional têm regra única e vetores dourados. |
| D42 | **Desempenho do sorteio é gate, não promessa:** ramo exato usa reservoir sampling sem guardar todos os ótimos; heurística usa orçamento determinístico versionado. Timeout de parede falha sem persistir resultado e o beta depende de benchmark adversarial. |
| D43 | **Auditoria pública é tipada:** cada evento tem allowlist de chaves, tipos e limites; campo desconhecido ou sensível é rejeitado por validador central. Cliente nunca fornece `public_payload` arbitrário. |
| D44 | **Backup é conjunto verificável:** roles, schema, dados, histórico de migrations, configuração e Storage têm artefatos/manifesto distintos, cifrados e testados por restore. Fotos e comprovantes finalizados ainda dentro de `purge_after` entram; órfãos não. O RPO documental de comprovante é 24 h e precisa de aceite antes do beta; restore descarta tudo que já venceu e reaplica exclusões antes de liberar tráfego. |
| D45 | **N1 e N13 são simples e fixas:** N1 ocorre em T0−30 min. N13 sempre gera dois fatos in-app — 20h do dia anterior no fuso e 3h antes; o único toggle controla em conjunto as duas entregas externas, sem escolha parcial. |
| D46 | **Idempotência de banco é uma transação, não uma lease:** `executing_uncommitted` só existe dentro da transação vencedora e um trigger diferido impede seu commit. `ON CONFLICT` faz o concorrente aguardar; após o commit ele compara o HMAC e reproduz o outcome. Crash elimina placeholder e efeito juntos. |
| D47 | **Hash idempotente tem canonicalização v1:** entrada normalizada por schema usa NFC, UUID minúsculo, timestamp UTC com seis casas, dinheiro decimal em string e JSON JCS/RFC 8785; ausência difere de `null`. HMAC separa domínio por operação e persiste `canonical_version` e `hash_key_version`, com vetores dourados comuns. |
| D48 | **Escopo financeiro é integridade referencial, não convenção de RPC:** ciclo, prova, sessão, resolução, evento, disputa, apelação e caso carregam grupo/racha e se ligam por FKs compostas. Mesmo `service_role` não consegue formar grafo cruzado. |
| D49 | **Convite recompartilhável guarda apenas material público:** convite de grupo e de racha persistem `public_nonce` aleatório e `token_version`; o cofre guarda a chave HMAC. Token é reconstruível por ID+versão+nonce, enquanto dump sem o cofre não cria token válido. Rotação troca nonce/versão/digest. |
| D50 | **Recorrência tem autoridade explícita:** somente dono/organizador ativo edita ou liga/desliga; mudanças incrementam a versão e afetam apenas ocorrências ainda não materializadas. O próximo racha copia um snapshot da regra/template/Pix sob lock e registra a versão de origem. |
| D51 | **Comprovante não usa bearer assinado no cliente:** upload e leitura passam por endpoints Edge autenticados que revalidam sessão, ciclo, claim e autoridade em cada requisição. Leitura faz streaming sem redirect, com `private, no-store`; perda de autorização corta novas leituras, ressalvada cópia já baixada fora do controle do serviço. |
| D52 | **Exclusão de conta é saga recuperável:** a transação inicial cria `deletion_request`, transfere autoridade e marca `deletion_pending`, bloqueando imediatamente qualquer RPC/RLS mesmo com JWT antigo. Worker limpa ownership/Storage, apaga Auth com retry e só então finaliza desidentificação em `deleted`; o estado intermediário admite o `on delete set null` e crash em qualquer fronteira é retomável. |
| D53 | **Exportação do titular é dado governado:** `data_exports` enumera estado, conteúdo permitido, bucket privado, digest, expiração de 24 h e purge. Download autenticado é one-shot/sem cache; exclusão cancela e remove export pendente antes da saga Auth. |
| D54 | **Contestação de nota aponta para uma versão concreta:** `rating_disputes` referencia por FK composta o `rating_history` do próprio titular, possui resposta, SLA, escalonamento, resolução e eventos append-only. O purge suspende somente a versão alvo. |
| D55 | **Preferência opcional controla entrega externa, não o registro in-app:** todo evento lógico continua no sino. Desligar um tipo suprime push/e-mail futuros; para N13 o único boolean suprime as duas entregas externas, sem subtoggle. A UI diz “Alertas externos”, não promete apagar a Central. |
| D56 | **Conteúdo e metadado de notificação têm retenções independentes:** `notifications` guarda fato mínimo e `notification_contents` guarda payload tipado por 90 dias; deliveries podem ficar 12 meses sem FK quebrada nem payload `{}` inválido. |
| D57 | **Ajuste manual é rascunho validado no commit:** “Mover para time” altera apenas um draft local, que pode ficar temporariamente inválido e anuncia o erro. `publish_draw` aceita somente conjunto/tamanhos finais válidos e registra `manual_move` por participante; nenhum estado intermediário chega ao banco. |
| D58 | **O titular sempre vê a própria nota:** `get_my_rating` independe de `ratings_visibility` e continua acessível após remoção durante a retenção aplicável. A política `private\|members` controla apenas a visão dos demais membros ativos. |
| D59 | **Remoção não é banimento na v1:** membership `removed` pode voltar a `pending` somente por novo resgate válido, com aprovação nova, papel `player` e mensalista desligado. Não existe reativação silenciosa nem bloqueio permanente implícito; rate limit protege contra abuso. |
| D60 | **Pix possui estado de expurgo próprio:** segredo de racha e segredo de série recorrente ficam em tabelas separadas, com `active\|purged`, campos cifrados anuláveis e `purged_at`; o racha continua íntegro após apagar a cifra. Série ativa preserva sua configuração apenas para materializar ocorrências futuras. |
| D61 | **JSON é registro fechado e exaustivo:** todas as colunas JSON físicas — inclusive `private_result` e credenciais push — aparecem no mapa com schema, tamanho, acesso e retenção. Migration falha no teste de inventário se surgir coluna JSON sem validador registrado. |
| D62 | **Cancelamento tem evento tipado real:** `match_canceled` faz parte do enum da auditoria, usa apenas `reason_code` público fechado e é criado exatamente uma vez na transação do cancelamento; nota livre permanece privada. |

## Algoritmo v3 — resumo

Comparação **lexicográfica** (diferença de médias → dispersão de todas as médias → proporção
de craques → proporção de fracos). N≤12 usa busca exata; N maior usa um início serpentina
mais partições balanceadas realmente aleatórias, busca local 1↔1 e 2↔2 e escolha aleatória
entre os melhores resultados deduplicados. **Versão, PRNG, semente e HMAC** entram no
registro técnico privado; a trilha pública recebe só versão e identificador opaco.
Times de tamanho desigual são permitidos apenas com aviso explícito: média compara força por
jogador, não compensa jogar com uma pessoa a menos. Especificação completa em
`04-algoritmo-sorteio.md`.

## Em aberto

1. **Design e layout** — a definir (agora sem prazo externo).
2. Padrões de T1/T2, reserva aberta de 10 min e prazo do promovido — validar no uso real.
3. Ordem de construção da v1 (mantida): auth → grupos → racha → lista atômica →
   pagamento → estrelas → sorteio.

## D63 — piloto mínimo e evolução incremental (decisão de César em 29/09/2026)

A D63 acrescenta uma decisão de **sequenciamento** às D1–D62, que permanecem
íntegras. O objetivo é um app funcional que evolui: primeiro um piloto com um
grupo de amigos; depois, a expansão. O mapa item a item e as perguntas ainda
abertas estão em `27-piloto-minimo.md`. “Pós-piloto” conserva a especificação;
não autoriza remover contratos, invariantes de segurança, acessibilidade ou
proteção de dados das funções que efetivamente entrarem no piloto.

1. **Ciclo do piloto:** criar grupo → convidar por link → criar racha → lista
   com vaga atômica e fila → organizador marcar à mão quem pagou, pelo contrato
   `mark_paid` → sortear e publicar os times. O app é a autoridade para vaga e
   para o registro manual de pagamento; WhatsApp comunica os avisos no piloto.
2. **Depois do piloto, com especificação preservada:** apelação financeira,
   caso Admin, contestação de nota, upload de comprovante e notificações
   externas (push e e-mail). O piloto não transforma pagamento manual em
   confirmação bancária nem altera o ledger de resolução única por ciclo.
3. **Revisão por risco, generalizando M2-D41 do plano do M2:** fatia que toca
   vaga, dinheiro, login ou dado pessoal recebe uma revisão completa e, se
   necessária, no máximo uma conferência (até duas rodadas); as demais recebem
   uma revisão. Autor e revisor são pessoas/sessões distintas; o revisor aponta
   achados e o autor corrige. A cerimônia histórica já executada não é refeita.
4. **Staging hospedado:** entra depois do M2, antes do primeiro piloto. A
   decisão não autoriza deploy nem acesso ao projeto Supabase remoto nesta PR.
5. **Antes do M3:** trocar a cadeia de validadores de idempotência, hoje
   renomeados e redefinidos a cada fatia com um `CHECK` que enumera operações,
   por um registro de operações em tabela lido por um validador estável. A
   fatia própria deve preservar os outcomes fechados, os vetores e a fronteira
   de privilégios; este documento não especifica migration nem implementação.

Respostas humanas de 30/09/2026, parte da D63:

- **D63-A — sorteio.** No piloto, o organizador atribui uma nota a cada jogador de linha e o app distribui em serpentina: 1º no time A, 2º e 3º no B, 4º e 5º no A, e assim por diante. Goleiros continuam fora do sorteio conforme `01`. O resultado do sorteio é guardado e reproduzível; a sequência A/B ilustra dois times, sem decidir o número de times nem o formato de persistência. A v3 de `04` é evolução preservada. **Antes do marco do sorteio**, especificar empate de notas, número de times, seed, persistência e versão do algoritmo simples; esta decisão não inventa essas regras.
- **D63-B — comunicação.** Nenhuma notificação dentro do app no piloto. Lista, fila e posição exibem o estado atual; WhatsApp leva os avisos humanos. Sino in-app é evolução.
- **D63-C — observabilidade.** Sentry sai da promessa do piloto. Instalação com filtro de dados pessoais é obrigatória antes da abertura pública.
- **D63-D — abertura pública.** Apelação financeira, caso Admin e contestação de nota são obrigatórios antes do público, assim como rotação de chave, limitador por IP e Sentry. Comprovante, push/e-mail, sino, Pix no app, Google, recorrência, mensalistas e v3 são evolução. Gates de segurança, LGPD e M2 já decididos continuam válidos.
- **D63-D (extensão, decisão do planejador em 30/09/2026).** A primeira instância financeira (`open_financial_dispute`, `respond_financial_dispute`, `resolve_financial_dispute_first_instance`) integra a apelação financeira: pós-piloto e obrigatória antes da abertura pública. As intervenções `set_group_suspension`, `set_profile_access` e `admin_transfer_ownership` integram o caso Admin: pós-piloto e obrigatórias antes da abertura pública. N27 é o aviso de abertura de contestação financeira (`12` §8; `13` §2.10), portanto acompanha a disputa e também é obrigatório antes da abertura pública. Isto fecha as sete perguntas de escopo do mapa `27`; as especificações técnicas pré-marco continuam pendentes.
- **D63-D (correção em 30/09/2026).** `transfer_financial_authority` integra o piloto no M5 para sustentar a exclusão de conta com pagamentos marcados. N26 e N28 acompanham as funcionalidades Admin e financeiras que os emitem, respectivamente: pós-piloto, obrigatórios antes da abertura pública.
- **D63-E — racha.** Cancelar e editar racha entram no piloto. Pagamento marcado que deva ser devolvido recebe marcação manual «a devolver» e depois «devolvido», sem alegar confirmação bancária. `13` §§2.6.1–2.9 e 3.2–3.3 governam ledger, estorno, locks e invalidação; recorrência é evolução. Antes do marco de racha/pagamento, especificar qualquer adaptação do fluxo publicado ou com pagamento marcado que `13` não cubra, sem liberar mudança de preço/Pix, reabertura de prazo ou publicação inconsistente por inferência.
- **D63-F — participantes.** O próprio jogador entra e sai; o organizador adiciona e remove manualmente segundo `13` §1.6. Convite avulso de quem não pertence ao grupo é evolução.
- **D63-G — pagamento.** O acerto é externo; o app mostra «pague ao organizador» e só registra a declaração manual do organizador por `mark_paid`. Pix no app é evolução.
- **D63-H — tempo.** O piloto usa T0 (abertura), fila e T2 (fechamento). Não executa T1 automático, pois esquecer de marcar pagamento não pode retirar alguém da lista; TP e mensalistas são evolução. Antes do marco de lista, especificar a adaptação do contrato `13` que hoje exige `TP <= T0 < T1 < T2`, inclusive configuração, claims, transições, alteração de prazo e testes, sem escolher defaults aqui.
- **D63-I (corrigida em 30/09/2026) — login.** Login como já entregue no M1-A: e-mail e senha, com os códigos de confirmação existentes; login Google é evolução. Esta correção substitui a formulação anterior da pergunta I, sem alterar o fluxo entregue.

A extensão D63-D fecha as sete perguntas de classificação do
`27-piloto-minimo.md`. As especificações pré-marco exigidas por A, E e H são
trabalho contratual pendente, não escolhas técnicas já autorizadas.
