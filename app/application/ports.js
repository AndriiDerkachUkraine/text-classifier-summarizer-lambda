/**
 * Contracts the use case depends on; adapters in infrastructure/ implement them.
 *
 * @typedef {import('../domain/email.js').WorkItem} WorkItem
 * @typedef {import('../domain/modes/index.js').Mode} Mode
 *
 * @typedef {object} ModelProvider
 * @property {string} name
 * @property {number} batchSize                  max items per run()
 * @property {number} maxConcurrency             max parallel run() calls
 * @property {{ inputPerMTok: number, outputPerMTok: number } | null} pricing  USD, null = free
 * @property {boolean} [deterministic]           same input ⇒ same output, so no retries
 * @property {(mode: Mode) => string} modelId    part of the cache key
 * @property {(mode: Mode) => boolean} supports
 * @property {(mode: Mode, items: WorkItem[], ctx: object, logger: Logger)
 *   => Promise<{ results: Map<number, unknown>, usage?: { inputTokens: number, outputTokens: number } }>} run
 *   One value per item key, shaped like `mode.llm.resultSchema` (or an Error); missing keys count as failures.
 *
 * @typedef {{ get(key: string): unknown, set(key: string, value: unknown): void }} ResultCache
 * @typedef {Record<'debug' | 'info' | 'warn' | 'error', (msg: string, fields?: object) => void>} Logger
 */

export {};
