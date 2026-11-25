/**
 * Mode registry. A new mode = one file + one line in MODES; LLM backends need no changes.
 *
 * @typedef {object} Mode
 * @property {string} name
 * @property {string} outputKey                       result field in the output item
 * @property {(options?: object) => object} prepare   per-request context (e.g. topics)
 * @property {{ instructions: (ctx: object) => string, resultSchema: (ctx: object) => object }} llm
 * @property {(raw: unknown, ctx: object) => unknown} normalize
 */
import { RequestError } from '../errors.js';
import { classifyMode } from './classify.js';
import { summarizeMode } from './summarize.js';

const MODES = Object.freeze({
  [classifyMode.name]: classifyMode,
  [summarizeMode.name]: summarizeMode,
});

export function getMode(name) {
  const mode = MODES[String(name ?? '').toLowerCase()];
  if (!mode) throw new RequestError(`unknown mode "${name}", expected one of: ${Object.keys(MODES).join(', ')}`, 'unknown_mode');
  return mode;
}
