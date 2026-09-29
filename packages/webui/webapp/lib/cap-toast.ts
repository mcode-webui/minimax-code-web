// webapp/lib/cap-toast.ts
//
// The home quick-capability capsule toast's state machine (ticket 55c).
//
// Why a module of its own rather than an export from components/chat.tsx:
// chat.tsx carries the store/api/graph dependency graph ("use client",
// `@/lib/*` runtime imports), which node:test's loader cannot resolve —
// the same reason the ticket-53 display cards live in their own
// import-clean `components/usage-models-cards.tsx`. Pulling the state
// machine out makes the click→toast CONTRACT testable as behaviour
// (`webapp/test/shell-elements-parity.test.ts`), not only as source text:
// QA round M6 hollowed out the handler body while keeping the call site,
// and every source-only assertion stayed green.
//
// Two invariants live here and nowhere else:
//
//   - `click` always REPLACES the current toast with the newly clicked
//     chip's id and a fresh `at` stamp — one toast, latest reason, and the
//     auto-dismiss timer restarts with it.
//   - `dismiss` clears the toast ONLY when the stamp matches: the timer
//     belongs to the toast it was scheduled for, so a stale timer from an
//     already-replaced toast cannot dismiss its successor.

export type CapToast = { key: string; at: number } | null;

export type CapToastAction =
  | { type: "click"; id: string; now?: number }
  | { type: "dismiss"; at: number };

export function capToastReducer(state: CapToast, action: CapToastAction): CapToast {
  switch (action.type) {
    case "click":
      return { key: action.id, at: action.now ?? Date.now() };
    case "dismiss":
      return state !== null && state.at === action.at ? null : state;
  }
}
