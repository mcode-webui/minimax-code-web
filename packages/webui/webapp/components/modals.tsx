"use client";

import { Input as AntInput, Modal as AntModal } from "antd";
import { useState } from "react";

import * as api from "@/lib/api";
import { useSessionContext } from "@/lib/store";
import { postAuthDecision } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";

/**
 * Blocking prompts: plan review, ask_user and authorization.
 *
 * All three are driven by state the server already pushes — `state.plan`,
 * `state.ask` ride on the snapshot, and authorization arrives as the
 * `needs_authorization` SSE frame (exposed by the store as `authorize`). Nothing
 * here polls.
 *
 * Answers go back on the channels the server documents:
 *   plan    -> POST /api/answer {type:"plan", option: agree|skip|add}
 *   ask     -> POST /api/send   {content, isAskAnswer:true}
 *   auth    -> POST /api/auth/decision {requestId, approve}
 */

export function Modals({ t }: { t: (key: MessageKey) => string }) {
  return (
    <>
      <PlanModal t={t} />
      <AskModal t={t} />
      <AuthModal t={t} />
    </>
  );
}

function PlanModal({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const [busy, setBusy] = useState(false);
  const plan = state?.plan;
  if (!plan?.active) return null;

  const answer = async (option: "agree" | "skip" | "add") => {
    setBusy(true);
    try {
      await api.answer("plan", option);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={plan.title || t("plan.title")}>
      {plan.summary ? (
        <p className="whitespace-pre-wrap text-text_default_secondary">{plan.summary}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PrimaryButton disabled={busy} onClick={() => void answer("agree")}>
          {t("plan.agree")}
        </PrimaryButton>
        <GhostButton disabled={busy} onClick={() => void answer("add")}>
          {t("plan.addContext")}
        </GhostButton>
        <GhostButton disabled={busy} onClick={() => void answer("skip")}>
          {t("plan.skip")}
        </GhostButton>
      </div>
    </Modal>
  );
}

function AskModal({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  // Multi-select: the labels the user has ticked. Cleared on every
  // successful reply so a follow-up question starts from a fresh state.
  // Order is preserved by filtering `ask.options` rather than dumping the
  // set directly.
  const [picked, setPicked] = useState<string[]>([]);
  const ask = state?.ask;
  if (!ask?.active) return null;

  // Read `multiSelect` defensively: AskState does not declare it yet, so the
  // checkbox branch stays dormant until the server forwards the flag.
  const multiSelect = (ask as { multiSelect?: boolean }).multiSelect === true;

  const reply = async (content: string) => {
    setBusy(true);
    try {
      // Documented path for ask_user: sending with isAskAnswer keeps the
      // answer out of the transcript (the server skips the `›` line for it).
      // Multi-select reuses this channel — the wire payload is unchanged
      // (`{ content: string, isAskAnswer: true }`), the labels are joined
      // into a single string. The server route forwards the string to the
      // engine without validating the answer shape.
      await api.sendMessage({ content, isAskAnswer: true });
      setOther("");
      setPicked([]);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Option click handler. Dispatches on single vs multi:
   *   single — reply immediately with the option's index string,
   *            matching the existing single-select contract.
   *   multi  — toggle the option in the picked list; nothing is sent
   *            until the Submit button is pressed.
   */
  const onOption = (label: string, index: number) => {
    if (multiSelect) {
      setPicked((current) => {
        if (current.includes(label)) return current.filter((entry) => entry !== label);
        return [...current, label];
      });
      return;
    }
    void reply(String(index));
  };

  /**
   * Submit handler for the free-text "Other" row.
   *   single — sends `other.trim()` (unchanged from the pre-port
   *            behaviour: option clicks already submitted directly).
   *   multi  — sends the collected set: selected option labels (in
   *            the order they appear in `ask.options`) joined by
   *            `, `, then a `; ` separator and the "Other" text when
   *            both are present. Order-preserving matters because the
   *            answer is forwarded as a single string to the engine.
   */
  const submitOther = () => {
    const text = other.trim();
    if (multiSelect) {
      const selected = ask.options.filter((option) => picked.includes(option));
      if (selected.length === 0 && !text) return;
      const parts: string[] = [];
      if (selected.length) parts.push(selected.join(", "));
      if (text) parts.push(text);
      void reply(parts.join("; "));
      return;
    }
    if (!text) return;
    void reply(text);
  };

  const canSubmit =
    multiSelect
      ? picked.length > 0 || other.trim().length > 0
      : other.trim().length > 0;

  return (
    <Modal
      title={t("ask.title")}
      meta={ask.total > 1 ? `${ask.currentIdx + 1}/${ask.total}` : undefined}
    >
      <p className="whitespace-pre-wrap text-text_default_primary">{ask.question}</p>

      {multiSelect ? (
        <p
          className="mt-2 text-caption-small-strong text-text_default_tertiary"
          data-testid="ask-multiselect-hint"
        >
          {t("ask.multiSelectHint")}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-1">
        {ask.options.map((option, index) => {
          const isPicked = multiSelect && picked.includes(option);
          return (
            <button
              key={`${index}-${option}`}
              type="button"
              disabled={busy}
              role={multiSelect ? "checkbox" : undefined}
              aria-checked={multiSelect ? isPicked : undefined}
              onClick={() => onOption(option, index)}
              className="flex items-center gap-2 rounded-lg border border-border_default px-3 py-2 text-left text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
            >
              <span
                className={[
                  "flex flex-none items-center justify-center text-caption-small-strong text-text_default_secondary",
                  multiSelect
                    ? isPicked
                      ? "size-5 rounded bg-bg_interaction_primary_default text-text_default_inverted_static"
                      : "size-5 rounded border border-border_default bg-bg_grouped_primary"
                    : "size-5 rounded-full bg-bg_grouped_primary",
                ].join(" ")}
              >
                {multiSelect ? (isPicked ? "✓" : "") : index + 1}
              </span>
              <span className="min-w-0 flex-1">{option}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <AntInput
          value={other}
          onChange={(event) => setOther(event.target.value)}
          placeholder={t("ask.other")}
          className="mavis-input min-w-0 flex-1"
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) {
              event.preventDefault();
              submitOther();
            }
          }}
        />
        <GhostButton disabled={busy || !canSubmit} onClick={submitOther}>
          {t("ask.submit")}
        </GhostButton>
        <GhostButton disabled={busy} onClick={() => void api.answer("ask", "esc")}>
          {t("ask.skip")}
        </GhostButton>
      </div>
    </Modal>
  );
}

function AuthModal({ t }: { t: (key: MessageKey) => string }) {
  const { authorize } = useSessionContext();
  const [busy, setBusy] = useState(false);
  if (!authorize) return null;

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await postAuthDecision(authorize.requestId, approve);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("auth.title")}>
      <p className="whitespace-pre-wrap text-text_default_secondary">{t("auth.requested")}</p>
      <p className="mt-2 break-all text-caption-small-strong text-text_default_tertiary">
        {authorize.action}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <PrimaryButton disabled={busy} onClick={() => void decide(true)}>
          {t("auth.approve")}
        </PrimaryButton>
        <GhostButton disabled={busy} onClick={() => void decide(false)}>
          {t("auth.deny")}
        </GhostButton>
      </div>
    </Modal>
  );
}

// --- shared chrome ----------------------------------------------------------

/**
 * Modal chrome.
 *
 * Two flavours, and the difference is deliberate:
 *
 *   blocking (no `onClose`)  the plan / ask / authorize prompts. They carry a
 *                            decision the server is waiting on, so there is no
 *                            close affordance, no Escape handler and no
 *                            backdrop dismissal — answering is the only way out.
 *   dismissible (`onClose`)  user-opened dialogs such as settings. A close
 *                            button, Escape and a backdrop click all dismiss.
 *
 * The body scrolls once it outgrows the viewport, which matters for the settings
 * dialog; the blocking prompts are short enough that it never engages.
 */
/**
 * The blocking decision prompts (plan / ask / authorize).
 *
 * antd's `Modal`, wearing the desktop's confirm-modal skin: the
 * `mavis-confirm-modal-compact*` rules were already ported verbatim into
 * `styles/official-utilities.css`, so the numbers below are the desktop's own
 * rather than a guess — the mask is `#00000040` with 10px of padding, the
 * surface has no border, a 20px radius and a `0 0 48px -12px` shadow, and the
 * title is weight 590 (which `text-heading3` also sets, so the ported title rule
 * is belt and braces).
 *
 * Note the mask: `--utility_blanket` is `#000000b2` and that is what the
 * desktop's *generic* overlay uses (measured on its update notice), but its
 * confirm modal overrides the dim to `#00000040`. The specific rule wins.
 *
 * Not dismissible, and that is the point: each of these carries a decision the
 * server is waiting on. The hand-rolled version got that by omitting three
 * listeners; here it is three explicit props — `closable={false}`,
 * `keyboard={false}`, `maskClosable={false}`. `footer={null}` because every
 * prompt brings its own answer buttons, and `destroyOnHidden` so a closed
 * prompt's local state (a typed "Other", a ticked set) does not survive into the
 * next question.
 */
export function Modal({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <AntModal
      open
      centered
      closable={false}
      keyboard={false}
      maskClosable={false}
      footer={null}
      destroyOnHidden
      width={520}
      rootClassName="mavis-confirm-modal-compact"
      classNames={{
        mask: "mavis-confirm-modal-compact-mask",
        content: "mavis-confirm-modal-compact-surface",
      }}
      // antd paints the header with `colorBgElevated`, and this app's
      // ConfigProvider does not configure antd's dark algorithm — the dark
      // palette comes from the token layer. So the header is a white band across
      // the desktop's dark surface, with white title text on it.
      //
      // A `bg-transparent` class does not fix it: antd's rule is
      // `:where(.css-hash).ant-modal .ant-modal-header`, which is two effective
      // classes and beats a one-class utility. `styles` emits an inline
      // declaration, which wins. (Same cascade fact as `hashPriority` in
      // `docs/ANTD-MIGRATION.md`, from the other side.)
      styles={{ header: { background: "transparent" } }}
      title={
        <span className="flex items-center gap-2">
          <span className="mavis-confirm-modal-compact-title text-heading3 text-text_default_primary">
            {title}
          </span>
          {meta ? (
            <span className="text-caption-small-strong text-text_default_tertiary">{meta}</span>
          ) : null}
        </span>
      }
    >
      {children}
    </AntModal>
  );
}

function PrimaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function GhostButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
    >
      {children}
    </button>
  );
}
