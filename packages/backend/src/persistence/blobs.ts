/**
 * §12.7 binary storage:
 *   chunk bodies  DATA_DIR/chunks/<bet>/<witness>/<index>
 *   exhibits      DATA_DIR/exhibits/<bet>/<eid>
 *   misc blobs    DATA_DIR/blobs/<namespace>/<key>  (scene crops, TTS cache, …)
 * Path segments are validated so a request can never escape DATA_DIR.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_CHUNK_BODY_BYTES } from '@verdict/engine';
import { ApiError } from '../errors.js';
import { isPubkey } from '../util/bytes.js';

const EXHIBIT_RE = /^E[1-9][0-9]{0,4}$/;
const SAFE_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

function checkPubkey(k: string, what: string): void {
  if (!isPubkey(k)) throw new ApiError('NOT_FOUND', `bad ${what} ${k}`);
}

function checkIndex(i: number): void {
  if (!Number.isSafeInteger(i) || i < 0 || i > 0xffffffff) throw new ApiError('NOT_FOUND', `bad chunk index ${i}`);
}

function checkSafe(s: string, what: string): void {
  if (!SAFE_RE.test(s) || s.includes('..')) throw new ApiError('NOT_FOUND', `bad ${what} ${s}`);
}

export class BlobStore {
  private readonly mem: Map<string, Uint8Array> | null;

  /** `dataDir` null ⇒ in-memory (tests). */
  constructor(readonly dataDir: string | null) {
    this.mem = dataDir ? null : new Map();
  }

  chunkPath(bet: string, witness: string, index: number): string {
    checkPubkey(bet, 'bet');
    checkPubkey(witness, 'witness');
    checkIndex(index);
    return join('chunks', bet, witness, String(index));
  }

  exhibitPath(bet: string, eid: string): string {
    checkPubkey(bet, 'bet');
    if (!EXHIBIT_RE.test(eid)) throw new ApiError('NOT_FOUND', `bad exhibit id ${eid}`);
    return join('exhibits', bet, eid);
  }

  blobPath(namespace: string, key: string): string {
    checkSafe(namespace, 'namespace');
    checkSafe(key, 'key');
    return join('blobs', namespace, key);
  }

  /** Stores a chunk body; enforces MAX_CHUNK_BODY_BYTES (CHUNK_TOO_LARGE, 413). Returns its sha256 hex. */
  putChunk(bet: string, witness: string, index: number, body: Uint8Array): string {
    if (body.length > MAX_CHUNK_BODY_BYTES) throw new ApiError('CHUNK_TOO_LARGE');
    return this.write(this.chunkPath(bet, witness, index), body);
  }

  getChunk(bet: string, witness: string, index: number): Uint8Array | null {
    return this.read(this.chunkPath(bet, witness, index));
  }

  hasChunk(bet: string, witness: string, index: number): boolean {
    return this.exists(this.chunkPath(bet, witness, index));
  }

  putExhibit(bet: string, eid: string, body: Uint8Array): string {
    return this.write(this.exhibitPath(bet, eid), body);
  }

  getExhibit(bet: string, eid: string): Uint8Array | null {
    return this.read(this.exhibitPath(bet, eid));
  }

  putBlob(namespace: string, key: string, body: Uint8Array): string {
    return this.write(this.blobPath(namespace, key), body);
  }

  getBlob(namespace: string, key: string): Uint8Array | null {
    return this.read(this.blobPath(namespace, key));
  }

  /** Absolute file path for streaming (null in memory mode). */
  absolute(rel: string): string | null {
    return this.dataDir ? join(this.dataDir, rel) : null;
  }

  /** Removes all chunks of a bet (close-out). */
  deleteBetChunks(bet: string): void {
    checkPubkey(bet, 'bet');
    const prefix = join('chunks', bet);
    if (this.mem) {
      for (const k of [...this.mem.keys()]) if (k.startsWith(prefix)) this.mem.delete(k);
      return;
    }
    rmSync(join(this.dataDir!, prefix), { recursive: true, force: true });
  }

  size(rel: string): number | null {
    if (this.mem) return this.mem.get(rel)?.length ?? null;
    const p = join(this.dataDir!, rel);
    return existsSync(p) ? statSync(p).size : null;
  }

  private write(rel: string, body: Uint8Array): string {
    const digest = createHash('sha256').update(body).digest('hex');
    if (this.mem) {
      this.mem.set(rel, Uint8Array.from(body));
      return digest;
    }
    const p = join(this.dataDir!, rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, p);
    return digest;
  }

  private read(rel: string): Uint8Array | null {
    if (this.mem) {
      const v = this.mem.get(rel);
      return v ? Uint8Array.from(v) : null;
    }
    const p = join(this.dataDir!, rel);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  }

  private exists(rel: string): boolean {
    return this.mem ? this.mem.has(rel) : existsSync(join(this.dataDir!, rel));
  }
}
