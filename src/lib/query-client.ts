import { QueryClient } from '@tanstack/react-query';

/**
 * HX-003 (human decision of 28/10/2026): Grupos, Agenda and the match detail
 * read again every 30 s while the screen is in front, so an approval, a
 * promotion from the waitlist or another person's change shows up without a
 * reload. Measured on the local stack (docs/26, "Tela que se atualiza
 * sozinha"): 3 to 4 ms of Edge CPU per read, about 10 ms per detail refresh.
 */
export const LIVE_REFRESH_MS = 30_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
    queries: { retry: false, staleTime: 15_000 },
  },
});
