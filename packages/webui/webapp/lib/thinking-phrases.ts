/**
 * Streaming-indicator phrase vocabulary (webui-parity 61, G5).
 *
 * The desktop rotates a short phrase beside the activity loader instead of
 * parking one static label on screen: 2–3 s before the first swap, then every
 * 3.5 s, drawn from three weighted buckets. The buckets and their weights are
 * transcribed from the reference package
 * (`src/client/components/ActivityIndicator.tsx`): basic 0.75, specific 0.15,
 * motion 0.1. The rotation logic itself lives in
 * `components/loading-states.tsx` next to the hook that drives it; this module
 * carries only the data, so the component keeps its import-clean shape (React
 * plus a pure data import) and the table can be asserted without rendering.
 *
 * Why a new module rather than `lib/i18n.ts`: that dictionary is a flat
 * `key → string` map typed as `Record<MessageKey, string>`, and this is a list
 * of lists with per-bucket structure — 42 phrases would arrive as 84 opaque
 * keys that no reader could scan. The precedent is `lib/i18n-agent-team.ts`,
 * which moved its slice's strings out for the same reason.
 *
 * Both locales are table-complete by construction: `THINKING_PHRASES` is keyed
 * by `Locale`, so a missing translation is a compile error rather than an
 * English string leaking into the Chinese UI (the failure mode
 * `lib/i18n-agent-team.ts` documents for its own table).
 */

import type { Locale } from "./i18n";

/**
 * Three weighted buckets, in draw order. The order is the tie-break when a
 * weighted draw lands exactly on a boundary, and it fixes which bucket a
 * caller sees first in `bucketPhrases`.
 */
export interface ThinkingPhraseSet {
  /** Generic progress copy — carries most of the weight. */
  readonly basic: readonly string[];
  /** Copy that names the specific step being worked on. */
  readonly specific: readonly string[];
  /** Copy about the model moving through the problem. */
  readonly motion: readonly string[];
}

export const THINKING_PHRASES: Record<Locale, ThinkingPhraseSet> = {
  zh: {
    basic: [
      "分析中…",
      "处理中…",
      "推进中…",
      "规划中…",
      "整理中…",
      "构建中…",
      "生成中…",
      "优化中…",
      "调整中…",
      "校准中…",
      "汇总中…",
      "提炼中…",
      "检查中…",
      "完善中…",
      "整合中…",
      "排布中…",
      "归并中…",
      "链接中…",
      "统筹中…",
      "展开中…",
      "补全中…",
      "修正中…",
      "结构化中…",
      "优先排序中…",
    ],
    specific: [
      "梳理结构中…",
      "串联信息中…",
      "逐步补全中…",
      "校验细节中…",
      "优化表达中…",
    ],
    motion: [
      "起势中…",
      "盘旋中…",
      "俯瞰中…",
      "定位中…",
      "调整方向中…",
      "对准中…",
      "轨迹调整中…",
      "定点处理中…",
      "俯冲准备中…",
      "收拢路径中…",
      "孵化中…",
      "降落中…",
      "筑巢中…",
    ],
  },
  en: {
    basic: [
      "Analyzing…",
      "Processing…",
      "Advancing…",
      "Planning…",
      "Organizing…",
      "Building…",
      "Generating…",
      "Optimizing…",
      "Adjusting…",
      "Calibrating…",
      "Summarizing…",
      "Distilling…",
      "Checking…",
      "Refining…",
      "Integrating…",
      "Laying out…",
      "Merging…",
      "Linking…",
      "Coordinating…",
      "Unfolding…",
      "Completing…",
      "Correcting…",
      "Structuring…",
      "Prioritizing…",
    ],
    specific: [
      "Mapping the structure…",
      "Chaining the details together…",
      "Filling in step by step…",
      "Verifying the fine print…",
      "Tightening the wording…",
    ],
    motion: [
      "Winding up…",
      "Circling…",
      "Surveying from above…",
      "Locating…",
      "Correcting course…",
      "Aiming…",
      "Adjusting trajectory…",
      "Working the exact spot…",
      "Preparing the dive…",
      "Gathering the path…",
      "Incubating…",
      "Descending…",
      "Building the nest…",
    ],
  },
};

/** The table for one locale. The object identity is stable per locale, which
 *  is what lets the rotation effect depend on it without re-arming the timer
 *  on every render. */
export function thinkingPhrases(locale: Locale): ThinkingPhraseSet {
  return THINKING_PHRASES[locale];
}
