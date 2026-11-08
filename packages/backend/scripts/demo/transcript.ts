/**
 * Compact demo transcript: one line per meaningful step, grouped by
 * scenario, with mock-clock offsets. Checks record pass/fail so the script
 * can exit non-zero when an expectation does not hold.
 */
export class Transcript {
  readonly lines: string[] = [];
  readonly failures: string[] = [];
  checks = 0;

  constructor(
    private readonly nowMs: () => number,
    private readonly startMs: number,
    private readonly echo = true,
  ) {}

  private emit(line: string): void {
    this.lines.push(line);
    if (this.echo) process.stdout.write(`${line}\n`);
  }

  private stamp(): string {
    const s = Math.max(0, Math.round((this.nowMs() - this.startMs) / 1000));
    return `t+${String(s).padStart(5)}s`;
  }

  section(title: string): void {
    this.emit('');
    this.emit(`== ${title} ${'='.repeat(Math.max(0, 70 - title.length))}`);
  }

  step(actor: string, text: string): void {
    this.emit(`${this.stamp()}  ${actor.padEnd(7)} ${text}`);
  }

  /** Records an expectation; failures are listed at the end and fail the run. */
  check(what: string, ok: boolean, detail = ''): void {
    this.checks++;
    if (!ok) {
      this.failures.push(`${what}${detail ? `: ${detail}` : ''}`);
      this.emit(`${this.stamp()}  CHECK   FAILED ${what}${detail ? ` (${detail})` : ''}`);
    }
  }

  eq<T>(what: string, actual: T, expected: T): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    this.check(what, a === e, `got ${a}, expected ${e}`);
  }
}

/** $ formatting per §12.9 (signed with U+2212 for negatives). */
export function usd(units: number, signed = false): string {
  const abs = Math.abs(units);
  const s = `$${(Math.floor(abs / 10_000) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!signed) return units < 0 ? `−${s}` : s;
  return units < 0 ? `−${s}` : `+${s}`;
}
