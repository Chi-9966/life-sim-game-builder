# 引擎蓝图 —— 单文件人生模拟游戏的通用架构

> 本文档是「人生模拟游戏生产」的机制内核说明。参考实现是一个 570KB 的中文恋爱修罗场题材单文件游戏；本文把它的**机制**抽象出来，使任何题材都能套用。
> 阅读顺序：先读本文的 §1 总览，再按需读 §2–§9。配套：`assets/engine-skeleton.html`（可直接运行的骨架）与 `references/theming-guide.md`（题材如何映射到机制）。

---

## §1 总览：这个游戏类型是什么

一句公式：

> **人生模拟 = 时间刻度(4槽/日) × 数值化人生(预算/属性/需求) × 关系网络(阶段机+好感) × 抉择内容流(场景/事件/剧情) + 手机社交界面 + 存档系统**

玩家的每一分钟消耗都在四个刻度槽上流动；每个动作是「花费（时间/精力/钱）→ 得到（数值/文本/关系）」；所有关系的进展被阶段机和好感值约束；所有随机事件都是带条件的抉择面板。**它是一台情绪与约束的引擎：玩家用时间、钱和精力，在 запрет 约束下换取故事与数值反馈。**

结构上它是**单文件 HTML**：无构建、无外部资源、无网络请求、离线可玩、`file://` 直接打开、`localStorage` 存档。这是交付形态的刚性约束。

### 引擎自检底线（打包前 hoop 三查，QA 详见 qa-checklist.md）
1. 单文件、零请求（无外链 CSS/JS/图片；视觉用 CSS 渐变 + emoji + SVG data-URI）。
2. 平台特化物清零（客服/QQ/版权防盗话术/`?v=` 缓存参数/workbuddy 字样）。
3. `scripts/qa_lint.mjs` 通过。

---

## §2 状态模型（State Schema）

参考实现的全局状态 `S`（骨架已实现同构，字段名可按题材微调但**下层引擎依赖这些概念**）：

```javascript
S = {
  schemaVersion: 1, seq: 0,            // 存档迁移用
  cal: {y, m, d, slot:0..3},           // 唯一如历时间；slot: 0晨 1午 2昏 3夜
  player: {
    name, age, look, style,            // 身份与外观（外观影响初次印象/邀约）
    cash,                              // 钱（唯一账本入口记账，不许直改）
    energy,                            // 精力：上限 = f(体魄)，所有行动的通用成本
    mood,                              // 心情：影响交付质量与事件权重
    beauty, physique, charm, wit,      // 四维：气色/体力/社交/学识
    satiety,                           // 饱食：日结 -30：<20 触发饥饿链
    sickUntil,                         // 病倒标记
    sk: {eff, com, doc, aes, plan, risk}, // 六技能：判定(gamble dc)与交付质量
    prefType,                          // 择偶/交友偏好：正向互动 +1 好感
    origin, zodiac, hobby              // 出身/占卜/爱好：创角时的一次性修正
  },
  chg: {},                             // 主题扩展计数器（如风评/亲情/名望），fx 的 x 键
  weather, tidbit,                     // 每天 0 点随机：天气与城市闲话
  home: {name, rent, ...},             // 住所：房租月结，可升级
  rel: { <castId>: {stage, aff, metDate, lastDate, cooldown, angryUntil} },  // 关系
  msgs: [], moments: [], mems: [],     // 手机消息 / 动态流 / 记忆册
  ledger: [],                          // 现金流水 {date, reason, amount, cat}
  events: {},                          // 触发标记 f:id=1（一次性）；cd:id=天戳（冷却）
  pending: [],                         // 待演出场景队列（阻断时间流动！）
  career: {job, level, workDays, rep, project, gigs},  // 职业/外包
  items: [],                           // 背包 {id,name,qty}
  health: {...}, commitLog: [],        // 健康与不可逆抉择留痕
  endings: [], knows: {},              // 结局收集 / NPC知情表
  ui: {page, sub, thread, tab}         // UI 状态
}
```

**关键经验（来自参考实现的多次返工）：**
- `cal` 只能经 `advanceSlots()` 推进（唯一时钟入口），防双写。
- 现金只能经 `addCash()`（余额不足自动回滚入账），`spend()=false` 时动作必须中止。
- `events` 里 `f:` 一次性标记 + `cd:` 冷却天戳是触发器状态的通用记法。
- `pending` 队列里的场景**阻断时间**：`advanceSlots` 遇 pending 即停（`force` 才跳过）。
- 存档键 `lifesim_<id>_save_v1`；`migrateSave()` 兜底补字段（旧档兼容的根因防线）。

---

## §3 时间系统（唯一时钟）

```
4 slots = 1 day；日界触发 dailySettle()；月初触发 monthlySettle()（d===1）
advanceSlots(n, force)：逐槽推进；每槽后跑 checkTriggers()；遇 pending 且非 force 即停。
force 快进（跳天/月底/下月）会丢弃「可再生内容」前缀 = /^(ev:|gen_invite|sys_pamper)/，
保留剧情类（初遇/确认/身体警报/开延伸）——丢弃可再生、保留剧情，是内容分层的关键规则。
```

`dailySettle()`（每一天的"物理"）：
- 生存消耗：`cash -= 25..60`；`satiety -= 30`；`satiety<20` → mood-4 / physique-1 / 塞入 `sys_eat` 阻断场景（次日晨提醒）。
- `energy` 刷新为 `energyCap() = 60 + physique*0.4`（40..110）。
- 天气/闲话随机；心情向 60 漂移 ±1；关系冷却-1。
- **NPC 主动性**：25%（"被动"人设 40%）一位已相识成员主动发消息 + 把这句话写进动态流。
- 题材钩子 `THEME_HOOKS.daily()`（孕育阶段/经营流水/宗门日课等都挂在这里）。

`monthlySettle()`（锦上添花/钝刀割肉）：工资按职业与级别入账、房租/水电/养护费出账、婚姻家用（题材钩子）。

`monthLedger(y,m)` 汇报本月收支给首页。

---

## §4 触发器引擎（剧情调度的核心）

`checkTriggers()` 在**每个时段槽**后轮询。参考实现中它承载了所有"世界主动来找我"的戏码：

| 触发器 | 条件 | 时段 | 概率/规则 |
|---|---|---|---|
| 每日随机事件 | 事件池 cond 通过 + 冷却外 | 下午 | 62%**（"迟钝"体质 75%） |
| 主动邀约 | dating/secret 且无冷却 | 清晨 | 10% |
| NPC 日常问候 | 已相识且 ≥2 天未收到 | 清晨 | 25%/40% |
| 高好感糖 | aff≥70 | 下午 | 12% |
| 婚姻线离婚戏 | 有-wife 成员 & aff≥82 | 清晨 | 阈值触发 |
| 求婚 | aff≥88 & 无妻/已为你离婚 | 清晨 | 阈值触发 |
| 冷淡裂缝 | lastDate 超过 14 天 | 傍晚 | 15% → 生气 N 天 |
| 题材自定义 | THEME_HOOKS.customTriggers | 任意 | — |

事件池条目：`{id, who(分类), title, cond(S), body, choices:[{t, hint, fx, next?, custom?}]}`。抽奖加权：心情类 50% 优先（情绪价值密度），用 `cd:` 天戳做 5–6 天冷却，冷却久的优先回池。**谁（分类 who）决定事件的"频道"**——题材要有一套自己的频道名（如 修罗场/职场/孕育/金丝雀 般的情绪标签）。

主线剧情第二轴：**人物专属剧情幕**（PLOT_SCENES，每人 2 幕，`人物id_p1/p2`）按好感与剧情位触发；初遇幕由 MEET_DEF 表自动生成 `<人物id>_meet`。

---

## §5 场景-选项-效果引擎（fx DSL）

```javascript
SCENES[id] = () => ({ who, title, body, choices:[{t, hint, fx, next, custom, cond}] })
showScene(id)：解析 'sys_x:节点' 前缀族 → 打开弹窗 → choices 渲染 → doChoice
doChoice(c)：fx → applyFx；custom → CUSTOM_CHOICE 注册表（不可逆抉择的结算器）；
            next → 跳链；无 → 关闭 + processPending（弹出队列下一个或刷新）
```

**效果词表（fx 全量，题材不应该发明新键，扩展需要引擎支持）：**

| 键 | 语义 | 备注 |
|---|---|---|
| aff / stage | 好感± / 关系阶段跳转 | 阶段机见 §6 |
| aff_rand_met / aff_rand_dating / aff_rand_married | 对某类成员集体加成 | |
| cash {v,reason} | 走账本的现金（正入负出，不足回滚） | **一切钱都走这里** |
| slot {n} | 直接消耗 n 个时段（约会用） | |
| msg {from,text} | 推送消息（from 可为 '__rand'） | 未知发送者强制转 sys 并加括号 |
| mem / mem_x | 记忆册（带/不带 who） | 情感沉淀的主要容器 |
| relcool | 关系冷却（天数） | |
| energy / mood / rep / phys / satiety / beauty | 属性 fx（自动 clamp） | |
| skill {id,v} 或 'eff:1' | 技能 ± | 供 gamble 判定 DC 与交付质量 |
| item {id,n} | 背包物品 | |
| flag {kk,v} | 引擎外布尔标记 S.events['c:'+kk] | |
| x {id,v} | chg 计数器（题材自声明 xFields 才会显示） | 名望/亲情/宗门贡献… |
| ending {id} | 收录结局 + toast | |
| gamble {dc, sk, okfx, badfx} | **技能判定**：sk 值+魅力修正 ≥ dc 成功 | hint 必须写明判定线 |

内容规范（写内容时的语法铁律）：
- 每个选择必须可见代价：`hint` 格式 `「代价 · 收益」`（如 `现金 ¥268 · 心动 +2 · 心情 +3`）；判定类写明 `技能名 ≥N`。
- 场景 body 是第二人称叙事（"你……"），人物台词用「」包裹；2-4 句为宜，结尾留钩子。
- `ev_` 前缀 = 日常事件；`sys_` = 引擎系统场景；`gen_` = 引擎生成场景；`wev:` = 工作偶发。
- 选项收益通常是复合的（数值+文本+记忆），单向收益选项必须带负效对照或成本。

---

## §6 关系系统（阶段机 + 好感）

```
stage: stranger 未相识 → met 相识 → friends 朋友 → dating 恋人 | secret 秘密关系
                → ex 前任 ⇄(复合)  ；dating → engaged → married（求婚线）
```

- **affAdd 的阻力设计**：正加成全局减半（`v=max(1, round(v*0.5))`），偏好匹配 +1；负值原样生效。**让攻略慢下来是可玩性的一半。**
- 好感里程碑（GAME_META.milestones 如 [10,25,40]）：跨阈值时人物以自己的 `heart[]` 台词主动私聊（一次性 `hl:` 标记）；aff=100 时触发"心意已满"提示，引导去推进关系而非无限复读。
- 生气系统：`angryUntil` 天戳；`makeAngry(n天)` = 冷语消息 + aff-5 + mood-8；冷却期回信变冷淡池。
- 约定周期：`lastDate` 最近一次见面，`cooldown` 为邀约锁；懒得见 → `sys_conflict` 裂缝事件。
- 私会引擎 `gen_invite:mid → gen_date:mid:place`：邀约文本（人物 invite 或主题默认）→ 赴约 → 2-3 个对话选项 + 离场；每一步写记忆册。
- **确认关系**（theta 门）：aff≥60 才解锁「推进关系」——有-wife 成员走 `secret`（"秘密关系"剧本），无妻子成员走 `dating`。二者的确认幕都要有代价表（公平 vs 不公平）。
- **婚姻/离婚/继承（进阶槽，见 §9）**：系统场景 `sys_propose / sys_divorce / sys_male_estate` 与 CUSTOM_CHOICE 结算器。求婚会**串行化**：已有婚姻成员同时只能有一位已婚丈夫（旧婚自动变 ex）。
- 分手=stage ex + 冷却 14；复合=aff≥40 → friends（重新认识）。

---

## §7 手机与社交层（界面身份的共同点）

- **收件箱(fids)**：所有认识成员按最近消息排列，未读徽标；点开进 thread。
- **自由聊天**：`detectIntent()` 关键词意图分类（想你/在忙/约饭/累了/晚安/爱……11 类）→ `genReplies()` 融合「通用回池 + 人物声线覆盖（MALE_VOICE 式个性短语）+ 人物默认回池」出 1-2 条；**真实感细节**：30% 双条回（double text）、忙时「（两条消息隔了很久）」、夜间/清晨自动转晚安/早安池。
- **配额**：每人每日最多 2 次主动聊天收益（第 1 次 aff+4，第 2 次 +2，其余无收益）——防刷。
- **话题库**：每人 `topics[]`（q/a 对，3-5 条），3 天冷却（`ct:` 天戳）——「有心跳的话题」。
- **动态流 moments**：NPC 的清晨消息进圈；点赞 +1、走心回应 +2（有一次性回复）。这层是"社区感"的最廉价实现。
- 系统号（sys）承担：新手引导、健康提示、节气提醒、剧情广播。

---

## §8 经济与工作系统

- **账本**：`S.ledger` 每笔流水 `{date, reason, amount, cat}`；首页显示本月收支。cat 分类：工资/房租/伙食/消费/人情/婚姻/健康…
- **职业线**（工资型）：`CAREERS[job].levels[].salary[]`；上班 1 时段 = 精力-15 + 口碑+1 + 35% 触发工作偶发（`wev:` WORK_EVENTS：加班取舍/领导画饼/背锅抉择之类 2-3 选项）；口碑达标自动**升职**（薪资跳档是主要快乐源）。
- **接单线**（交付型）：`GIGS[line][]` 每单 3 阶段 × 3 档投入（稳妥/标准/进击，钱与质量换算）→ `settleGig`：`pay × quality`（quality = Σ(投入-0.8) + 技能加成，clamp 0.6-1.25）。**报价策略真实影响收入**，这是深度的重要感。
- 解锁制：单的门槛是 `repNeed`（口碑），防止数值上限被一单刷爆。
- 消费面：`GOODS{food/mall/health…}` + `giftTiers`（送礼 3 档）+ place 消费（入场/看病/护理…）；消费同时也是 fx 输入（心情/饱食/体魄）。
- 难度参数（可选）：`MODE_META{normal: bills×1, pay×1; heavy: 1.6/1.12; intense: 2.2/1.25}`。

---

## §9 生活阶段·进阶槽（题材可选，参考实现完整示范了这些）

系统在 `advanceSlots` 的日结/月结钩子中各有明确挂点：
- **亲密抉择门**（features.intimacy）：`openCommit (consent 面板)`：4 选项（防护周全/已有安排/无防护/今晚到此为止）→ `recordIntimacy`(log) → 隔天早晨 aftermath 随机段子（余温/冷淡/风险通话）， married 成员另有"怕被发现"消息池 → **settleConceptions**：无防护 35% / 已有安排 5% / 防护 2%，命中且未孕 → 怀孕记录 `{conceived, status:'ongoing', confirmed:false, months}`；验孕棒晴天报（孕 4 周+）；产检/告知父亲/叙述胎动，孕 9-10 月 `startBirth()`（体魄-15 饱食-20，15% 双胞胎）→ 起名场景；孩子 `children{bond, ageMonths, persona}`；亲子页照顾动作；18 岁（216 月）可**传承**：选择继承人（遗嘱 equal/favorite/elder），新主角继承 30% 现金、`S.gen++`、剧本世界重置、**buildGen2NPCs() 程序化生成全新阵容**（名字/职业/性格/初遇场所随机池）——形成周期性重开的 roguelite 世代循环。
- 这些逻辑量级大，建议把它们作为**引擎功能开关** + 题材命名壳：例如亲密夜改"签约夜/决斗夜"（保留 4 选项与后果链）；婚姻改"结义/结盟"；遗传改"继承衣钵"。**机制保持，语义换壳。**

---

## §10 UI 蓝图（界面骨架与响应式）

- 底层：`#app` 列容器 `max-width:480px` 居中 + `#view` 内滚动；桌面（≥600px）自动成为"手机画框"。
- **底部页签**（4-5 个）：参考实现 = 首页/情人/生活/家族/更多。骨架 = 日记(状态+推进)/人物/城市/更多；题材可改名或加第 5 页（家族/势力/仓库…）。
- 页面结构 = `datebar（📍 城市 · 日期 · 时段）+ topbar(标题/副标/←返回) + 页面正文`。子页通过 `nav(page, sub)`。
- **弹窗栈 modalStack**：场景弹窗(锁定=必须选)、确认弹窗、地点动作弹窗；`closeModalTop/All` + `panicHome()` 逃生门 + 全局 error 兜底面（"继续游玩（存档仍在）"）——**三层防卡死**，参考实现 26 个版本迭代换来。
- 状态卡（首页）：现金/精力/心情/饱食/体魄 chips + 红色预警带（心情<30/饱食<20/体魄<30 各一条）+ 快捷推进按钮（下一天/下月）。
- 物页 = 人物卡列表（头像=名字首字+渐变色）；详情页 = 关系进度章 + 四大动作（聊天/邀约/送礼/推进）+ 分手/复合。
- toast：非模态反馈统一 2.4s 自动消失。

---

## §11 存档与出货

- `save(silent)` 四级瘦身重试：normal → trim(已读消息/旧流水/旧记忆) → remove hist 重写 → 深度剪 — **自动档全程静默**；`_hist` 单份历史副本。
- `exportSave()` Blob 下载 JSON；`importClick()/handleImport()` FileReader 恢复（覆盖前红字警告）。
- `migrateSave()`：给新字段补默认值；schemaVersion 升级时 switch 旧档。
- 版本声明放「更多」页（`GAME_META.version`）；发布更新时更新它。

---

## §12 合规与题材安全层（结构从参考实现抽取，文案随题材改）

标题屏三件套（`renderTitle`）：
1. 年龄/分级门（默认 18+，题材定文案）；
2. 健康公告（虚构/适度游玩/勿带入现实）；
3. 免责声明（角色虚构、不构成现实建议）。

「更多」页保留作者署名与版本；**平台特化物（客服/售卖/防盗）一律无**——见 qa-checklist 反擦除清单。
