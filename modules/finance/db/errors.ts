/**
 * Driver-independent reading of the one SQLite failure the app reacts to:
 * a UNIQUE (or PRIMARY KEY) violation, which the queue routes turn into a 409.
 *
 * The shape of the error has moved between `@libsql/client` releases:
 *   ≤ 0.14  `LibsqlError.code === 'SQLITE_CONSTRAINT_UNIQUE'`
 *   ≥ 0.18  `code === 'SQLITE_CONSTRAINT'` (the primary result code) and the
 *           extended code in a new `extendedCode` field
 * and the remote (Turso/hrana) transport relays whatever the server sends.
 * So: accept the extended code in either field, and fall back to SQLite's
 * own message, which has read "UNIQUE constraint failed: …" for twenty years.
 * Deliberately not `instanceof LibsqlError` — a duplicated package copy or a
 * wrapped error would silently turn a 409 into a 500 (and did, once).
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; extendedCode?: unknown; message?: unknown; cause?: unknown };
  const codes = [e.code, e.extendedCode].filter((c): c is string => typeof c === 'string');
  if (codes.some((c) => c === 'SQLITE_CONSTRAINT_UNIQUE' || c === 'SQLITE_CONSTRAINT_PRIMARYKEY')) return true;
  if (typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message)) return true;
  return e.cause !== undefined && e.cause !== err ? isUniqueViolation(e.cause) : false;
}
