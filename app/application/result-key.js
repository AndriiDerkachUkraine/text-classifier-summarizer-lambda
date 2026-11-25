import { createHash } from 'node:crypto';

/** `scope` includes the model version, so a model upgrade never serves stale answers. */
export function resultKey(scope, subject, body) {
  return createHash('sha256').update(JSON.stringify([scope, subject, body])).digest('base64url');
}
