// Process entry: `npm run dev -w apps/server` (tsx watch, reads apps/server/.env) or
// `npm start -w apps/server` (Fly). Env names: SETUP-CHECKLIST §7 (see env.ts).
import { EnvError, loadEnv } from './env';
import { providerModes } from './providers/registry';
import { SpendDisabledError } from './providers/spend';
import { createDeps, startServer } from './server';

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  let created;
  try {
    created = createDeps({ env });
  } catch (err) {
    // Spend guard: a *_PROVIDER=live without ALLOW_SPEND=true stops boot with a clear message.
    if (err instanceof SpendDisabledError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const { deps, dbHandle } = created;
  dbHandle.startKeepalive(undefined, (err) => deps.log.warn('db.keepalive_failed', { err }));
  const running = await startServer(deps, { port: env.PORT, onClose: () => dbHandle.close() });
  deps.log.info('server.listening', {
    port: running.port,
    node_env: env.NODE_ENV,
    lock_mode: env.LOCK_MODE,
    providers: providerModes(deps.providers),
    // the projector's ElevenLabs voice: 'on', or why not (no_key / spend_disabled / off)
    stage_tts: deps.stageVoice ? (deps.stageVoice.status().tts_off ?? 'on') : 'off',
  });

  const shutdown = (signal: string) => {
    deps.log.info('server.shutdown', { signal });
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
