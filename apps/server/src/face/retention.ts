// Keeper task `face-retention`: enforces the face data retention schedule and audits each
// deletion. Runs hourly (cheap: one DELETE ... RETURNING), so a deadline is never missed by more
// than an hour, including the 2026-12-31 hackathon cut-off.
// Spec: docs/planning/DATA-MODEL.md §10.
import type { AppDeps } from '../context';
import type { KeeperTask } from '../keeper/keeper';
import { purgeExpiredEnrollments } from './service';

export const FACE_RETENTION_EVERY_MS = 60 * 60_000;

export function faceRetentionTask(deps: Pick<AppDeps, 'db' | 'log'>): KeeperTask {
  return {
    name: 'face-retention',
    everyMs: FACE_RETENTION_EVERY_MS,
    async run(nowMs) {
      const r = await purgeExpiredEnrollments(deps, nowMs);
      if (r.deleted > 0) deps.log.info('face.retention_purged', { deleted: r.deleted });
      return r;
    },
  };
}
