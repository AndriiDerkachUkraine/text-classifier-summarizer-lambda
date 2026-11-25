/** "summarize" mode: a 1–2 sentence summary per text. */
import { ErrorCode, ItemError } from '../errors.js';

const MAX_SENTENCES = 2;

// ICU splitter: unlike splitting on ".", keeps amounts like "2.5%" intact.
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Enforces the 1–2 sentence contract whatever the model returns. */
export function limitSentences(text, max = MAX_SENTENCES) {
  return [...segmenter.segment(text)]
    .map((s) => s.segment.trim())
    .filter(Boolean)
    .slice(0, max)
    .join(' ');
}

export const summarizeMode = {
  name: 'summarize',
  outputKey: 'summary',

  prepare() {
    return {};
  },

  llm: {
    instructions: () =>
      [
        'Summarize each email in 1-2 short sentences, at most 40 words in total.',
        'Say what the email is about. Include the requested action, amounts and deadlines that the email itself mentions;',
        'never add facts that are not in the email and never comment on what is missing.',
        'Use the same language as the email. Start directly with the content:',
        'no labels, no lists, no "This email..." preamble.',
      ].join('\n'),
    resultSchema: () => ({ type: 'string' }),
  },

  normalize(raw) {
    if (typeof raw !== 'string') throw new ItemError(ErrorCode.INVALID_MODEL_OUTPUT, 'summary is not a string');
    const cleaned = raw
      .replace(/^\s*summary\s*:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const summary = limitSentences(cleaned);
    if (!summary) throw new ItemError(ErrorCode.INVALID_MODEL_OUTPUT, 'summary is empty');
    return summary;
  },
};
