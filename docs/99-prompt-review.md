# Prompts para revisão dos documentos do Colete

> **FERRAMENTA DE REVISÃO — NÃO NORMATIVA.** Estes prompts não definem requisitos. Qualquer
> inventário literal é hipótese a conferir no repositório atual.

Cole o **Prompt Mestre** para uma revisão completa. Se quiser profundidade maior, rode os
três **prompts focados** separadamente e depois o de **consistência**.

---

## 🎯 PROMPT MESTRE — revisão completa

```
Você é um revisor crítico e adversarial. Seu trabalho NÃO é elogiar nem resumir: é
encontrar problemas reais. Se um documento estiver bom numa seção, ignore essa seção e
siga em frente. Prefiro dez achados duros a trinta observações amenas.

## CONTEXTO DO PROJETO

"Colete" é um aplicativo para organizar futebol semanal (pelada) entre amigos: lista de
confirmação, cobrança via Pix e sorteio equilibrado de times.

Quem constrói: César, estudante brasileiro de Sistemas de Informação, desenvolvedor
experiente, trabalhando sozinho.

O projeto atende TRÊS objetivos simultâneos:
1. Trabalho de faculdade em duas disciplinas
   - Desenvolvimento Mobile: entrega 4 telas + código, e o aluno é ARGUIDO sobre o
     código. Há penalidade explícita para "projeto feito com LLM sem o aluno conseguir
     explicar o que tem lá".
   - UX / Engenharia da Empatia: entrega pesquisa, perfil de usuário, persona, jornada
     do usuário, arquitetura da informação e principais fluxos. A professora afirma que
     "suposições invalidam o mapa" e exige pesquisa real com usuários.
2. Uso real com o grupo de futebol do César
3. Peça de portfólio publicada no LinkedIn e no GitHub, para candidatura a vagas

RESTRIÇÕES:
- Stack definida: React Native + Expo + TypeScript, Supabase (plano gratuito) no backend
- MOBILE é a versão principal (iOS e Android). O app TAMBÉM precisa rodar na WEB, via
  React Native Web. Enquanto não há orçamento para publicar nas lojas, a distribuição é
  por PWA — solução de contorno, não decisão de arquitetura.
- Interface é mobile-first, mas precisa se comportar bem em tela larga.
- Orçamento zero.
- Prazo da entrega de mobile: 31/08/2026

## DOCUMENTOS A REVISAR

- colete-requisitos.md ......... requisitos funcionais e técnicos do produto
- colete-review-requisitos.md .. revisão crítica anterior dos requisitos
- colete-faculdade.md .......... exigências das disciplinas e plano de entrega
- colete-telas-v0.md ........... arquitetura da informação e especificação das telas
- colete-algoritmo-sorteio.md .. algoritmo de balanceamento dos times
- colete-pesquisa-usuarios.md .. roteiro de entrevista e questionário
- colete-concorrentes.md ....... análise de concorrentes

## O QUE PROCURAR

1. CONTRADIÇÕES — dentro de cada documento e entre documentos diferentes. Números,
   prazos, regras e decisões que não batem.

2. REGRAS NÃO IMPLEMENTÁVEIS — regras de negócio ambíguas, circulares ou que não
   sobrevivem ao contato com o código.

3. CASOS DE BORDA — situações reais que quebrariam o app e não estão previstas.

4. IMPACTO DE TAMBÉM RODAR NA WEB — o produto é mobile-first, mas precisa funcionar no
   navegador, e a distribuição inicial é por PWA. Avalie especificamente: notificação
   push em navegador (o iOS só entrega push para PWA instalado na tela inicial), upload
   de comprovante sem câmera, QR Code Pix em desktop (o usuário não escaneia a própria
   tela), links de convite servindo deep link e URL ao mesmo tempo, armazenamento local
   com comportamentos diferentes, e abas inferiores em tela larga.

5. INGENUIDADE TÉCNICA — o que um entrevistador sênior apontaria como imaturo. Inclui a
   corretude do pseudocódigo do algoritmo de sorteio e se a função de pontuação com
   pesos 10/3/3 é defensável ou arbitrária.

6. RISCO DE ESCOPO CONTRA PRAZO — o que está desenhado cabe no tempo disponível?

7. PROBLEMAS METODOLÓGICOS NA PESQUISA — perguntas enviesadas, sugestivas, duplicadas ou
   que não geram dado útil; cobertura insuficiente para os seis artefatos exigidos.

8. DEFENSABILIDADE — onde um professor arguindo o aluno acharia buraco na explicação.

## O QUE NÃO APONTAR

- A palavra "racha" em minúscula NÃO é resquício do nome antigo. É termo de domínio e
  significa "o evento de jogar futebol". Só aponte "Racha" quando estiver usado como
  NOME DO PRODUTO, que agora é Colete.
- Não sugira trocar a stack. Está decidida.
- Não reescreva os documentos. Aponte e recomende.
- Não elogie. Não resuma o que leu.

## FORMATO DA RESPOSTA

Para cada achado:

**[SEVERIDADE] Título curto do problema**
- Onde: arquivo e seção
- Problema: o que está errado, em uma ou duas frases, citando o trecho
- Recomendação: o que fazer, em uma ou duas frases

Severidade: ALTA (quebra o app, perde nota ou inviabiliza a entrega) · MÉDIA (causa
retrabalho ou confusão) · BAIXA (melhoria).

Ordene por severidade. Máximo 25 achados. Se um achado for especulativo — se você não
tem certeza e está inferindo — diga isso explicitamente na linha do problema.

Termine com uma seção "AS 3 COISAS QUE EU CONSERTARIA PRIMEIRO", justificando a ordem.
```

---

## 🔬 PROMPTS FOCADOS (opcional, para profundidade maior)

Use o mesmo bloco de **CONTEXTO DO PROJETO** acima em todos, trocando só a parte final.

### Foco 1 — Produto e requisitos

```
Revise apenas colete-requisitos.md e colete-review-requisitos.md.

Procure: contradições internas, regras de negócio ambíguas ou não implementáveis, casos
de borda não cobertos, e decisões que se tornam problemáticas agora que a WEB é o alvo
principal.

Preste atenção especial a estas mecânicas, que são o coração do produto:
- A reserva atômica de vaga quando a lista abre e vários jogadores clicam ao mesmo tempo
- A segunda disputa por vaga depois de vencido o prazo de pagamento, onde quem reserva é
  quem envia comprovante
- A trilha de auditoria do sorteio e se ela realmente impede manipulação
- A política de retenção do comprovante de Pix sob a LGPD
- Os dois modos de goleiro (fixo e sorteado)

Máximo 15 achados, ordenados por severidade.
```

### Foco 2 — Telas e algoritmo

```
Revise apenas colete-telas-v0.md e colete-algoritmo-sorteio.md.

Sobre as telas: a especificação está completa o suficiente para construir? Faltam telas
ou estados? É grande demais para o prazo? A navegação por abas inferiores mais pilha
funciona bem em navegador desktop, ou precisa de layout responsivo diferente?

Sobre o algoritmo: o pseudocódigo tem bug lógico? A distribuição serpentina mais busca
local resolve de fato o problema? Os pesos 10/3/3 da função de pontuação são
justificáveis? A complexidade computacional descrita está correta? Os testes propostos
bastam? Um professor arguindo o aluno acharia buraco nas explicações da seção "Como
explicar isso numa arguição"?

Máximo 15 achados, ordenados por severidade.
```

### Foco 3 — Acadêmico e pesquisa

```
Revise apenas colete-faculdade.md, colete-pesquisa-usuarios.md e colete-concorrentes.md.

Sobre o plano de entrega: é realista? Alguma exigência das disciplinas foi registrada mas
não virou ação concreta? O faseamento tem furos?

Sobre o roteiro de pesquisa: há perguntas enviesadas, sugestivas, duplicadas ou que não
geram dado útil? A cobertura basta para produzir os seis artefatos exigidos? O
questionário quantitativo tem problema de escala ou de formulação? Faltam perguntas
óbvias?

Sobre os concorrentes: a análise é rasa? Alguma conclusão não se sustenta na evidência
apresentada?

Máximo 15 achados, ordenados por severidade.
```

### Foco 4 — Consistência entre documentos

```
Leia TODOS os sete documentos e encontre inconsistências ENTRE eles, não dentro de cada
um. Este é trabalho de conferência literal, não de opinião.

Procure:
- Fatos que se contradizem entre arquivos (números, prazos, regras, decisões)
- Referências cruzadas quebradas — documento que cita arquivo ou seção que não existe
- Decisões tomadas num documento e não refletidas em outro. Em especial: o chat foi
  movido para a v2, o app passou a ter que rodar também na web via PWA, e o vocabulário
  de interface passou a ser "titular" e "reserva" no lugar de "confirmado" e "lista de
  espera"
- Informação duplicada entre arquivos que pode divergir com o tempo — diga onde ela
  deveria morar
- Numeração de perguntas, seções ou versões que não bate entre arquivos

Para cada achado, cite OS DOIS trechos que divergem e diga qual deveria prevalecer.
Máximo 20 achados.
```

---

## 💡 Como aproveitar melhor

**Anexe os sete arquivos de uma vez.** Revisor que enxerga só um documento inventa
problema que já está resolvido em outro.

**Rode o Foco 4 (consistência) por último**, depois de aplicar as correções dos outros
três. Senão ele acusa divergências que você acabou de criar ao corrigir.

**Desconfie de achado sem trecho citado.** Se o revisor não conseguiu apontar onde está,
provavelmente inferiu. O prompt pede que ele marque o que é especulativo — cobre isso.

**Não aplique tudo.** Revisão adversarial produz falso positivo por construção: o revisor
foi instruído a procurar problema, então ele acha. Julgue cada achado.
