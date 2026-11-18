// Regenerates the CONFIG block of infra/quicknode/filter.js from the escrow IDL + ESCROW_ID, and
// prints the Streams create body (API-CONTRACT §5.1). Offline: never calls QuickNode.
//
//   npx tsx infra/quicknode/build-filter.ts                 # rewrite filter.js CONFIG
//   npx tsx infra/quicknode/build-filter.ts --check         # exit 1 if filter.js is stale
//   npx tsx infra/quicknode/build-filter.ts --create-body https://<FLY_APP>.fly.dev
//        # print stream.json with filter_function = base64(filter.js) and the webhook URL filled
//        # in (no security token), for inspection. To CREATE the Stream use scripts/qn-stream.ts
//        # (npm run qn-stream -- create), which also sets and verifies the webhook security token.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderFilterJs } from '../../scripts/lib/quicknode';

const FILTER = fileURLToPath(new URL('./filter.js', import.meta.url));
const STREAM = fileURLToPath(new URL('./stream.json', import.meta.url));

const render = (): Promise<string> => renderFilterJs(readFileSync(FILTER, 'utf8'));

async function main(argv: string[]): Promise<number> {
  const next = await render();
  if (argv.includes('--check')) {
    const stale = next !== readFileSync(FILTER, 'utf8');
    console.error(
      stale ? 'filter.js CONFIG is stale: run build-filter.ts' : 'filter.js is current',
    );
    return stale ? 1 : 0;
  }
  const i = argv.indexOf('--create-body');
  if (i >= 0) {
    const base = argv[i + 1];
    if (!base || !/^https:\/\//.test(base)) {
      console.error(
        '--create-body needs the hosted https base URL (the Stream is created only after it exists)',
      );
      return 2;
    }
    const stream = JSON.parse(readFileSync(STREAM, 'utf8')) as Record<string, unknown> & {
      destination_attributes: Record<string, unknown>;
    };
    delete stream['notes'];
    stream['filter_function'] = Buffer.from(next, 'utf8').toString('base64');
    stream.destination_attributes['url'] = `${base.replace(/\/$/, '')}/webhooks/quicknode`;
    process.stdout.write(JSON.stringify(stream, null, 2) + '\n');
    return 0;
  }
  writeFileSync(FILTER, next);
  console.error(`wrote ${FILTER}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
