// QR codes for the projector (judges scan the lock / payout transaction on Solana Explorer). The
// matrix comes from `toqr` (MIT, ~13 KB, no dependencies; the same encoder scripts/demo-claim-qr.ts
// uses), drawn as one SVG path: dark modules on a light field with the 4-module quiet zone
// scanners expect. Error correction L keeps a 130-char Explorer URL at version 6 (41 x 41), so
// each module stays large enough to scan from a few metres away.
import { toQR } from 'toqr';

export const QR_QUIET = 4;
type EcLevel = NonNullable<Parameters<typeof toQR>[1]>;
/** toqr's ECLevel is a non-exported const enum: M = 0, L = 1, H = 2, Q = 3. */
export const QR_EC = { M: 0, L: 1, H: 2, Q: 3 } as const;

export interface QrMatrix {
  size: number;
  dark(x: number, y: number): boolean;
}

export function qrMatrix(text: string, ec: number = QR_EC.L): QrMatrix {
  const cells = toQR(text, ec as EcLevel);
  const size = Math.round(Math.sqrt(cells.length));
  if (size * size !== cells.length) throw new Error('qr: not a square matrix');
  return {
    size,
    dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && cells[y * size + x] !== 0,
  };
}

/**
 * The dark modules as an SVG path in module units, offset by the quiet zone; horizontal runs
 * are merged into one rectangle each, which keeps the path short.
 */
export function qrPath(m: QrMatrix, quiet = QR_QUIET): string {
  const parts: string[] = [];
  for (let y = 0; y < m.size; y++) {
    let x = 0;
    while (x < m.size) {
      if (!m.dark(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < m.size && m.dark(x, y)) x++;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h${start - x}z`);
    }
  }
  return parts.join('');
}

export interface QrSvg {
  /** viewBox side, quiet zone included. */
  side: number;
  path: string;
  /** Version 1-40 (size = 17 + 4 * version). */
  version: number;
}

export function qrSvg(text: string, ec: number = QR_EC.L): QrSvg {
  const m = qrMatrix(text, ec);
  return { side: m.size + 2 * QR_QUIET, path: qrPath(m), version: (m.size - 17) / 4 };
}
