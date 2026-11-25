/** JSON-lines logger (CloudWatch-friendly) on stderr, so stdout carries only the result. */

const LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 });

/** "info" / "warning" / undefined → a known level name. */
function parseLevel(value) {
  const name = String(value ?? '').trim().toUpperCase();
  const resolved = name === 'WARNING' ? 'WARN' : name;
  return resolved in LEVELS ? resolved : 'INFO';
}

/** @returns {import('../application/ports.js').Logger} */
export function createLogger({ level, sink = (line) => process.stderr.write(`${line}\n`), context = {} } = {}) {
  const threshold = LEVELS[parseLevel(level)];

  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] >= threshold) sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...context, ...fields }));
  };

  return {
    debug: (msg, fields) => emit('DEBUG', msg, fields),
    info: (msg, fields) => emit('INFO', msg, fields),
    warn: (msg, fields) => emit('WARN', msg, fields),
    error: (msg, fields) => emit('ERROR', msg, fields),
  };
}
