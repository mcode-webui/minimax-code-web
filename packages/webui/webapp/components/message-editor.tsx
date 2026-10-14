// webapp/components/message-editor.tsx
//
// PB-15 (`doc/placeholder-batch-plan.md` §7 row G-3): the inline editor on a
// user message — 「编辑消息 → 从该处重发」.
//
// The shape, and why it is this shape:
//
//   * THE CONTROL APPEARS ON HOVER over the user's own bubble, and only on a
//     bubble that carries an engine coordinate (`block.userMessageId`, the
//     `§§ user_msg=<id>` marker the server writes and `lib/transcript.ts`
//     decodes). A user message with no coordinate has no honest edit target,
//     so it gets no button at all rather than one that would send an empty
//     selector.
//   * CLICKING 编辑 replaces the bubble with a textarea and 确认 / 取消. It
//     does not open a modal: the desktop edits in place, and a modal hides
//     the very message the user is rewriting.
//   * 确认 does NOT always make the same call. Text changed → the engine's
//     atomic `editSessionMessage` (rewind, rewrite, resubmit). Text unchanged
//     → `rewindSession` and then an ordinary `/api/send`, because re-running
//     an identical message through the atomic path would mint a second engine
//     operation for no change to the text. `lib/message-edit.ts` owns that
//     decision as a pure function.
//   * AFTERWARDS the session is re-read through the existing switch path
//     (`POST /api/sessions/switch`), which reloads the transcript from the
//     engine and pushes a state frame. That is the same refresh a session
//     click performs; no new refresh mechanism is introduced here.
//   * FAILURES ARE SHOWN AS THEY CAME. A refusal carries the server's own
//     `error` string, and a 200 whose `rewound` is false is reported as a
//     non-rewind rather than as a success. There is no path in this file
//     that renders 「已重发」 without the engine having said `rewound: true`.
//
// The presentational half (`MessageEditControl`) takes every piece of that
// state as a prop so the rendering is testable without a DOM harness; the
// stateful half (`UserMessage`) owns the calls.

import { useCallback, useState } from "react";
import * as api from "../lib/api";
import { getActiveSessionId } from "../lib/store";
import {
  planMessageEdit,
  readEditOutcome,
  readRefusalOutcome,
  readRewindOutcome,
  type MessageEditOutcome,
} from "../lib/message-edit";
import type { MessageKey } from "../lib/i18n";

type TFn = (key: MessageKey) => string;

/**
 * The presentational half: a user bubble, its 编辑 control, and — while
 * editing — the textarea with 确认 / 取消.
 *
 * `editable` is decided by the CALLER (the bubble must carry a coordinate
 * and the session must be idle) so that this function has one job: render
 * the state it was given.
 */
export function MessageEditControl({
  text,
  editable,
  editing,
  draft,
  busy,
  note,
  t,
  onStart,
  onDraftChange,
  onConfirm,
  onCancel,
}: {
  text: string;
  editable: boolean;
  editing: boolean;
  draft: string;
  busy: boolean;
  /** The outcome sentence, or `null`. Rendered as written. */
  note: string | null;
  t: TFn;
  onStart: () => void;
  onDraftChange: (next: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <div
        className="w-full max-w-[80%]"
        data-testid="user-message-editor"
        data-message-id-busy={busy ? "1" : undefined}
      >
        <textarea
          className="w-full resize-y rounded-[16px] border border-border_default bg-bg_default_primary px-3 py-2 text-text_default_primary outline-none focus:border-text_default_primary"
          value={draft}
          rows={Math.min(12, Math.max(2, draft.split("\n").length + 1))}
          aria-label={t("chat.messageEdit.field")}
          data-testid="user-message-editor-field"
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-[8px] border border-border_default px-3 py-1 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
            data-testid="user-message-editor-cancel"
          >
            {t("chat.messageEdit.cancel")}
          </button>
          <button
            type="button"
            className="rounded-[8px] bg-bg_accent_default px-3 py-1 text-sm text-text_on_accent disabled:opacity-50"
            onClick={onConfirm}
            disabled={busy}
            data-testid="user-message-editor-confirm"
          >
            {busy ? t("chat.messageEdit.busy") : t("chat.messageEdit.confirm")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-end gap-2">
      <div className="relative w-fit max-w-[80%]">
        {/* The control sits ABOVE the bubble's leading edge, revealed on the
            group's hover — the desktop puts it there, and a control inside
            the bubble would sit on top of the text being read. */}
        {editable ? (
          <button
            type="button"
            aria-label={t("chat.messageEdit.action")}
            title={t("chat.messageEdit.action")}
            onClick={onStart}
            className="absolute -top-7 right-0 rounded-[8px] border border-border_default bg-bg_default_primary px-2 py-0.5 text-xs text-text_default_secondary opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
            data-testid="user-message-edit"
          >
            {t("chat.messageEdit.action")}
          </button>
        ) : null}
        <div className="rounded-[16px] bg-bg_grouped_tertiary px-3 py-2 text-left">
          <div className="text-text_default_primary">
            <p className="desktop-text-chat-body message-container-user-text break-words whitespace-pre-wrap">
              {text}
            </p>
          </div>
        </div>
      </div>
      {note ? (
        <p
          className="text-xs text-text_default_secondary"
          data-testid="user-message-edit-note"
          data-outcome={note}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The stateful half: owns the editor's open/closed state, the draft, the
 * in-flight flag and the outcome sentence, and performs the two engine
 * calls.
 */
export function UserMessage({
  text,
  messageId,
  sessionRunning,
  t,
}: {
  text: string;
  /** The engine coordinate. Absent → no editor is offered at all. */
  messageId?: string;
  sessionRunning: boolean;
  t: TFn;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MessageEditOutcome | null>(null);
  // The session id is read at CALL time from the module-scope store rather
  // than captured at render time: a rewind changes the conversation, and a
  // closed-over id from before the user switched sessions would refresh the
  // wrong one.
  const refreshSession = useCallback(async () => {
    const active = getActiveSessionId();
    if (!active) return;
    try {
      await api.switchSession(active);
    } catch {
      // The mutation already happened and the transcript is stale; a failed
      // REFRESH must not overwrite the sentence describing the mutation
      // with a different failure. The user sees the engine's own answer.
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!messageId || busy) return;
    const plan = planMessageEdit(text, draft);
    if (plan.kind === "blocked") {
      setOutcome({ status: "refused", code: "empty", message: t("chat.messageEdit.empty") });
      return;
    }
    setBusy(true);
    try {
      let result: MessageEditOutcome;
      if (plan.kind === "edit") {
        result = readEditOutcome(await api.editSessionMessage(messageId, plan.content));
      } else {
        const rewound = readRewindOutcome(await api.rewindSession(messageId));
        if (rewound.status !== "resent") {
          result = rewound;
        } else {
          // The resend is an ordinary send, and its acceptance is the
          // user's own message landing — a refusal here is the engine's and
          // is shown as one.
          await api.sendMessage({ content: plan.content });
          result = rewound;
        }
      }
      setOutcome(result);
      setEditing(false);
      if (result.status === "edited" || result.status === "resent") {
        await refreshSession();
      }
    } catch (error) {
      // Never a success: the editor stays open with the user's text so the
      // click is not lost.
      setOutcome(readRefusalOutcome(error));
    } finally {
      setBusy(false);
    }
  }, [messageId, busy, text, draft, t, refreshSession]);

  const note = outcome === null ? null : describeOutcome(outcome, t);

  return (
    <div className="mb-4">
      <div className="message-animate-in group flex w-full justify-end">
        <MessageEditControl
          text={text}
          editable={!!messageId && !sessionRunning}
          editing={editing}
          draft={draft}
          busy={busy}
          note={note}
          t={t}
          onStart={() => {
            setDraft(text);
            setOutcome(null);
            setEditing(true);
          }}
          onDraftChange={setDraft}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setEditing(false);
            setDraft(text);
            setOutcome(null);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Turn an outcome into the ONE sentence the row may show.
 *
 * Kept separate from the component so the wording is testable and so the
 * mapping is exhaustive by construction: a new outcome that nobody words is a
 * type error rather than a silent blank row.
 */
export function describeOutcome(outcome: MessageEditOutcome, t: TFn): string {
  switch (outcome.status) {
    case "edited":
      return t("chat.messageEdit.edited");
    case "resent":
      return outcome.diffRewind === "reverted"
        ? t("chat.messageEdit.resent")
        : t("chat.messageEdit.resentFilesKept");
    case "not_rewound":
      return t("chat.messageEdit.notRewound");
    case "refused":
      // The server's own sentence, verbatim. A refusal written for the
      // engine's caller is still more useful than a webui paraphrase that
      // hides which of the engine's gates closed.
      return outcome.message;
  }
}