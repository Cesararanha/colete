// Guarda comum dos harnesses db:test:* que usam a barreira de docs/25 §2.
//
// Uma falha, seja erro de main, seja rejeição sem tratador, segue sempre o
// mesmo caminho, e a limpeza nunca corre junto com o harness:
//
// (a) a causa é relatada na hora, antes de qualquer outra linha de falha;
// (b) o sinal de abort é acionado. O guard instrumenta pg.Client e fetch, e
//     toda query, conexão ou requisição do harness consulta o sinal antes de
//     sair: depois do abort, trabalho novo é recusado com HarnessAbortedError,
//     e commit vira rollback, para que nenhuma transação em voo grave depois da
//     causa. Linha "ok" impressa depois da causa é marcada como ignorada;
// (c) o guard espera o trabalho em voo terminar (main, as promessas da
//     barreira, as queries e as requisições já enviadas), com prazo. Estourado
//     o prazo, encerra por pg_terminate_backend as conexões com o
//     application_name do harness, corta as requisições e só então segue;
// (d) a limpeza do harness roda numa conexão própria do guard, em ordem de FK,
//     e a varredura de Auth nunca apaga usuário que ainda tem perfil: a ação
//     ON DELETE SET NULL de profiles.auth_user_id deixaria um perfil active,
//     suspended ou banned sem auth_user_id, o que profiles_lifecycle_check
//     recusa. O perfil sai antes, pela limpeza do harness;
// (e) o censo roda depois da limpeza e é relatado à parte, sem substituir a
//     causa;
// (f) o processo sai com código 1.
//
// Toda conexão do harness precisa ter application_name com o prefixo que ele
// declara: é por ele que o passo (c) a encontra, e o guard recusa conexão sem
// ele.
//
// Usuário Auth criado por harness carrega uma marca: e-mail no domínio
// reservado colete.test (RFC 6761) que começa pelo prefixo do próprio harness.
// A varredura remove somente usuários com a marca do harness que a chama.

import { AsyncLocalStorage } from 'node:async_hooks';
import process from 'node:process';

import pg from 'pg';

import { trackedInFlight } from './lock-barrier.mjs';

export const HARNESS_EMAIL_DOMAIN = 'colete.test';

export function harnessEmail(prefix, suffix) {
  return `${prefix}${suffix}@${HARNESS_EMAIL_DOMAIN}`;
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

// Padrão LIKE da marca, com os curingas do prefixo escapados.
export function harnessEmailPattern(prefix) {
  return `${escapeLike(prefix)}%@${HARNESS_EMAIL_DOMAIN}`;
}

// Apaga do Auth os usuários com a marca do harness que já não têm perfil. Um
// usuário cujo perfil ainda existe fica, e a função reprova depois de apagar os
// demais: o perfil precisa sair antes, pela limpeza do harness. Devolve quantos
// apagou.
export async function sweepMarkedAuthUsers(client, prefix) {
  const { rows } = await client.query(
    `with marked as (
       select account.id,
              exists (select 1 from public.profiles profile
                       where profile.auth_user_id = account.id) as has_profile
         from auth.users account
        where account.email like $1 escape '\\'
     ), deleted as (
       delete from auth.users account using marked
        where account.id = marked.id and not marked.has_profile
       returning 1
     )
     select (select count(*) from deleted)::integer as deleted,
            (select count(*) from marked where has_profile)::integer as blocked`,
    [harnessEmailPattern(prefix)],
  );
  const { deleted, blocked } = rows[0];
  if (blocked > 0) {
    throw new Error(
      `${blocked} marked Auth users of ${prefix} still own a profile; the profile must leave first (profiles_lifecycle_check)`,
    );
  }
  return deleted;
}

export async function countMarkedAuthUsers(client, prefix) {
  const result = await client.query(
    `select count(*)::integer as count from auth.users where email like $1 escape '\\'`,
    [harnessEmailPattern(prefix)],
  );
  return result.rows[0].count;
}

export class HarnessAbortedError extends Error {
  constructor(name) {
    super(`${name}: new work refused after the cause`);
    this.name = 'HarnessAbortedError';
  }
}

// Marca o trabalho do próprio guard (limpeza, censo, encerramento), que o
// sinal de abort não recusa.
const guardContext = new AsyncLocalStorage();
let installed = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function installHarnessGuard(
  name,
  { applicationPrefix, authEmailPrefix, settleMilliseconds = 20_000 },
) {
  if (installed) throw new Error(`${name}: the harness guard is installed once per process`);
  if (!applicationPrefix) throw new Error(`${name}: the harness guard needs an applicationPrefix`);
  installed = true;

  const abort = new AbortController();
  const requests = new AbortController();
  const inFlight = { queries: 0, requests: 0 };
  let cause;
  let refused = 0;
  let terminating = false;
  let databaseUrl;
  let cleanup = async () => {};
  let census = async () => {};

  const internal = () => guardContext.getStore() === true;
  const refusing = () => abort.signal.aborted && !internal();
  const refuse = () => {
    refused += 1;
    return Promise.reject(new HarnessAbortedError(name));
  };
  const counted = (kind, result) => {
    if (typeof result?.then !== 'function' || internal()) return result;
    inFlight[kind] += 1;
    const release = () => {
      inFlight[kind] -= 1;
    };
    result.then(release, release);
    return result;
  };

  // (a) A primeira falha é a causa; as seguintes aparecem depois dela.
  const fail = (label, reason) => {
    if (cause === undefined) {
      cause = reason ?? new Error(label);
      process.exitCode = 1;
      console.error(`not ok - ${name}:${label ? ` ${label}` : ''}`, reason);
    } else if (!(reason instanceof HarnessAbortedError)) {
      console.error(`# ${name}: after the cause,${label ? ` ${label}` : ''}`, reason?.message);
    }
    abort.abort();
  };

  // (b) O sinal de abort, consultado por toda query, conexão e requisição.
  const { Client } = pg;
  const query = Client.prototype.query;
  Client.prototype.query = function guardedQuery(config, ...rest) {
    if (refusing()) {
      const text = typeof config === 'string' ? config : (config?.text ?? '');
      if (/^\s*(commit|end)\b/i.test(text)) {
        refused += 1;
        return counted('queries', query.call(this, 'rollback')).then(() => {
          throw new HarnessAbortedError(name);
        });
      }
      if (!/^\s*(rollback|abort)\b/i.test(text)) return refuse();
    }
    return counted('queries', query.call(this, config, ...rest));
  };
  const connect = Client.prototype.connect;
  Client.prototype.connect = function guardedConnect(...args) {
    const applicationName = this.connectionParameters?.application_name ?? '';
    if (!applicationName.startsWith(applicationPrefix)) {
      return Promise.reject(
        new Error(
          `${name}: every harness connection needs an application_name starting with ${applicationPrefix}, got "${applicationName}"`,
        ),
      );
    }
    if (refusing()) return refuse();
    // Erro de conexão fora de query vira falha do harness, e não queda do
    // processo antes da limpeza. Durante o encerramento pelo guard, é esperado.
    this.on('error', (error) => {
      if (!terminating) fail('connection error:', error);
    });
    return connect.apply(this, args);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init = {}) {
    if (internal()) return fetch(input, init);
    if (refusing()) return refuse();
    const signal = init.signal ? AbortSignal.any([init.signal, requests.signal]) : requests.signal;
    return counted('requests', fetch(input, { ...init, signal }));
  };
  const log = console.log;
  console.log = (...args) => {
    if (refusing() && typeof args[0] === 'string' && /^ok\b/.test(args[0])) {
      log(`# ${name}: ignored after the cause: ${args[0]}`, ...args.slice(1));
      return;
    }
    log(...args);
  };

  process.on('unhandledRejection', (reason) => fail('unhandled promise rejection:', reason));

  const withGuardClient = (work) =>
    guardContext.run(true, async () => {
      const client = new Client({
        application_name: `${applicationPrefix}guard`,
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 15_000,
      });
      await client.connect();
      try {
        return await work(client);
      } finally {
        await client.end().catch(() => {});
      }
    });

  // (c) Trabalho em voo: main, promessas da barreira, queries e requisições.
  // Três leituras seguidas sem nada em voo contam como assentado.
  async function settle(isMainSettled) {
    const started = Date.now();
    let quiet = 0;
    for (;;) {
      const busy = {
        main: !isMainSettled(),
        tracked: trackedInFlight(),
        queries: inFlight.queries,
        requests: inFlight.requests,
      };
      const idle = !busy.main && busy.tracked + busy.queries + busy.requests === 0;
      quiet = idle ? quiet + 1 : 0;
      if (quiet >= 3) return { settled: true, elapsed: Date.now() - started };
      if (Date.now() - started > settleMilliseconds) {
        return { settled: false, elapsed: Date.now() - started, busy };
      }
      await delay(20);
    }
  }

  async function terminateHarnessConnections() {
    terminating = true;
    requests.abort();
    const { rows } = await withGuardClient((client) =>
      client.query(
        `select application_name, pg_terminate_backend(pid) as terminated
           from pg_stat_activity
          where application_name like $1 escape '\\' and pid <> pg_backend_pid()
          order by application_name`,
        [`${escapeLike(applicationPrefix)}%`],
      ),
    );
    return rows;
  }

  return {
    signal: abort.signal,
    throwIfAborted() {
      if (refusing()) throw new HarnessAbortedError(name);
    },
    useDatabase(connectionString) {
      databaseUrl = connectionString;
    },
    // A limpeza recebe a conexão do guard e apaga em ordem de FK: dependentes,
    // depois perfis. Os usuários Auth com a marca saem depois dela, pelo guard.
    onCleanup(callback) {
      cleanup = callback;
    },
    onCensus(callback) {
      census = callback;
    },
    // Devolve true quando main, a limpeza e o censo passaram.
    async run(main) {
      let mainSettled = false;
      const mainDone = Promise.resolve()
        .then(main)
        .then(
          () => {
            mainSettled = true;
          },
          (error) => {
            mainSettled = true;
            fail('', error);
          },
        );
      const aborted = new Promise((resolve) =>
        abort.signal.addEventListener('abort', resolve, { once: true }),
      );
      await Promise.race([mainDone, aborted]);
      abort.abort();

      const settled = await settle(() => mainSettled);
      if (cause !== undefined) {
        console.error(
          settled.settled
            ? `# ${name}: new work refused after the cause (${refused} refusals); in-flight work settled in ${settled.elapsed} ms`
            : `# ${name}: in-flight work did not settle in ${settled.elapsed} ms: ${JSON.stringify(settled.busy)}`,
        );
      }
      if (!settled.settled) {
        if (cause === undefined) fail('in-flight work did not settle:', settled.busy);
        if (databaseUrl !== undefined) {
          const terminated = await terminateHarnessConnections().catch((error) => error);
          console.error(
            `# ${name}: terminated the harness connections by application_name:`,
            terminated instanceof Error ? terminated.message : JSON.stringify(terminated),
          );
        }
      }

      if (databaseUrl === undefined) {
        if (cause === undefined) fail('the harness never declared its database', undefined);
        console.error(`# ${name}: no database declared; cleanup and census skipped`);
      } else {
        // (d) Limpeza do harness, depois a varredura de Auth pela marca.
        let cleanupError;
        await withGuardClient(async (client) => {
          try {
            await cleanup(client);
          } catch (error) {
            cleanupError = error;
          }
          if (authEmailPrefix !== undefined) {
            await sweepMarkedAuthUsers(client, authEmailPrefix).catch((error) => {
              cleanupError ??= error;
            });
          }
        }).catch((error) => {
          cleanupError ??= error;
        });
        if (cleanupError !== undefined) {
          process.exitCode = 1;
          console.error(
            cause === undefined
              ? `not ok - ${name}: cleanup failed:`
              : `# ${name}: cleanup also failed after the cause:`,
            cleanupError,
          );
        } else if (cause !== undefined) {
          console.error(`# ${name}: cleanup ran after the cause`);
        }

        // (e) Censo à parte, depois da limpeza.
        let censusError;
        await withGuardClient((client) => census(client)).catch((error) => {
          censusError = error;
        });
        if (censusError !== undefined) {
          process.exitCode = 1;
          console.error(`not ok - ${name}: residue census after the cleanup:`, censusError);
        } else if (cause !== undefined) {
          console.error(`# ${name}: residue census after the cleanup passed`);
        }
      }

      // (f) Saída com código 1. A causa é repetida no fim para quem lê só a
      // cauda do log, e um handle esquecido não segura o processo.
      if (cause !== undefined) {
        console.error(`# ${name}: failed; the cause is the first not ok above: ${cause?.message}`);
      }
      if (process.exitCode === 1) setTimeout(() => process.exit(1), 5_000).unref();
      return process.exitCode !== 1;
    },
  };
}
