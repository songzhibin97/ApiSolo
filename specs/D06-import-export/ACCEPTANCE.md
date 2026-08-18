# D06 — 验收记录

本文件是「什么通过了」的唯一权威。轮次**只追加不改写**。

- 切片：D06 导入导出保真
- 分支：`songzhibin/d06-import-export`
- 起点：`c2f0f84`（main）
- 基线（owner 亲跑）：vitest **15 files / 84 passed**；cargo **68 passed**

## 角色

| 角色 | 承担者 | 产出 |
|---|---|---|
| owner | 主会话 | 裁定、gate 亲跑、合并 |
| implementer | subagent | 代码 + 测试 + 自检报告（自检**不是**验收证据） |
| reviewer | codex CLI（独立模型） | 逐轮 verdict |

## 阶段 3 — spec 评审轮次

| 轮次 | verdict | 状态 |
|---|---|---|
| R1 | **REVISE(5C + 3I + 1M)** | 已处置 → rev2 |
| R2 | **REVISE(2C + 4I + 3M)** | 已处置 → rev3 |
| R3 | **REVISE(1C + 1I + 2M)** | 已处置 → rev4 |
| R4 | **REVISE(0C + 1I + 2M)** | 已处置 → rev5 |
| 定向复核 | **REVISE(0C + 0I + 2M)** | 已处置 → rev5 文本修正 |
| owner 机械核对（非独立） | 三处文本修正全部通过 | ✅ **已冻结** |

### 各轮 CRITICAL 摘要

| 轮 | 摘要 |
|---|---|
| R1 | 错误与 warning 的 UI 展示被当成可延后交接（实为发布阻断）；`--data-ascii @f` 承诺了但未实现；`--data-urlencode` 空格编码错误（规格写 `%20`，真 curl 是 `+`）；Authorization 未纳入统一抑制模型；`Boolean(fileContent)` 误判零字节文件 |
| R2 | 多个可识别的显式 Authorization 被静默折叠成一个（真 curl 发两行）；非 UTF-8 或无冒号的 Basic header 被静默改写字节 |
| R3 | 谓词本身正确，但 `parseHeaderDirective` 先归一化+trim 才调用它——只证明了「规范化后的值可回放」，而非「用户粘贴的值可回放」 |
| R4 | — （0C；余下 1I 为已证明的假绿 killer，owner 判定不带假绿进实现） |

### 关键裁定

| # | 内容 |
|---|---|
| A2 | D06 的 6 个 i18n key 归 D06 自己，不推给 D01（否则 D01 携带一批自己不使用的死键） |
| A3 | 「绝不按路径读 `@file`」的 README 声明归 D06——谁引入的产品边界谁写 |
| A8 | scope 从 backlog 的 10 项扩到 46 条行为，**全部保留不拆分**（都落在本就要重写的同一批函数里，拆出去意味着同一函数改两次）；可追溯性由 TECH 的 backlog→不变式对照表承担 |
| — | `--compressed` 由 D02 的发现追加进本切片；其合并顺序受 D02 的解压落地约束，单列为独立 rollback 单元 |

### R4 的 IMPORTANT：为什么 0C 仍未放行

测试 #30 的 fixture `Bearer ey\r\n  Jhb` 折叠后含内部空格、匹配不上 `/^Bearer (\S+)$/`，因此**删掉整个「保真受损⇒禁止提升」的 guard，测试照样绿**——确定性假绿。owner 判定：带着一个已证明的假绿进实现，等于把一条永远绿灯的测试写进代码库，而本切片存在的理由就是保真度。

rev5 换成 `Bearer\r\n  eyJhb`（折叠后**恰好**是合法的 `Bearer eyJhb`），实跑确认删 guard 即被提升、测试转红。

**起草者在复盘中给出的诊断，是本切片最有价值的产出**：

> 那一行测试**看起来有三个 case 撑着一个 guard，而其中两个确实撑着**。

即 #30 的另两例（冒号后无空格、TAB）本来就是有效 killer，只有换行折叠那一半没被保护。这解释了为什么抽查会漏掉这类缺陷——抽查看到的是「这个 guard 有三例覆盖」，而不是「这三例分别锁住 guard 的哪一部分」。

### 冻结

**冻结版本 `rev5`（含三处文本修正）**，46 条 Behavior 不变式，46 行测试映射，追溯覆盖 1–46 无孤儿。冻结后任何改动必须是标注理由的受控修订。

## 阶段 4 — 实现

**状态**：待开始。
