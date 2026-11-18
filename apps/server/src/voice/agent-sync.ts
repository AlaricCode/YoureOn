// Create-or-update the ElevenLabs judge idempotently (TASKS D0-J2: "a second run of the script
// is a no-op"). Engine behind scripts/el-agent.ts; HTTP is injected so it is unit-tested with a
// fake ElevenLabs (no key yet: PENDING-KEY).
//
// Resources, in order (SETUP-CHECKLIST K2 step 4), each matched by exact name:
//   1. workspace secret  GET /v1/convai/secrets?search=  POST /v1/convai/secrets  (PATCH only with rotate)
//   2. webhook + client tools  GET /v1/convai/tools?search=  POST /v1/convai/tools  PATCH /v1/convai/tools/{id}
//   3. the private agent  GET /v1/convai/agents?search=  GET/PATCH /v1/convai/agents/{id}  POST /v1/convai/agents/create
// A resource is PATCHed only when the desired JSON is not already a subset of what ElevenLabs
// returns, so an unchanged config sends no writes.
//
// A throwaway test agent (SyncOptions.agentName != JUDGE_AGENT_NAME, el-agent --agent-name): the
// secret and the tools are workspace-wide and shared with the live judge, so that mode never
// PATCHes them (a tool that differs from this checkout stops the run, --rotate-secret is refused):
// it only creates what is missing and creates / updates its own agent, tagged 'test'.
import {
  agentBody,
  CLIENT_TOOLS,
  clientToolConfig,
  DEFAULT_WEBHOOK_TOOLS,
  TOOL_SECRET_NAME,
  toolRequest,
  webhookToolConfig,
  type AgentOptions,
  type WebhookToolName,
} from '@youre-on/shared/judge/el-config';
import { JUDGE_AGENT_NAME, type JudgeToolName } from '@youre-on/shared/judge/persona';

export interface ElHttp {
  request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown>;
}

export class ElHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    method: string,
    path: string,
  ) {
    super(`ElevenLabs ${method} ${path} -> HTTP ${status}: ${detail}`);
    this.name = 'ElHttpError';
  }
}

/** fetch-based ElHttp. `redact` strings (the secret value) never appear in error messages. */
export function fetchElHttp(o: {
  apiKey: string;
  baseUrl?: string;
  fetch?: (u: string, i?: RequestInit) => Promise<Response>;
  redact?: string[];
}): ElHttp {
  const base = (o.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const scrub = (s: string) =>
    (o.redact ?? []).reduce((t, r) => (r ? t.split(r).join('<redacted>') : t), s);
  return {
    async request(method, path, body) {
      const res = await f(base + path, {
        method,
        headers: {
          'xi-api-key': o.apiKey,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) throw new ElHttpError(res.status, scrub(text).slice(0, 2_000), method, path);
      return text ? (JSON.parse(text) as unknown) : null;
    },
  };
}

/**
 * Arrays that are sets: ElevenLabs may hand them back in another order, which is not a change
 * (re-PATCHing the agent every run for it would make the script never a no-op).
 */
const UNORDERED_KEYS = new Set(['tool_ids', 'client_events', 'required']);

const sameSet = (a: unknown[], b: unknown[]) => {
  const key = (x: unknown) => JSON.stringify(x);
  const bs = b.map(key).sort();
  return (
    a.length === b.length &&
    a
      .map(key)
      .sort()
      .every((x, i) => x === bs[i])
  );
};

/**
 * true iff every leaf of `want` equals the same leaf of `have` (arrays: same length,
 * element-wise; under UNORDERED_KEYS, the same elements in any order).
 */
export function isSubset(want: unknown, have: unknown, key?: string): boolean {
  if (want === null) return have === null || have === undefined;
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || have.length !== want.length) return false;
    if (key !== undefined && UNORDERED_KEYS.has(key)) return sameSet(want, have);
    return want.every((w, i) => isSubset(w, have[i]));
  }
  if (typeof want === 'object') {
    if (!have || typeof have !== 'object' || Array.isArray(have)) return false;
    return Object.entries(want as Record<string, unknown>).every(([k, v]) =>
      isSubset(v, (have as Record<string, unknown>)[k], k),
    );
  }
  return want === have;
}

/** Paths where `want` and `have` differ (for the log line of an update). */
export function diffPaths(want: unknown, have: unknown, at = ''): string[] {
  if (isSubset(want, have, at.split('.').at(-1) || undefined)) return [];
  if (
    want &&
    typeof want === 'object' &&
    !Array.isArray(want) &&
    have &&
    typeof have === 'object' &&
    !Array.isArray(have)
  )
    return Object.entries(want as Record<string, unknown>).flatMap(([k, v]) =>
      diffPaths(v, (have as Record<string, unknown>)[k], at ? `${at}.${k}` : k),
    );
  return [at || '(root)'];
}

export interface SyncOptions {
  baseUrl: string;
  /** The value of ELEVENLABS_TOOL_SECRET (only sent on create or rotate). */
  toolSecret: string;
  rotateSecret?: boolean;
  webhookTools?: readonly WebhookToolName[];
  agent?: Omit<AgentOptions, 'toolIds' | 'promptTools' | 'name' | 'tags'>;
  /**
   * Default JUDGE_AGENT_NAME (the live judge). Any other name is a throwaway test agent: shared
   * workspace resources are never PATCHed (see the header).
   */
  agentName?: string;
  log?: (line: string) => void;
}

/** Tags of a test agent (el-agent --agent-name): never the live judge's alone. */
export const TEST_AGENT_TAGS = ['youre-on', 'test'] as const;

/** Is this sync for a throwaway test agent (never PATCH shared resources)? */
export const isTestAgent = (o: Pick<SyncOptions, 'agentName'>): boolean =>
  o.agentName !== undefined && o.agentName !== JUDGE_AGENT_NAME;
const agentNameOf = (o: Pick<SyncOptions, 'agentName'>) => o.agentName ?? JUDGE_AGENT_NAME;

export type SyncAction = {
  resource: 'secret' | 'tool' | 'agent';
  name: string;
  action: 'create' | 'update' | 'noop';
  method?: 'POST' | 'PATCH';
  path?: string;
  body?: unknown;
  changed?: string[];
};

export interface SyncResult {
  secret_id: string;
  tool_ids: Record<string, string>;
  agent_id: string;
  actions: SyncAction[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const q = encodeURIComponent;

function exactlyOne<T>(items: T[], what: string): T | null {
  if (items.length > 1)
    throw new Error(`${items.length} ElevenLabs ${what} share the name; delete the extras first`);
  return items[0] ?? null;
}

/** The desired tool configs (webhook tools need the secret id). */
export function desiredTools(o: Pick<SyncOptions, 'baseUrl' | 'webhookTools'>, secretId: string) {
  const webhooks = (o.webhookTools ?? DEFAULT_WEBHOOK_TOOLS).map((n) =>
    webhookToolConfig(n, o.baseUrl, secretId),
  );
  const clients = CLIENT_TOOLS.map((n) => clientToolConfig(n));
  return [...webhooks, ...clients];
}

export function desiredAgent(
  o: Pick<SyncOptions, 'webhookTools' | 'agent' | 'agentName'>,
  toolIds: string[],
) {
  const promptTools = new Set<JudgeToolName>([
    ...(o.webhookTools ?? DEFAULT_WEBHOOK_TOOLS),
    ...CLIENT_TOOLS,
    // Built-in system tool (prompt.built_in_tools): silent through the room's celebration.
    'skip_turn',
  ]);
  return agentBody({
    ...(o.agent ?? {}),
    toolIds,
    promptTools,
    ...(isTestAgent(o) ? { name: agentNameOf(o), tags: TEST_AGENT_TAGS } : {}),
  });
}

/**
 * Dry run: no HTTP at all (no key needed). Returns the exact bodies a first run would POST, with
 * the secret value and the not-yet-known ids as placeholders.
 */
export function dryRunPlan(o: SyncOptions): SyncAction[] {
  const secretId = '<secret_id of yo-tool-secret>';
  const tools = desiredTools(o, secretId);
  const toolIds = tools.map((t) => `<tool_id of ${t.name}>`);
  return [
    {
      resource: 'secret',
      name: TOOL_SECRET_NAME,
      action: 'create',
      method: 'POST',
      path: '/v1/convai/secrets',
      body: { type: 'new', name: TOOL_SECRET_NAME, value: '<ELEVENLABS_TOOL_SECRET>' },
    },
    ...tools.map((t): SyncAction => ({
      resource: 'tool',
      name: t.name,
      action: 'create',
      method: 'POST',
      path: '/v1/convai/tools',
      body: toolRequest(t),
    })),
    {
      resource: 'agent',
      name: agentNameOf(o),
      action: 'create',
      method: 'POST',
      path: '/v1/convai/agents/create',
      body: desiredAgent(o, toolIds),
    },
  ];
}

export async function syncAgent(http: ElHttp, o: SyncOptions): Promise<SyncResult> {
  const log = o.log ?? (() => {});
  const actions: SyncAction[] = [];
  const testAgent = isTestAgent(o);
  const AGENT_NAME = agentNameOf(o);
  if (testAgent && o.rotateSecret)
    throw new Error('--rotate-secret with --agent-name: the secret is shared with the live judge');

  // 1. workspace secret
  const secrets = arr(
    obj(await http.request('GET', `/v1/convai/secrets?search=${q(TOOL_SECRET_NAME)}`)).secrets,
  )
    .map(obj)
    .filter((s) => s.name === TOOL_SECRET_NAME);
  let secretId: string;
  const existingSecret = exactlyOne(secrets, 'secrets');
  if (!existingSecret) {
    const r = obj(
      await http.request('POST', '/v1/convai/secrets', {
        type: 'new',
        name: TOOL_SECRET_NAME,
        value: o.toolSecret,
      }),
    );
    secretId = String(r.secret_id);
    actions.push({
      resource: 'secret',
      name: TOOL_SECRET_NAME,
      action: 'create',
      method: 'POST',
      path: '/v1/convai/secrets',
    });
  } else {
    secretId = String(existingSecret.secret_id);
    if (o.rotateSecret) {
      const path = `/v1/convai/secrets/${q(secretId)}`;
      await http.request('PATCH', path, {
        type: 'update',
        name: TOOL_SECRET_NAME,
        value: o.toolSecret,
      });
      actions.push({
        resource: 'secret',
        name: TOOL_SECRET_NAME,
        action: 'update',
        method: 'PATCH',
        path,
      });
    } else actions.push({ resource: 'secret', name: TOOL_SECRET_NAME, action: 'noop' });
  }
  log(`secret ${TOOL_SECRET_NAME}: ${actions.at(-1)!.action} (${secretId})`);

  // 2. tools
  const toolIds: Record<string, string> = {};
  for (const want of desiredTools(o, secretId)) {
    const found = arr(
      obj(await http.request('GET', `/v1/convai/tools?search=${q(want.name)}&page_size=100`)).tools,
    )
      .map(obj)
      .filter((t) => obj(t.tool_config).name === want.name);
    const have = exactlyOne(found, `tools named ${want.name}`);
    const body = toolRequest(want);
    if (!have) {
      const r = obj(await http.request('POST', '/v1/convai/tools', body));
      toolIds[want.name] = String(r.id);
      actions.push({
        resource: 'tool',
        name: want.name,
        action: 'create',
        method: 'POST',
        path: '/v1/convai/tools',
        body,
      });
    } else {
      toolIds[want.name] = String(have.id);
      const changed = diffPaths(want, have.tool_config);
      if (changed.length && testAgent)
        throw new Error(
          `tool ${want.name} differs from this checkout [${changed.join(', ')}]: a test agent ` +
            '(--agent-name) never PATCHes a workspace tool the live judge shares. Sync the live ' +
            'judge first, or use scripts/el-review-eval.ts (its own throwaway tool).',
        );
      if (changed.length) {
        const path = `/v1/convai/tools/${q(String(have.id))}`;
        await http.request('PATCH', path, body);
        actions.push({
          resource: 'tool',
          name: want.name,
          action: 'update',
          method: 'PATCH',
          path,
          body,
          changed,
        });
      } else actions.push({ resource: 'tool', name: want.name, action: 'noop' });
    }
    const a = actions.at(-1)!;
    log(
      `tool ${want.name}: ${a.action}${a.changed ? ` [${a.changed.join(', ')}]` : ''} (${toolIds[want.name]})`,
    );
  }

  // 3. agent
  const body = desiredAgent(o, Object.values(toolIds));
  const agents = arr(
    obj(await http.request('GET', `/v1/convai/agents?search=${q(AGENT_NAME)}&page_size=100`))
      .agents,
  )
    .map(obj)
    .filter((a) => a.name === AGENT_NAME && a.archived !== true);
  const summary = exactlyOne(agents, 'agents');
  let agentId: string;
  if (!summary) {
    const r = obj(await http.request('POST', '/v1/convai/agents/create', body));
    agentId = String(r.agent_id);
    actions.push({
      resource: 'agent',
      name: AGENT_NAME,
      action: 'create',
      method: 'POST',
      path: '/v1/convai/agents/create',
      body,
    });
  } else {
    agentId = String(summary.agent_id);
    const path = `/v1/convai/agents/${q(agentId)}`;
    const have = await http.request('GET', path);
    const changed = diffPaths(body, have);
    if (changed.length) {
      await http.request('PATCH', path, body);
      actions.push({
        resource: 'agent',
        name: AGENT_NAME,
        action: 'update',
        method: 'PATCH',
        path,
        body,
        changed,
      });
    } else actions.push({ resource: 'agent', name: AGENT_NAME, action: 'noop' });
  }
  const a = actions.at(-1)!;
  log(
    `agent ${AGENT_NAME}: ${a.action}${a.changed ? ` [${a.changed.join(', ')}]` : ''} (${agentId})`,
  );

  return { secret_id: secretId, tool_ids: toolIds, agent_id: agentId, actions };
}
