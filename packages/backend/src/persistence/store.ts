/**
 * §12.7 persistence: JSON files under `DATA_DIR` (no external database).
 *
 * Each collection is one file `DATA_DIR/db/<name>.json` holding
 * `{ "<id>": <record>, ... }`, kept in memory and rewritten atomically
 * (write temp + rename) after every mutation. Records must be plain JSON
 * (no bigint, no Uint8Array: store u64 as decimal strings, bytes as base64/hex).
 * Reads return deep copies, so callers must write back through set/update.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../errors.js';

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export class Collection<T> {
  private readonly map = new Map<string, T>();

  constructor(
    readonly name: string,
    private readonly file: string | null,
  ) {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, T>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get(id: string): T | undefined {
    const v = this.map.get(id);
    return v === undefined ? undefined : structuredClone(v);
  }

  /** Like get, but throws NOT_FOUND. */
  require(id: string): T {
    const v = this.get(id);
    if (v === undefined) throw new ApiError('NOT_FOUND', `${this.name}/${id}`);
    return v;
  }

  set(id: string, value: T): T {
    assertJson(value, `${this.name}/${id}`);
    this.map.set(id, structuredClone(value));
    this.flush();
    return value;
  }

  /** Inserts only if absent; returns false if the id already exists. */
  insert(id: string, value: T): boolean {
    if (this.map.has(id)) return false;
    this.set(id, value);
    return true;
  }

  /** Read-modify-write (synchronous, so atomic within this process). Throws NOT_FOUND. */
  update(id: string, fn: (current: T) => T | void): T {
    const cur = this.require(id);
    const next = fn(cur);
    return this.set(id, next === undefined ? cur : next);
  }

  delete(id: string): boolean {
    const had = this.map.delete(id);
    if (had) this.flush();
    return had;
  }

  values(): T[] {
    return [...this.map.values()].map((v) => structuredClone(v));
  }

  entries(): [string, T][] {
    return [...this.map.entries()].map(([k, v]) => [k, structuredClone(v)]);
  }

  find(pred: (v: T) => boolean): T | undefined {
    for (const v of this.map.values()) if (pred(v)) return structuredClone(v);
    return undefined;
  }

  filter(pred: (v: T) => boolean): T[] {
    const out: T[] = [];
    for (const v of this.map.values()) if (pred(v)) out.push(structuredClone(v));
    return out;
  }

  private flush(): void {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function assertJson(v: unknown, where: string): void {
  const walk = (x: unknown, path: string): void => {
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return;
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new Error(`store ${where}: non-finite number at ${path}`);
      return;
    }
    if (typeof x === 'bigint') throw new Error(`store ${where}: bigint at ${path} (store as decimal string)`);
    if (x instanceof Uint8Array) throw new Error(`store ${where}: bytes at ${path} (store as base64/hex)`);
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${path}[${i}]`));
    if (typeof x === 'object') {
      for (const [k, y] of Object.entries(x as Record<string, unknown>)) if (y !== undefined) walk(y, `${path}.${k}`);
      return;
    }
    throw new Error(`store ${where}: unsupported ${typeof x} at ${path}`);
  };
  walk(v, '$');
}

export interface StoreOptions {
  /** DATA_DIR; null ⇒ purely in memory (tests). */
  dataDir: string | null;
}

/** Named JSON collections under `DATA_DIR/db`. */
export class JsonStore {
  private readonly collections = new Map<string, Collection<unknown>>();
  readonly dbDir: string | null;

  constructor(readonly opts: StoreOptions) {
    this.dbDir = opts.dataDir ? join(opts.dataDir, 'db') : null;
    if (this.dbDir) mkdirSync(this.dbDir, { recursive: true, mode: 0o700 });
  }

  collection<T>(name: string): Collection<T> {
    if (!NAME_RE.test(name)) throw new Error(`invalid collection name ${name}`);
    let c = this.collections.get(name);
    if (!c) {
      c = new Collection<unknown>(name, this.dbDir ? join(this.dbDir, `${name}.json`) : null);
      this.collections.set(name, c);
    }
    return c as Collection<T>;
  }
}
