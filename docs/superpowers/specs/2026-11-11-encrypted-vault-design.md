# 加密 Markdown 笔记库设计

**日期**：2026-11-11
**状态**：设计已确认，待实施
**范围**：把现有 Tauri Markdown 编辑器改造为“强制加密库”模式

## 1. 目标

- 用户选择的文件夹成为“加密笔记库”。库内所有 `.md` 文件在磁盘上只保存密文。
- 新建库时设置密码；打开已有库时输入密码。密码错误无法读取任何笔记。
- 编辑器、文件树、搜索、自动保存、新建/重命名/删除、刷新等交互保持不变。
- 加解密全部在 Rust 后端完成；前端不接触密钥或密文。

## 2. 非目标

首版明确不做：

- 明文工作区兼容模式。没有库标记文件的文件夹必须“创建为加密库”后才能打开。
- 修改密码、恢复密钥、多密码解锁、自动锁定。
- 文件名、目录名、文件大小、修改时间加密。这些元数据保持可见。
- 图片、附件等非 `.md` 文件加密。当前应用本来也不管理它们。
- 防内存转储、防调试、防截屏、防主动篡改。
- 同一库多实例并发写入的文件锁。

## 3. 已确认的产品决策

| 决策 | 结论 |
| --- | --- |
| 库的磁盘形态 | 目录型：保留原 `.md` 文件名和目录结构，只加密内容 |
| 旧明文文件夹 | 强制加密：必须走“创建加密库并原地加密现有笔记”流程 |
| 密码能力 | 最小实现：创建时设置、打开时验证；忘记密码不可恢复 |
| 敏感 UI 元数据 | 最近笔记、折叠目录、上次库路径只放内存；重启后不恢复 |
| 加密架构 | Rust 信封加密：Argon2id 派生 KEK，包裹随机 DEK，文件用 DEK 加密 |

## 4. 威胁模型

**能防护**：

- 磁盘/移动硬盘被拷走。
- 云盘同步、备份、版本历史中只有密文。
- 不持有密码的人无法通过普通文本工具读取笔记内容。
- 密文被篡改、损坏或从另一个库拷贝过来时，AEAD 认证失败。

**不能防护**：

- 应用运行期间的进程内存、交换分区、崩溃转储、调试器、截屏。
- 文件名、目录结构、文件大小、修改时间泄露的主题信息。
- 附件和图片仍为明文。
- 旧明文库原地加密后，旧数据可能残留在文件系统未擦除块、SSD 磨损均衡区、云盘历史版本、系统备份中。

## 5. 磁盘格式

### 5.1 库标记文件

库根目录下的隐藏文件 `.mojian-vault.json`：

```json
{
  "format": "mojian-vault",
  "version": 1,
  "state": "ready",
  "vaultId": "base64(16 bytes)",
  "kdf": {
    "algorithm": "argon2id",
    "memoryKiB": 65536,
    "iterations": 3,
    "parallelism": 1
  },
  "salt": "base64(16 bytes)",
  "cipher": "xchacha20poly1305",
  "wrappedKey": "base64(24-byte nonce || 32-byte DEK || 16-byte tag)"
}
```

- `state` 为 `migrating` 或 `ready`。
- `vaultId` 同时作为文件密文和密钥包裹的 AAD 成员，防止跨库拷贝。
- 标记文件写入必须原子替换；Unix 下权限为 `0600`。
- 标记文件以 `.` 开头且不是 `.md`，现有扫描和路径校验都会忽略/拒绝它。

### 5.2 笔记文件

`.md` 文件内容格式：

```
"MOJIANM1" (8 bytes magic) | nonce (24 bytes) | ciphertext + tag (16 bytes)
```

- 算法：XChaCha20-Poly1305。
- 密钥：32 字节 DEK。
- 每次保存生成新 nonce。
- AAD：`MAGIC || vaultId`。同一库内移动/改名不影响解密；跨库拷贝失败。
- 空笔记写成空明文的合法密文，绝不是 0 字节文件。
- 密文大小约为明文 + 48 字节。

### 5.3 固定参数

| 参数 | 值 |
| --- | --- |
| KDF | Argon2id, memoryKiB 65536, iterations 3, parallelism 1 |
| salt | 16 字节随机 |
| vaultId | 16 字节随机 |
| DEK | 32 字节随机 |
| 包裹 AAD | `b"MOJIAN-KEY" || vaultId` |
| 文件 AAD | `b"MOJIANM1" || vaultId` |
| nonce | 24 字节随机 |
| tag | 16 字节 |
| 标记文件名 | `.mojian-vault.json` |
| 标记 format | `mojian-vault` |
| 标记 version | `1` |

KDF 参数读取时校验范围：`memoryKiB` 8192..=262144，`iterations` 1..=10，`parallelism` 1..=8，防止损坏/恶意标记造成资源耗尽。新库一律写 65536/3/1。

## 6. 密钥生命周期

1. 创建库：随机 DEK；Argon2id(密码, salt) 得到 KEK；用 KEK 包裹 DEK；写 `migrating` 标记；加密现有笔记；写 `ready` 标记。
2. 打开库：读标记；Argon2id 派生 KEK；解包 DEK。解包失败统一返回“密码错误，或库文件已损坏”。
3. DEK 放入 `VaultKey`，实现 `ZeroizeOnDrop`，通过 `Arc<VaultSession>` 注入命令。
4. 密码字符串用 `Zeroizing<String>` 持有，派生密钥后立即释放。
5. 切换库成功时替换 `ActiveVault`；旧 `Arc` 的最后一个引用释放后 DEK 清零。失败时不替换，旧库继续可用。
6. 首版无自动锁定；不做密钥轮换，但信封结构允许未来只重包裹 DEK 来改密码。

## 7. 后端接口

### 7.1 新增模块

- `src-tauri/src/crypto.rs`：KDF、包裹/解包、文件 seal/open、`is_sealed`、`VaultKey`、`VaultSession`。
- `src-tauri/src/vault.rs`：标记读写、`inspect`、`create`、`unlock`、迁移/恢复。

### 7.2 修改模块

- `notes.rs`：读写/新建走 `VaultSession`；新增 `pub(crate) replace_file_atomically`。
- `workspace.rs`：新增 `workspace_from_root`（规范化 + 命名，不扫描）。
- `lib.rs`：`ActiveVault { workspace, session }` 单 Mutex；更新命令与状态。

### 7.3 命令

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `inspect_workspace` | `path` | `VaultInspection` | 不需要密码；返回 `kind`/`name`/`noteCount` |
| `create_vault` | `path`, `password` | `WorkspaceInfo` | 创建并迁移，成功后激活 |
| `open_vault` | `path`, `password` | `WorkspaceInfo` | 解锁，必要时续迁移，成功后激活 |
| `rescan_workspace` | — | `WorkspaceInfo` | 需要活动库 |
| `read_note` | `path` | `NoteDocument` | 后端解密 |
| `save_note` | `path`, `content` | `SavedNote` | 后端加密后原子写 |
| `create_folder` | `parent`, `name` | `String` | 行为不变 |
| `create_note` | `parent`, `name` | `String` | 写入空明文的密文 |
| `rename_note` | `path`, `newName` | `String` | 行为不变，不需要密钥 |
| `delete_note` | `path` | `()` | 行为不变 |

`VaultInspection` 序列化为：

```json
{ "kind": "ready" | "migrating" | "needsCreation", "name": "…", "noteCount": 3 }
```

所有命令错误继续使用 `Result<T, String>`，与现有风格一致。

## 8. 前端交互

### 8.1 打开流程

1. 选择文件夹。
2. 调用 `inspect_workspace`。
3. `needsCreation` → 创建对话框：输入密码 + 确认密码；若已有笔记，显示警告并勾选“已备份”。
4. `ready` → 解锁对话框：输入密码。
5. `migrating` → 解锁对话框，提示将续完上次加密。
6. 调用 `create_vault` / `open_vault`；成功后才替换当前库，失败保留原库。
7. 密码错误在对话框内联提示，允许重试；取消则不改变当前库。

### 8.2 启动行为

- 不再自动恢复上次库。启动显示欢迎页，由用户打开或创建加密库。
- `localStorage` 只保留主题、侧栏宽度/折叠状态等非内容元数据。
- 最近笔记、折叠目录、上次库路径退化为内存状态，重启即清空。
- 启动时删除旧版本遗留的 `mojian.last-workspace`、`mojian.recent`、`mojian.collapsed`。

### 8.3 保持不变

文件树、搜索、编辑器、自动保存、刷新、新建/重命名/删除、快捷键、右键菜单、主题、侧栏布局都不改。

## 9. 迁移与崩溃安全

创建库的迁移顺序：

1. 扫描库内可见 `.md`。
2. 生成 DEK/salt/vaultId，写 `state: migrating` 标记。
3. 逐个读取笔记；若已有 `MOJIANM1` magic 则跳过；否则加密并原子替换原文件。明文只存在于内存；临时文件始终是密文。
4. 全部成功后写 `state: ready`。

中断处理：

- 标记已存在且为 `migrating` 时，`inspect` 返回 `migrating`；`open_vault` 成功解锁后重新扫描并跳过已加密文件，完成剩余迁移，再置为 `ready`。
- 标记先于文件写入，因此不会出现“部分文件已加密但应用以为是普通文件夹”的双重加密。
- 单个文件失败则中止并保留 `migrating`，用户修复权限/空间后可重试。
- 每次成功解锁和手动刷新后，都会扫描并加密新出现的明文 `.md`（已有 magic 的跳过），确保用户从外部放入的文件不会以明文长期留在库中。

## 10. 测试与验收

自动化：

- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- `npm run build`

Rust 测试覆盖：

- 加解密往返（含空内容和 UTF-8 非法内容）。
- 错误密码、错误 vaultId、密文篡改、跨库拷贝失败。
- 每次 seal 的 nonce 不同。
- inspect 三种状态与笔记计数。
- 创建空库、含明文笔记的库；迁移后磁盘无明文。
- 迁移中断后续传，不双重加密。
- 新建空笔记可解密为空字符串。
- 重命名后仍可解密；保存保留文件权限。
- 失败解锁不影响已有活动库。

手工验收：

1. 创建空库 → 新建笔记 → 输入唯一短语 → 保存。
2. `xxd -l 8 note.md` 显示 `MOJIANM1`；`grep -a "唯一短语" note.md` 无结果。
3. 重启应用：不自动打开库；错误密码被拒绝；正确密码打开且内容完整。
4. 对含多篇明文笔记的文件夹创建库：全部可读，磁盘 grep 无原文。
5. 新建、重命名、删除、刷新、自动保存、切换库均正常。
6. DevTools 的 localStorage 不含笔记名、目录名或上次库路径。
7. 迁移中途杀进程后重新打开，能续完迁移且无双重加密。

## 11. 已知代价与提示文案

- 用户必须知道：密码丢失 = 数据永久不可读。
- 用户必须知道：加密会覆盖原文件，创建前应备份。
- 用户必须知道：文件名、目录名、文件大小、修改时间仍然可见。
- 用户必须知道：旧明文可能残留在备份、云盘历史版本、文件系统未擦除块中。

创建对话框的警告文案固定为：

> 密码不会被保存。忘记密码后无法找回，也无法解密任何笔记。加密会原地覆盖现有文件，创建前请先备份整个文件夹。
