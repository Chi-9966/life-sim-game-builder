#!/usr/bin/env node
/* qa_lint.mjs — 单文件人生模拟游戏的机械化完备度检查器（无第三方依赖，node >= 16）
 *
 * 用法: node qa_lint.mjs <game.html> [--tier mini|standard|full|demo] [--whitelist-x xx,yy]
 *   --demo 用于引擎骨架自身（demo 内容仅在格式示例档位）
 * 退出码: 0 = 通过；1 = 存在 error
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const file = argv[0];
if (!file) { console.error('用法: node qa_lint.mjs <game.html> [--tier mini|standard|full|demo]'); process.exit(2); }
let tier = 'standard', wlX = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--tier') tier = argv[++i];
  else if (argv[i] === '--whitelist-x') wlX = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  else if (argv[i] === '--demo') tier = 'demo';
}
const html = fs.readFileSync(file, 'utf8');
const errs = [], warns = [], notes = [];

/* ---------- 抽取 JS ---------- */
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) { console.log('✗ [E0] 未找到 <script> 主脚本块'); process.exit(1); }
const js = scriptMatch[1];

/* 1. 语法 */
try { new Function(js); notes.push('JS 语法编译通过'); }
catch (e) {
  console.log('===== qa_lint 报告 =====\n✗ [E1] JS 语法错误: ' + e.message + '\n===== 结果: FAIL =====');
  process.exit(1);
}

/* ---------- 收集定义 ---------- */
const definedFns = new Set();
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) definedFns.add(m[1]);
for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) definedFns.add(m[1]);
for (const m of js.matchAll(/window\.(__[A-Za-z_$][\w$]*)\s*=/g)) definedFns.add(m[1]);

const getBlock = (name) => {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*[{[]([\\s\\S]*?)\\n[}]`);
  const m = js.match(re);
  return m ? m[1] : '';
};
const CAST_BLOCK = getBlock('CAST'), CAST2_BLOCK = getBlock('CAST2'), PLACES_BLOCK = getBlock('PLACES'), MEET_BLOCK = getBlock('MEET_DEF');

const keysAtLineStart = (block) => {
  const ids = new Set();
  for (const m of block.matchAll(/^[ \t]*'(?:([A-Za-z0-9_]+))'|^[ \t]*([A-Za-z_][\w$]*)\s*:/gm)) ids.add(m[1] || m[2]);
  return ids;
};
const castIds = new Set();
for (const m of (CAST_BLOCK + '\n' + CAST2_BLOCK).matchAll(/\bid:'([a-z0-9_]+)'/g)) castIds.add(m[1]);
const placeIds = keysAtLineStart(PLACES_BLOCK);
for (const m of (MEET_BLOCK || '').matchAll(/^ {2}[A-Za-z][\w$]*:\s*\{/gm)) {/* noop: member keys at indent 2 */}
const meetTopKeys = new Set();
for (const m of (MEET_BLOCK || '').matchAll(/(?:^|\n)( {2})([a-z][a-z0-9_]*):/g)) meetTopKeys.add(m[2]);

/* 内置 SYSTEM 前缀场景族（引擎级，世俗 id 依工厂/switch 手工解析） */
const registeredPrefixes = ['sys_pamper', 'sys_divorce', 'sys_propose', 'sys_ex_family', 'sys_male_estate', 'sys_conflict', 'sys_eat', 'gen_date', 'gen_secret', 'gen_invite', 'sys_birth', 'sys_preg_risk', 'opening'];

/* ---------- 2. 处理函数闭合 ---------- */
const DOM_NOISE = new Set(['this', 'window', 'document', 'alert', 'confirm', 'prompt', 'closest', 'remove', 'replace', 'preventDefault', 'stopPropagation', 'focus', 'blur', 'select', 'scroll', 'scrollTo', 'get', 'set', 'push', 'i', 'e', 'el']);
const handlers = new Set();
for (const m of html.matchAll(/\son(?:click|input|change)="([^"]*)"/g)) {
  for (const f of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (!DOM_NOISE.has(f[1])) handlers.add(f[1]);
}
const missFns = [...handlers].filter(h => !definedFns.has(h));
if (missFns.length) errs.push('[E2] 内联处理函数未定义: ' + missFns.join(', '));

/* ---------- 3. 场景引用闭合 ---------- */
const sceneDefs = new Set();
{
  const scBlock = js.match(/const\s+SCENES\s*=\s*\{([\s\S]*?)\n\};/);
  if (scBlock) for (const m of scBlock[1].matchAll(/(?:^|[\n,])[ \t]*(?:'([A-Za-z0-9_]+)'|([A-Za-z_][\w$]*))\s*:\s*(?:\(|function|\{|\()/g)) sceneDefs.add(m[1] || m[2]);
  for (const m of js.matchAll(/SCENES\[('([^']+)'|([A-Za-z_$][\w$]*)\+)?/g)) { if (m[2]) sceneDefs.add(m[2]); }
  const plotBlock = js.match(/const\s+PLOT_SCENES\s*=\s*\{([\s\S]*?)\n\};/);
  if (plotBlock) for (const m of plotBlock[1].matchAll(/(?:^|[\n,])[ \t]*(?:'([A-Za-z0-9_]+)'|([A-Za-z_][\w$]*))\s*:\s*\{/g)) sceneDefs.add(m[1] || m[2]);
  if (/PLOT_SCENES\s*=\s*\{/.test(js) && !plotBlock) warns.push('[W31] PLOT_SCENES 存在但未按 const PLOT_SCENES = {...}; 形式书写，请人工核对');
  // 初遇工厂：SCENES[k+'_meet'] 模式 ⇒ MEET_DEF 的每个键派生 <key>_meet
  if (/SCENES\[\s*[A-Za-z_$][\w$]*\s*\+\s*'_meet'?/.test(js) || /SCENES\[[A-Za-z_$][\w$]*\+' _ meet'/.test(js) || js.includes("_meet']")) {
    meetTopKeys.forEach(k => sceneDefs.add(k + '_meet'));
  }
  sceneDefs.add('__none__');
}
sceneDefs.delete('__none__');
const usedIds = new Set();
for (const m of js.matchAll(/next:\s*'@?([A-Za-z0-9_:]+)'/g)) { const id = m[1]; if (id && !['close', 'consent', 'commit'].includes(id)) usedIds.add(id.split(':')[0]); }
for (const m of js.matchAll(/\.push\(\s*'([A-Za-z0-9_:]+)'(?!\s*\+)/g)) usedIds.add(m[1].split(':')[0]);
for (const m of js.matchAll(/showScene\(\s*'([^':]+)'/g)) usedIds.add(m[1].split(':')[0]);
const unresolvedBad = [...usedIds].filter(id =>
  !sceneDefs.has(id) && !registeredPrefixes.some(p => id === p || id.startsWith(p + '_') || id.startsWith(p + ':')) &&
  !id.startsWith('ev_') && !/^[a-z][a-z0-9_]+_meet$/.test(id));
if (unresolvedBad.length) errs.push('[E3] 引用了未知场景 id: ' + unresolvedBad.join(', '));

/* ---------- 4. fx 词表闭合 ---------- */
const acceptFx = new Set();
for (const m of js.matchAll(/case\s+'([a-z_0-9]+)'\s*:/g)) acceptFx.add(m[1]);
if (!acceptFx.has('aff')) warns.push('[W41] applyFx 中未见 aff 分支，请人工核对效果词表');
const xFields = new Set([...wlX]);
(function collectXFields() {
  const gm = js.match(/const\s+GAME_META\s*=\s*\{([\s\S]*?)\n\};/);
  if (!gm) return;
  const xf = gm[1].match(/xFields\s*:\s*\{([^}]*)\}/);
  if (xf) for (const m of xf[1].matchAll(/([A-Za-z_][\w$]*)\s*:/g)) xFields.add(m[1]);
})();
const ALLFX = new Set(acceptFx); xFields.forEach(x => ALLFX.add(x));
const unknownFx = new Set();
for (const m of js.matchAll(/\{\s*k:\s*'([a-z_0-9]+)'\s*[,}]/g)) if (!ALLFX.has(m[1])) unknownFx.add(m[1]);
if (unknownFx.size) errs.push('[E5] 未知 fx 键（applyFx 无 case，也不在 GAME_META.xFields）: ' + [...unknownFx].join(', '));

/* ---------- 5. 角色 id 闭合 ---------- */
const unknownCast = new Set();
for (const m of js.matchAll(/k:'(aff|stage|relcool)'\s*,\s*id:'([a-z0-9_]+)'/g)) {
  if (!castIds.has(m[2]) && m[2] !== 'sys') unknownCast.add(m[2]);
}
for (const m of js.matchAll(/k:'mem'\s*,\s*who:'([a-z0-9_]+)'/g)) {
  if (!castIds.has(m[1]) && m[1] !== 'sys') unknownCast.add(m[1]);
}
if (unknownCast.size) errs.push('[E6] fx 中的角色 id 不在 CAST/CAST2 中: ' + [...unknownCast].join(', '));

/* ---------- 6. 地点 id 闭合 ---------- */
{
  for (const k of meetTopKeys) if (!castIds.has(k)) warns.push(`[W61] MEET_DEF 的键 "${k}" 不是 CAST/CAST2 成员`);
  for (const m of (MEET_BLOCK || '').matchAll(/place:'([a-z_]+)'/g)) if (!placeIds.has(m[1])) errs.push(`[E61] MEET_DEF 地点 "${m[1]}" 不在 PLACES 中`);
}

/* ---------- 7. 存档体系 ---------- */
if (!/SAVE_KEY/.test(js)) errs.push('[E7] 未发现 SAVE_KEY 存档键');
if (!/function\s+save\s*\(/.test(js)) errs.push('[E71] 未发现 save() 函数');
if (!/function\s+loadSave\s*\(|function\s+continueGame\s*\(/.test(js)) errs.push('[E72] 未发现 loadSave()/continueGame()');
if (!/schemaVersion|migrateSave/.test(js)) warns.push('[W73] 未见 schemaVersion/migrateSave（跨版本存档兼容）');
if (!/exportSave/.test(js)) warns.push('[W74] 未见 exportSave 导出存档');

/* ---------- 8. 移动优先底座 ---------- */
if (!/viewport/i.test(html)) errs.push('[E8] 缺少 viewport meta');
if (!/@media/.test(html)) warns.push('[W8] 缺少 @media 断点（桌面适配）');
if (!/safe-area|env\(/.test(html)) warns.push('[W81] 未使用 safe-area（刘海屏适配）');
if (!/bottom-nav/.test(js) && !/bottom-nav/.test(html)) warns.push('[W82] 未见底部导航条');

/* ---------- 9. 平台反擦除 ---------- */
const BL = [
  { re: /workbuddy/i, what: '出现 workbuddy 平台字样' },
  { re: /技术维护|售后攺|在线客服/, what: '出现平台客服话术' },
  { re: /学习资料|电子学习资料/, what: '出现平台商品话术' },
  { re: /防盗|水印|盗版|二次分发/, what: '出现平台版权防盗话术' },
  { re: /小红书号|视频号|公众号|客户QQ|QQ群|技术维护QQ/, what: '出现平台引流话术' },
  { re: /\?v=\d{6,}/, what: '出现 ?v= 缓存击穿查询参数（部署平台特化）' },
];
for (const b of BL) if (b.re.test(html)) errs.push('[E9] 反擦除违规: ' + b.what);

/* ---------- 10. 体量门槛 ---------- */
const evCount = (js.match(/\bid:'ev_/g) || []).length;
const achCount = (getBlock('ACHIEVEMENTS').match(/\{n:'/g) || []).length;
const TIER = {
  demo: { cast: 2, ev: 6, place: 4, ach: 4 },
  mini: { cast: 3, ev: 25, place: 5, ach: 8 },
  standard: { cast: 6, ev: 60, place: 8, ach: 15 },
  full: { cast: 8, ev: 100, place: 12, ach: 20 },
}[tier];
if (castIds.size < TIER.cast) warns.push(`[W10] CAST 有效条目 ${castIds.size} < ${tier} 档门槛 ${TIER.cast}`);
if (evCount < TIER.ev) warns.push(`[W101] RANDOM_EVENTS 事件 ${evCount} 条 < ${tier} 档门槛 ${TIER.ev} 条`);
if (placeIds.size < TIER.place) warns.push(`[W102] PLACES 地点 ${placeIds.size} 个 < ${tier} 档门槛 ${TIER.place} 个`);
if (achCount < TIER.ach) warns.push(`[W103] 成就 ${achCount} 个 < ${tier} 档门槛 ${TIER.ach} 个`);

/* ---------- 输出 ---------- */
const pass = errs.length === 0;
console.log('===== qa_lint 报告 =====');
console.log(`文件: ${path.resolve(file)}   档位: ${tier}`);
notes.forEach(n => console.log('✎ ' + n));
if (errs.length) { console.log(`\n[${errs.length} 项 error]`); errs.forEach(e => console.log('  ✗ ' + e)); }
if (warns.length) { console.log(`\n[${warns.length} 项 warning（人工确认后可豁免）]`); warns.forEach(w => console.log('  ▲ ' + w)); }
console.log(`\n场景表: ${sceneDefs.size}  角色: ${castIds.size}  地点: ${placeIds.size}  事件: ${evCount}  成就: ${achCount}`);
console.log(pass ? '===== 结果: PASS =====' : '===== 结果: FAIL =====');
process.exit(pass ? 0 : 1);
