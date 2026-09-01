export const pt = {
  app: {
    name: 'Colete',
    skipToContent: 'Ir para o conteúdo principal',
  },
  navigation: {
    label: 'Navegação principal',
    home: 'Início',
    foundation: 'Fundação',
  },
  theme: {
    useLight: 'Usar tema claro',
    useDark: 'Usar tema escuro',
    currentLight: 'Tema claro ativo',
    currentDark: 'Tema escuro ativo',
  },
  home: {
    eyebrow: 'M0-A · Fundação local',
    title: 'Organize o racha antes de a bola rolar.',
    description:
      'Este shell valida a base mobile-first do Colete sem antecipar as telas ou regras dos próximos marcos.',
    statusTitle: 'Base pronta para evoluir',
    statusBody:
      'Navegação, temas, safe areas e reflow já compartilham a mesma fundação no celular e na web.',
    statusLabel: 'Scaffold sem dados reais',
    principlesTitle: 'Guardrails ativos',
    principles: [
      'Interface em português, centralizada e operável por teclado.',
      'Nenhum Pix, comprovante, nota ou dado financeiro em cache local.',
      'Service worker limitado a recursos públicos e estáticos.',
    ],
    nextTitle: 'O que ainda não existe',
    nextBody:
      'Autenticação real, grupos, rachas e financeiro entram apenas nos marcos aprovados. M0-B não foi iniciado.',
  },
  foundation: {
    eyebrow: 'Decisões verificáveis',
    title: 'Uma fundação pequena e deliberada.',
    description:
      'O scaffold preserva as fronteiras definidas na especificação e deixa os próximos domínios fora desta entrega.',
    architectureTitle: 'Estrutura',
    architectureBody:
      'Rotas dependem de features; features usam componentes de UI, biblioteca e tokens de tema.',
    accessibilityTitle: 'Acessibilidade',
    accessibilityBody:
      'Alvos têm no mínimo 44 pontos, o foco permanece visível, o movimento reduzido é respeitado e o layout reflui.',
    securityTitle: 'Segurança do PWA',
    securityBody:
      'Navegação e respostas autenticadas usam a rede. Somente scripts, estilos, fontes e imagens públicas podem entrar no cache técnico.',
  },
  pwa: {
    updateTitle: 'Atualização disponível',
    updateBody: 'Uma nova versão local do shell está pronta para ser ativada.',
    updateAction: 'Atualizar agora',
  },
  smoke: {
    eyebrow: 'Ferramenta local',
    title: 'Smoke sintético do PWA',
    description:
      'Este bloco só aparece no modo de smoke. Ele não autentica uma pessoa e não envia arquivos a nenhum serviço.',
    authAction: 'Simular retorno de autenticação',
    authCallbackTitle: 'Validando retorno sintético',
    authCallbackBody: 'A identidade fictícia será devolvida ao shell sem criar conta.',
    authResultLabel: 'Identidade sintética recebida',
    uploadAction: 'Escolher arquivo sintético',
    uploadCanceled: 'Nenhum arquivo sintético selecionado.',
    uploadResultLabel: 'Arquivo lido somente em memória',
    uploadResult: (name: string, mimeType: string, size: number) =>
      `${name} · ${mimeType} · ${size} bytes. Nenhum byte foi persistido ou enviado.`,
  },
  common: {
    backHome: 'Voltar ao início',
  },
} as const;
