# Colete — Review adversarial geral (7 documentos)

> **HISTÓRICO — NÃO NORMATIVO.** Parecer sobre uma baseline anterior. Achados, contagens e
> referências não demonstram o estado atual; use os documentos canônicos e nova validação.

**Data:** 25/08/2026
**Base revisada:** requisitos · review-requisitos · faculdade · telas-v0 · algoritmo-sorteio · pesquisa-usuarios · concorrentes
**Postura:** adversarial — achados reais, sem elogio, sem resumo. 25 achados, ordenados por severidade.

---

## 🔴 ALTA

### A1. Faltam 6 dias e o item de maior peso da nota está "a definir"
- **Onde:** `colete-requisitos.md` §9 · `colete-faculdade.md` §5–7
- **Problema:** entrega em 31/08; os docs (17/08) ainda listam abertos: aprovação da v0, pergunta 58, entrevistas não realizadas e "Design e layout — a definir" — layout vale 3,0 pontos, maior item da rubrica. *(Parcialmente especulativo: inferido do que está escrito.)*
- **Recomendação:** congelar o escopo da v0 hoje, escolher referência visual em 1h, agendar as entrevistas para esta semana — o racha semanal é a única janela de acesso aos usuários antes do prazo.

### A2. Push não existe no canal de distribuição real
- **Onde:** `colete-requisitos.md` §8 (stack: "Push: Expo Notifications") × §1 (distribuição por PWA)
- **Problema:** `expo-notifications` não suporta web — enquanto a distribuição for só PWA, ninguém recebe push, e o produto inteiro é orientado a push. O doc só trata o problema menor (iOS exige PWA instalado); web push é implementação separada (service worker, VAPID). Consequência social: quem está sem push perde a corrida por vaga sistematicamente.
- **Recomendação:** especificar web push próprio (ou fallback por e-mail) na v1, e declarar a injustiça-por-design da corrida para usuários sem push.

### A3. A rejeição automática em 2h pune quem pagou de verdade
- **Onde:** `colete-requisitos.md` §5.5
- **Problema:** comprovante legítimo à 1h da manhã, organizador dormindo → rejeição automática "libera a vaga". O Pix já saiu, a vaga vai para outro: duas pessoas pagaram pela mesma vaga — a briga que a regra do valor travado (§3.4) quer evitar. E "libera a vaga" contradiz o regime 1 (não pagar antes do prazo não tira vaga).
- **Recomendação:** restringir a expiração ao regime 2 (onde o vetor de bloqueio existe); ao expirar, recolocar no topo da espera com comprovante pendente. Rejeição definitiva só humana.

### A4. A máquina de estados contradiz as próprias regras do documento
- **Onde:** `colete-requisitos.md` §3.3 × §5.4 × §5.6
- **Problema:** (a) "vaga vazia + espera vazia = lista reabre" exige `lista_cheia → lista_aberta`, transição inexistente; (b) racha que não enche nunca chega a `em_pagamento`/`times_publicados`, mas a etapa 8 manda "seguir"; (c) mensalista entra pago na abertura — pagamento é processo concorrente, não estado; (d) republicação de times implica voltar de `times_publicados`.
- **Recomendação:** dois eixos ortogonais — estado da lista (aberta/cheia) e fase do racha — ou transições reversas explícitas.

### A5. Cancelar um racha mata a recorrência silenciosamente
- **Onde:** `colete-requisitos.md` §3.2
- **Problema:** "o próximo racha só nasce quando o atual vira `realizado`" + `cancelado` nunca vira `realizado` ⇒ a quinta cancelada por chuva encerra a recorrência para sempre. Chuva é o caso comum.
- **Recomendação:** gatilho = estado **terminal** (`realizado` OU `cancelado`).

### A6. A trilha pública vaza a nota privada
- **Onde:** `colete-requisitos.md` §5.6 × §5.7 · `colete-telas-v0.md` §2.6
- **Problema:** a trilha visível a todos registra alterações de estrela, e o mock exibe o valor ("Marcos Souza: 4 → 3") — contradição direta com nota privada por padrão, na tela da demo.
- **Recomendação:** com nota privada, a trilha mostra *que* houve alteração (quem, quando), nunca valores. Corrigir o mock 2.6.

### A7. Sorteio rodando no aparelho destrói a garantia da trilha
- **Onde:** `colete-algoritmo-sorteio.md` §7 ("pode rodar no próprio aparelho") × `colete-requisitos.md` §5.7
- **Problema:** cliente roda o algoritmo e reporta a trilha ⇒ "sorteado 3 vezes"/"0 trocas" são autodeclarados — em web/PWA, DevTools é um F12. Append-only impede editar o passado, não impede mentir no presente. O diferencial nº 1 não resiste a uma pergunta sênior.
- **Recomendação:** sorteio + escrita da trilha em Edge Function, ou rebaixar a promessa de "prova" para "registro".

### A8. A função 10/3/3 não faz o que a prosa diz — e o exemplo motivador é um mínimo local dela
- **Onde:** `colete-algoritmo-sorteio.md` §2, §3 (passo 2), §7
- **Problema:** (a) pesos arbitrários — nada justifica 1 ponto de soma = 3,33 de contagem de extremos; a prosa "soma vem primeiro" é falsa (extremos, até 12 pts, compram piora de soma, 10); (b) 5-5-1-1 × 3-3-3-3 pontua 12 e **todas** as trocas simples pontuam 46 — mínimo local estrito que o refinamento não escapa. A serpentina evita neste exemplo; "chega ao ótimo ou a um passo" é afirmado, não demonstrado.
- **Recomendação:** comparação lexicográfica (soma primeiro, extremos como desempate) ou defender pesos com experimento vs força bruta (N≤16); documentar o risco de mínimo local (mitigado pelos re-sorteios).

### A9. AI e fluxos prontos antes da pesquisa — o pecado que a professora pune nominalmente
- **Onde:** `colete-telas-v0.md` (cabeçalho, §1) × `colete-faculdade.md` §3
- **Problema:** entregáveis 5 e 6 "derivados dos requisitos" — que vêm de entrevista com o próprio desenvolvedor: o "design centrado no próprio desenvolvedor" que a Aula 02 condena. O ciclo cobrado é Pesquisa → Síntese → Interface; a interface veio antes. Se a AI sair idêntica após as entrevistas, "como a pesquisa alimentou o design?" fica sem resposta.
- **Recomendação:** rotular a AI atual como hipótese; após as entrevistas, documentar ao menos uma mudança concreta (ou validação explícita) causada pela pesquisa.

---

## 🟠 MÉDIA

### M1. Mensalista trava o valor do racha no instante da abertura
- **Onde:** `colete-requisitos.md` §3.4 × §5.4
- **Problema:** valor trava "no primeiro pagamento aprovado"; o primeiro mensalista entra "pago" na janela ⇒ o valor trava na abertura e "pode mudar enquanto ninguém pagou" é letra morta.
- **Recomendação:** pagamento presumido de mensalista não conta para a trava.

### M2. "Pagamento resolvido" para liberar o Sortear é circular
- **Onde:** `colete-requisitos.md` §5.7 × §5.4 (etapas 7–8)
- **Problema:** o regime 2 ("vaga é de quem paga") não tem fim próprio; a "decisão do organizador" não é estado nem evento. Resolve quando sorteia, sorteia quando resolve.
- **Recomendação:** o botão Sortear fecha a lista naquele instante e exige apenas titulares atuais pagos/aprovados.

### M3. Refinamento: prosa best-improvement, pseudocódigo first-improvement, mutação durante iteração
- **Onde:** `colete-algoritmo-sorteio.md` §3 × §7
- **Problema:** prosa: "fica com a que melhorar mais"; código: aceita a primeira melhora e segue iterando sobre listas já modificadas — fonte clássica de elemento pulado/repetido. `timeX`/`timeY` não quantificados.
- **Recomendação:** alinhar prosa e código; estrutura segura: coletar a melhor troca da passada, aplicar depois, repetir.

### M4. A regra da média para times desiguais não existe na função de pontuação
- **Onde:** `colete-algoritmo-sorteio.md` §6 × §7
- **Problema:** §6 promete comparação "por média" com tamanhos diferentes; `pontuação()` só usa somas. Com média, os pesos mudam de significado (diferença fracionária ×10).
- **Recomendação:** incorporar ao pseudocódigo e recalibrar — ou não balancear automaticamente times desiguais (a sobra já é do organizador em requisitos §5.7).

### M5. A suíte de testes não testa o diferencial — e o teste de variedade é falso
- **Onde:** `colete-algoritmo-sorteio.md` §8
- **Problema:** "Equilíbrio" só mede somas; distribuição de extremos — a razão do algoritmo existir — não tem teste. "Duas execuções produzem divisões diferentes" pode falhar legitimamente (poucos empates; refinamento converge shuffles ao mesmo resultado).
- **Recomendação:** asserção sobre extremos (diff de craques/fracos ≤ 1) e variedade estatística (≥ k resultados distintos em 100 execuções com empates).

### M6. iOS PWA: verificação de e-mail e OAuth caem no Safari, não no app instalado
- **Onde:** `colete-requisitos.md` §5.1 × §8 (pontos de atenção web não cobrem)
- **Problema:** no iOS o PWA instalado tem armazenamento separado do Safari; link de verificação e redirect OAuth abrem no Safari — o usuário "verifica" e volta ao PWA deslogado.
- **Recomendação:** validar cedo; preferir OTP digitável (Supabase suporta) em vez de link.

### M7. Telas exigidas pelo bônus e pelos fluxos não têm especificação
- **Onde:** `colete-telas-v0.md` §1 × §2 × §3
- **Problema:** Grupos e Perfil sustentam o bônus de tabs e não têm spec; Fluxo 1 usa "Entrar com código" (sem tela); Fluxo 4 usa "Avaliar jogadores" (sem tela); botões Google/Apple mortos na demo, sem comportamento definido.
- **Recomendação:** especificar o mínimo dessas telas e o comportamento dos botões mortos (ocultar ou toast).

### M8. "Sou goleiro" promete o que as regras não cumprem
- **Onde:** `colete-requisitos.md` §5.1 × §5.3 · `colete-telas-v0.md` §2.2
- **Problema:** vendido como "sinalização para o sorteio", mas o sorteio ignora o flag (goleiro = quem entra na lista de goleiros). O texto está na tela dos 2,0 pontos; uma pergunta da arguição derruba.
- **Recomendação:** dar função real (pré-seleção/sugestão de lista) ou corrigir o texto e tirar da v0.

### M9. Recrutamento e roteiro contaminam a amostra com a solução
- **Onde:** `colete-pesquisa-usuarios.md` PARTE 1 e Bloco C
- **Problema:** a mensagem de recrutamento anuncia a solução ("lista, pagamento, times") antes de perguntar o problema; o Bloco C sonda exatamente as quatro dores que o produto já decidiu resolver — confirmação, não descoberta.
- **Recomendação:** recrutar sem revelar features; abrir o Bloco C pela pergunta aberta (13) e anotar dores espontâneas × induzidas.

### M10. Questionário com item duplo, fatos em Likert e zero perfil
- **Onde:** `colete-pesquisa-usuarios.md` PARTE 3
- **Problema:** Q2 junta duas causas (ininterpretável); Q2/Q4 são eventos factuais em escala de concordância (o correto é frequência); sem idade/papel/frequência não há cruzamento — e "Perfil = Bloco A + questionário".
- **Recomendação:** separar Q2, converter Q2/Q4 para frequência, abrir com 3 perguntas de perfil.

### M11. Observação ficou de fora, e a curva emocional está subalimentada
- **Onde:** `colete-pesquisa-usuarios.md` × `colete-faculdade.md` §3
- **Problema:** dos três métodos da Aula 02, o plano cobre dois — observação seria gratuita (o racha é semanal). "A curva emocional é o ouro", mas só a Q19 pergunta emoção, e só numa fase.
- **Recomendação:** sonda "como você se sentiu?" por fase dentro da Q7 + uma observação estruturada no próximo jogo.

### M12. O review antigo circula como se fosse atual
- **Onde:** `colete-review-requisitos.md` × `colete-requisitos.md` (cabeçalho)
- **Problema:** audita versão que não existe mais (seções 7-bis/7-ter, chat na v1, C1–C4 corrigidas, L13 substituída); o requisitos aponta para ele como "a revisão crítica" sem aviso — contradições fantasma para banca e recrutador.
- **Recomendação:** carimbar "histórico — snapshot de 17/08, achados incorporados" e listar divergências deliberadas (ex.: recorrência).

---

## 🔵 BAIXA

### B1. "Nome com ao menos duas palavras" exclui gente real
- **Onde:** `colete-telas-v0.md` §2.2 — mononímia existe; contradiz a bandeira de inclusão, no formulário arguido de 2,0 pontos.
- **Recomendação:** só não-vazio com mínimo de caracteres; apelido já cobre "como quer ser chamado".

### B2. Apple "Hide My Email" quebra a unificação de contas
- **Onde:** `colete-requisitos.md` §5.1/§6.5 — relay privado entrega e-mail diferente ⇒ conta duplicada silenciosa no fluxo que a seção diz resolver.
- **Recomendação:** documentar e decidir (merge manual ou orientar a compartilhar o e-mail real).

### B3. "5 grupos ativos" sem definição, e dono ausente sem saída
- **Onde:** `colete-requisitos.md` §3.1/§2 — "ativo" indefinido; dono que abandona sem transferir trava o grupo, e o Admin não pode transferir.
- **Recomendação:** definir "ativo"; transferência excepcional pelo Admin, justificada e logada.

### B4. Concorrentes: mídia misturada com concorrente e afirmação pelo silêncio
- **Onde:** `colete-concorrentes.md` §1–2 — Partida/FutBora são sites de conteúdo; "nenhum anuncia auditoria" é argumento por ausência sem abrir os apps.
- **Recomendação:** separar concorrentes de fontes; instalar os 2–3 principais (Convoca tem trial) e registrar prints.

---

## AS 3 COISAS QUE EU CONSERTARIA PRIMEIRO

1. **Congelar a v0 e começar a construir hoje** (A1, M7). O prazo é o único item irrecuperável: tudo o mais se corrige depois de 31/08, a nota não. Layout (3,0) exige dias e não tem referência escolhida; há telas do bônus sem spec.
2. **Corrigir o roteiro e rodar as entrevistas nesta semana** (A9, M9, M10, M11). A correção custa 1h mas precisa vir antes de aplicar — entrevista contaminada não se refaz. O racha é semanal: perder a janela custa 7 dias, e os seis artefatos de UX dependem do dado.
3. **Resolver trilha × privacidade e sorteio no cliente** (A6, A7). É o diferencial declarado — discurso de banca, LinkedIn e entrevista — e hoje ele se contradiz e não resiste a uma pergunta técnica. Decisão de especificação, barata agora, cara depois que o mock 2.6 virar componente.
