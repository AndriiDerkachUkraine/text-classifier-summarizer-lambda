/** Input validation and cleanup, done before any model call. */
import { ErrorCode } from './errors.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isValidId = (id) => (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.trim() !== '');

/** Drops quoted replies ("> ...") and extra whitespace: billed as tokens, useless to the model. */
export function cleanText(text) {
  const collapse = (s) => s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*\n\s*/g, '\n\n').trim();
  const withoutQuotes = collapse(
    text
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('>'))
      .join('\n'),
  );
  return withoutQuotes || collapse(text);
}

/** Cuts to `maxChars`, at a word boundary when that loses little text. */
export function truncate(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return { text: `${(lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`, truncated: true };
}

/**
 * `key` is the input position: results are matched by it, so duplicate user ids are harmless.
 * @typedef {{ key: number, id: string|number, subject: string, body: string, text: string }} WorkItem
 */

/**
 * @param {unknown} raw  item as received in the event
 * @param {number} index position in the input (becomes `WorkItem.key`)
 * @param {{ maxChars: number }} limits
 * @returns {{ ok: true, item: WorkItem, warnings: string[] }
 *         | { ok: false, id: string|number|null, error: string, reason: string }}
 */
export function validateItem(raw, index, { maxChars }) {
  if (!isPlainObject(raw)) {
    return { ok: false, id: null, error: ErrorCode.INVALID_INPUT, reason: `item at index ${index} is not an object` };
  }

  const id = isValidId(raw.id) ? raw.id : null;
  if (id === null) {
    return { ok: false, id: raw.id ?? null, error: ErrorCode.INVALID_INPUT, reason: `item at index ${index} has no valid "id"` };
  }

  for (const field of ['subject', 'body']) {
    const value = raw[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { ok: false, id, error: ErrorCode.INVALID_INPUT, reason: `"${field}" must be a string, got ${typeof value}` };
    }
  }

  const subject = cleanText(raw.subject ?? '');
  const body = cleanText(raw.body ?? '');
  if (!subject && !body) {
    return { ok: false, id, error: ErrorCode.EMPTY_INPUT, reason: 'subject and body are empty' };
  }

  const warnings = [];
  const { text, truncated } = truncate(body, maxChars);
  if (truncated) warnings.push(`body truncated from ${body.length} to ${maxChars} chars`);

  return { ok: true, item: { key: index, id, subject, body: text, text: [subject, text].filter(Boolean).join('\n\n') }, warnings };
}
