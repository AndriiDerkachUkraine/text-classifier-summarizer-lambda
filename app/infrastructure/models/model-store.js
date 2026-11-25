/**
 * Model files pinned by models.lock.json (Hugging Face commit + SHA-256), like package-lock
 * for npm: a download is accepted only if its hash matches.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** @typedef {{ repo: string, revision: string, file: string, size: number, sha256: string }} ModelSpec */

export async function readModelSpec(lockFile, name) {
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  const spec = lock[name];
  if (!spec) throw new Error(`model "${name}" is not listed in ${path.basename(lockFile)} (available: ${Object.keys(lock).join(', ')})`);
  return spec;
}

const exists = async (file) => stat(file).then((s) => s, () => null);

/**
 * Returns the model path, downloading and verifying it first if needed.
 * @param {ModelSpec} spec
 * @param {{ dir: string, offline?: boolean, logger?: import('../../application/ports.js').Logger }} options
 */
export async function ensureModelFile(spec, { dir, offline = false, logger }) {
  const target = path.join(dir, spec.file);

  // Hash was checked on download; a size check avoids re-hashing 1 GB on every cold start.
  const existing = await exists(target);
  if (existing?.size === spec.size) return target;

  if (offline) {
    throw new Error(`model file ${target} is missing and LOCAL_MODELS_OFFLINE=true; run "npm run models:fetch" first`);
  }

  await mkdir(dir, { recursive: true });
  const url = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${spec.file}`;
  const partial = `${target}.part`;
  logger?.info('downloading local model (one-time)', { url, sizeMb: Math.round(spec.size / 1e6) });

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`model download failed: HTTP ${response.status} for ${url}`);

  const hash = createHash('sha256');
  let received = 0;
  let nextReport = 0.1;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (received / spec.size >= nextReport) {
        logger?.info('download progress', { percent: Math.round((received / spec.size) * 100) });
        nextReport += 0.1;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  const digest = hash.digest('hex');
  if (digest !== spec.sha256) {
    await rm(partial, { force: true });
    throw new Error(`checksum mismatch for ${spec.file}: expected ${spec.sha256}, got ${digest}`);
  }
  // Atomic publish: a crashed download never leaves a half-written model.
  await rename(partial, target);

  logger?.info('local model verified and stored', { file: target });
  return target;
}
