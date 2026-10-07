// smoke_driver.cjs — 无头浏览器点击流冒烟（零依赖，CDP over WebSocket）
// 用法: node scripts/smoke_driver.cjs [gameFileUrl] [chromePath] [port] [shotsDir]
// 缺省步骤为 demo 骨架主题；测其他游戏请按与该文件对应的页面结构改写 STEP 部分。
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const path = require('path');
const argvU=process.argv[2]||'';
const FILE_URL = argvU.startsWith('file:') ? argvU : (argvU ? 'file:///'+path.resolve(argvU).replace(/\\/g, '/') : 'file:///'+path.resolve(__dirname, '../assets/engine-skeleton.html').replace(/\\/g, '/'));
const CHROME = process.argv[3] || process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[4])||9333;
const SHOTS = process.argv[5]||path.resolve(__dirname, '../.qa_shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null; let idc = 0; const pend = new Map(); const evHandlers = [];
const consoleErrs = [], pageErrs = [];

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++idc; pend.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function on(method, fn) { evHandlers.push({ method, fn }); }

function getTargets() {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

function record(step, status, evidence) {
  console.log(`RESULT|${step}|${status}|${String(evidence).replace(/[\r\n\t]+/g, ' ').slice(0, 600)}`);
}

async function main() {
  fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
  const profile = path.resolve(SHOTS, '_profile'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=430,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 50; i++) { try { targets = await getTargets(); if (targets && targets.length) break; } catch (e) {} await sleep(300); }
  if (!targets) { console.log('FATAL|chrome not reachable'); return; }
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  ws.onmessage = (evm) => {
    const m = JSON.parse(evm.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) { for (const h of evHandlers) if (h.method === m.method) h.fn(m.params); }
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable');
  on('Runtime.consoleAPICalled', (p) => {
    const txt = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
    if (p.type === 'error' || p.type === 'warning') { consoleErrs.push(p.type + ': ' + txt); console.log(`LOG|${p.type}|${txt.slice(0, 240)}`); }
  });
  on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    const txt = d.exception ? ((d.exception.description || (d.exception.value !== undefined ? String(d.exception.value) : '')) || d.text) : d.text;
    pageErrs.push(txt); console.log('PAGEERROR|' + String(txt).slice(0, 300));
  });
  on('Log.entryAdded', (p) => { if (p.entry.level === 'error') { consoleErrs.push(p.entry.text); console.log('BROWSERLOGERR|' + p.entry.text.slice(0, 240)); } });
  on('Page.javascriptDialogOpening', (p) => { console.log('DIALOG|' + p.type + '|' + String(p.message).slice(0, 200)); send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });

  // ---------- helpers ----------
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (((r.exceptionDetails.exception || {}).description) || r.exceptionDetails.text));
    return r.result.value;
  }
  const text = () => ev(`document.body.innerText`);
  const datebar = () => ev(`(document.querySelector('.datebar')||{}).innerText || ''`);
  const overflow = () => ev(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, sh:document.documentElement.scrollHeight})`);
  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'));
  }
  async function clickIn(selector, needle, { exact = false, nth = 0 } = {}) {
    return ev(`(() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
      const cand = els.filter(e => { const t = (e.innerText || e.textContent || '').trim(); return ${exact ? `t === ${JSON.stringify(needle)}` : `t.includes(${JSON.stringify(needle)})`}; });
      if (!cand.length) return 'NOTFOUND|all=' + els.slice(0, 12).map(e => (e.innerText || '').trim().slice(0, 16).replace(/\\n/g, '/')).join(' ;; ');
      const t = cand[${nth}]; t.click();
      return 'CLICKED|' + (t.innerText || '').trim().slice(0, 40).replace(/\\n/g, '/');
    })()`);
  }
  async function fillInput(selector, value) {
    return ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOEL';
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      (d && d.set ? d.set : (v) => { el.value = v; }).call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK|' + el.value;
    })()`);
  }
  const toasts = () => ev(`Array.from(document.querySelectorAll('#toast .toast')).filter(e=>e.offsetParent!==null||true).map(e=>e.innerText.trim())`);
  const modalCount = () => ev(`document.querySelectorAll('.modal').length`);
  const state = () => ev(`JSON.stringify({cal:S.cal, cash:S.player.cash, satiety:S.player.satiety, mood:S.player.mood, energy:S.player.energy, yan:(S.rel.yan_shu||{}).stage, yanAff:(S.rel.yan_shu||{}).aff, page:S.ui.page})`);

  // ================= STEP 1 =================
  try {
    await send('Page.navigate', { url: FILE_URL });
    await sleep(2300);
    const t = await text();
    const hasTitle = t.includes('北岸日记');
    const hasGate = t.includes('我已满 18 周岁，进入作品');
    await shot('s01_title_gate');
    // boot-time fatal overlay check (B0): 🧯 modal appears on load and covers the title screen
    const fatalOnLoad = await ev(`Array.from(document.querySelectorAll('.modal')).some(m => m.innerText.includes('出了点小问题'))`);
    const fatalText = await ev(`(Array.from(document.querySelectorAll('.modal')).find(m => m.innerText.includes('出了点小问题'))||{}).innerText || ''`);
    if (fatalOnLoad) {
      // real-user path: dismiss the overlay first, otherwise it blocks all clicks
      await clickIn('.modal button', '继续游玩');
      await sleep(400);
    }
    if (hasTitle && hasGate) {
      const c = await clickIn('button', '我已满 18 周岁');
      await sleep(500);
      const t2 = await text();
      record(1, 'PASS', `标题「北岸日记」+「我已满 18 周岁，进入作品」按钮均在；点击=${c}；点击后出现「开始新的生活」=${t2.includes('开始新的生活')}；⚠️加载即出现🧯错误弹层遮挡标题屏=${fatalOnLoad}（真实用户需先点「继续游玩」），弹层文本="${String(fatalText).replace(/\s+/g, ' ').slice(0, 150)}"`);
    } else {
      record(1, 'FAIL', `标题=${hasTitle} 18+按钮=${hasGate}；页面文本: ${t.slice(0, 300)}`);
    }
  } catch (e) { record(1, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 2 =================
  try {
    const t = await text();
    if (t.includes('开始新的生活')) {
      await clickIn('button', '开始新的生活');
      await sleep(600);
      const hasModal = await ev(`!!document.querySelector('.modal') && !!document.querySelector('#c-name')`);
      const t2 = await text();
      await shot('s02_create_modal');
      record(2, hasModal ? 'PASS' : 'FAIL', `点击「开始新的生活」后弹窗出现=${hasModal}（#c-name 输入框存在）；弹窗含「开始新生活」提交按钮=${t2.includes('开始新生活')}`);
    } else record(2, 'FAIL', `未见「开始新的生活」按钮。页面: ${t.slice(0, 250)}`);
  } catch (e) { record(2, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 3 =================
  try {
    const fill = await fillInput('#c-name', '测试员');
    const v = await ev(`document.querySelector('#c-name').value`);
    const c = await clickIn('button', '开始新生活');
    await sleep(900);
    const t = await text();
    const sceneUp = t.includes('抵达的第一天');
    record(3, sceneUp ? 'PASS' : 'FAIL', `名字已填="${v}"(${fill})；点击「开始新生活」=${c}；开局剧情弹窗「抵达的第一天」出现=${sceneUp}；弹窗数=${await modalCount()}`);
  } catch (e) { record(3, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 4 =================
  try {
    const db = await datebar();
    const t = await text();
    const chips = await ev(`Array.from(document.querySelectorAll('.chip')).map(e=>e.innerText.trim())`);
    // click first scene choice (去渡口面馆)
    const c1 = await clickIn('.modal .choice', '去渡口面馆');
    await sleep(600);
    const tMeet = await text();
    const meetUp = tMeet.includes('初遇') && (await modalCount()) >= 1;
    // click first meet-scene choice to return home
    const c2 = await clickIn('.modal .choice', '认真道谢');
    await sleep(700);
    const t2 = await text();
    const st = JSON.parse(await state());
    await shot('s04_home');
    const chipsAfter = await ev(`Array.from(document.querySelectorAll('.chip')).map(e=>e.innerText.trim())`);
    const ok = t2.includes('2026.09.20') && chipsAfter.some(x => x.includes('¥'));
    record(4, ok ? 'PASS' : 'FAIL', `日期栏="${(await datebar()).replace(/\n/g, ' ')}"；剧情「抵达的第一天」弹出且点选项1(${c1})；初遇弹窗=${meetUp}，点「认真道谢...」(${c2})；状态卡chips=${JSON.stringify(chipsAfter)}；颜叔关系=${st.yan}/心意${st.yanAff}`);
  } catch (e) { record(4, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 5 =================
  let cash0 = null, cal0 = null;
  try {
    const s0 = JSON.parse(await state()); cash0 = s0.cash; cal0 = s0.cal;
    const c1 = await clickIn('button', '下一天'); await sleep(900);
    const d1 = (await datebar()).replace(/\n/g, ' ');
    const c2 = await clickIn('button', '下一天'); await sleep(900);
    const s2 = JSON.parse(await state());
    const db2 = (await datebar()).replace(/\n/g, ' ');
    await shot('s05_after_2days');
    const noFatal = !(await text()).includes('出了点小问题');
    const okDate = s2.cal.y === 2026 && s2.cal.m === 9 && (s2.cal.d === 21 || s2.cal.d === 22);
    record(5, (okDate && s2.cash < cash0 && noFatal) ? 'PASS' : 'FAIL', `初始 现金¥${cash0} @${cal0.y}.${cal0.m}.${cal0.d}；点「下一天」x2(${c1}/${c2})；第一天日期栏="${d1}"；两天后=${db2}(d=${s2.cal.d})；现金 ¥${cash0}->¥${s2.cash}；无错误弹层=${noFatal}`);
  } catch (e) { record(5, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 6 =================
  async function gotoPage(pageKey, label) {
    const navCount = await ev(`document.querySelectorAll('.bottom-nav .nav-i').length`);
    let how = '';
    if (navCount === 0) {
      await ev(`nav('${pageKey}')`);
      how = `底部页签栏为空(0项,renderNav启动时崩溃未渲染)→直接调用nav('${pageKey}')代替`;
    } else {
      how = await clickIn('.bottom-nav .nav-i', label);
    }
    await sleep(700);
    return { how, navCount };
  }
  try {
    const { how } = await gotoPage('people', '人物');
    const t = await text();
    const yanCard = t.includes('颜叔') && t.includes('相识');
    const unknownCount = (t.match(/？？？/g) || []).length;
    await shot('s06_people');
    record('6a', yanCard && unknownCount === 2 ? 'PASS' : (yanCard ? 'PARTIAL' : 'FAIL'),
      `${how}；人物页: 颜叔卡(含"相识")=${yanCard}；未相识显示为"？？？"的卡片数=${unknownCount}（童晓/赵伯未相识时隐藏真名显示为？？？）；页面片段: ${t.slice(0, 240)}`);
    // click yan_shu card
    const cy = await ev(`(() => {
      const cards = Array.from(document.querySelectorAll('.card.soft')).filter(e => e.offsetParent && e.innerText.includes('颜叔'));
      if (!cards.length) return 'NOCARD';
      cards[0].click(); return 'CLICKED yan_shu card';
    })()`);
    await sleep(800);
    const t2 = await text();
    const inChat = !!await ev(`!!document.querySelector('#chat-in')`) && t2.includes('发送');
    const bubbles = await ev(`document.querySelectorAll('.bubble').length`);
    record('6b', inChat ? 'PASS' : 'FAIL', `${cy}；进入聊天页: #chat-in 输入框=${!!await ev(`!!document.querySelector('#chat-in')`)}，发送按钮=${t2.includes('发送')}，消息气泡数=${bubbles}；顶部="${(t2.split('\n').slice(0, 4).join('/'))}"`);
  } catch (e) { record('6a', 'FAIL', '异常: ' + e.message); }

  // ================= STEP 7 =================
  try {
    const before = await ev(`S.msgs.length`);
    await fillInput('#chat-in', '你好呀');
    const c = await clickIn('button', '发送', { exact: true });
    await sleep(600);
    const tList = await toasts();
    let reply = null;
    for (let i = 0; i < 6; i++) {
      const newMsgs = await ev(`JSON.stringify(S.msgs.slice(${before}).filter(m=>m.from==='yan_shu'&&m.kind!=='me').map(m=>m.text))`);
      const arr = JSON.parse(newMsgs);
      if (arr.length) { reply = arr.join(' / '); break; }
      await sleep(400);
    }
    const bubbles = await ev(`document.querySelectorAll('.bubble').length`);
    await shot('s07_chat_reply');
    record(7, reply ? 'PASS' : 'FAIL', `发送=${c}；AI回复气泡="${reply}"；页面气泡总数=${bubbles}；toast=${JSON.stringify(tList)}`);
  } catch (e) { record(7, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 8 =================
  try {
    const before = await ev(`S.msgs.length`);
    const topics = await ev(`Array.from(document.querySelectorAll('.sect ~ button.choice, button.choice')).map(e => e.innerText.split(String.fromCharCode(10))[0]).slice(0, 5)`);
    const c = await clickIn('button.choice', '汤为什么这么好喝');
    await sleep(1200);
    const newMsgs = JSON.parse(await ev(`JSON.stringify(S.msgs.slice(${before}).map(m=>m.kind+':'+m.text.slice(0,60)))`));
    const t2 = await text();
    record(8, newMsgs.length >= 2 ? 'PASS' : 'FAIL', `话题按钮列表=${JSON.stringify(topics)}；点击「${'汤为什么这么好喝？'}」=${c}；新消息=${JSON.stringify(newMsgs)}`);
  } catch (e) { record(8, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 9 =================
  try {
    const back = await ev(`(() => { const b = document.querySelector('.topbar .back'); if (!b) return 'NOBACK'; b.click(); return 'CLICKED back'; })()`);
    await sleep(500);
    const { how } = await gotoPage('world', '城市');
    await sleep(700);
    const t = await text();
    const hasPlace = t.includes('渡口早市与面馆');
    let actBtn = '', strollBtn = '';
    if (hasPlace) {
      const cp = await ev(`(() => { const p = Array.from(document.querySelectorAll('.place')).find(e => e.innerText.includes('渡口早市与面馆')); if (!p) return 'NOPLACE'; p.click(); return 'CLICKED place'; })()`);
      await sleep(700);
      const mt = await text();
      actBtn = mt.includes('吃一碗热汤'); strollBtn = mt.includes('在早市逛逛');
      await shot('s09_place_modal');
      const sBefore = JSON.parse(await state());
      const ce = await clickIn('.modal .choice', '吃一碗热汤');
      await sleep(900);
      const sAfter = JSON.parse(await state());
      const tl = await toasts();
      const modalGone = (await modalCount()) === 0;
      record(9, actBtn && modalGone ? 'PASS' : 'FAIL', `返回=${back}；→城市页(${how})；地点卡「渡口早市与面馆」存在=${hasPlace}(${cp})；动作弹窗: 吃一碗热汤=${actBtn} 在早市逛逛=${strollBtn}；点击后: 现金¥${sBefore.cash}->¥${sAfter.cash} 饱食${sBefore.satiety}->${sAfter.satiety}；toast=${JSON.stringify(tl)}；弹窗已关=${modalGone}(${ce})`);
    } else record(9, 'FAIL', `城市页(${how})未见「渡口早市与面馆」。页面: ${t.slice(0, 300)}`);
  } catch (e) { record(9, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 10 =================
  try {
    const { how } = await gotoPage('more', '更多');
    await sleep(700);
    const t = await text();
    const btns = {};
    for (const b of ['手动存档', '导出存档', '读取存档', '删除存档']) btns[b] = t.includes(b);
    const achRows = await ev(`Array.from(document.querySelectorAll('.kv')).filter(e => /🏆|🔒/.test(e.innerText)).map(e => e.innerText.split(String.fromCharCode(10)).join(' '))`);
    await shot('s10_more');
    const lsBefore = await ev(`(JSON.parse(localStorage.getItem('lifesim_demo_northshore_save_v1')||'{}').player||{}).cash`);
    await clickIn('button', '手动存档');
    await sleep(500);
    const tl = await toasts();
    const lsAfter = await ev(`(JSON.parse(localStorage.getItem('lifesim_demo_northshore_save_v1')||'{}').player||{}).cash`);
    record(10, Object.values(btns).every(Boolean) && tl.some(x => x.includes('已存档')) ? 'PASS' : 'FAIL',
      `→更多页(${how})；存档区按钮: ${JSON.stringify(btns)}；成就行(🏆/🔒)数=${achRows.length} 行=${JSON.stringify(achRows.slice(0, 6))}；点「手动存档」后toast=${JSON.stringify(tl)}；localStorage现金 ${lsBefore}->${lsAfter}`);
  } catch (e) { record(10, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 11 =================
  try {
    const raw = await ev(`localStorage.getItem('lifesim_demo_northshore_save_v1')`);
    const sv = JSON.parse(raw);
    const saveDate = `${sv.cal.y}.${String(sv.cal.m).padStart(2, '0')}.${String(sv.cal.d).padStart(2, '0')}`;
    const saveCash = sv.player.cash;
    await send('Page.reload', { ignoreCache: false });
    await sleep(2200);
    const t0 = await text();
    const titleBack = t0.includes('北岸日记') && t0.includes('我已满 18 周岁');
    // 18+ gate appears again after reload
    await clickIn('button', '我已满 18 周岁');
    await sleep(500);
    const t1 = await text();
    const hasCont = t1.includes('继续上次的生活');
    let restored = '';
    let ok = titleBack && hasCont;
    if (hasCont) {
      await clickIn('button', '继续上次的生活');
      await sleep(1000);
      const db = (await datebar()).replace(/\n/g, ' ');
      // go to 日记 page to see cash chip (nav bar may be empty -> direct nav fallback)
      await gotoPage('home', '日记');
      await sleep(700);
      const s = JSON.parse(await state());
      const chips = await ev(`Array.from(document.querySelectorAll('.chip')).map(e=>e.innerText.trim())`);
      await shot('s11_restored_home');
      const dateMatch = db.includes(saveDate);
      const cashMatch = chips.some(x => x.includes('¥') && x.replace(/[^\d]/g, '') === String(saveCash));
      restored = `恢复后日期栏="${db}"(存档日=${saveDate} 匹配=${dateMatch})；现金chip含¥${saveCash}=${cashMatch}；chips=${JSON.stringify(chips.slice(0, 4))}`;
      ok = ok && dateMatch && cashMatch;
    }
    record(11, ok ? 'PASS' : (titleBack && hasCont ? 'PARTIAL' : 'FAIL'), `刷新后回到标题屏=${titleBack}；「继续上次的生活」出现=${hasCont}（注意：刷新后需重新点18+确认按钮才显示）；${restored}`);
  } catch (e) { record(11, 'FAIL', '异常: ' + e.message); }

  // ================= STEP 12 + bonus probe =================
  try {
    // bonus probe: bottom nav is visible on title screen; clicking it with S=null may crash
    await send('Page.reload', { ignoreCache: false });
    await sleep(2000);
    let probe = '';
    try {
      const navCount = await ev(`document.querySelectorAll('.bottom-nav .nav-i').length`);
      probe = `底部页签栏可点项数=${navCount}`;
    } catch (e) { probe = 'probe err: ' + e.message; }
    const t = await text();
    const fatalNow = await ev(`Array.from(document.querySelectorAll('.modal')).some(m => m.innerText.includes('出了点小问题'))`);
    const ovf = await overflow();
    const hOverflow = ovf.sw > ovf.cw;
    const pageUrl = await ev(`location.href`);
    record(12, !fatalNow && !hOverflow ? 'PASS' : 'FAIL',
      `URL=${pageUrl}；全流程中错误弹层🧯出现=${fatalNow}；水平溢出(scrollW>clientW)=${ovf.sw}>${ovf.cw}=${hOverflow}；console错误=${consoleErrs.length}条 未捕获异常=${pageErrs.length}条；附加探测: ${probe}`);
  } catch (e) { record(12, 'FAIL', '异常: ' + e.message); }

  console.log('CONSOLEERRS|' + JSON.stringify(consoleErrs.slice(0, 20)));
  console.log('PAGEERRS|' + JSON.stringify(pageErrs.map(x => String(x).slice(0, 300)).slice(0, 10)));

  try { await send('Browser.close').catch(() => {}); } catch {}
  try { ws.close(); } catch {}
  try { proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.log('FATAL|' + (e && e.stack || e)); try { process.exit(2); } catch {} });
