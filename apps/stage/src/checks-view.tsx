// The ref cam on the projector (checks.ts holds the pure half): a quiet "Ref cam" line on the
// terms card, and after a ruling a compact result (each check ✓ / ✗ / ? with its plain-language
// clause, the veto when the camera sent the attempt back) plus the SAM boxes drawn over the frame
// the checks cite, when the stage has that evidence frame.
import type { ChecksReportPayload } from '@youre-on/shared/checks/events';
import {
  boxRect,
  compactLabels,
  markOf,
  refCamLine,
  VETO_TITLE,
  whyWords,
  type ChecksView,
} from './checks';

/** Terms card: "Ref cam · the bottle fully in shot at the end; …" or "Ref cam · Judge only". */
export function RefCamTermsLine({
  checks,
  termsHash,
}: {
  checks: ChecksView | null;
  termsHash: string | null | undefined;
}) {
  const line = refCamLine(checks, termsHash);
  if (!line) return null;
  return (
    <p className={`refcam-line ${line.decision === 'judge_only' ? 'judge-only' : 'on'}`}>
      <span className="label">Ref cam</span> <span className="refcam-text">{line.text}</span>
    </p>
  );
}

const MARK_CLASS = { '✓': 'yes', '✗': 'no', '?': 'unsure', '–': 'skip' } as const;
const RANK = { '✗': 0, '?': 1, '–': 2, '✓': 3 } as const;

/**
 * The ruling panel's ref cam result, one line (the moment panel never scrolls): "Ref cam veto
 * ? stands upright (too close to call) ✓ fully in shot at the end ✓ comes to rest", what went
 * wrong first, the clauses without their shared subject (the boxed frame's caption names it).
 * `reason` is the ruling's own reason: a veto's why is the reason word for word, so it is not
 * printed twice; a different why gets its own line.
 */
export function RefCamResult({
  report,
  reason = null,
}: {
  report: ChecksReportPayload;
  reason?: string | null;
}) {
  if (report.status === 'unavailable')
    return (
      <div className="refcam-result unavailable" aria-label="ref cam">
        <p className="refcam-checks">
          <span className="label">Ref cam</span>{' '}
          <span className="muted">offline · the judge decided alone</span>
        </p>
      </div>
    );
  const v = report.veto;
  const { subject, labels } = compactLabels(report.results.map((r) => r.label));
  // one line on the projector: what went wrong first (✗, then ?, then –), the passes after
  const order = report.results
    .map((row, i) => ({ row, i, rank: RANK[markOf(row.value)] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  const extraWhy = v && v.why.trim() !== (reason ?? '').trim() ? v.why : null;
  return (
    <div className={`refcam-result${v ? ' vetoed' : ''}`} aria-label="ref cam">
      <p className="refcam-checks" title={subject ? `Ref cam · ${subject}` : undefined}>
        {v ? (
          <span className="label veto-title" title={VETO_TITLE[v.kind]}>
            Ref cam veto
          </span>
        ) : (
          <span className="label">Ref cam</span>
        )}
        {order.map(({ row, i }) => {
          const m = markOf(row.value);
          const why = whyWords(row);
          return (
            <span key={i} className={`refcam-check ${MARK_CLASS[m]}`}>
              <span className="mark" aria-hidden="true">
                {m}
              </span>
              <span className="what">
                {labels[i]}
                {why && <span className="why"> ({why})</span>}
              </span>
            </span>
          );
        })}
      </p>
      {/* the veto's why is the ruling's reason word for word: only a different one is printed */}
      {extraWhy && <p className="refcam-veto">{extraWhy}</p>}
    </div>
  );
}

/**
 * One evidence frame with the report's boxes on it: the SVG overlay's viewBox is the frame's
 * pixel size, and the frame box keeps that aspect ratio, so the boxes land where SAM saw them.
 */
export function RefCamFrame({
  report,
  idx,
  url,
  cited = false,
}: {
  report: ChecksReportPayload;
  idx: number;
  url: string;
  /** The judge cited this frame too. */
  cited?: boolean;
}) {
  const size = report.frame_size!;
  const boxes = report.boxes[String(idx)] ?? [];
  return (
    <figure className="cited refcam-cited">
      <div
        className="refcam-frame"
        style={{
          // Both bounds (22vh tall, 30vh wide) through the width alone, so the aspect ratio
          // always wins: portrait (judge phone) and landscape (tripod) frames are never squashed.
          width: `min(30vh, ${round2((22 * size.w) / size.h)}vh)`,
          aspectRatio: `${size.w} / ${size.h}`,
        }}
      >
        <img src={url} alt={`${cited ? 'cited' : 'ref cam'} frame ${idx}`} />
        <svg
          className="refcam-boxes"
          viewBox={`0 0 ${size.w} ${size.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {boxes.map((b, i) => {
            const r = boxRect(b, size);
            return (
              <g key={i} className={i === 0 ? 'box main' : 'box alt'}>
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption>
        frame {idx} · ref cam{boxes[0] ? ` · ${boxes[0].prompt}` : ''}
      </figcaption>
    </figure>
  );
}

const round2 = (x: number) => Math.round(x * 100) / 100;
