# Colete — Arquitetura da informação e especificação de telas (v0)

> **HISTÓRICO — NÃO NORMATIVO.** A v0 foi substituída por `11-telas-v1.md`; nomes,
> inventários e fluxos daqui servem apenas como proveniência.

**Especificação funcional das telas da v0**, sem decisões visuais.
Última atualização: 17/08/2026

Serve a dois propósitos:

- **Disciplina de Mobile** — o que construir em cada uma das telas
- **Disciplina de UX** — entregáveis **5 (arquitetura da informação)** e **6 (principais
  fluxos)**

> ⚠️ Persona, jornada e mapa de empatia **não estão aqui** — dependem das entrevistas com o
> grupo, que ainda não foram feitas. Esta especificação deriva dos **requisitos**, que são
> reais; não de usuário inventado.

---

## 1. Arquitetura da informação

```
Colete
│
├── NÃO AUTENTICADO
│   ├── Entrar
│   ├── Criar conta
│   └── Esqueci minha senha
│
└── AUTENTICADO  ── navegação por abas ──
    │
    ├── 🏟  RACHAS                    ← aba inicial
    │   ├── (vazio) Nenhum racha marcado
    │   ├── Lista de rachas
    │   └── Detalhe do racha
    │       ├── Titulares e reservas
    │       ├── Pagamento
    │       └── Times sorteados
    │           └── Trilha de auditoria
    │
    ├── 👥  GRUPOS
    │   ├── (vazio) Você ainda não tem grupo
    │   ├── Lista de grupos
    │   └── Detalhe do grupo
    │       ├── Membros
    │       ├── Histórico de rachas
    │       └── Configurações
    │
    └── 👤  PERFIL
        ├── Meus dados
        ├── Notificações
        └── Sair
```

**Duas camadas de navegação:**

| Camada | Onde | Requisito atendido |
|---|---|---|
| **Stack** | Dentro de cada aba — lista → detalhe → sub-detalhe | Obrigatório (1,0 ponto) |
| **Bottom tabs** | Rachas · Grupos · Perfil | **Bônus (+0,5)** |

**Adaptação para tela larga:** as abas inferiores são padrão de celular e não se sustentam em
navegador desktop. Acima de aproximadamente 768 px de largura, elas viram **navegação lateral
fixa à esquerda**, e o conteúdo ganha largura máxima para não esticar linha de texto. Mesma
árvore de navegação, apresentação diferente.

---

## 2. Especificação das telas

### 2.1 Entrar

**Objetivo:** primeira tela do app. Autenticar quem já tem conta.

| Elemento | Detalhe |
|---|---|
| Logo e nome | Colete |
| Campo | E-mail |
| Campo | Senha, com botão de mostrar/ocultar |
| Ação principal | **Entrar** |
| Ações sociais | Entrar com Google · Entrar com Apple |
| Link | Esqueci minha senha |
| Link | Não tem conta? **Criar conta** |

**Estados:** repouso · carregando (botão com spinner, campos travados) · erro de credencial
(mensagem acima do formulário, sem limpar os campos).

**Acessibilidade:** rótulo associado a cada campo · foco visível · erro anunciado por leitor
de tela · área de toque mínima de 44×44 · contraste mínimo 4.5:1.

---

### 2.2 Criar conta 💎

> **Esta é a tela que vale os 2 pontos de "formulário com validação".** É onde a validação
> precisa estar mais caprichada.

| Campo | Regras de validação |
|---|---|
| **Nome** | Obrigatório · mínimo 3 caracteres · precisa ter ao menos duas palavras |
| **E-mail** | Obrigatório · formato válido · normalizado para minúsculas |
| **Senha** | Obrigatória · mínimo 8 caracteres · pelo menos uma letra e um número · indicador visual de força |
| **Confirmar senha** | Obrigatória · precisa ser idêntica à senha |
| **Sou goleiro** | Opcional · interruptor · texto de apoio explicando que serve para o sorteio |
| **Aceite** | Obrigatório · caixa de seleção com links para Termos de Uso e Política de Privacidade |

**Comportamento da validação — decisões deliberadas, defensáveis na arguição:**

1. **Validar ao sair do campo**, não a cada tecla digitada. Validar em tempo real mostra
   "e-mail inválido" quando a pessoa digitou só a primeira letra — pune quem está no meio da
   tarefa.
2. **Depois do primeiro erro, aquele campo passa a validar em tempo real**, para a pessoa ver
   o erro sumir enquanto corrige.
3. **Botão sempre habilitado.** Botão desabilitado sem explicação é armadilha de
   acessibilidade: o leitor de tela anuncia "botão indisponível" e não diz por quê. Ao tocar
   com erro, o app leva o foco ao primeiro campo inválido.
4. **Mensagem de erro diz o que fazer**, não o que está errado: "A senha precisa de pelo
   menos 8 caracteres" em vez de "Senha inválida".

**Estados:** repouso · validando · enviando · sucesso (leva à tela de verificação de e-mail) ·
erro de servidor.

---

### 2.3 Rachas — estado vazio

**Objetivo:** o usuário acabou de criar conta e não tem grupo nenhum. Esta é a **segunda tela
que o professor vai ver**, e é onde a maioria dos apps entrega uma tela em branco.

| Elemento | Detalhe |
|---|---|
| Ilustração ou ícone | Discreto |
| Título | "Nenhum racha à vista" |
| Explicação | "Você entra em um grupo por convite. Peça o link ou o código para quem organiza." |
| Ação principal | **Entrar com código** |
| Ação secundária | **Criar meu grupo** |

---

### 2.4 Rachas — lista

**Objetivo:** tela principal do app. Linha do tempo dos próximos rachas de **todos** os
grupos, do mais próximo ao mais distante.

**Cada card de racha mostra:**

| Informação | Exemplo |
|---|---|
| Dia e horário | Quinta, 20h–22h |
| Grupo | Grupo do Bolinha |
| Local | Society do Zé |
| Ocupação | 14 / 20 vagas |
| **Situação do usuário** | a etiqueta muda tudo — ver abaixo |
| Ação contextual | idem |

**Etiquetas de situação — o coração da tela:**

| Situação | Etiqueta | Ação no card |
|---|---|---|
| Lista ainda não abriu | Abre quinta, 20h | Contagem regressiva |
| Lista aberta, você fora | 6 vagas | **Entrar na lista** |
| Você é titular, sem pagar | Falta pagar · vence em 2h | **Pagar** |
| Pagamento em análise | Em análise | — |
| Você é titular e pago | **Titular** ✓ | — |
| Você é reserva | **3º reserva** | Sair da fila |
| Times publicados | **Time 2** | Ver times |
| Racha cancelado | Cancelado | — |

**Estados da tela:** carregando (esqueleto) · vazia (2.3) · com conteúdo · erro de rede com
botão de tentar de novo.

---

### 2.5 Detalhe do racha

**Objetivo:** tudo sobre um racha e o lugar onde as ações acontecem.

**Blocos, de cima para baixo:**

1. **Cabeçalho** — data, horário de início e término, grupo
2. **Local** — endereço + botão **Abrir no mapa**
3. **Situação da lista** — barra de ocupação, quanto falta, prazo de pagamento
4. **Titulares** — lista numerada, cada linha com nome, foto e situação de pagamento
   (pago ✓ · em análise · pendente)
5. **Reservas** — lista numerada, com a posição do usuário destacada
6. **Goleiros** — lista separada, indicando o modo (fixo ou sorteado)
7. **Valor e pagamento** — valor por cabeça, QR Code Pix, botão de copiar, envio de
   comprovante.
   **Na web em tela larga o QR Code perde a função** — ninguém escaneia a própria tela.
   Nesse caso o **copia-e-cola vira a ação principal** e o QR Code fica secundário. No
   celular, o inverso.
8. **Ação principal fixa no rodapé** — muda conforme a situação: Entrar na lista · Pagar ·
   Enviar comprovante · Sair da lista · Ver times

**Só para organizador:** painel financeiro (esperado, arrecadado, pendente) · aprovar ou
rejeitar comprovante · adicionar jogador manualmente · botão **Sortear times**.

---

### 2.6 Times sorteados 🏆

**Objetivo:** o resultado. É a tela que justifica o app existir — e a que carrega o
diferencial do produto.

| Bloco | Conteúdo |
|---|---|
| **Times** | Um cartão por time: Time 1, Time 2, Time 3… com os jogadores |
| **Goleiros** | À parte, se o modo for Fixo |
| **Equilíbrio** | Indicador discreto de que os times estão equilibrados |
| **🔍 Trilha de auditoria** | Recolhível, **visível a todos** |

**Conteúdo da trilha:**

```
Sorteado 3 vezes antes de publicar
2 trocas manuais feitas pelo organizador
  • João Silva: Time 1 → Time 2
  • Pedro Lima: Time 2 → Time 1
1 alteração de estrela no dia do racha
  • Marcos Souza: 4 → 3
Publicado por Carlos Mendes, quinta 18h42
```

> Esta seção é o diferencial competitivo do produto (nenhum dos doze concorrentes anuncia
> nada parecido) e o melhor material de conversa numa entrevista de emprego.

---

## 3. Principais fluxos

### Fluxo 1 — Primeiro acesso

```
Abrir app → Criar conta → Preencher formulário → Verificar e-mail
   → Rachas (vazio) → Entrar com código → Aguardar aprovação → Rachas (com conteúdo)
```

### Fluxo 2 — Entrar em um racha (o fluxo central do produto)

```
Push "Lista aberta!" → Rachas → tocar no card → Detalhe do racha
   → ENTRAR NA LISTA
        ├── conseguiu vaga  → Titular, pagamento pendente
        └── lotou           → 3º reserva
```

### Fluxo 3 — Pagar

```
Detalhe do racha → Copiar Pix ou ler QR Code → pagar no banco
   → voltar → Enviar comprovante → "Em análise"
   → push de aprovação → Titular ✓
```

### Fluxo 4 — Sortear os times (organizador)

```
Detalhe do racha → todos pagos → Avaliar jogadores (estrelas)
   → SORTEAR → ver proposta
        ├── Sortear de novo   ↺
        └── Ajustar na mão    ✎   (tudo registrado na trilha)
   → PUBLICAR → push para todos → Times sorteados
```

### Fluxo 5 — Desistir

```
Detalhe do racha → Sair da lista
   ├── ainda não pagou  → sai na hora; 1º reserva sobe automaticamente
   └── já pagou         → app orienta a falar com o organizador
```

---

## 4. Dados falsos da v0

A v0 não tem servidor. Os dados ficam num arquivo local, e são pensados para **demonstrar
todos os estados** durante a apresentação:

| Racha | Serve para mostrar |
|---|---|
| Quinta, 20h — Grupo do Bolinha | Lista aberta, usuário fora, 14/20 vagas |
| Sábado, 9h — Fut dos Guri | Usuário titular com pagamento pendente |
| Terça, 21h — Racha da Firma | Lotado, usuário é 3º reserva |
| Domingo, 8h — Grupo do Bolinha | Times já publicados, com trilha de auditoria |

Vinte jogadores fictícios com nome, apelido, foto, posição e estrela de 1 a 5 — o suficiente
para o sorteio rodar de verdade na tela de times.

---

## 5. Fora da v0

Para deixar explícito na apresentação o que é recorte consciente, e não esquecimento:

- Backend, banco de dados, autenticação real
- Pagamento de verdade (o QR Code aparece, mas é ilustrativo)
- Notificações push
- Chat (foi para a v2)
- Criação e configuração de racha pelo organizador
- Gestão de membros e convites
