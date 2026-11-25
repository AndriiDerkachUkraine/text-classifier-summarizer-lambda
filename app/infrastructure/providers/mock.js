/** Keyword rules, not a model: instant and offline, for tests and smoke runs. */
import { FALLBACK_TOPIC } from '../../domain/modes/classify.js';
import { limitSentences } from '../../domain/modes/summarize.js';

const KEYWORDS = {
  finance: ['invoice', 'payment', 'overdue', 'billing', 'budget', 'expense', 'refund'],
  technical: ['deploy', 'outage', 'server', 'bug', 'api', 'engineering', 'incident', 'database'],
  hr: ['hiring', 'onboarding', 'vacation', 'benefits', 'retreat', 'team building', 'policy'],
  marketing: ['campaign', 'newsletter', 'promotion', 'brand', 'social media', 'launch event'],
  sales: ['quote', 'deal', 'lead', 'proposal', 'pricing'],
  legal: ['contract', 'compliance', 'gdpr', 'privacy', 'nda'],
  support: ['ticket', 'complaint', 'cannot log in', 'help', 'issue'],
};

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words only ("issued" ≠ "issue"); custom topics match their own name.
const topicPattern = (topic) => new RegExp(`\\b(${(KEYWORDS[topic] ?? [topic]).map(escape).join('|')})\\b`, 'i');

export function createMockProvider() {
  const patterns = new Map();

  const handlers = {
    classify: (item, { topics }) => {
      const hits = Object.keys(topics).filter((topic) => {
        if (!patterns.has(topic)) patterns.set(topic, topicPattern(topic));
        return patterns.get(topic).test(item.text);
      });
      return { primary: hits[0] ?? FALLBACK_TOPIC, secondary: hits[1] ?? 'none' };
    },
    // "Lead" baseline: the first sentence of the body, or the subject.
    summarize: (item) => limitSentences(item.body, 1) || item.subject,
  };

  return {
    name: 'mock',
    batchSize: 50,
    maxConcurrency: Infinity,
    pricing: null,
    deterministic: true,
    modelId: () => 'keyword-rules-v1',
    supports: (mode) => mode.name in handlers,
    async run(mode, items, ctx) {
      return { results: new Map(items.map((item) => [item.key, handlers[mode.name](item, ctx)])) };
    },
  };
}
