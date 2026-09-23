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
import type { AppController } from './app-controller';
import { useRegistry } from './registry-context';
import { useAppActions, useAppSnapshot } from './use-app';

export interface ModalsFeatureProps {
  controller: AppController;
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

  // ── ③ PlanModal：由当前会话里未决（pending）的 plan 块触发，同一块只弹一次 ──
  const pendingPlan = useMemo<PlanBlock | null>(() => {
    let found: PlanBlock | null = null;
    for (const m of s.slice?.messages ?? []) {
      for (const b of m.blocks) {
        if (b.kind === 'plan' && b.status === 'pending') found = b;
      }
    }
    return found;
  }, [s.slice]);

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

  // ── ④ PlanModeModal / ⑤ ApiKeyModal：受控 open 用本地 useState ──
  // TODO（接缝缺失，非本轮所有权）：PlanModal/PlanModeModal 的应答在 vanilla 走
  // POST /api/answer（sendPlanAnswer/sendPlanModeAnswer），端口面（contracts/）尚未
  // 暴露该通道；PlanModeModal 的触发源（state.enterPlanMode.active）也待主控上抛到
  // AppSnapshot。本地 open 与回调已就绪，通道到位后补一行即可。
  const [planModeOpen, setPlanModeOpen] = useState(false);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState('');

  const choosePlan = (choice: PlanChoice, contextText: string): void => {
    void choice;
    void contextText;
    setPlanOpen(false);
  };

  const choosePlanMode = (choice: PlanModeChoice): void => {
    void choice;
    setPlanModeOpen(false);
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
        open={planOpen}
        planTitle={pendingPlan?.title ?? 'Plan'}
        summary={(pendingPlan?.steps ?? []).join('\n')}
        contextText={planContext}
        onContextChange={setPlanContext}
        onSubmit={choosePlan}
        onClose={() => setPlanOpen(false)}
      />

      <PlanModeModal open={planModeOpen} onChoose={choosePlanMode} onClose={() => setPlanModeOpen(false)} />

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
