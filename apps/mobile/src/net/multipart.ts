// multipart/form-data built as bytes, because the request signature covers the raw body bytes
// exactly as sent (API-CONTRACT §1.3 "Multipart bodies are signed over the raw bytes as sent"):
// FormData would let the platform pick the boundary and encoding after we signed.
import { concatBytes, utf8 } from '../wallet/bytes';

export interface Part {
  name: string;
  filename?: string;
  contentType: string;
  body: string | Uint8Array;
}

export function buildMultipart(
  parts: readonly Part[],
  boundary = defaultBoundary(),
): {
  bytes: Uint8Array;
  contentType: string;
} {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}`;
    chunks.push(
      utf8(
        `--${boundary}\r\nContent-Disposition: ${disp}\r\nContent-Type: ${p.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(typeof p.body === 'string' ? utf8(p.body) : p.body);
    chunks.push(utf8('\r\n'));
  }
  chunks.push(utf8(`--${boundary}--\r\n`));
  return {
    bytes: concatBytes(...chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function defaultBoundary(): string {
  let s = '';
  for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 36).toString(36);
  return `yo-${s}`;
}
