# Text Classifier / Summarizer — AWS Lambda (Node.js)

An AWS Lambda function that takes a batch of short texts (e.g. emails) and either

- **classifies** each one into predefined topics (`finance`, `technical`, `hr`, `marketing`, `sales`, `legal`, `support`, fallback `other`), or
- **summarizes** each one in 1–2 sentences.

It ships with **two interchangeable model backends** behind one port:

| Backend | What it is | Keys | Cost per call |
|---|---|---|---|
| `local` *(default)* | Qwen2.5-1.5B-Instruct (4-bit GGUF, Apache-2.0) on CPU via llama.cpp | none | $0 |
| `anthropic` | Claude Haiku 5.5 via the Anthropic Messages API | `ANTHROPIC_API_KEY` | fractions of a cent per batch, logged per request |

There is also a `mock` backend (deterministic keyword rules) used by the tests.

```bash
npm ci
node app/run.js --input sample/emails.json --mode classify  --log-level INFO
node app/run.js --input sample/emails.json --mode summarize --log-level INFO
```

---

## Contents

1. [Quick start](#quick-start)
2. [Input and output](#input-and-output)
3. [Architecture](#architecture)
4. [Cost awareness](#cost-awareness)
5. [Error handling](#error-handling)
6. [Extending: new mode, new model](#extending-new-mode-new-model)
7. [Configuration](#configuration)
8. [Deploying to AWS](#deploying-to-aws)
9. [Tests](#tests)
10. [Known limitations](#known-limitations)

---

## Quick start

**Requirements:** Node.js 22+ (the Lambda runtime is `nodejs22.x`), ~1.5 GB free disk and ~2 GB RAM for the local model.
No cloud account or API key is needed for the default backend.

```bash
git clone https://github.com/AndriiDerkachUkraine/text-classifier-summarizer-lambda.git
cd text-classifier-summarizer-lambda
npm ci                     # exact versions from package-lock.json
```

### Run with the local model (default, offline)

```bash
node app/run.js --input sample/emails.json --mode classify  --log-level INFO
node app/run.js --input sample/emails.json --mode summarize --log-level INFO
```

On the first run, the model (1.1 GB) is downloaded once into `./models/` and **verified against the SHA-256 in
[`models.lock.json`](models.lock.json)**. That file is the model's lock file: it pins the exact Hugging Face commit and hash, like `package-lock.json` does for npm. After that, everything runs offline. You can also download the model ahead of time:

```bash
npm run models:fetch
```

### Run with Claude (API)

```bash
cp .env.example .env       # then put your key into ANTHROPIC_API_KEY (.env is git-ignored)
node app/run.js --input sample/emails.json --mode classify --provider anthropic
```

`app/run.js` loads `.env` automatically. `--provider` overrides `MODEL_PROVIDER`.

> The Claude adapter is covered by unit tests with a mocked client (request shape, structured outputs, batching, parsing, refusals, missing key). It was not run against the live API during development: the default local backend fully covers the assignment, which asks for one working backend.

### CLI options

```
--input, -i       JSON file: an array of { id, subject, body } (or { "items": [...] })
--mode, -m        classify | summarize
--log-level, -l   DEBUG | INFO | WARN | ERROR (default: INFO)
--provider, -p    local | anthropic | mock (default: $MODEL_PROVIDER or "local")
--topics          comma-separated topic list for classify (default: built-in list)
--output, -o      write the result to a file instead of stdout
```

The result goes to **stdout** and the logs (JSON lines) go to **stderr**, so you can redirect the output to a file or pipe it into `jq`.

### Sample data

- [`sample/emails.json`](sample/emails.json): the four emails from the assignment, with realistic bodies.
- [`sample/emails-edge-cases.json`](sample/emails-edge-cases.json): sales, legal and support emails, a Norwegian email, a prompt-injection attempt, duplicates, quoted reply history, an over-long body, a subject-only item, and five invalid items (wrong types, no id, not an object, empty).

---

## Input and output

### Lambda event

```json
{
  "mode": "classify",
  "items": [
    { "id": 1, "subject": "Invoice #1234 overdue", "body": "Dear customer..." },
    { "id": 4, "subject": "", "body": " " }
  ],
  "topics": ["billing", "spam"]
}
```

`topics` is optional (classify only). It can be an array of names or a `{ "name": "description" }` object.
The handler accepts this event directly (SDK / Step Functions / `run.js`) **and** in API Gateway / Function URL form (JSON string in `body`). In the second case it returns `{ statusCode, headers, body }`.

### Output — real output of the local model on `sample/emails.json`

Decoding is greedy, so the output is repeatable on a given machine. Between platforms (Windows / Linux builds of llama.cpp) the wording of a summary can differ slightly because of floating-point differences; topics were identical in every environment tested.

```json
[
  { "id": 1, "topics": ["finance"] },
  { "id": 2, "topics": ["technical"] },
  { "id": 3, "topics": ["hr", "marketing"] },
  { "id": 4, "error": "empty_input" }
]
```

```json
[
  { "id": 1, "summary": "Invoice #1234 for $2,450.00 is overdue and requires payment by November 30 to avoid a late fee of 2%. Accounts Receivable is requesting payment details from the customer if they have already paid." },
  { "id": 2, "summary": "Weekly engineering sync meeting: updates on payments API migration to Node 22, database outage post-mortem, and on-call rotation for December. Updates due by 10:00 on Thursday." },
  { "id": 3, "summary": "Company invites employees to an annual retreat in the Carpathians on June 12-14. HR needs confirmation by May 1." },
  { "id": 4, "error": "empty_input" }
]
```

Every request ends with a single summary log line, for example:

```json
{"level":"INFO","msg":"request completed","mode":"classify","provider":"local","model":"qwen2.5-1.5b-instruct",
 "items":4,"succeeded":3,"failed":1,"errors":{"empty_input":1},"cacheHits":0,"duplicatesSkipped":0,
 "modelCalls":1,"retriedItems":0,"inputTokens":664,"outputTokens":115,"durationMs":10138}
```

Tokens are counted for both backends; with `anthropic`, the line also contains `estimatedCostUsd`.

---

## Architecture

The code is layered as **ports & adapters (hexagonal)**. Dependencies point inwards only: the domain knows nothing about Lambda, SDKs or models.

```
app/
├── run.js                      CLI adapter: simulates Lambda locally
├── handler.js                  Lambda adapter: event parsing, wiring, HTTP vs direct invoke
├── config.js                   all settings from env vars
├── domain/                     pure logic, no I/O
│   ├── email.js                validation, cleanup (quoted replies, whitespace), truncation
│   ├── errors.js               item-level error codes, request errors
│   └── modes/                  one file per mode + registry
│       ├── classify.js         topics, prompt, JSON schema, answer normalization
│       └── summarize.js        prompt, schema, 1–2 sentence guarantee
├── application/                use case + ports
│   ├── process-batch.js        validate → cache → dedupe → batch → model → normalize → retry
│   ├── ports.js                ModelProvider / ResultCache / Logger contracts (JSDoc)
│   └── result-key.js
└── infrastructure/             adapters
    ├── providers/
    │   ├── anthropic.js        Claude: batched, structured outputs, usage → cost
    │   ├── local-llm.js        llama.cpp: grammar-constrained JSON, one email per prompt
    │   ├── mock.js             keyword rules for tests
    │   ├── llm-prompt.js       prompt pieces shared by both LLM adapters
    │   └── index.js            factory with lazy imports
    ├── models/model-store.js   download + SHA-256 verification of local models
    ├── logger.js               structured JSON logger
    └── result-cache.js         in-memory LRU (warm-container cache)
```

### Request flow

```
event ─► handler ─► getMode(mode) ─► processItems(items, mode, provider)
                                       │
                                       ├─ validate each item ──► invalid → { id, error } (no model call)
                                       ├─ result cache hit   ──► answer from memory
                                       ├─ identical texts    ──► sent once, result fanned out
                                       ├─ chunk by provider.batchSize, bounded concurrency
                                       ├─ provider.run(...)  ──► raw answers (per item, or Error)
                                       ├─ mode.normalize()   ──► never trust the model blindly
                                       └─ retry failed items once (only them; skipped for deterministic models)
                                     ◄─ results in input order + stats log
```

### Why one mode contract serves both models

Every mode describes itself with `llm.instructions(ctx)` and `llm.resultSchema(ctx)`. Both bundled backends need only that:

- the **Claude adapter** wraps the schema into a batch schema and sends it as **structured outputs** (`output_config.format`), so the API guarantees schema-valid JSON;
- the **local adapter** compiles the same schema into a **llama.cpp grammar**, so the small model can only produce valid JSON with allowed values.

As a result, a new mode runs on both backends without touching either adapter, and an invented topic name is impossible by construction. For classify, the schema asks for `{ primary, secondary | "none" }` instead of a free-length array: this caps the answer at two topics and makes the model commit to the main topic first. Without that, small models tend to tick every box.

---

## Cost awareness

Cost here means API money for the `anthropic` backend and CPU time / memory for `local`. Both are treated as budgets.

| Lever | Where | Effect |
|---|---|---|
| **Validate before the model** | `domain/email.js` | Empty or invalid items never cost a token or a CPU cycle. |
| **Strip noise** | `cleanText()` | Quoted reply history (`> ...`) and whitespace runs are removed; they carry no meaning but are billed. |
| **Truncate long bodies** | `MAX_INPUT_CHARS` (1200) | Bounds the worst-case cost per item; a warning is logged when it happens. |
| **De-duplicate** | `process-batch.js` | Identical texts in one request go to the model once. |
| **Result cache** | `result-cache.js` | Module-scope LRU survives warm Lambda invocations: re-delivered or repeated emails are free. The key includes the exact model version, so a model upgrade never serves stale answers. |
| **Batching** | `ANTHROPIC_BATCH_SIZE` (10) | Up to 10 emails share one request, so instructions and schema are paid once per batch instead of once per email. |
| **Cheapest sufficient model** | `claude-haiku-5-5`, `effort: low` | Classification and short summaries do not need a large model or long thinking. Switch with `ANTHROPIC_MODEL` if quality ever requires it. |
| **No retry loops for bad JSON** | structured outputs / grammars | The answer always matches the schema, so there are no "please fix your JSON" round-trips. |
| **Targeted retries** | `process-batch.js` | Only the items that failed are re-sent, once. Deterministic backends (local with greedy decoding, mock) are not retried at all: they would return the same answer. Transport errors are retried with backoff by the SDK. |
| **Compact prompt format** | `llm-prompt.js` | Emails are sent as tagged plain text, not JSON (no escaping, no repeated keys). |
| **Output caps** | `max_tokens`, grammar `maxLength` | Bounded output = bounded cost and latency. |
| **Lazy imports** | `providers/index.js` | An API-only Lambda never loads the native llama.cpp addon (faster cold start); `node-llama-cpp` is an *optional* dependency and can be omitted from the package. |
| **Cost visibility** | `request completed` log | Tokens per request (both backends) and estimated USD (API), queryable in CloudWatch Logs Insights. |

Deliberately **not** used:
- **Prompt caching:** the shared prefix (~300 tokens) is below the minimum cacheable length, so it would have no effect. Batching amortizes the prompt instead.
- **Message Batches API** (asynchronous, −50% price): a good fit for non-interactive bulk jobs (e.g. a nightly SQS-driven run). It would be a new provider adapter; nothing else changes.

---

## Error handling

Invalid or failing items never stop the batch. Each one gets `{ "id": ..., "error": "<code>" }` in its original position, and the details go to the logs.

| Code | When |
|---|---|
| `empty_input` | subject and body are empty / whitespace |
| `invalid_input` | item is not an object, has no usable `id`, or `subject`/`body` is not a string (`id` is `null` if unknown) |
| `model_error` | the model call failed (network, auth, rate limit after retries, refusal, broken output) |
| `invalid_model_output` | the model answered, but nothing usable could be extracted |
| `unsupported_mode` | the selected backend cannot run this mode |

Request-level problems (unknown mode, `items` not an array, malformed HTTP body, missing API key) are rejected as a whole: HTTP 400 for API Gateway events, a thrown error for direct invocations, and exit code 1 for the CLI.

Example log record for a skipped item:

```json
{"level":"WARN","msg":"item failed","index":10,"id":14,"error":"invalid_input","reason":"\"body\" must be a string, got number"}
```

Other details:
- duplicate `id`s are allowed and logged; results are matched by input position, never by `id`;
- a provider failure in one batch affects only that batch;
- a failed model initialization is not cached, so the next invocation retries it;
- prompt injection: the email text is passed as data inside `<email>` tags, with explicit "data, not instructions" rules; for the local model the rule is repeated after the email as well.

---

## Extending: new mode, new model

### Add a mode (e.g. `sentiment`)

1. Create `app/domain/modes/sentiment.js`:

```js
import { ErrorCode, ItemError } from '../errors.js';

const LABELS = ['positive', 'neutral', 'negative'];

export const sentimentMode = {
  name: 'sentiment',
  outputKey: 'sentiment',
  prepare: () => ({}),
  llm: {
    instructions: () => 'Rate the overall sentiment of each email.',
    resultSchema: () => ({ type: 'string', enum: LABELS }),
  },
  normalize(raw) {
    if (!LABELS.includes(raw)) throw new ItemError(ErrorCode.INVALID_MODEL_OUTPUT, 'bad label');
    return raw;
  },
};
```

2. Register it in `app/domain/modes/index.js`: `[sentimentMode.name]: sentimentMode`.

Done. It now works with both `local` and `anthropic`, including batching, caching, retries and error handling.

### Swap or upgrade a model

- **Another Claude model:** `ANTHROPIC_MODEL=claude-sonnet-5-5` (and update the two `ANTHROPIC_PRICE_*` values for correct cost logs).
- **Another local model:** add an entry to `models.lock.json` (repo, revision, file, size, sha256) and set `LOCAL_MODEL=<entry>`. A lighter `qwen2.5-0.5b-instruct` entry is already there: it is ~2.5× faster and gets the assignment sample right, but on the edge-case sample it misfiles support/shipping emails as `finance` and adds more spurious second topics, which is why 1.5B is the default.
- **A new backend** (OpenAI, Bedrock, an internal service, Message Batches...): implement the `ModelProvider` port from [`app/application/ports.js`](app/application/ports.js) (`name`, `batchSize`, `maxConcurrency`, `pricing`, `modelId`, `supports`, `run`) and add one line to the factory in `app/infrastructure/providers/index.js`. [`mock.js`](app/infrastructure/providers/mock.js) shows the minimum, in ~50 lines.

Every provider returns, per item, a value shaped like the mode's `llm.resultSchema` (e.g. `{ primary, secondary }` for classify). `mode.normalize` turns that into the public output, so the output format never depends on the backend.

---

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)); none are required for the default local run.

| Variable | Default | Purpose |
|---|---|---|
| `MODEL_PROVIDER` | `local` | `local` \| `anthropic` \| `mock` |
| `LOG_LEVEL` | `INFO` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `MAX_INPUT_CHARS` | `1200` | body length cap per item |
| `CONCURRENCY` | `2` | parallel provider calls (capped by the provider) |
| `RETRY_FAILED_ONCE` | `true` | re-send failed items once (non-deterministic providers only) |
| `RESULT_CACHE_SIZE` | `500` | entries in the warm-container LRU cache |
| `ANTHROPIC_API_KEY` | — | required for `anthropic` |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Claude model id |
| `ANTHROPIC_BATCH_SIZE` | `10` | emails per request |
| `ANTHROPIC_EFFORT` | `low` | thinking effort |
| `ANTHROPIC_PRICE_INPUT_PER_MTOK` / `..._OUTPUT_...` | `0.1` / `0.5` | USD per 1M tokens, for cost logs |
| `LOCAL_MODEL` | `qwen2.5-1.5b-instruct` | entry in `models.lock.json` |
| `MODEL_CACHE_DIR` | `./models` | where model files live (`/tmp/...` or baked into the image on Lambda) |
| `LOCAL_MODELS_OFFLINE` | `false` | `true` = never download, fail if the model is missing |
| `LOCAL_GPU` | `false` | `auto` = use Metal / CUDA / Vulkan if available |
| `LOCAL_THREADS` | auto | inference threads; auto = physical cores, capped by the CPUs available to the process |

---

## Deploying to AWS

The function is a standard Node.js handler: `app/handler.handler`. [`template.yaml`](template.yaml) (AWS SAM) describes two variants of the same code:

- **API variant:** zip package, 256 MB, `MODEL_PROVIDER=anthropic`. Package it without the optional native dependency (`npm ci --omit=dev --omit=optional`) so it stays far below the 250 MB zip limit. In production, store the key in Secrets Manager / SSM rather than in a plain env var.
- **Local-model variant:** a container image ([`Dockerfile`](Dockerfile)) with the model baked in at build time (verified by hash) and `LOCAL_MODELS_OFFLINE=true`. Only the CPU build of llama.cpp is kept (`node_modules` 124 MB instead of 825 MB). 4 GB memory, because Lambda allocates CPU proportionally to memory.

Try the image locally with the Lambda Runtime Interface Emulator that ships in the base image:

```bash
docker build -t text-classifier-summarizer .
# --cpuset-cpus makes the container see only 2 CPUs, like a ~4 GB Lambda
docker run -p 9000:8080 --memory 4g --cpuset-cpus 0-1 text-classifier-summarizer
curl -XPOST localhost:9000/2015-03-31/functions/function/invocations \
     -d '{"mode":"classify","items":[{"id":1,"subject":"Invoice overdue","body":"Please pay by Friday"}]}'
```

Measured this way (Amazon Linux 2023, 2 vCPU, 4 GB): ~3 s model load on a cold start, then ~5 s per email for classify and ~6 s per email for summarize; peak memory ~3 GB. With the default 300 s timeout, keep local batches to roughly 40 emails per invocation (or raise the timeout, up to 900 s).

> Verified: the image builds and runs under the Lambda emulator (direct, HTTP and error events), and `template.yaml` passes `cfn-lint`. It was not deployed to an AWS account.

---

## Tests

```bash
npm test
```

48 tests on the built-in `node:test` runner (no test dependencies, no network, no model files):

- **domain:** validation of every invalid-input kind, text cleanup, truncation, topic normalization, the summary sentence limit;
- **use case:** input order, dedupe, cache, batching, targeted retry, no retry for deterministic providers, isolated batch failure, unsupported mode, cost estimate, concurrency limit;
- **adapters:** the Claude request shape (structured outputs, effort, no sampling params), parsing, refusal / truncated JSON, missing key; the local schema/grammar helpers;
- **end to end:** the Lambda handler (direct and HTTP events) and the CLI process itself.

---

## Known limitations

- **The local model is small (1.5B).** It gets the topics right on the sample set, but it is weaker than Claude at nuance. It summarizes non-English emails in English, sometimes adds a detail that is not in the email (e.g. a "5 PM" deadline for a subject-only reminder) or a label such as "Action: ...", and **does not reliably resist prompt injection** (the injection sample tricks it, despite the guards). The trade-off is intentional: `local` gives zero cost and full data privacy, `anthropic` gives quality. Switching between them is a config change.
- **Local speed:** about 2–3 s per email for classify and 4–5 s for summarize on a desktop CPU (Ryzen 7 5700G, 8 threads), ~5–6 s on 2 Lambda vCPUs, plus ~2–3 s model load on a cold start. Fine for small batches; for high volume, use the API backend.
- **Sentence limiting** uses the standard ICU segmenter. It keeps amounts such as `2.5%` intact but may split after abbreviations such as "Dr.".
- **Windows:** llama.cpp's prebuilt binaries need an up-to-date *Microsoft Visual C++ Redistributable*. With an outdated one (e.g. 14.28 from 2020), native code crashes with a segmentation fault. Fix: `winget install Microsoft.VCRedist.2015+.x64`.
- `node_modules` includes prebuilt llama.cpp binaries for several GPU backends of your platform (a few hundred MB). They are optional: the API variant omits them, the container image keeps only the CPU build.
