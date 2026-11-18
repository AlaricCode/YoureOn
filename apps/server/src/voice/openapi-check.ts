// Structural check of the el-agent request bodies against ElevenLabs' public OpenAPI document
// (https://api.elevenlabs.io/openapi.json, no key needed). Strict where the generated schema is
// loose: an object key the schema does not list is an error (a misspelt field would otherwise be
// silently dropped by the API and the agent would run with a default).
//
//   checkPlan(doc, plan)        every create body, plus the PATCH twin each update would send
//   subsetForPlan(doc, plan)    the same schemas inlined and pruned to what the plan touches
//                               (test/fixtures/elevenlabs-openapi-subset.json is one, so the unit
//                               test runs offline; `el-agent --check-openapi` uses the live doc)
//
// Supported JSON-schema subset: $ref (local), anyOf / oneOf (any branch), allOf, const, enum,
// type, properties, required, additionalProperties, items, minimum / maximum (+ exclusive).
import type { SyncAction } from './agent-sync';

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON Schema documents are untyped JSON */
type Schema = Record<string, any>;
export interface OpenApiDoc {
  paths: Record<string, Record<string, any>>;
  components?: { schemas?: Record<string, Schema> };
  info?: { version?: string };
}

export interface PlannedRequest {
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
  label: string;
}

/** The requests a plan implies: each create, plus the PATCH an update run would send instead. */
export function plannedRequests(plan: readonly SyncAction[]): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  for (const a of plan) {
    if (!a.body || !a.method || !a.path) continue;
    out.push({ method: a.method, path: a.path, body: a.body, label: `${a.resource} ${a.name}` });
    if (a.action !== 'create') continue;
    if (a.resource === 'tool')
      out.push({
        method: 'PATCH',
        path: '/v1/convai/tools/tool_id',
        body: a.body,
        label: `${a.resource} ${a.name} (update)`,
      });
    if (a.resource === 'agent')
      out.push({
        method: 'PATCH',
        path: '/v1/convai/agents/agent_id',
        body: a.body,
        label: `${a.resource} ${a.name} (update)`,
      });
    if (a.resource === 'secret')
      out.push({
        method: 'PATCH',
        path: '/v1/convai/secrets/secret_id',
        body: { ...(a.body as object), type: 'update' },
        label: `${a.resource} ${a.name} (rotate)`,
      });
  }
  return out;
}

/** The path template for a concrete path; the most literal match wins (agents/create > {id}). */
export function pathTemplate(doc: OpenApiDoc, path: string): string | null {
  const segs = path.split('?')[0]!.split('/');
  let best: { t: string; literal: number } | null = null;
  for (const t of Object.keys(doc.paths)) {
    const ts = t.split('/');
    if (ts.length !== segs.length) continue;
    let literal = 0;
    let ok = true;
    for (let i = 0; i < ts.length && ok; i++) {
      if (/^\{[^}]+\}$/.test(ts[i]!)) continue;
      if (ts[i] === segs[i]) literal += 1;
      else ok = false;
    }
    if (ok && (!best || literal > best.literal)) best = { t, literal };
  }
  return best?.t ?? null;
}

export function requestBodySchema(doc: OpenApiDoc, method: string, path: string): Schema | null {
  const t = pathTemplate(doc, path);
  const op = t ? doc.paths[t]?.[method.toLowerCase()] : undefined;
  return op?.requestBody?.content?.['application/json']?.schema ?? null;
}

function deref(doc: OpenApiDoc, s: Schema | undefined): Schema | undefined {
  let cur = s;
  for (let i = 0; cur && typeof cur.$ref === 'string'; i++) {
    if (i > 64) throw new Error(`$ref loop at ${String(cur.$ref)}`);
    const parts = (cur.$ref as string).replace(/^#\//, '').split('/');
    cur = parts.reduce<any>((o, k) => (o == null ? undefined : o[k]), doc);
    if (!cur) throw new Error(`unresolvable $ref ${parts.join('/')}`);
  }
  return cur;
}

const typeOf = (v: unknown): string =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'number' && Number.isInteger(v)
        ? 'integer'
        : typeof v;

/** Errors for `v` against `schema` (empty = valid). Paths read like `agent.prompt.llm`. */
export function checkValue(doc: OpenApiDoc, v: unknown, schema: Schema, at: string): string[] {
  const errs: string[] = [];
  const s = deref(doc, schema);
  if (!s || Object.keys(s).length === 0) return errs;
  const alts: Schema[] | undefined = s.anyOf ?? s.oneOf;
  if (alts) {
    const tries = alts.map((a) => checkValue(doc, v, a, at));
    if (tries.some((e) => e.length === 0)) return errs;
    // The closest branch explains the failure best.
    return tries.sort((a, b) => a.length - b.length)[0]!;
  }
  for (const a of (s.allOf as Schema[] | undefined) ?? []) errs.push(...checkValue(doc, v, a, at));
  if ('const' in s && v !== s.const)
    errs.push(`${at}: ${JSON.stringify(v)} is not ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(v))
    errs.push(`${at}: ${JSON.stringify(v)} is not one of ${s.enum.length} allowed values`);
  if (s.type) {
    const want: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(v);
    if (!(want.includes(t) || (t === 'integer' && want.includes('number')))) {
      errs.push(`${at}: ${t}, expected ${want.join(' | ')}`);
      return errs;
    }
  }
  if (
    typeOf(v) === 'object' &&
    (s.properties || s.type === 'object' || 'additionalProperties' in s)
  ) {
    const obj = v as Record<string, unknown>;
    for (const r of (s.required as string[] | undefined) ?? [])
      if (!(r in obj)) errs.push(`${at}: missing required ${r}`);
    for (const [k, x] of Object.entries(obj)) {
      const p = s.properties?.[k];
      if (p) errs.push(...checkValue(doc, x, p, `${at}.${k}`));
      else if (s.additionalProperties && typeof s.additionalProperties === 'object')
        errs.push(...checkValue(doc, x, s.additionalProperties, `${at}.${k}`));
      else if (s.additionalProperties !== true)
        errs.push(`${at}: unknown field "${k}"${s.title ? ` (${s.title})` : ''}`);
    }
  }
  if (Array.isArray(v) && s.items)
    v.forEach((x, i) => errs.push(...checkValue(doc, x, s.items, `${at}[${i}]`)));
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errs.push(`${at}: ${v} < ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) errs.push(`${at}: ${v} > ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum)
      errs.push(`${at}: ${v} <= ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum)
      errs.push(`${at}: ${v} >= ${s.exclusiveMaximum}`);
  }
  return errs;
}

export interface PlanCheck {
  label: string;
  method: string;
  path: string;
  errors: string[];
}

export function checkPlan(doc: OpenApiDoc, plan: readonly SyncAction[]): PlanCheck[] {
  return plannedRequests(plan).map((r) => {
    const schema = requestBodySchema(doc, r.method, r.path);
    const errors = schema
      ? checkValue(doc, r.body, schema, r.label.split(' ')[0]!)
      : [`no ${r.method} ${r.path} request body in the OpenAPI document`];
    return { label: r.label, method: r.method, path: r.path, errors };
  });
}

// ---- subset ----------------------------------------------------------------------------

const KEEP = [
  'type',
  'const',
  'enum',
  'required',
  'title',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
] as const;

/** `schema` inlined and pruned against every value in `values` (properties no value uses -> {}). */
function prune(doc: OpenApiDoc, schema: Schema | undefined, values: unknown[], depth = 0): Schema {
  if (depth > 40) throw new Error('schema too deep to prune');
  // Nothing in the plan reaches here: keep no constraint (and never walk recursive schemas).
  if (values.length === 0) return {};
  const s = deref(doc, schema);
  if (!s) return {};
  const out: Schema = {};
  for (const k of KEEP) if (k in s) out[k] = s[k];
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const)
    if (Array.isArray(s[k]))
      out[k] = (s[k] as Schema[]).map((a) => prune(doc, a, values, depth + 1));
  const objs = values.filter((v) => typeOf(v) === 'object') as Record<string, unknown>[];
  if (s.properties) {
    out.properties = {};
    for (const [k, p] of Object.entries(s.properties as Record<string, Schema>)) {
      const used = objs.filter((o) => k in o).map((o) => o[k]);
      out.properties[k] = used.length ? prune(doc, p, used, depth + 1) : {};
    }
  }
  if ('additionalProperties' in s) {
    const ap = s.additionalProperties;
    if (ap && typeof ap === 'object') {
      const extra = objs.flatMap((o) =>
        Object.entries(o)
          .filter(([k]) => !s.properties || !(k in s.properties))
          .map(([, x]) => x),
      );
      out.additionalProperties = prune(doc, ap, extra, depth + 1);
    } else out.additionalProperties = ap;
  }
  if (s.items) {
    const elems = values.filter(Array.isArray).flat();
    out.items = prune(doc, s.items, elems, depth + 1);
  }
  return out;
}

/** A self-contained OpenAPI fragment (no $ref) that checks `plan` exactly as `doc` would. */
export function subsetForPlan(doc: OpenApiDoc, plan: readonly SyncAction[]): OpenApiDoc {
  const byOp = new Map<string, { template: string; method: string; bodies: unknown[] }>();
  for (const r of plannedRequests(plan)) {
    const template = pathTemplate(doc, r.path);
    if (!template) continue;
    const key = `${r.method} ${template}`;
    const e = byOp.get(key) ?? { template, method: r.method.toLowerCase(), bodies: [] };
    e.bodies.push(r.body);
    byOp.set(key, e);
  }
  const paths: OpenApiDoc['paths'] = {};
  for (const { template, method, bodies } of byOp.values()) {
    const schema = requestBodySchema(doc, method, template);
    if (!schema) continue;
    paths[template] ??= {};
    paths[template][method] = {
      requestBody: { content: { 'application/json': { schema: prune(doc, schema, bodies) } } },
    };
  }
  return { info: { version: doc.info?.version }, paths };
}
