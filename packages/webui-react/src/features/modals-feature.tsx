/** modals-feature —— 弹窗容器：授权队列/ask 问卷/Plan/PlanMode/ApiKey 的挂载与应答接线（接缝：AppSnapshot → 哑组件弹窗 props）。 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { PlanBlock } from '../contracts/domain';
import {
  ApiKeyModal,
  AskModal,
  AuthModal,
  PlanModal,
  PlanModeModal,
  type ApiKeySource,
  type AskModalAnswer,
  type AskModalQuestion,
  type PlanChoice,
  type PlanModeChoice,
} from '../ui/modals';
import type { AppController, Lang } from './app-controller';
import { useRegistry } from './registry-context';
import { useAppActions, useAppSnapshot } from './use-app';

export interface ModalsFeatureProps {
  controller: AppController;
}

/**
 * plan 应答的后续话术：agree/add 的决定要到达模型，唯一可用通道是把话术
 * 作为消息发出（vanilla 的 /api/answer 曾是 no-op，决定根本没送出去）。
 * 文案在 UI 层本地化；skip 不发。
 */
function planFollowUpText(choice: PlanChoice, contextText: string, lang: Lang): string | null {
  const ctx = contextText.trim();
  if (choice === 'agree') {
    return lang === 'en' ? 'Approved. Proceed with the plan.' : '同意该计划，开始执行。';
  }
  if (choice === 'add') {
    if (ctx === '') return null;
    return lang === 'en'
      ? `Addendum: ${ctx}\n\nProceed with the updated plan.`
      : `补充：${ctx}\n\n请按补充后的计划执行。`;
  }
  return null;
}

/** 授权请求 ctx 字段 → 友好名（'cid' 由 AuthModal 自动跳过）。 */
const AUTH_CTX_LABELS: Record<string, string> = {
  cmd: '命令',
  chatLen: '当前消息数',
  sessionId: '会话',
  mcodeSessionId: 'mcode 会话',
  source: '触发来源',
};

export function ModalsFeature({ controller }: ModalsFeatureProps) {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);
  const { notifier } = useRegistry();

  // ── ① AuthModal：授权队列（最紧急 —— 不接线会让请求静默挂到超时被拒） ──
  const head = s.authQueue[0] ?? null;
  const [msLeft, setMsLeft] = useState(0);
  const [deciding, setDeciding] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // 倒计时：msLeft = expiresAt - Date.now()，每秒刷新。
  useEffect(() => {
    const req = s.authQueue[0];
    if (!req) return;
    const tick = (): void => setMsLeft(Math.max(0, req.expiresAt - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [s.authQueue]);

  const decide = (approve: boolean): void => {
    const req = s.authQueue[0];
    if (!req || deciding) return;
    setDeciding(true);
    setAuthError(null);
    void a
      .decideAuth(req.requestId, approve)
      .catch((e: unknown) => setAuthError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDeciding(false));
  };

  // ── ② AskModal：当前会话里未答的 ask-user 块构成问卷 ──
  const questions = useMemo<AskModalQuestion[]>(() => {
    const out: AskModalQuestion[] = [];
    for (const m of s.slice?.messages ?? []) {
      for (const b of m.blocks) {
        if (b.kind === 'ask-user' && b.answered !== true) {
          out.push({ id: b.id, question: b.question, options: b.options, multiSelect: b.multiSelect });
        }
      }
    }
    return out;
  }, [s.slice]);

  // 提交/跳过后本地收起（块的 answered 由服务端回流才会置真）；题目集合变化时重新弹出。
  const questionsKey = questions.map((q) => q.id).join('|');
  const [askDismissed, setAskDismissed] = useState(false);
  useEffect(() => {
    setAskDismissed(false);
  }, [questionsKey]);

  const submitAsk = (answers: AskModalAnswer[]): void => {
    for (const ans of answers) {
      a.sendAskConfirm(ans.questionId, ans.optionIds);
      // 「其他」自由文本按 vanilla 语义作为一条消息回答（/api/send isAskAnswer 的等价物）。
      if (ans.text) void a.send(ans.text);
    }
    setAskDismissed(true);
  };

  // ── ③ PlanModal：wire state.plan 直读（plan_update 事件维护）优先，
  //    历史会话无 wire plan 时回落到聊天文本里的 pending plan 块 ──
  const pendingPlan = useMemo<PlanBlock | null>(() => {
    let found: PlanBlock | null = null;
    for (const m of s.slice?.messages ?? []) {
      for (const b of m.blocks) {
        if (b.kind === 'plan' && b.status === 'pending') found = b;
      }
    }
    return found;
  }, [s.slice]);

  // live plan：应答（POST /api/answer type=plan）后服务端清 cs.plan 并广播
  // state → slice.plan 变 null → 弹窗必然关闭，无需本地手动维持开合。
  const livePlan = s.slice?.plan ?? null;
  const livePlanKey = livePlan ? livePlan.planId ?? livePlan.title : null;
  const [livePlanDismissed, setLivePlanDismissed] = useState(false);
  useEffect(() => {
    setLivePlanDismissed(false);
  }, [livePlanKey]);

  const [planOpen, setPlanOpen] = useState(false);
  const [planContext, setPlanContext] = useState('');
  const planShownRef = useRef<string | null>(null);
  useEffect(() => {
    const plan = pendingPlan;
    if (plan && plan.id !== planShownRef.current) {
      planShownRef.current = plan.id;
      setPlanOpen(true);
    }
  }, [pendingPlan]);

  // ── ④ PlanModeModal：state.enterPlanMode.active 驱动（mode_update 事件）；
  //    应答后服务端清 enterPlanMode → active 变 false 自动关闭。 ──
  const planModeActive = s.enterPlanMode?.active === true;
  const planModePrompt = s.enterPlanMode?.prompt ?? null;
  const [planModeDismissed, setPlanModeDismissed] = useState(false);
  const planModePromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (planModePrompt !== planModePromptRef.current) {
      planModePromptRef.current = planModePrompt;
      setPlanModeDismissed(false);
    }
  }, [planModePrompt]);

  // ── ⑤ ApiKeyModal：受控 open 用本地 useState ──
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState('');

  const choosePlan = (choice: PlanChoice, contextText: string): void => {
    setPlanOpen(false);
    setLivePlanDismissed(true);
    void a
      .answerPlan(choice, contextText)
      .then(() => {
        // agree/add 的决定要到达模型 —— 作为消息发出；skip 不发。
        const text = planFollowUpText(choice, contextText, s.lang);
        if (text !== null) return a.send(text);
      })
      .catch((e: unknown) => {
        notifier.toast(`应答失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      });
  };

  const choosePlanMode = (choice: PlanModeChoice): void => {
    setPlanModeDismissed(true);
    void a.answerPlanMode(choice).catch((e: unknown) => {
      notifier.toast(`应答失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    });
  };

  // ApiKeyModal：保存/清空 Subscription Key —— 对齐 vanilla events.js 的
  // saveApiKey/deleteApiKey（POST /api/settings { tokenPlanApiKey }）。
  const saveApiKey = (): void => {
    const k = apiKeyValue.trim();
    if (!k) {
      notifier.toast('请先填入 Subscription Key', 'warn');
      return;
    }
    void a.updateSettings({ tokenPlanApiKey: k, quotaEnabled: true }).then(() => {
      setApiKeyValue('');
      setApiKeyOpen(false);
      notifier.toast('已保存', 'success');
      void a.refreshUsage();
    });
  };

  const deleteApiKey = (): void => {
    void (async () => {
      const ok = await notifier.confirm('清空 Subscription Key', '确定清空 Subscription Key？清空后套餐用量数据不显示。');
      if (!ok) return;
      await a.updateSettings({ tokenPlanApiKey: '' });
      setApiKeyOpen(false);
      notifier.toast('已清空', 'success');
      void a.refreshUsage();
    })();
  };

  const settings = s.settings;
  const apiKeySourceValue = settings?.tokenPlanApiKeySource;
  const apiKeySource: ApiKeySource =
    apiKeySourceValue === 'env' || apiKeySourceValue === 'file' || apiKeySourceValue === 'settings'
      ? apiKeySourceValue
      : '';

  return (
    <>
      <AuthModal
        open={head != null}
        request={
          head
            ? { requestId: head.requestId, action: head.action, ctx: head.ctx }
            : null
        }
        position={1}
        total={s.authQueue.length}
        msLeft={msLeft}
        deciding={deciding}
        error={authError}
        ctxLabels={AUTH_CTX_LABELS}
        onApprove={() => decide(true)}
        onDeny={() => decide(false)}
      />

      <AskModal
        open={!askDismissed && questions.length > 0}
        questions={questions}
        onSubmit={submitAsk}
        onSkip={() => {
          void a.send('esc');
          setAskDismissed(true);
        }}
        onClose={() => setAskDismissed(true)}
      />

      <PlanModal
        open={planOpen || (livePlan != null && !livePlanDismissed)}
        planTitle={livePlan?.title ?? pendingPlan?.title ?? 'Plan'}
        summary={livePlan?.summary !== '' && livePlan != null ? livePlan.summary : (pendingPlan?.steps ?? []).join('\n')}
        contextText={planContext}
        onContextChange={setPlanContext}
        onSubmit={choosePlan}
        onClose={() => {
          setPlanOpen(false);
          setLivePlanDismissed(true);
        }}
      />

      <PlanModeModal
        open={planModeActive && !planModeDismissed}
        onChoose={choosePlanMode}
        onClose={() => setPlanModeDismissed(true)}
      />

      <ApiKeyModal
        open={apiKeyOpen}
        configured={settings?.hasTokenPlanKey === true}
        masked={typeof settings?.tokenPlanApiKeyMasked === 'string' ? settings.tokenPlanApiKeyMasked : undefined}
        source={apiKeySource}
        filePath={
          typeof settings?.tokenPlanApiKeyFilePath === 'string'
            ? settings.tokenPlanApiKeyFilePath
            : undefined
        }
        value={apiKeyValue}
        onValueChange={setApiKeyValue}
        onSave={saveApiKey}
        onDelete={deleteApiKey}
        onClose={() => setApiKeyOpen(false)}
      />
    </>
  );
}
