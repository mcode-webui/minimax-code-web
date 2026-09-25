/**
 * chat/time.ts —— 消息时间格式化（MessageItem / MessageActions / ExecStatusRow 共用）
 * 毫秒时间戳 → "YY/MM/dd HH:mm:ss"；历史消息经 chatLinesToMessages 水合时
 * 用序号占位（0,1,2…），不是真实时间戳，一律返回 null（UI 显示 "--"）。
 */
export function formatMessageTime(ts: number): string | null {
  if (!Number.isFinite(ts) || ts < 1e11) return null;
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${yy}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** ts → ISO（<time dateTime> 用）；无效返回 undefined。 */
export function messageTimeISO(ts: number): string | undefined {
  if (!Number.isFinite(ts) || ts < 1e11) return undefined;
  return new Date(ts).toISOString();
}
