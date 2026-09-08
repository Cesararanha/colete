// A origem real destes dados será a fatia de grupos/rachas de docs/16-roadmap.md §3.

export type MatchSituation = 'open' | 'payment_due' | 'reserve' | 'teams_published';

export type PaymentStatus = 'paid' | 'review' | 'pending';

export type Player = {
  readonly id: string;
  readonly name: string;
  readonly paymentStatus: PaymentStatus;
  readonly preferredPosition: string;
};

export type Reserve = {
  readonly id: string;
  readonly isCurrentUser: boolean;
  readonly name: string;
  readonly position: number;
};

export type Goalkeeper = {
  readonly amount: string | null;
  readonly id: string;
  readonly name: string;
  readonly pays: boolean;
};

export type PublishedTeam = {
  readonly id: string;
  readonly name: string;
  readonly players: readonly {
    readonly id: string;
    readonly name: string;
    readonly preferredPosition: string;
  }[];
};

export type AuditEventKind =
  'draw' | 'manual_swap' | 'manual_addition' | 'star_change' | 'republish';

export type AuditEvent = {
  readonly actor: string;
  readonly id: string;
  readonly kind: AuditEventKind;
  readonly when: string;
};

export type DemoMatch = {
  readonly amount: string;
  readonly auditTrail: readonly AuditEvent[];
  readonly capacity: number;
  readonly dateLabel: string;
  readonly goalkeepers: readonly Goalkeeper[];
  readonly groupName: string;
  readonly id: string;
  readonly location: string;
  readonly mapQuery: string;
  readonly paymentDeadlineMinutes: number | null;
  readonly publishedTeamNumber: number | null;
  readonly reserves: readonly Reserve[];
  readonly situation: MatchSituation;
  readonly starters: readonly Player[];
  readonly startsAt: string;
  readonly teams: readonly PublishedTeam[];
  readonly timeLabel: string;
};

const openStarters = [
  ['aberta-1', 'Aline Moura', 'Meio-campista', 'paid'],
  ['aberta-2', 'Bruno Lins', 'Defensor', 'review'],
  ['aberta-3', 'Caio Nobre', 'Atacante', 'paid'],
  ['aberta-4', 'Dandara Melo', 'Defensora', 'pending'],
  ['aberta-5', 'Elias Sales', 'Meio-campista', 'paid'],
  ['aberta-6', 'Fernanda Luz', 'Atacante', 'paid'],
  ['aberta-7', 'Guto Paes', 'Defensor', 'review'],
] as const satisfies readonly (readonly [string, string, string, PaymentStatus])[];

const unpaidStarters = [
  ['prazo-1', 'Helena Cruz', 'Atacante', 'paid'],
  ['prazo-2', 'Igor Mota', 'Defensor', 'pending'],
  ['prazo-3', 'Joana Reis', 'Meio-campista', 'paid'],
  ['prazo-4', 'Kauê Vidal', 'Atacante', 'review'],
  ['prazo-5', 'Lia Tavares', 'Defensora', 'paid'],
  ['prazo-6', 'Mateus Neri', 'Meio-campista', 'paid'],
  ['prazo-7', 'Nina Pires', 'Atacante', 'pending'],
  ['prazo-8', 'Otávio Sá', 'Defensor', 'paid'],
  ['prazo-9', 'Paula Farias', 'Meio-campista', 'review'],
  ['prazo-10', 'Ravi Torres', 'Atacante', 'paid'],
] as const satisfies readonly (readonly [string, string, string, PaymentStatus])[];

const reserveStarters = [
  ['reserva-1', 'Sofia Leal', 'Meio-campista', 'paid'],
  ['reserva-2', 'Tiago Maia', 'Defensor', 'paid'],
  ['reserva-3', 'Úrsula Porto', 'Atacante', 'review'],
  ['reserva-4', 'Vítor Ramires', 'Defensor', 'paid'],
  ['reserva-5', 'Wanda Diniz', 'Meio-campista', 'pending'],
  ['reserva-6', 'Yuri Costa', 'Atacante', 'paid'],
  ['reserva-7', 'Zara Brito', 'Defensora', 'paid'],
  ['reserva-8', 'André Falcão', 'Meio-campista', 'review'],
  ['reserva-9', 'Bia Siqueira', 'Atacante', 'paid'],
  ['reserva-10', 'Ciro Góis', 'Defensor', 'paid'],
] as const satisfies readonly (readonly [string, string, string, PaymentStatus])[];

const publishedPlayers = [
  ['times-1', 'Dora Amaral', 'Defensora'],
  ['times-2', 'Enzo Braga', 'Atacante'],
  ['times-3', 'Flávia Serpa', 'Meio-campista'],
  ['times-4', 'Gil Ramos', 'Defensor'],
  ['times-5', 'Heloísa Prado', 'Atacante'],
  ['times-6', 'Iago Veiga', 'Meio-campista'],
  ['times-7', 'Júlia Matos', 'Defensora'],
  ['times-8', 'Luan Neves', 'Atacante'],
  ['times-9', 'Maya Freire', 'Meio-campista'],
  ['times-10', 'Noah Correia', 'Defensor'],
] as const;

const toPlayers = (
  rows: readonly (readonly [string, string, string, PaymentStatus])[],
): readonly Player[] =>
  rows.map(([id, name, preferredPosition, paymentStatus]) => ({
    id,
    name,
    paymentStatus,
    preferredPosition,
  }));

const publishedStarters: readonly Player[] = publishedPlayers.map(
  ([id, name, preferredPosition]) => ({
    id,
    name,
    paymentStatus: 'paid',
    preferredPosition,
  }),
);

export const demoMatches: readonly DemoMatch[] = [
  {
    amount: 'R$ 25,00',
    auditTrail: [],
    capacity: 10,
    dateLabel: 'Ter, 8 set',
    goalkeepers: [
      { amount: null, id: 'goleiro-a1', name: 'Davi Holanda', pays: false },
      { amount: 'R$ 15,00', id: 'goleiro-a2', name: 'Elisa Fontes', pays: true },
    ],
    groupName: 'Bola da Praia',
    id: 'aberto-com-vagas',
    location: 'Arena Pajuçara · Quadra 2',
    mapQuery: 'Arena Pajuçara Maceió',
    paymentDeadlineMinutes: null,
    publishedTeamNumber: null,
    reserves: [],
    situation: 'open',
    starters: toPlayers(openStarters),
    startsAt: '2026-09-08T19:30:00-03:00',
    teams: [],
    timeLabel: '19h30',
  },
  {
    amount: 'R$ 30,00',
    auditTrail: [],
    capacity: 10,
    dateLabel: 'Qui, 10 set',
    goalkeepers: [
      { amount: null, id: 'goleiro-b1', name: 'Olívia Paz', pays: false },
      { amount: null, id: 'goleiro-b2', name: 'Pedro Vale', pays: false },
    ],
    groupName: 'Quinta no Farol',
    id: 'titular-com-prazo',
    location: 'Society Farol · Campo A',
    mapQuery: 'Society Farol Maceió',
    paymentDeadlineMinutes: 120,
    publishedTeamNumber: null,
    reserves: [],
    situation: 'payment_due',
    starters: toPlayers(unpaidStarters),
    startsAt: '2026-09-10T20:00:00-03:00',
    teams: [],
    timeLabel: '20h',
  },
  {
    amount: 'R$ 22,00',
    auditTrail: [],
    capacity: 10,
    dateLabel: 'Sáb, 12 set',
    goalkeepers: [
      { amount: 'R$ 12,00', id: 'goleiro-c1', name: 'Raul Simões', pays: true },
      { amount: 'R$ 12,00', id: 'goleiro-c2', name: 'Sara Uchôa', pays: true },
    ],
    groupName: 'Sábado Valente',
    id: 'terceiro-reserva',
    location: 'Arena Serraria · Campo 1',
    mapQuery: 'Arena Serraria Maceió',
    paymentDeadlineMinutes: null,
    publishedTeamNumber: null,
    reserves: [
      { id: 'fila-1', isCurrentUser: false, name: 'Téo Linhares', position: 1 },
      { id: 'fila-2', isCurrentUser: false, name: 'Val Costa', position: 2 },
      { id: 'fila-3', isCurrentUser: true, name: 'Yara Lima', position: 3 },
    ],
    situation: 'reserve',
    starters: toPlayers(reserveStarters),
    startsAt: '2026-09-12T16:00:00-03:00',
    teams: [],
    timeLabel: '16h',
  },
  {
    amount: 'R$ 28,00',
    auditTrail: [
      { actor: 'Lara Queiroz', id: 'audit-1', kind: 'draw', when: '14 set · 18h02' },
      {
        actor: 'Lara Queiroz',
        id: 'audit-2',
        kind: 'manual_swap',
        when: '14 set · 18h05',
      },
      {
        actor: 'Lara Queiroz',
        id: 'audit-3',
        kind: 'manual_addition',
        when: '14 set · 18h06',
      },
      {
        actor: 'Lara Queiroz',
        id: 'audit-4',
        kind: 'star_change',
        when: '14 set · 18h07',
      },
      { actor: 'Lara Queiroz', id: 'audit-5', kind: 'republish', when: '14 set · 18h08' },
    ],
    capacity: 10,
    dateLabel: 'Ter, 15 set',
    goalkeepers: [
      { amount: null, id: 'goleiro-d1', name: 'Pietra Nunes', pays: false },
      { amount: null, id: 'goleiro-d2', name: 'Quim Araújo', pays: false },
    ],
    groupName: 'Terça da Orla',
    id: 'times-publicados',
    location: 'Arena Jatiúca · Campo B',
    mapQuery: 'Arena Jatiúca Maceió',
    paymentDeadlineMinutes: null,
    publishedTeamNumber: 2,
    reserves: [],
    situation: 'teams_published',
    starters: publishedStarters,
    startsAt: '2026-09-15T20:30:00-03:00',
    teams: [
      {
        id: 'time-1',
        name: 'Time 1',
        players: publishedPlayers.slice(0, 5).map(([id, name, preferredPosition]) => ({
          id,
          name,
          preferredPosition,
        })),
      },
      {
        id: 'time-2',
        name: 'Time 2',
        players: publishedPlayers.slice(5).map(([id, name, preferredPosition]) => ({
          id,
          name,
          preferredPosition,
        })),
      },
    ],
    timeLabel: '20h30',
  },
] as const;

export function findDemoMatch(id: string | undefined): DemoMatch | undefined {
  return demoMatches.find((match) => match.id === id);
}
