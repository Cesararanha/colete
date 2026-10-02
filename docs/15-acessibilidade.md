# Colete — Checklist de acessibilidade (v2, pré-migration)

25/08/2026. **WCAG 2.2 AA traduzido em critério de aceite: nenhuma tela é "pronta" sem
passar nesta lista.** Não é etapa final — é parte da definição de pronto de cada marco
(`16-roadmap.md`, M0–M8).

Emendas documentais de 28–29/09/2026 (M2-D23/M2-D27/M2-D37/M2-D40): código humano e espera por
quota seguem os critérios abaixo; confirmação de arquivamento por RPC é pós-piloto; a evidência manual única fica no gate do piloto, conforme M2-D43 de `25`.

## 1. Checklist por tela (o critério de aceite)

### Visual
- [ ] Contraste de texto ≥ **4.5:1** (texto grande ≥ 3:1) — **nos dois temas**
- [ ] Componentes de interface (bordas de campo, ícones funcionais) ≥ **3:1**
- [ ] Nenhuma informação transmitida **só por cor** — "pago" é ✓ + texto, não só verde;
      etiquetas de situação têm texto, não só cor
- [ ] Texto escala até **200%** (Dynamic Type / font scaling) sem corte nem sobreposição
- [ ] Nada de texto dentro de imagem

### Toque e teclado
- [ ] Todo alvo de toque ≥ **44×44** com espaço entre alvos vizinhos
- [ ] Web: tudo alcançável e operável **por teclado**, ordem de foco lógica, sem armadilha
- [ ] Foco **visível** em todo elemento interativo (nunca `outline: none` sem substituto)
- [ ] Arrastar nunca é a única operação: ajustes de time oferecem menu/botões
      **Mover para o time…**, acionáveis por teclado e leitor de tela
- [ ] O rascunho de times anuncia após cada movimento as contagens e se está inválido;
      Publicar fica focável com `aria-disabled` e descreve exatamente o que corrigir

### Leitor de tela (VoiceOver / TalkBack / NVDA)
- [ ] Todo controle tem rótulo (`accessibilityLabel`) — inclusive ícones sem texto
- [ ] Estados anunciados: selecionado, expandido, carregando, **desabilitado com motivo**
      ("Sortear — indisponível: 3 jogadores sem estrela")
- [ ] Ação indisponível não esconde o motivo do teclado: usar `aria-disabled` em controle
      ainda focável ou texto adjacente associado por `aria-describedby`; `disabled` nativo
      sem explicação alcançável não passa
- [ ] Erros de formulário **anunciados** ao aparecer (live region) e associados ao campo
- [ ] Imagens decorativas ocultas do leitor; fotos de jogador com o nome como alternativa
- [ ] Cabeçalhos reais e ordem correta (web: `h1→h2`, título de página por rota)

### Formulários (regras já fixadas nas telas — conferir sempre)
- [ ] Validar ao sair do campo; depois do 1º erro, em tempo real
- [ ] Botão **sempre habilitado**; com erro, foco vai ao primeiro campo inválido
- [ ] Mensagem diz **o que fazer**, não o que está errado

### Movimento e tempo
- [ ] `prefers-reduced-motion` respeitado (animações viram transições discretas)
- [ ] Nenhuma informação importante desaparece sozinha: feedback persiste na tela ou no
      sino; contagens também mostram horário absoluto ("vence às 17h"), não só cronômetro
- [ ] Claims de 10/30 min anunciam início, 5 min e 1 min — nunca cada segundo — e mantêm
      o prazo absoluto acessível ao leitor de tela
- [ ] Expiração usa relógio do servidor; perda de rede/retorno do banco atualiza o estado
      antes de orientar novo pagamento e nunca mostra Pix sem claim válida; replay de
      reserva expirada anuncia “prazo encerrado”, não reapresenta credencial antiga
- [ ] OTP aceita colar o código inteiro; reenviar informa o horário, não depende só de
      uma animação regressiva

- [ ] Quota de convite anuncia o erro e o instante absoluto de liberação calculado
      pelo servidor (`13` §8), sem depender só de cronômetro nem revelar o contador;
      indisponibilidade orienta nova tentativa sem prometer prazo inventado

### Cognição, atenção e prevenção de erro
- [ ] Uma ação principal por estado; texto pós-T1 diz **"reserve antes de pagar"**, sem
      linguagem ambígua como "quem pagar primeiro"
- [ ] Operação financeira irreversível pede confirmação com pessoa, valor e racha;
      `request_id` evita repetição acidental sem esconder conflito real
- [ ] Sessão de upload distingue "arquivo enviado" de "comprovante confirmado" e oferece
      retomar o endpoint autenticado ainda válido; expirada explica que é preciso novo fluxo,
      sem falar em token/URL de Storage
- [ ] A tela se chama **Alertas externos** e explica que a Central permanece; eventos
      obrigatórios aparecem bloqueados e os demais controlam push/e-mail individualmente
- [ ] “Lembretes do jogo” explica que um único toggle controla o push de
      **véspera 20h + 3h antes**, enquanto os dois registros continuam no sino
- [ ] Histórico financeiro e contestação têm headings/linha do tempo sem depender de cor;
      status, SLA, resposta, primeira decisão, prazo de apelação e decisão final são
      anunciados; Contestar/Aceitar/Apelar permanecem acessíveis a partir do evento N23

## 2. Decisões de produto que já são acessibilidade (não regredir)

- **Alerta externo granular por evento** — TDAH: excesso de push é barreira real. Categorias
  são agrupamento visual; a Central preserva o fato e a única preferência composta é N13,
  declarada como dois horários sob um único toggle.
- **Tema claro e escuro** de verdade, com tokens validados nos dois.
- **Linguagem simples** nos textos (tom do catálogo de notificações) — dislexia e baixa
  letração agradecem; dado essencial (dia, hora, valor) sempre presente e por extenso.
- **Botão desabilitado sempre explica o porquê** (padrão da tela 22).
- **Estados vazios com explicação e ação** — nunca tela em branco.
- **Corrida não depende de gesto complexo:** entrar/reservar é uma ação simples e
  idempotente. Claims temporárias são essenciais à justiça da vaga; a exceção de tempo
  é documentada, com aviso antecipado e horário absoluto. Quando uma pessoa precisar de
  acomodação, o organizador pode fazer adição manual auditada, sem fingir que pagamento
  fora do app ganhou a corrida.

## 3. Como isso entra no processo

| Quando | O quê |
|---|---|
| No design (etapa D) | Tokens de cor já nascem validados: cada par texto/fundo dos dois temas passa no contraste **antes** de virar tela |
| Em todo PR | `eslint-plugin-react-native-a11y` no lint (CI) — pega rótulo faltando e erro comum |
| Em cada fatia de interface | Provas automatizadas de axe, teclado, foco, reflow, nomes acessíveis e anúncio de erros no alvo web |
| No gate do piloto | Uma passada manual com leitor de tela, cobrindo todas as telas do piloto, em tabela por tela num documento operacional fora do manifesto |
| No M8 (polish) | Auditoria completa: axe DevTools no alvo web, zoom 400% com reflow, revisão da lista inteira tela a tela |
| No beta | Perguntar ao grupo, de verdade, se alguém precisa de ajuste (tamanho de fonte, movimento, notificação) — acessibilidade também se pesquisa |

No gate do piloto, a passada manual também verifica leitura e cópia dos 10 símbolos
do alfabeto `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, agrupados `XXXXX-XXXXX`, e
a digitação com maiúsculas/minúsculas, espaço e hífen normalizados (M2-D23).
O teste registra o alfabeto efetivo, leitor/plataforma, ação e resultado no
formato da M2-D43: leitor, versão, navegador, roteiro, resultado por item do §1
e achados. Axe integra as provas automatizadas de cada fatia e não prova, sozinho,
a legibilidade do código.

Na etapa pós-piloto, a tela 25 exige confirmação acessível antes de `archive_group`: título e
texto anunciam que o grupo ficará somente leitura, que pedidos pendentes
serão removidos sem punição, que ativos conservarão leitura histórica e que
convites deixarão de valer pelo estado do grupo. A ação destrutiva tem nome
inequívoco, foco inicial e retorno de foco previsíveis; cancelar não altera
estado. A UI só confirma sucesso depois do commit (M2-D37/M2-D40).
O controle não aparece na UI-B de piloto.

## 4. Fora do escopo v1 (explícito, não esquecido)

- Áudio/vídeo (não há mídia no app)
- Suporte a idiomas além do pt-BR (estrutura pronta em `i18n/`, tradução depois)
- Conformidade AAA (alvo é AA; itens AAA que vierem de graça, vêm)
