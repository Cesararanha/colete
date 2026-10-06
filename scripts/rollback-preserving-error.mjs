// A broken connection may reject ROLLBACK too. Keep the proof failure first,
// including its SQLSTATE, while retaining the rollback failure for diagnosis.
export async function rollbackPreservingError(client, error) {
  try {
    await client.query('rollback');
    return error;
  } catch (rollbackError) {
    const combined = new AggregateError([error, rollbackError], 'Proof and rollback failed', {
      cause: error,
    });
    combined.code = error?.code;
    return combined;
  }
}
