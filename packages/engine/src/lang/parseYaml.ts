/**
 * `parseYaml(src, ctx)` (§2.7): YAML surface → canonical, validated `Program`.
 */
import type { CompileContext, ParseYamlResult } from '../types.js';
import { canonicalizeDraft } from './canonicalize.js';
import { validateProgram } from './validate.js';
import { parseSurface } from './yamlSurface.js';

export function parseYaml(src: string, ctx: CompileContext): ParseYamlResult {
  const surface = parseSurface(src);
  if (!surface.draft) return { ok: false, errors: surface.errors };
  const canon = canonicalizeDraft(surface.draft, ctx);
  if (!canon.program) return { ok: false, errors: canon.errors };
  const { errors, warnings } = validateProgram(canon.program, ctx, { sideEntities: canon.sideEntities });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, program: canon.program, warnings };
}
