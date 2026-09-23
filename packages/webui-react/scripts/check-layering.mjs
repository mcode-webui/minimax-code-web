#!/usr/bin/env node
/**
 * check-layering.mjs —— 分层铁律的机器验证（咬合力的守门员）
 * ============================================================================
 * 把高内聚低耦合从口头约定变成 CI 可执行的约束。任何越层 import 都会在这里
 * 报错，防止重构时不知不觉把接缝咬坏。
 *
 * 允许的依赖方向（单向向下）：
 *   ui/        -> contracts/domain, contracts/ports, core/store, ui/*
 *   features/  -> contracts/*, core/*, ui/*        （唯一可同时看见两侧）
 *   core/      -> contracts/*, core/*
 *   contracts/ -> contracts/*                       （自包含，不依赖任何层）
 *
 * 用法：node scripts/check-layering.mjs   （退出码 0 = 通过）
 * ============================================================================
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const specifiers = [];
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) specifiers.push(m[1]);
  return specifiers;
}

function layerOf(relPath) {
  const head = relPath.split(/[\\/]/)[0];
  return head === 'contracts' || head === 'core' || head === 'features' || head === 'ui' ? head : null;
}

// 每一层允许依赖的目标。null 表示同层。
const ALLOWED = {
  contracts: new Set(['contracts']),
  core: new Set(['contracts', 'core']),
  features: new Set(['contracts', 'core', 'features', 'ui']),
  ui: new Set(['contracts/domain', 'contracts/ports', 'core/store', 'ui']),
};

// 额外的硬禁令：ui 与 core 都不得引入 React 之外的 UI 框架到 core；core 不得用 react。
const FORBIDDEN = [
  { layer: 'core', pattern: /^react(-dom)?$|^antd$|^@ant-design\//, reason: 'core 必须零 UI 依赖' },
  { layer: 'ui', pattern: /^\.\.\/contracts\/protocol$/, reason: 'ui 只见 domain/ports，不得见线上格式' },
  { layer: 'ui', pattern: /^\.\.\/core\/(?!store\/)/, reason: 'ui 不得依赖 core 实现（只能用 core/store 的纯 store）' },
  { layer: 'ui', pattern: /^\.\.\/features\//, reason: 'ui 不得反向依赖 features' },
];

const files = walk(SRC);
const violations = [];

for (const file of files) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  const layer = layerOf(rel);
  if (!layer) continue;
  for (const spec of importsOf(file)) {
    // 相对 import 解析到哪一层
    let target = null;
    if (spec.startsWith('.')) {
      const abs = join(SRC, rel, '..', spec);
      const relTarget = relative(SRC, abs).replace(/\\/g, '/');
      target = layerOf(relTarget);
      if (relTarget.startsWith('contracts/')) target = 'contracts/' + relTarget.split('/')[1].replace(/\.ts$/, '');
    } else {
      // 包 import：只对 core 层做 UI 框架禁令
      for (const f of FORBIDDEN) {
        if (f.layer === layer && f.pattern.test(spec)) violations.push({ rel, spec, reason: f.reason });
      }
      continue;
    }
    if (!target) continue;
    const allowed = ALLOWED[layer];
    const ok = [...allowed].some((a) => target === a || target.startsWith(a + '/') || (a.endsWith('.ts') && target === a.replace(/\.ts$/, '')));
    // ui 层的白名单是精确子路径，单独判
    if (layer === 'ui') {
      const fine = target === 'contracts/domain' || target === 'contracts/ports' || target === 'core/store' || target.startsWith('ui');
      if (!fine) violations.push({ rel, spec, reason: 'ui 层只允许依赖 contracts/domain、contracts/ports、core/store、ui/*' });
      continue;
    }
    if (!ok) violations.push({ rel, spec, reason: layer + ' 不得依赖 ' + target });
  }
  // 相对路径的硬禁令
  for (const f of FORBIDDEN) {
    if (f.layer !== layer) continue;
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.') && f.pattern.test(spec)) violations.push({ rel, spec, reason: f.reason });
    }
  }
}

if (violations.length === 0) {
  console.log('分层检查通过：' + files.length + ' 个文件，0 处越层依赖。');
  process.exit(0);
}

console.error('分层检查失败：发现 ' + violations.length + ' 处越层依赖\n');
for (const v of violations) console.error('  ' + v.rel + '\n    import ' + v.spec + '\n    → ' + v.reason);
process.exit(1);
