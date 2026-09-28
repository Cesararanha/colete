// Barreira de concorrência de docs/25 §2, compartilhada pelos harnesses que
// provam pares do mesmo ator (M2-D14). O tratador é anexado na mesma instrução
// síncrona que cria a promessa; a espera é um laço com prazo que consulta
// pg_stat_activity e o estado da promessa, e só vale se for de Lock com o
// detentor esperado em pg_blocking_pids. Nada aqui engole rejeição: o estado
// guarda o resultado para a asserção explícita de quem chamou.

// Toda promessa acompanhada fica registrada até assentar. A limpeza dos
// harnesses espera por elas antes de apagar fixture: uma transação ainda em voo
// não pode commitar no meio da limpeza.
const inFlight = new Set();

export function track(promise) {
  const state = { done: false, result: undefined };
  const settled = promise.then(
    (value) => {
      state.done = true;
      state.result = { status: 'fulfilled', value };
      return state.result;
    },
    (reason) => {
      state.done = true;
      state.result = { status: 'rejected', reason };
      return state.result;
    },
  );
  inFlight.add(settled);
  settled.then(() => inFlight.delete(settled));
  return { state, settled };
}

// Quantas promessas acompanhadas ainda não assentaram. O guard dos harnesses
// (scripts/harness-guard.mjs) espera por elas antes de limpar.
export function trackedInFlight() {
  return inFlight.size;
}

export function describeResult(result) {
  if (result === undefined) return 'pending';
  if (result.status === 'fulfilled') return `fulfilled ${JSON.stringify(result.value)}`;
  return `rejected ${result.reason?.code} ${result.reason?.message}`;
}

export async function backendPid(client) {
  return Number((await client.query('select pg_backend_pid() as pid')).rows[0].pid);
}

async function activitySnapshot(observer, applicationPrefix) {
  const snapshot = await observer.query(
    `select pid, application_name, state, wait_event_type, wait_event,
            pg_blocking_pids(pid) as blockers
       from pg_stat_activity
      where application_name like $1
      order by pid`,
    [`${applicationPrefix}%`],
  );
  return JSON.stringify(snapshot.rows);
}

export async function awaitLockWait(
  observer,
  competitor,
  competitorPid,
  blockerPid,
  label,
  applicationPrefix,
) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (competitor.state.done) {
      throw new Error(
        `${label}: the competitor finished before its lock wait was observed: ${describeResult(
          competitor.state.result,
        )}`,
      );
    }
    const { rows } = await observer.query(
      `select wait_event_type, pg_blocking_pids(pid) as blockers
         from pg_stat_activity where pid = $1`,
      [competitorPid],
    );
    const row = rows[0];
    if (row?.wait_event_type === 'Lock' && row.blockers.map(Number).includes(blockerPid)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: lock wait on ${blockerPid} was not observed; pg_stat_activity=${await activitySnapshot(
          observer,
          applicationPrefix,
        )}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// docs/25 §2: cada papel da barreira roda na própria conexão. A, B, o
// detentor e o observador precisam ser backends distintos, com
// application_name distinto; com A e B na mesma conexão, B só seria enviada
// depois de A terminar, e a espera observada seria só a de A.
export async function assertDistinctConnections(connections, label) {
  const roles = Object.entries(connections);
  const facts = await Promise.all(
    roles.map(async ([role, client]) => {
      const { rows } = await client.query(
        "select pg_backend_pid() as pid, current_setting('application_name') as name",
      );
      return { role, pid: Number(rows[0].pid), name: rows[0].name };
    }),
  );
  const pids = new Set(facts.map((fact) => fact.pid));
  const names = new Set(facts.map((fact) => fact.name));
  if (pids.size !== facts.length || names.size !== facts.length) {
    throw new Error(
      `${label}: the barrier needs distinct connections, got ${JSON.stringify(facts)}`,
    );
  }
  return Object.fromEntries(facts.map((fact) => [fact.role, fact.pid]));
}

export function outcomeOf(result) {
  if (result.status === 'fulfilled') return 'ok';
  if (result.reason?.code === '40P01') return '40P01';
  return `${result.reason?.code} ${result.reason?.message}`;
}

// Par do mesmo ator pela barreira. As duas transações inserem a idempotência,
// que toma FOR KEY SHARE no perfil do ator pela FK actor_id, e depois travam o
// mesmo perfil. O detentor segura esse perfil em FOR NO KEY UPDATE, compatível
// com os dois FOR KEY SHARE: A fica parada entre a aquisição implícita e a
// trava do perfil, e só então B começa e para no mesmo ponto. Como cada uma já
// segura um lock na linha, o PostgreSQL não enfileira a segunda atrás da
// primeira: as duas esperam o detentor. Liberado o detentor, com FOR UPDATE
// cada uma espera o FOR KEY SHARE da outra (40P01); com FOR NO KEY UPDATE uma
// trava e a outra espera o commit dela.
export async function sameActorPair(connections, pair) {
  const { observer, holder, first, second, applicationPrefix } = connections;
  const {
    holder: holderPid,
    first: firstPid,
    second: secondPid,
  } = await assertDistinctConnections({ observer, holder, first, second }, pair.label);
  await holder.query('begin');
  await holder.query('select 1 from public.profiles where id = $1 for no key update', [
    pair.profileId,
  ]);
  let a;
  let b;
  try {
    a = track(pair.runFirst(first));
    await awaitLockWait(observer, a, firstPid, holderPid, `${pair.label} A`, applicationPrefix);
    b = track(pair.runSecond(second));
    await awaitLockWait(observer, b, secondPid, holderPid, `${pair.label} B`, applicationPrefix);
  } finally {
    await holder.query('commit');
  }
  const settled = await Promise.allSettled([a.settled, b?.settled ?? Promise.resolve(undefined)]);
  const results = settled.map((entry) => entry.value).filter(Boolean);
  for (const result of results) {
    if (result.status === 'rejected' && result.reason?.code === '40P01') {
      throw new Error(`${pair.label}: the barrier observed a deadlock (SQLSTATE 40P01)`);
    }
  }
  return results;
}
