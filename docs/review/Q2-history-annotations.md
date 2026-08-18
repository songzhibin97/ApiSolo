# 问题 2 设计：历史记录备注 / 收藏

## 结论与建议

值得做，但要拆成两个独立切片，且优先级不同。

**先做（独立可发布）：从历史记录一键"保存到集合"** —— 零 schema 改动、零 Rust 改动、纯前端。它才是真正解决"以后还想找到这个请求"的方案，因为集合是项目里唯一的长期存储。

**再做（可选）：note + starred 写进 history.jsonl 内部** —— 服务的是另一个需求："这 40 条几乎一样的 POST 里，哪条复现了 bug"。这个需求 save-to-collection 解决不了（没人想往集合里塞 40 条），成本也小（2 个 serde 字段 + 1 个 command）。

**明确否决 sidecar 文件**（如 `scratch/history-notes.json`），三条理由：
1. 破坏"清空历史"的心理模型。用户在 note 里写"prod token 在 1Password 第 X 条"，点了 Clear History，note 还在磁盘上 —— 这是隐私倒退，直接违反项目"UI 不许说谎"红线。
2. 产生永久孤儿。被 trim 掉的条目留下的 note 指向不存在的 id，只能无限增长或写一套 GC。
3. 引入第三种生命周期。项目模型是二元的：history = 一次性快照，saved request = 长期定义。sidecar 造出"比快照活得久、但又不是定义"的第三类，模型就烂了。

note/starred 属于**对快照的元数据**，就应该和快照同生共死 —— 这样反而是最忠于既有模型的选择。

星标唯一改变语义的地方：**只豁免自动 trim，不豁免显式 Clear/Delete**。豁免自动 trim 是诚实的（用户星标就是为了别被后面 1000 条挤掉）；豁免显式清空是不诚实的（用户明确要求清空）。

关于"用星标 = 以后能重放"这个陷阱：**必须在 UI 上正面否认**。见 risks 段。

## 数据模型

**决策：note/starred 存在 history.jsonl 行内，不用 sidecar。**

--- Rust: src-tauri/src/lib.rs:245-282 `struct HistoryEntry` ---
在 `response_headers: Vec<(String, String)>,`（:281）之后、结构体闭合 `}`（:282）之前追加两个字段：

```rust
    #[serde(default)]
    note: String,
    #[serde(default)]
    starred: bool,
```

结构体已有 `#[serde(rename_all = "camelCase")]`（:244），`note` / `starred` 都是单词，线上字段名就是 `note` / `starred`，无需 rename。

`#[serde(default)]` 在这里是**承重的，不是可选的**：`read_history_entries`（lib.rs:651-670）在 :664-666 对任何一行解析失败都 `?` 直接向上返回 Err，不跳过坏行。少写 default 的后果是：所有存量 history.jsonl 行全部 `missing field 'note'`，整个历史面板变空并报错。

降级方向是安全的：结构体没有 `deny_unknown_fields`，旧版本二进制读新文件会静默忽略这两个字段（下次重写时丢失，可接受）。

--- 新常量，加在 lib.rs:354 `MAX_HISTORY_ENTRIES` 旁 ---
```rust
const MAX_STARRED_HISTORY_ENTRIES: usize = 200;
const HISTORY_NOTE_MAX_CHARS: usize = 500;
```
截断必须用 `note.chars().take(HISTORY_NOTE_MAX_CHARS).collect::<String>()`，**不能用 `&note[..500]`** —— 中文 note 会在 char boundary 上 panic。

--- 测试夹具必改 ---
lib.rs:3113-3145 `fn sample_history_entry` 是全字段字面量，不加 `note: String::new(), starred: false,` 整个 test module 编译不过。

--- TS: src/types/index.ts:154-177 `interface HistoryEntry` ---
在 :176 `responseHeaders?` 之后加：
```ts
  note?: string
  starred?: boolean
```
用可选（和 `timings?` / `requestParams?` 一致），这样 src/stores/__tests__/tabs-history.test.ts 的 `makeHistoryEntry` 夹具不用动，`buildHistoryEntry`（src/stores/request.ts:456）也不用构造这两个字段（新条目本来就既没 note 也没星标）。

--- 磁盘格式 ---
仍是 jsonl，不加 version 头。$HOME/ApiSolo/scratch/history.jsonl 每行多两个 key。

## Rust 侧改动

全部在 src-tauri/src/lib.rs。

**1. 新增一个 command（合并 note + star，不拆两个）**

```rust
#[tauri::command]
fn update_history_annotation(
    id: String,
    note: Option<String>,
    starred: Option<bool>,
) -> Result<(), String> {
    let mut entries = read_history_entries()?;

    if starred == Some(true) {
        let already = entries.iter().any(|e| e.id == id && e.starred);
        if !already && entries.iter().filter(|e| e.starred).count() >= MAX_STARRED_HISTORY_ENTRIES {
            return Err(format!(
                "Starred history limit reached ({MAX_STARRED_HISTORY_ENTRIES})"
            ));
        }
    }

    let entry = entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| "History entry not found".to_string())?;

    if let Some(note) = note {
        entry.note = note.trim().chars().take(HISTORY_NOTE_MAX_CHARS).collect();
    }
    if let Some(starred) = starred {
        entry.starred = starred;
    }

    write_history_entries(&entries)
}
```
返回 `Result<(), String>` 与 `delete_history_entry`（lib.rs:2053）保持一致；note 归一化前端也做一遍，Rust 这层是防御性 clamp。

**2. 改 `append_history`（lib.rs:2024-2038）的 trim 逻辑**

现在是 `entries.drain(0..overflow)`（:2034），按文件位置删最老的。改成优先淘汰**未星标**的最老条目：

```rust
    if entries.len() > MAX_HISTORY_ENTRIES {
        let mut overflow = entries.len() - MAX_HISTORY_ENTRIES;
        entries.retain(|entry| {
            if overflow > 0 && !entry.starred {
                overflow -= 1;
                false
            } else {
                true
            }
        });
        // 兜底：全是星标时仍按最老丢弃，保证文件有界
        if entries.len() > MAX_HISTORY_ENTRIES {
            let rest = entries.len() - MAX_HISTORY_ENTRIES;
            entries.drain(0..rest);
        }
    }
```
`retain` 按序遍历，所以先命中的就是最老的未星标条目，语义正确。因为 `MAX_STARRED_HISTORY_ENTRIES`(200) < `MAX_HISTORY_ENTRIES`(1000)，兜底分支实际不可达，但保留它保证文件永远有界 —— 星标只会挤掉未星标条目，绝不会让 jsonl 无限增长。

注意：这里没有新增 I/O 成本。`append_history` 本来就每次发请求都 read-all + write-all 整个文件，star toggle 做同样的事完全符合既有开销画像。

**3. 注册（三处，缺一不可）**
- `#[cfg(feature = "dev-bridge")]` args struct，加在 lib.rs:2749-2752 `DeleteHistoryEntryArgs` 旁：
  ```rust
  #[derive(Deserialize)]
  struct UpdateHistoryAnnotationArgs {
      id: String,
      note: Option<String>,
      starred: Option<bool>,
  }
  ```
  三个字段都是单词，和 `DeleteHistoryEntryArgs` 一样不需要 `rename_all`。
- handler，加在 lib.rs:2942-2944 `api_delete_history_entry` 之后：
  ```rust
  async fn api_update_history_annotation(
      Json(args): Json<UpdateHistoryAnnotationArgs>,
  ) -> impl IntoResponse {
      api_unit(update_history_annotation(args.id, args.note, args.starred))
  }
  ```
- 路由 lib.rs:2988 之后加 `.route("/api/update_history_annotation", post(api_update_history_annotation))`；invoke_handler lib.rs:3041 `delete_history_entry,` 之后加 `update_history_annotation,`。

**4. Rust 测试（tests mod，~lib.rs:3777 `test_clear_history` 附近）**
- `test_history_annotation_roundtrip`：append → update note+star → load，断言两个字段落盘。
- `test_history_trim_preserves_starred`：append 1 条并星标，再 append 1000 条，断言星标那条仍在、总数 == 1000。
- `test_history_note_truncates_multibyte`：note 传 600 个中文字，断言不 panic 且 `chars().count() == 500`。
- `test_legacy_history_line_without_note_parses`：直接往 history.jsonl 写一行不含 note/starred 的旧 JSON，断言 `load_history()` 成功且 `note == ""`。这条是迁移的唯一护栏。
- 遵守项目约定：`npm run test:rust`（--test-threads=1）。

## 前端改动

**A. src/utils/history-grouping.ts:99-105 —— 扩展 filterEntries（第三参数带默认值，现有 2 参调用点不动）**

```ts
export function filterEntries(
  entries: HistoryEntry[],
  query: string,
  starredOnly = false,
): HistoryEntry[] {
  const trimmed = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (starredOnly && !entry.starred) return false
    if (!trimmed) return true
    return (
      entry.url.toLowerCase().includes(trimmed) ||
      (entry.note ?? "").toLowerCase().includes(trimmed)
    )
  })
}
```
note 必须可搜 —— 否则 note 是只写的，"以后找到它"这个需求根本没被满足。默认参数保证 src/utils/__tests__/history-grouping.test.ts:94/100/101 的现有调用不用改。

**B. 明确不做：不加第四种 grouping mode "starred"，也不改 sortEntries 让星标置顶**

两条硬理由，都是对着代码验证过的：
1. `HistoryGroupMode`（src/types/index.ts:193）是对全集的**划分**，"starred" 是**谓词**。做成 mode 就是"披着分组皮的过滤器"，而且 HistoryPanel.vue:42-48 的 `collapsedGroups` 是**按 `group.label` 做 key** 的，多一种 mode 只会加剧 label 撞车。
2. 星标置顶会引入真 bug：`finalizeGroups`（history-grouping.ts:126-130）先 `sortGroupEntries` 排序组内条目，**再**用 `latestTimestamp`（:140-143，读 `group.entries[0]?.timestamp`）给组排序。一旦组内改成星标优先，某个很老的星标条目会窜到 `entries[0]`，整个组就被误排到列表底部。所以组内排序保持纯时间序，星标只靠图标 + 过滤开关表达。

正解：一个 `showStarredOnly` 过滤开关，放在 HistoryPanel.vue:174-207 的 group-mode 分段控件旁边。

**C. src/stores/history.ts**

```ts
const HISTORY_NOTE_MAX_CHARS = 500
const showStarredOnly = ref(false)

const filteredEntries = computed(() =>
  filterEntries(entries.value, searchQuery.value, showStarredOnly.value),
)   // 替换 :24

const starredCount = computed(() => entries.value.filter((e) => e.starred).length)

function patchEntry(id: string, patch: Partial<HistoryEntry>) {
  const entry = entries.value.find((item) => item.id === id)
  if (entry) Object.assign(entry, patch)   // ref 数组深响应，能触发 computed
}

async function setEntryNote(id: string, note: string) {
  const normalized = note.trim().slice(0, HISTORY_NOTE_MAX_CHARS)
  await invoke("update_history_annotation", { id, note: normalized })
  patchEntry(id, { note: normalized })
}

async function toggleEntryStar(id: string) {
  const entry = entries.value.find((item) => item.id === id)
  if (!entry) return
  const starred = !entry.starred
  await invoke("update_history_annotation", { id, starred })   // 先 await 再改本地
  patchEntry(id, { starred })
}

function toggleStarredOnly() { showStarredOnly.value = !showStarredOnly.value }
```
**不要乐观更新**：星标上限会让 command 返回 Err，先落盘再改本地状态，否则 UI 显示已星标而磁盘上没有 —— 又是一次 UI 说谎。
`appendEntry`（:43）的 `.slice(0, 1000)` 保持不变（前端只是内存镜像，权威 trim 在 Rust）。

**D. src/components/sidebar/HistoryPanel.vue**

1. **行结构必须重构**：现在整行是一个 `<button>`（:246-274）。星标按钮不能嵌在 `<button>` 里（非法 HTML，点击/可访问性都会坏）。改成外层 `<div class="flex ...">`，内层一个 `<button class="flex min-w-0 flex-1 ...">` 承接 `@click="openEntry(entry)"`，星标按钮作为兄弟节点。
2. 星标按钮用 `lucide-vue-next` 的 `Star`（文件 :4 已在从该包导入 ChevronDown/ChevronRight/Search/Trash2），星标态加 `fill-current text-amber-400`，`:title="t('history.starHint')"`。
3. **note 优先于响应体预览**：:261-266 那条次要行改成 `entry.note ? entry.note : summarizeResponseBody(entry.responseBody)`，note 用 `italic text-[var(--text-secondary)]`。用户手写的 note 比响应体片段有信息量。
4. **右键菜单**：复用 src/components/ui/ContextMenu.vue（`ContextMenuItem { label, action, icon?, danger? }`），行上挂 `@contextmenu.prevent`，菜单项：`star`/`unstar`、`note`、`save-to-collection`、`delete`(danger)。参考 CollectionPanel.vue:145-162 + :549-553 的既有用法。
   注意：`historyStore.deleteEntry`（history.ts:56）目前**全 src/ 无调用方**，这个右键菜单顺带把这条死路径接上了。
5. **note 编辑复用 src/components/ui/PromptDialog.vue**（props: visible/title/placeholder/confirmLabel/cancelLabel/initialValue/errorMessage/busy）。注意它 :32-36 的 `submit()` 对空串直接 return —— 所以**清空 note 走不了 PromptDialog**，右键菜单要单独给一项 `clear-note`（仅当 `entry.note` 非空时出现），调 `setEntryNote(id, "")`。这是不看代码就会踩的坑。
6. **安全提示扩写**：:209-211 的 `history.securityNotice` 区块追加一句 note 明文警告（note 是用户主动键入的文本，**不脱敏**，脱敏只针对自动捕获的请求/响应字段）。
7. **清空确认加星标数**：:298 的 `history.clearConfirm` 换成 `history.clearConfirmWithStarred`（当 `starredCount > 0` 时），把会被销毁的星标条数说出来。

**E. 「保存到集合」（建议先发的那个切片，与 note/star 完全解耦）**

新文件 `src/utils/history-to-saved-request.ts`：
```ts
export function savedRequestFromHistoryEntry(entry: HistoryEntry, name: string): SavedRequest
```
**关键：必须把值恰好等于 `"[redacted]"` 的 header/param 值清成 `""`**，不能整份照抄。理由见 risks 段。用全值精确匹配，**不能用 substring** —— `redactSensitiveText`（request.ts:554-569）会在 body 文本内部内联插入 `[redacted]`，按子串清洗会毁掉正常 body。

HistoryPanel 里新增一个"保存到集合"对话框（collection `<select>` + name `<input>`，形状照抄 RequestPanel.vue:591-643），提交时调 `projectsStore.saveRequest(collection, savedRequestFromHistoryEntry(entry, name))` —— **第三个参数 tab 不传**（projects.ts:64 签名 `saveRequest(collection, request, tab?, shouldReload = true)`），避免把历史条目错误绑定到某个 tab 的 `savedRequestPath`。
无 `activeProject` 时该菜单项置灰（projects.ts:70-72 本来就会抛 `errors.noActiveProject`）。

**F. 前端测试**
- src/utils/__tests__/history-grouping.test.ts：加 `filterEntries(entries, "", true)` 只返回星标、以及 query 命中 note 的两个用例。
- 新增 src/utils/__tests__/history-to-saved-request.test.ts：断言 `Authorization: "[redacted]"` → `""`，且 body 里内联的 `[redacted]` 子串**不被**改动。

## 迁移与兼容

**存量 history.jsonl 行**
靠 `#[serde(default)]`。这不是锦上添花：`read_history_entries`（lib.rs:651-670）在 :663-667 用 `serde_json::from_str::<HistoryEntry>(&line)` 后直接 `?`，**任何一行解析失败就整体返回 Err**，不跳过坏行。少了 default，全部存量行报 `Failed to parse history entry: missing field 'note'`，历史面板整个空掉并弹错。必须有 `test_legacy_history_line_without_note_parses` 兜住。

**降级（用户装回旧版）**
`HistoryEntry` 没有 `deny_unknown_fields`，旧二进制读新行会静默忽略 `note`/`starred`，下次 `append_history` 重写文件时这两个字段被抹掉。数据丢失但不崩溃，可接受。

**note/star 在 trim 下的存活**
- 自动 trim（超过 `MAX_HISTORY_ENTRIES` = lib.rs:354 的 1000）：**星标条目豁免**，见 backend_changes 第 2 点。上限 `MAX_STARRED_HISTORY_ENTRIES` = 200 保证星标最多占掉 20% 窗口，剩 800 个滚动位，且 jsonl 永远 ≤ 1000 行。
- **只有 note 没星标的条目不豁免 trim** —— 这是刻意的。想让它活下来就顺手加个星，这条规则一句话讲得清。

**note/star 在 Clear History 下的存活：不存活。**
`clear_history`（lib.rs:2048-2051）继续 `write_history_entries(&[])`，星标条目一起清掉。**这是刻意的**：用户明确点了"清空历史"，偷偷留一部分就是 UI 说谎的另一个方向。补偿措施是确认框把星标数说出来（`history.clearConfirmWithStarred`）。

**delete_history_entry**：语义不变，能删掉星标条目。右键菜单里它是 danger 项。

**没有 schema 版本号 / 没有迁移脚本 / 没有一次性升级步骤。** 用户第一次运行新版就是正常的：老条目 note 为空、starred 为 false，新条目可标注。这正是选择行内存储而不是 sidecar 的一个附带好处 —— sidecar 方案得额外写"孤儿 note 的清理时机"。

## 风险

**风险 1（最高）：星标暗示"以后能重放"，而这是假的。**
链路已验证：`buildHistoryEntry`（src/stores/request.ts:456）→ `redactAuth`（:499-...）把 basic password / bearer token / api-key value 全清成 `""`；`redactKeyValuePairs` → `redactValue`（:544-546）对敏感 key **直接返回字面量 `"[redacted]"`**。
注意这比 Rust 侧**更狠**：Rust 的 `redact_value`（lib.rs:1457-1463）走 `preserve_template_or_empty`（lib.rs:1465-1471），会**保留** `{{token}}`；前端历史侧不保留 —— `Authorization: {{token}}` 在 history.jsonl 里就变成字面字符串 `[redacted]`。
后果：`openHistoryEntry`（src/stores/tabs.ts:344）在 :356 把 `entry.requestHeaders` 原样灌进 tab，重放时真的会往服务器发一个值为 `[redacted]` 的 header。
缓解（必须做，不是可选）：星标 tooltip 用 `history.starHint` 明说"这是历史记录内的书签，凭证仍是脱敏的"；`history.securityNotice` 区块补一句；右键菜单里"保存到集合"排在"标记"上面。**绝不能**出现"星标 = 收藏 = 能再发一次"的措辞。

**风险 2：把历史条目存进集合时，`[redacted]` 会被当成真值写进去。**
`projectsStore.saveRequest`（src/stores/projects.ts:64）最终走 Rust `sanitize_saved_request_for_persistence`（lib.rs:1379），而 `redact_value`(lib.rs:1457) 对 `"[redacted]"` 这个值的判断是"不含 `{{}}`"→ 清成 `""`。所以敏感 key 那部分侥幸没事。
但**非敏感 key 上被 `redactSensitiveText` 内联污染过的值会原样存活**。更要命的是如果不做清洗，UI 上会显示一个"看起来完整"的保存请求。
所以 `savedRequestFromHistoryEntry` 必须自己把**全值恰等于 `"[redacted]"`** 的 header/param 清空，且必须在保存对话框上挂 `history.saveToCollectionHint` 告诉用户凭证没带过来。否则典型失败是：用户星标 + 保存 `Authorization: {{token}}` 的请求 → 集合里得到一个静默 401 的请求，还看不出哪错了。

**风险 3：非原子写。**
`write_history_entries`（lib.rs:672-687）用 `fs::File::create` 直接截断重写，没有 tmp + rename。这是既有行为（每次发请求的 `append_history` 都在做），**不是本次引入的**。但 note/star 是"用户耐用意图"，写坏的痛感远高于丢几条快照。如果要顺手加固，就是 `write_history_entries` 内部改成写 `history.jsonl.tmp` 再 `fs::rename`，约 5 行，且对现有所有调用点都是净收益。属于可选加固，不做也不阻塞。

**风险 4：note 是 history.jsonl 里唯一不脱敏的字段。**
这是正确的设计（脱敏是按字段名对**自动捕获**的数据做的硬规则，用户主动键入的备注不该被猜内容），但它确实开了一个用户可以自己往磁盘写明文密钥的口子。必须用 `history.noteWarning` 在 PromptDialog 上直说。

**风险 5（小）：星标上限的错误提示要落地。**
`update_history_annotation` 在超过 200 时返回 Err，HistoryPanel 必须把它 catch 到 `errorMessage`（该组件 :20 已有这个 ref、:281-283 已有渲染位），否则表现是"点星标没反应"。这也是为什么 store 里禁止乐观更新。

## 工作量

**切片 1 —— 从历史"保存到集合"（建议先发，可独立上线）：约 0.5 天。**
纯前端，零 Rust、零 schema、零迁移。
- 新增 src/utils/history-to-saved-request.ts（~40 行）+ 单测
- HistoryPanel.vue 行结构改 div + 接 ContextMenu + 一个保存对话框（~120 行）
- 6 个 i18n key ×2 语言
性价比最高：它是唯一真正解决"以后还想找到这个请求"的东西，而且不碰 history.jsonl。

**切片 2 —— note + starred：约 1~1.5 天。**
- Rust：2 个字段 + 1 个 command + trim 逻辑改写 + 3 处注册 + `sample_history_entry` 补字段 ≈ 70 行（lib.rs:245/354/2024/2745/2930/2985/3041/3113）
- Rust 测试 4 个 ≈ 90 行
- 前端：types 2 行、history-grouping filterEntries 改 12 行、history store +45 行、HistoryPanel +130 行（星标按钮、note 行、过滤开关、PromptDialog 接线、clear 确认改文案）
- i18n 12 个 key ×2 语言
- README.md:33 / :62 同步

**验收**：按项目既定纪律，`npm run test:rust`（必须 --test-threads=1）+ `npm run release:check` 自己跑一遍；因为改的是列表渲染和右键菜单，还要打包覆盖 /Applications 在真机 WebKit 里验一次（macOS 是 WebKit 不是 Chromium）。特别验两点：右键菜单在 1024x768 下贴近窗口底部时的翻转定位（ContextMenu.vue:57-81 的 updatePosition），以及行内星标按钮点击**不会**误触发打开 tab。

**如果只有一天**：做切片 1，跳过切片 2。

## i18n key

加在 src/i18n/zh-CN.ts:206-223 和 src/i18n/en.ts:206-222 的 `history` 块内（现有 key 无 `star`/`note` 冲突，已 grep 确认）：

```
history.star            zh "标记"                 en "Star"
history.unstar          zh "取消标记"             en "Unstar"
history.starredOnly     zh "仅看标记"             en "Starred only"
history.starHint        zh "仅在历史记录内做书签；凭证仍然是脱敏的。需要可重复发送的请求，请用「保存到集合」。"
                        en "Bookmarks this entry inside history. Credentials stay redacted — use Save to Collection for a re-sendable request."
history.starLimit       zh "最多只能标记 {count} 条历史记录。"
                        en "You can star at most {count} history entries."
history.addNote         zh "添加备注"             en "Add note"
history.editNote        zh "编辑备注"             en "Edit note"
history.clearNote       zh "清除备注"             en "Clear note"
history.notePlaceholder zh "例如：复现登录 500 的那次"
                        en "e.g. the call that reproduced the login 500"
history.noteWarning     zh "备注按原文明文写入磁盘，不做脱敏，请勿写入密钥。"
                        en "Notes are written to disk verbatim and are not redacted. Do not put secrets in them."
history.deleteEntry     zh "删除此条"             en "Delete entry"
history.saveToCollection zh "保存到集合"          en "Save to Collection"
history.saveToCollectionHint
                        zh "凭证不会一起带走（历史中已脱敏），保存后需要重新填写或改用 {{变量}}。"
                        en "Credentials are not carried over (already redacted in history) — re-enter them or switch to {{variables}} after saving."
history.clearConfirmWithStarred
                        zh "清除全部 {count} 条历史记录（含 {starred} 条已标记）？此操作无法撤销。"
                        en "Clear all {count} history entries, including {starred} starred? This cannot be undone."
```

另外 README.md:33 那句 "Request history grouped by URL prefix, time, or method, with replay-friendly saved entries" 和 :62 的历史文件说明要同步更新（项目有"决策必须写进 README 和 UI"的既定纪律，否则下一轮扫描会把星标语义当高危 bug 重新报上来）。
