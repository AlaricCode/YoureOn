/**
 * Backend entry point: `.env` (repo root, or VERDICT_ENV_FILE; keys generated
 * on first run) → config →
 * spend guard → context → HTTP + WS server.
 */
import { buildApp } from './app.js';
import { defaultEnvPath, ensureEnvFile } from './config/dotenv.js';
import { ConfigError, loadConfig } from './config/load.js';
import { consoleLogger, createContext } from './context.js';
import { SpendDisabledError } from './errors.js';

export async function main(): Promise<void> {
  const envFile = ensureEnvFile(process.env['VERDICT_ENV_FILE'] || defaultEnvPath());
  if (envFile.generated.length > 0) {
    console.log(`[verdict] generated ${envFile.generated.join(', ')} into ${envFile.path} (git-ignored; never commit it)`);
  }
  let config;
  try {
    config = loadConfig(envFile.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  let ctx;
  try {
    ctx = createContext(config, { log: consoleLogger(config.logLevel) });
  } catch (e) {
    if (e instanceof SpendDisabledError) {
      console.error(`[verdict] SPEND_DISABLED: ${e.detail}`);
      process.exit(3);
    }
    throw e;
  }
  const app = await buildApp(ctx, { logger: { level: config.logLevel } });
  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { solana_mode: config.solanaMode, program_id: config.programId, fee_payer: config.keys.feePayer.publicKey },
    'verdict backend ready',
  );
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
