// HX-003: what a screen that reads by itself says about its last reading.

export type LiveQuery = {
  dataUpdatedAt: number;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
};

/** "14:32", the device's own clock: it says when this screen last read. */
export function updatedAt(queries: readonly LiveQuery[]): string | undefined {
  const read = queries.map((query) => query.dataUpdatedAt).filter((at) => at > 0);
  if (read.length === 0) return undefined;
  // The oldest of the screen's reads: the screen is as fresh as its stalest part.
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
  }).format(new Date(Math.min(...read)));
}
