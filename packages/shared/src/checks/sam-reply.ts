// The SAM 3.1 service's POST /segment reply (services/sam3/modal_app.py), as the camera checks
// read it (design final.md §2). Loose objects: the service adds fields (tracks, timing_ms,
// boot_ms...) the evaluator ignores; the raw reply is what sam_reply_hash covers.
import { z } from 'zod/v4';

const Int = z.number().int();
/** xyxy pixels, x1/y1 exclusive. */
export const SamBox = z.tuple([Int.min(0), Int.min(0), Int.min(0), Int.min(0)]);
/** Uncompressed column-major COCO RLE, size [h, w], counts start with a zeros run. */
export const SamRle = z.object({
  size: z.tuple([Int.min(1).max(4096), Int.min(1).max(4096)]),
  counts: z.array(Int.min(0)),
});
export type SamRle = z.infer<typeof SamRle>;

/** One object on one frame. box_xyxy is the largest blob's box; null (and no mask) when empty. */
export const SamObject = z.object({
  id: Int,
  // SAM reports -10000 for an object it keeps tracking but no longer sees (bottle_flip_4 frame 10).
  score: z.number(),
  box_xyxy: SamBox.nullable(),
  box_all_xyxy: SamBox.nullable(),
  components: Int.min(0),
  mask_area: Int.min(0),
  /** Present when the request sent masks: true and the mask is non-empty. */
  mask_rle: SamRle.optional(),
});
export type SamObject = z.infer<typeof SamObject>;

export const SamFrame = z.object({ index: Int.min(0), objects: z.array(SamObject) });
export const SamPromptResult = z.object({ prompt: z.string(), frames: z.array(SamFrame) });

export const SamSegmentReply = z.object({
  /** The service's APP_REV, recorded as CheckReport.sam_rev. */
  rev: z.string().max(80),
  results: z.array(SamPromptResult).min(1).max(4),
});
export type SamSegmentReply = z.infer<typeof SamSegmentReply>;
