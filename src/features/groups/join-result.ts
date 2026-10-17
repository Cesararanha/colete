import type { Href } from 'expo-router';

import type { GroupOutcome } from '../../lib/api';

/**
 * Where a join answer leads (Ajustes do teste do César): a request sent, new
 * or repeated, goes to Grupos with the "Pedido enviado" notice, replacing the
 * form; an active membership stays on the form with its own way in.
 */
export function joinDestination(result: GroupOutcome): Href | null {
  return result.current?.status === 'pending'
    ? { pathname: '/grupos', params: { requested: '1' } }
    : null;
}
