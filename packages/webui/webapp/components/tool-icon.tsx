"use client";

// 16×16 SVG category-icon catalog (ticket 46, PR3 — D4), replacing the
// unicode-glyph placeholder the ActivityGroup header and ToolCard
// summary used to render. Paths are transcribed verbatim from the
// reference `WebuiToolIcon` registry
// (`other-minimax-code/.../TranscriptPrimitives.tsx` lines 99-120),
// keyed by THIS wire's `SummaryIconType`.
//
// The two vocabularies differ, so a few entries are mapped rather than
// identical — see TOOL_ICON_SOURCE for the provenance of each glyph.
// Entries with no reference counterpart (`summary`, `alert`) are drawn
// here in the same style (viewBox 16, stroke 1.25, round joins/caps).

// Like components/activity-group.tsx, this file imports React
// explicitly: webapp/test/activity-group.test.ts renders the component
// graph through react-dom/server under the tsx loader, which honours
// `jsx: "preserve"` by falling back to the classic runtime.
import * as React from "react";

import type { SummaryIconType } from "../lib/transcript";

const TOOL_ICON_PATHS: Record<SummaryIconType, React.ReactElement> = {
  // --- verbatim from the reference registry ---
  command: (
    <>
      <path d="M14 11C14 12.3807 12.8807 13.5 11.5 13.5H4.5C3.11929 13.5 2 12.3807 2 11V5C2 3.61929 3.11929 2.5 4.5 2.5H11.5C12.8807 2.5 14 3.61929 14 5V11Z" />
      <path d="M5.04907 6.5L6.46329 7.91421L5.04907 9.32843" />
      <path d="M8.5 9.5H11.5" />
    </>
  ),
  file: (
    <>
      <path d="M4.5 2.5h5l3 3v8h-8z" />
      <path d="M9.5 2.5v3h3" />
      <path d="M6.5 8h4M6.5 10.5h4" />
    </>
  ),
  code: (
    <>
      <path d="M4.5 2.5h5l3 3v4" />
      <path d="M9.5 2.5v3h3" />
      <path d="m7 12 4.8-4.8 1.8 1.8L8.8 13.8 6.5 14z" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2.5 8h11M8 2a9 9 0 0 1 0 12M8 2a9 9 0 0 0 0 12" />
    </>
  ),
  logo: (
    <>
      <path d="M8 1.5 14.5 5v6L8 14.5 1.5 11V5z" />
      <path d="m5.5 8 1.5 1.5L10.5 6" />
    </>
  ),
  memory: (
    <>
      <path d="M4 3.5h8v9H4z" />
      <path d="M6 6h4M6 8h4M6 10h2" />
    </>
  ),
  thinking: (
    <path d="M6.21625 1.48035C6.94482 1.48047 7.59202 1.82294 8.01019 2.35437C8.42522 1.83146 9.06516 1.495 9.78461 1.495C10.9445 1.49529 11.8994 2.367 12.0327 3.49109C12.342 3.60811 12.6301 3.77777 12.8832 3.99304C13.2171 4.2771 13.4828 4.63447 13.6586 5.03601C13.8342 5.43734 13.9165 5.87369 13.8989 6.3114C13.8861 6.62574 13.8203 6.93497 13.7084 7.22742C14.2332 7.75714 14.548 8.49467 14.519 9.29968C14.4855 10.2242 14.005 11.0242 13.2953 11.5087C13.3061 11.8125 13.2703 12.1168 13.186 12.41C13.0768 12.7895 12.891 13.1432 12.6401 13.4481C12.3891 13.753 12.0774 14.0034 11.726 14.1835C11.3747 14.3634 10.99 14.4693 10.5961 14.495C10.2021 14.5206 9.80583 14.465 9.43402 14.3319C9.06239 14.1988 8.72222 13.9904 8.43402 13.7206C8.27464 13.5714 8.1335 13.4046 8.01215 13.2245C7.88792 13.411 7.74385 13.5843 7.57953 13.7382C7.28946 14.0097 6.94675 14.2194 6.57269 14.3534C6.19859 14.4873 5.80027 14.5431 5.40375 14.5175C5.00732 14.4917 4.61965 14.385 4.26605 14.204C3.91253 14.0228 3.59964 13.7704 3.34711 13.4637C3.09458 13.1569 2.90719 12.8007 2.7973 12.4188C2.71348 12.1272 2.67653 11.8245 2.68597 11.5223C1.97653 11.0341 1.49702 10.2312 1.46332 9.30457C1.43423 8.49837 1.74747 7.75901 2.27094 7.22644C2.16117 6.9357 2.09712 6.62843 2.08441 6.31628C2.06657 5.87554 2.14873 5.43619 2.32562 5.0321C2.50255 4.62806 2.76898 4.26912 3.10492 3.98328C3.35712 3.76878 3.64371 3.59895 3.9516 3.48132C4.09108 2.35361 5.05088 1.48052 6.21625 1.48035ZM9.78461 2.45789C9.1186 2.45789 8.56935 2.95827 8.49164 3.60339C8.49535 3.65661 8.50043 3.71037 8.50043 3.76453C8.50036 3.80755 8.49215 3.84871 8.48187 3.88855V11.4911C8.49252 11.5317 8.50044 11.5741 8.50043 11.618C8.50035 11.684 8.49714 11.7497 8.49261 11.8153C8.51321 12.0092 8.56314 12.1993 8.64105 12.3788C8.74595 12.6203 8.90001 12.8375 9.09222 13.0175C9.28439 13.1973 9.51141 13.3359 9.75922 13.4247C10.0071 13.5134 10.2709 13.5511 10.5336 13.5341C10.7962 13.5169 11.0533 13.446 11.2875 13.326C11.5216 13.206 11.7287 13.0389 11.8959 12.8358C12.0632 12.6326 12.1874 12.3964 12.2602 12.1434C12.2801 12.074 12.295 12.0034 12.3071 11.9325C12.0858 11.9798 11.8559 12.0054 11.6196 11.9969C11.3537 11.9874 11.1461 11.7638 11.1557 11.4979C11.1656 11.2324 11.3882 11.0246 11.6537 11.0341C12.6676 11.0705 13.5193 10.2783 13.5561 9.26453C13.5781 8.64915 13.2956 8.0927 12.8412 7.74207C12.7313 7.65725 12.6688 7.53423 12.6567 7.40613C12.6419 7.30689 12.6563 7.20226 12.7075 7.1073C12.8458 6.85007 12.9241 6.56418 12.936 6.27234C12.9477 5.9805 12.8929 5.68932 12.7758 5.42175C12.6586 5.15419 12.4817 4.91672 12.2592 4.72742C12.0366 4.53811 11.7736 4.40177 11.4907 4.32898C11.3188 4.28472 11.1942 4.15246 11.1489 3.99304C11.1103 3.9239 11.0865 3.84535 11.0864 3.76062C11.0864 3.04157 10.5036 2.4582 9.78461 2.45789ZM6.21625 2.48035C5.5073 2.48054 4.93207 3.05553 4.93207 3.76453C4.93193 3.85075 4.90813 3.93104 4.86957 4.00183C4.82258 4.1671 4.69312 4.30437 4.51508 4.35046C4.23478 4.42253 3.97383 4.55751 3.75336 4.745C3.53288 4.93256 3.35775 5.16832 3.24164 5.43347C3.12564 5.69855 3.07173 5.98713 3.08344 6.27625C3.09526 6.56528 3.1729 6.84866 3.31 7.10339C3.36256 7.20149 3.37782 7.30968 3.36273 7.41199C3.35008 7.54467 3.28511 7.67268 3.17133 7.76062C2.72119 8.10787 2.44035 8.65893 2.46234 9.26843C2.49896 10.272 3.34249 11.0556 4.34613 11.0194C4.62184 11.0097 4.85363 11.2261 4.86371 11.5018C4.87333 11.7774 4.65784 12.0093 4.38226 12.0194C4.15373 12.0277 3.93087 12.0045 3.71625 11.9608C3.72748 12.0218 3.74106 12.0827 3.75824 12.1425C3.83033 12.3929 3.953 12.6268 4.11859 12.828C4.28426 13.0292 4.49019 13.1945 4.72211 13.3134C4.95398 13.4321 5.20826 13.5025 5.4682 13.5194C5.72832 13.5362 5.99037 13.4998 6.23578 13.412C6.48095 13.3241 6.70575 13.1866 6.89594 13.0087C7.08629 12.8304 7.23834 12.6141 7.34222 12.3749C7.446 12.1358 7.50012 11.8777 7.50043 11.6171C7.5005 11.5724 7.50789 11.5294 7.51898 11.4882V3.89246C7.50804 3.85145 7.50049 3.80894 7.50043 3.76453C7.50043 3.05555 6.92518 2.48056 6.21625 2.48035Z" />
  ),
  tool: (
    <path d="M9.5 3a4 4 0 0 0-5.2 5.2L2.5 10l3.5 3.5 1.8-1.8A4 4 0 0 0 13 6.5l-2.5 2.2-2.2-2.2z" />
  ),
  bot: (
    <>
      <rect x="2.5" y="4" width="11" height="8.5" rx="2" />
      <path d="M8 1.5v2.5M5.5 7.5h.01M10.5 7.5h.01M5.5 10h5" />
    </>
  ),
  // --- mapped: this wire's type has no identically-named reference
  //     glyph, so the closest reference glyph stands in ---
  plugin: (
    // reference "combine": four assembled blocks — the composition
    // metaphor for a plugin/extension.
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  "file-edit": (
    // reference "code": a document with a pencil — the edit-a-file glyph.
    <>
      <path d="M4.5 2.5h5l3 3v4" />
      <path d="M9.5 2.5v3h3" />
      <path d="m7 12 4.8-4.8 1.8 1.8L8.8 13.8 6.5 14z" />
    </>
  ),
  edit: (
    // same reference glyph as "file-edit".
    <>
      <path d="M4.5 2.5h5l3 3v4" />
      <path d="M9.5 2.5v3h3" />
      <path d="m7 12 4.8-4.8 1.8 1.8L8.8 13.8 6.5 14z" />
    </>
  ),
  agent: (
    // reference "bot": a robot head — the subagent/delegate glyph.
    <>
      <rect x="2.5" y="4" width="11" height="8.5" rx="2" />
      <path d="M8 1.5v2.5M5.5 7.5h.01M10.5 7.5h.01M5.5 10h5" />
    </>
  ),
  skill: (
    // reference "task": a checklist — executing a packaged skill.
    <>
      <path d="M8.5 4.75H13.5M8.5 12.25H13.5M2.35 11.25L3.55 12.45L5.95 10.05" />
      <circle cx="3.75" cy="4.75" r="1.75" />
    </>
  ),
  // --- drawn here (no reference counterpart), same stroke style ---
  summary: (
    // three stacked lines — a digest/list.
    <path d="M3 5h10M3 8h10M3 11h7" />
  ),
  alert: (
    // triangle with an exclamation mark.
    <>
      <path d="M8 2.5 14 13H2z" />
      <path d="M8 6.5v3M8 11.5h.01" />
    </>
  ),
};

/** The 16×16 category glyph for an activity header or tool summary. */
export function ToolIcon({
  type,
  className,
}: {
  type: SummaryIconType;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      data-tool-icon-type={type}
    >
      {TOOL_ICON_PATHS[type]}
    </svg>
  );
}
