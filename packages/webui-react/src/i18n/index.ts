/**
 * src/i18n/index.ts —— 双语字典入口（纯函数，零 React / 零 DOM 扫描）
 * 【职责】t(key, lang?) 取文案（缺键回落 key 本身，与 vanilla 行为一致）；
 *   setLang / getLang 管当前语言并经 KeyValueStorePort 持久化（webui-lang，
 *   首次默认 en，与 public/app/i18n.js 一致）；LANGS 枚举可用语言。
 * 【接缝】词典数据在 zh.ts / en.ts；持久化走 KeyValueStorePort（默认
 *   core/store/kv-port.ts 的 localStorage 实现，可用 setLangStore 注入替换）。
 *   不做 DOM 的 data-i18n 扫描（那是 ui 层的职责），保持可测纯逻辑。
 */
import type { KeyValueStorePort } from '../contracts/ports';
import { createKvPort } from '../core/store/kv-port';
import type { I18nKey } from './zh';
import { zh } from './zh';
import { en } from './en';

export const LANGS = ['zh', 'en'] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_STORE_KEY = 'webui-lang';
export const DEFAULT_LANG: Lang = 'en';

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

let kv: KeyValueStorePort = createKvPort();

function readInitial(): Lang {
  const saved = kv.get(LANG_STORE_KEY);
  return isLang(saved) ? saved : DEFAULT_LANG;
}

let currentLang: Lang = readInitial();

/** 替换持久化实现（测试 / 组装根注入）。会用新 kv 重新读一次当前语言。 */
export function setLangStore(store: KeyValueStorePort): void {
  kv = store;
  currentLang = readInitial();
}

/** 取文案；lang 省略时用当前语言。缺键回落到 key 本身（与 vanilla t() 一致）。 */
export function t(key: string, lang?: Lang): string {
  const l: Lang = lang && isLang(lang) ? lang : currentLang;
  const dict = DICTS[l];
  const v = dict ? dict[key] : undefined;
  return v || key;
}

/** 切换语言并持久化；非法值忽略。 */
export function setLang(lang: Lang): void {
  if (!isLang(lang)) return;
  currentLang = lang;
  kv.set(LANG_STORE_KEY, lang);
}

export function getLang(): Lang {
  return currentLang;
}

/** 全部文案键的类型（供 ui 层做键名约束）。 */
export type { I18nKey };
