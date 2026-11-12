# 加密 Markdown 笔记库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 Tauri Markdown 编辑器改造成强制加密库：所有 `.md` 内容以密文落盘，创建库时设密码，打开库时验证密码，其余编辑器交互不变。

**Architecture:** Rust 后端信封加密。Argon2id 从密码派生 KEK，随机 DEK 被 KEK 包裹后存入隐藏标记文件；每个笔记用 DEK 做 XChaCha20-Poly1305 加密。前端只新增密码对话框和“检查库 → 解锁/创建”流程，读写命令签名保持不变。

**Tech Stack:** Tauri 2、Rust 2024 edition、serde、Argon2id、XChaCha20-Poly1305、TypeScript/Vite。

**Spec:** `docs/superpowers/specs/2026-11-11-encrypted-vault-design.md`

## Global Constraints

- 标记文件固定为库根目录 `.mojian-vault.json`，`format = "mojian-vault"`，`version = 1`。
- KDF 新库固定 Argon2id：`memoryKiB = 65536`、`iterations = 3`、`parallelism = 1`，salt 16 字节。
- DEK 32 字节，vaultId 16 字节，XChaCha20-Poly1305 nonce 24 字节，tag 16 字节。
- 文件 magic 固定 8 字节 `MOJIANM1`；文件 AAD = `MAGIC || vaultId`；包裹 AAD = `b"MOJIAN-KEY" || vaultId`。
- 没有 `.mojian-vault.json` 的文件夹不得以明文模式打开。
- 明文不得写入磁盘：保存和迁移的临时文件必须已是密文。
- 后端错误统一 `Result<T, String>`；不得在错误、日志、返回值中泄露密码、DEK 或明文。
- 敏感 UI 元数据（最近笔记、折叠目录、上次库路径）只放内存；`localStorage` 只保留主题和侧栏布局。
- 首版不做改密码、恢复密钥、自动锁定、附件加密。

## Review Focus

- 迁移中途崩溃后重新解锁：必须续完剩余文件，且不能把已加密文件再加密一次。
- 打开新库失败（尤其密码错误）：必须保留当前已打开库和会话密钥，不允许清空状态。
- 新建空笔记：磁盘上必须是可解密的空明文密文，不能是 0 字节文件。
- 库内重命名或外部移动文件：只要仍在同一库，密文必须仍可解密（AAD 不绑定路径）。
- 旧版本 `localStorage`：启动时必须清除遗留的 `mojian.last-workspace`、`mojian.recent`、`mojian.collapsed`。

---

### Task 1: 密码学原语

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/crypto.rs`
- Modify: `src-tauri/src/lib.rs`（只加 `mod crypto;`）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `pub const MAGIC: &[u8; 8]`
  - `pub const NONCE_LEN: usize = 24`
  - `pub const TAG_LEN: usize = 16`
  - `pub const KEY_LEN: usize = 32`
  - `pub const VAULT_ID_LEN: usize = 16`
  - `pub const SALT_LEN: usize = 16`
  - `pub const KEY_AAD: &[u8]`
  - `pub struct KdfParams { pub memory_kib: u32, pub iterations: u32, pub parallelism: u32 }`（serde camelCase，`Default` 为 65536/3/1，`validate()`）
  - `pub struct VaultKey([u8; 32])`（`generate()`、`from_bytes()`、`pub(crate) as_bytes()`、`Drop` 清零）
  - `pub struct VaultSession { pub key: VaultKey, pub vault_id: [u8; 16] }`（`new()`）
  - `pub fn derive_kek(password: &str, salt: &[u8], params: &KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>, String>`
  - `pub fn wrap_dek(kek: &[u8; KEY_LEN], key: &VaultKey, vault_id: &[u8; 16]) -> Result<Vec<u8>, String>`（返回 72 字节 nonce||ciphertext）
  - `pub fn unwrap_dek(kek: &[u8; KEY_LEN], wrapped: &[u8], vault_id: &[u8; 16]) -> Result<VaultKey, String>`
  - `pub fn seal(key: &VaultKey, vault_id: &[u8; 16], plaintext: &[u8]) -> Result<Vec<u8>, String>`
  - `pub fn open(key: &VaultKey, vault_id: &[u8; 16], sealed: &[u8]) -> Result<Vec<u8>, String>`
  - `pub fn is_sealed(bytes: &[u8]) -> bool`

- [ ] **Step 1: 添加依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 加入：

```toml
argon2 = "0.5"
chacha20poly1305 = "0.10"
rand = "0.8"
zeroize = "1"
base64 = "0.22"
```

- [ ] **Step 2: 写失败测试**

创建 `src-tauri/src/crypto.rs`，先放公开签名（函数体 `todo!()`）和以下测试。测试使用快速 KDF 参数，避免每次跑测试都耗 0.5 秒：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn fast_kdf() -> KdfParams {
        KdfParams { memory_kib: 8192, iterations: 1, parallelism: 1 }
    }
    fn key() -> VaultKey { VaultKey::from_bytes([7u8; 32]) }
    const VAULT: [u8; 16] = [9u8; 16];

    #[test]
    fn seal_open_roundtrip_including_empty() {
        let plain = b"hello \xe4\xb8\x96\xe7\x95\x8c";
        let sealed = seal(&key(), &VAULT, plain).unwrap();
        assert!(is_sealed(&sealed));
        assert_eq!(open(&key(), &VAULT, &sealed).unwrap(), plain);
        let empty = seal(&key(), &VAULT, b"").unwrap();
        assert_eq!(open(&key(), &VAULT, &empty).unwrap(), b"");
    }

    #[test]
    fn wrong_key_vault_or_tamper_fails() {
        let sealed = seal(&key(), &VAULT, b"secret").unwrap();
        let other = VaultKey::from_bytes([8u8; 32]);
        assert!(open(&other, &VAULT, &sealed).is_err());
        assert!(open(&key(), &[1u8; 16], &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(open(&key(), &VAULT, &tampered).is_err());
        assert!(!is_sealed(b"short"));
    }

    #[test]
    fn every_seal_uses_a_new_nonce() {
        assert_ne!(seal(&key(), &VAULT, b"x").unwrap(), seal(&key(), &VAULT, b"x").unwrap());
    }

    #[test]
    fn wraps_and_unwraps_the_dek() {
        let kek = derive_kek("correct horse", &[3u8; SALT_LEN], &fast_kdf()).unwrap();
        let wrapped = wrap_dek(&kek, &key(), &VAULT).unwrap();
        assert_eq!(wrapped.len(), NONCE_LEN + KEY_LEN + TAG_LEN);
        assert_eq!(unwrap_dek(&kek, &wrapped, &VAULT).unwrap().as_bytes(), key().as_bytes());
    }

    #[test]
    fn wrong_password_or_vault_id_cannot_unwrap() {
        let kek = derive_kek("correct horse", &[3u8; SALT_LEN], &fast_kdf()).unwrap();
        let other = derive_kek("wrong horse", &[3u8; SALT_LEN], &fast_kdf()).unwrap();
        let wrapped = wrap_dek(&kek, &key(), &VAULT).unwrap();
        assert!(unwrap_dek(&other, &wrapped, &VAULT).is_err());
        assert!(unwrap_dek(&kek, &wrapped, &[4u8; 16]).is_err());
    }

    #[test]
    fn kdf_params_are_validated() {
        assert!(fast_kdf().validate().is_ok());
        for params in [
            KdfParams { memory_kib: 1024, iterations: 1, parallelism: 1 },
            KdfParams { memory_kib: 8192, iterations: 0, parallelism: 1 },
            KdfParams { memory_kib: 8192, iterations: 1, parallelism: 0 },
            KdfParams { memory_kib: 1_000_000, iterations: 1, parallelism: 1 },
        ] {
            assert!(params.validate().is_err());
        }
    }
}
```

同时把 `mod crypto;` 加进 `src-tauri/src/lib.rs`。

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml crypto`

Expected: 编译失败（函数未实现）或测试 panic `not yet implemented`。

- [ ] **Step 4: 实现 `crypto.rs`**

实现要点：

- `derive_kek` 用 `argon2::Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(memory_kib, iterations, parallelism, Some(KEY_LEN))?)`，再 `hash_password_into(password.as_bytes(), salt, &mut out)`。
- `wrap_dek` / `unwrap_dek` 用 XChaCha20-Poly1305，AAD 为 `KEY_AAD || vault_id`；`wrapped` 布局是 `nonce (24) || ciphertext (48)`。
- `seal` 返回 `MAGIC || nonce || ciphertext || tag`，AAD 为 `MAGIC || vault_id`。
- `open` 校验长度和 magic，按固定偏移拆 nonce，认证失败返回通用错误，不带细节。
- `is_sealed` 只判断长度至少 `8 + 24 + 16` 且前 8 字节等于 `MAGIC`。
- 随机数统一用 `rand::rngs::OsRng`；`VaultKey::Drop` 调 `self.0.zeroize()`。
- `VaultKey` 不实现 `Clone`、`Debug`；`VaultSession` 只提供 `new`。

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml crypto`

Expected: 6 个测试全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/crypto.rs src-tauri/src/lib.rs
git commit -m "feat(crypto): add Argon2id envelope encryption primitives"
```

---

### Task 2: 笔记读写接入加密

**Files:**
- Modify: `src-tauri/src/notes.rs`

**Interfaces:**
- Consumes: Task 1 的 `VaultSession`、`VaultKey`、`seal`、`open`、`is_sealed`。
- Produces:
  - `pub fn read_note(root: &Path, raw_path: &str, session: &VaultSession) -> Result<NoteDocument, String>`
  - `pub fn save_note(root: &Path, raw_path: &str, content: &str, session: &VaultSession) -> Result<SavedNote, String>`
  - `pub fn create_note(root: &Path, raw_parent: &str, raw_name: &str, session: &VaultSession) -> Result<String, String>`
  - `pub(crate) fn replace_file_atomically(target: &Path, bytes: &[u8], permissions: fs::Permissions) -> Result<fs::Metadata, String>`
  - `rename_note`、`delete_note` 签名不变。

- [ ] **Step 1: 写失败测试**

在 `notes.rs` 测试模块加入辅助函数。把模块内所有创建 `.md` 的 `TestDir::write(...)` 改为 `write_sealed(...)`，并把 `creates_an_empty_note_and_rejects_duplicates...` 的 `metadata.len() == 0` 断言改为“解密后内容为空”。原有 `saved.size == updated.len()` 改为 `saved.size > updated.len()`（现在是密文大小）。

```rust
use crate::crypto::{self, VaultKey, VaultSession};

fn test_session() -> VaultSession {
    VaultSession::new(VaultKey::from_bytes([7u8; 32]), [9u8; 16])
}

fn write_sealed(root: &Path, relative: &str, content: &str, session: &VaultSession) -> PathBuf {
    let path = root.join(relative);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).unwrap(); }
    fs::write(&path, crypto::seal(&session.key, &session.vault_id, content.as_bytes()).unwrap()).unwrap();
    path
}
```

新增/改写的断言：

```rust
#[test]
fn disk_bytes_are_ciphertext_with_the_magic() {
    let workspace = TestDir::new("ciphertext");
    let session = test_session();
    write_sealed(workspace.path(), "note.md", "TOP-SECRET-PHRASE", &session);
    let raw = fs::read(workspace.path().join("note.md")).unwrap();
    assert!(crypto::is_sealed(&raw));
    assert!(!raw.windows(b"TOP-SECRET-PHRASE".len()).any(|w| w == b"TOP-SECRET-PHRASE"));
}

#[test]
fn creates_an_empty_note_that_decrypts_to_empty() {
    let workspace = TestDir::new("empty-note");
    let session = test_session();
    let relative = create_note(workspace.path(), "", "fresh.md", &session).unwrap();
    assert_eq!(relative, "fresh.md");
    assert!(fs::metadata(workspace.path().join("fresh.md")).unwrap().len() > 0);
    assert_eq!(read_note(workspace.path(), "fresh.md", &session).unwrap().content, "");
}

#[test]
fn refuses_plaintext_notes_in_an_encrypted_library() {
    let workspace = TestDir::new("plaintext-refused");
    let session = test_session();
    workspace.write("plain.md", "# plain");
    let error = read_note(workspace.path(), "plain.md", &session).unwrap_err();
    assert!(error.contains("encrypted"), "{error}");
}

#[test]
fn rename_keeps_the_note_decryptable() {
    let workspace = TestDir::new("rename-encrypted");
    let session = test_session();
    write_sealed(workspace.path(), "notes/old.md", "# Original", &session);
    rename_note(workspace.path(), "notes/old.md", "new.markdown").unwrap();
    assert_eq!(read_note(workspace.path(), "notes/new.markdown", &session).unwrap().content, "# Original");
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes`

Expected: 编译失败，提示 `read_note` 等函数参数数量不匹配。

- [ ] **Step 3: 实现加密读写**

要点：

- 把现有 `write_file_atomically` 拆出 `replace_file_atomically(target, bytes, permissions)`，内部继续用 `unique_temp_path`、`create_new`、`sync_all`、`rename`。
- `read_note`：先检查 `crypto::is_sealed`，不是密文则返回 `"Note \"…\" is not an encrypted library note."`；再 `crypto::open`，最后 UTF-8 校验。
- `save_note`：先 `crypto::seal(session.key, session.vault_id, content.as_bytes())`，再调用 `replace_file_atomically`；`SavedNote.size` 返回磁盘上的密文大小。
- `create_note`：用 `create_new` 打开目标，写入 `crypto::seal(..., b"")`，`sync_all`；写入失败时删除刚创建的目标再返回错误。
- 迁移期间的临时文件始终是密文；不得把明文写进任何临时文件。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes`

Expected: 全部 PASS，包括原有的路径安全、权限保留、删除测试（测试数据已改为密文）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/notes.rs
git commit -m "feat(notes): encrypt note contents read and write"
```

---

### Task 3: 库标记、创建、解锁与迁移

**Files:**
- Create: `src-tauri/src/vault.rs`
- Modify: `src-tauri/src/workspace.rs`
- Modify: `src-tauri/src/lib.rs`（加 `mod vault;`）

**Interfaces:**
- Consumes: Task 1 `crypto`；Task 2 `notes::replace_file_atomically`；`workspace::scan_workspace`、`security`。
- Produces:
  - `pub const MARKER_FILE: &str = ".mojian-vault.json"`
  - `pub const FORMAT: &str = "mojian-vault"`
  - `pub const VERSION: u32 = 1`
  - `pub enum VaultKind { Ready, Migrating, NeedsCreation }`（Serialize, PartialEq, Debug）
  - `pub struct VaultInspection { pub kind: VaultKind, pub name: String, pub note_count: usize }`（serde camelCase）
  - `pub struct OpenVault { pub workspace: Workspace, pub session: Arc<VaultSession>, pub scan: WorkspaceScan }`
  - `pub fn inspect(root: &Path) -> Result<VaultInspection, String>`
  - `pub fn create(root: &Path, password: &str) -> Result<OpenVault, String>`
  - `pub fn unlock(root: &Path, password: &str) -> Result<OpenVault, String>`
  - `pub fn ensure_encrypted(root: &Path, session: &VaultSession) -> Result<(), String>`
  - `workspace::workspace_from_root(root: &Path) -> Result<Workspace, String>`

- [ ] **Step 1: 写失败测试**

在 `workspace.rs` 增加：

```rust
pub fn workspace_from_root(root: &Path) -> Result<Workspace, String> {
    let root = security::verify_workspace_dir(root)?;
    let name = workspace_name(&root);
    Ok(Workspace { root, name })
}
```

删除不再使用的 `workspace::open_workspace_folder`，并把它的测试改为 `workspace_from_root` + `scan_workspace` 组合，避免非测试构建出现 dead_code 警告。

创建 `src-tauri/src/vault.rs`，先放签名（`todo!()`）和测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;
    use crate::test_support::TestDir;
    use crate::workspace;
    use std::fs;

    fn contains(bytes: &[u8], needle: &[u8]) -> bool {
        bytes.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn inspect_reports_needs_creation_with_note_count() {
        let dir = TestDir::new("vault-inspect");
        dir.write("a.md", "alpha");
        dir.write("notes/b.md", "beta");
        let inspection = inspect(dir.path()).unwrap();
        assert_eq!(inspection.kind, VaultKind::NeedsCreation);
        assert_eq!(inspection.note_count, 2);
    }

    #[test]
    fn create_encrypts_existing_notes_and_writes_a_marker() {
        let dir = TestDir::new("vault-create");
        dir.write("a.md", "alpha-secret");
        dir.write("notes/b.md", "beta-secret");
        let opened = create(dir.path(), "correct horse").unwrap();
        assert_eq!(inspect(dir.path()).unwrap().kind, VaultKind::Ready);
        assert!(dir.path().join(MARKER_FILE).is_file());
        for path in ["a.md", "notes/b.md"] {
            let raw = fs::read(dir.path().join(path)).unwrap();
            assert!(crypto::is_sealed(&raw), "{path}");
            assert!(!contains(&raw, b"-secret"), "{path}");
        }
        assert_eq!(crate::notes::read_note(dir.path(), "a.md", &opened.session).unwrap().content, "alpha-secret");
        assert_eq!(opened.scan.notes.len(), 2);
    }

    #[test]
    fn create_supports_an_empty_folder() {
        let dir = TestDir::new("vault-empty");
        let opened = create(dir.path(), "pw").unwrap();
        assert_eq!(inspect(dir.path()).unwrap().kind, VaultKind::Ready);
        assert_eq!(inspect(dir.path()).unwrap().note_count, 0);
        assert!(opened.scan.notes.is_empty());
    }

    #[test]
    fn unlock_rejects_wrong_password_and_accepts_the_right_one() {
        let dir = TestDir::new("vault-unlock");
        dir.write("a.md", "alpha");
        create(dir.path(), "right-password").unwrap();
        assert!(unlock(dir.path(), "wrong-password").is_err());
        let opened = unlock(dir.path(), "right-password").unwrap();
        assert_eq!(crate::notes::read_note(dir.path(), "a.md", &opened.session).unwrap().content, "alpha");
    }

    #[test]
    fn unlock_encrypts_plaintext_files_added_later() {
        let dir = TestDir::new("vault-late-plaintext");
        dir.write("a.md", "alpha");
        create(dir.path(), "pw").unwrap();
        dir.write("late.md", "later-secret");
        let opened = unlock(dir.path(), "pw").unwrap();
        assert!(crypto::is_sealed(&fs::read(dir.path().join("late.md")).unwrap()));
        assert_eq!(crate::notes::read_note(dir.path(), "late.md", &opened.session).unwrap().content, "later-secret");
    }

    #[test]
    fn resumes_a_migrating_vault_without_double_encryption() {
        let dir = TestDir::new("vault-resume");
        dir.write("a.md", "first");
        let opened = create(dir.path(), "pw").unwrap();
        let original = fs::read(dir.path().join("a.md")).unwrap();

        let marker = dir.path().join(MARKER_FILE);
        let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        json["state"] = serde_json::json!("migrating");
        fs::write(&marker, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        dir.write("late.md", "second");

        let resumed = unlock(dir.path(), "pw").unwrap();
        assert_eq!(resumed.scan.notes.len(), 2);
        assert_eq!(fs::read(dir.path().join("a.md")).unwrap(), original, "already encrypted file was rewritten");
        assert!(crypto::is_sealed(&fs::read(dir.path().join("late.md")).unwrap()));
        assert_eq!(inspect(dir.path()).unwrap().kind, VaultKind::Ready);
        assert_eq!(crate::notes::read_note(dir.path(), "late.md", &resumed.session).unwrap().content, "second");
    }

    #[test]
    fn rejects_unknown_versions_and_corrupt_markers() {
        let dir = TestDir::new("vault-version");
        dir.write("a.md", "alpha");
        create(dir.path(), "pw").unwrap();
        let marker = dir.path().join(MARKER_FILE);

        let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        json["version"] = serde_json::json!(2);
        fs::write(&marker, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        assert!(inspect(dir.path()).is_err());
        assert!(unlock(dir.path(), "pw").is_err());

        fs::write(&marker, b"{not json").unwrap();
        assert!(inspect(dir.path()).is_err());
    }

    #[test]
    fn create_refuses_an_existing_vault_and_marker_is_not_scanned() {
        let dir = TestDir::new("vault-existing");
        dir.write("a.md", "alpha");
        create(dir.path(), "pw").unwrap();
        assert!(create(dir.path(), "pw2").is_err());
        let scan = workspace::scan_workspace(dir.path()).unwrap();
        assert_eq!(scan.notes.len(), 1);
        assert!(scan.notes.iter().all(|note| note.path != MARKER_FILE));
        assert!(scan.folders.iter().all(|folder| folder != ".mojian-vault.json"));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault`

Expected: 编译失败（`inspect`/`create`/`unlock` 未实现）。

- [ ] **Step 3: 实现 `vault.rs`**

数据结构：

```rust
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultMetadata {
    pub format: String,
    pub version: u32,
    pub state: VaultState,
    pub vault_id: String,
    pub kdf: crypto::KdfParams,
    pub salt: String,
    pub cipher: String,
    pub wrapped_key: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultState { Migrating, Ready }
```

要点：

- `read_metadata(root) -> Result<Option<VaultMetadata>, String>`：文件不存在返回 `None`；解析失败、`format`/`version`/`cipher` 不符、dict 字段 base64 长度不对、`KdfParams::validate()` 失败都返回错误。
- `write_metadata(root, meta)`：`serde_json::to_vec_pretty` → `notes::replace_file_atomically` → Unix 下 `set_permissions(0o600)`。
- `inspect`：`workspace_from_root`；`read_metadata`；`scan_workspace`；按 marker 状态和 `scan.notes.len()` 构造 `VaultInspection`。无 marker 时返回 `NeedsCreation`。
- `create`：
  1. `workspace_from_root`；
  2. 若 marker 已存在则报错；
  3. `scan_workspace` 得到待迁移笔记；
  4. 生成 salt、vaultId、DEK；
  5. `derive_kek`，`wrap_dek`；
  6. 写 `state: Migrating` 的 marker；
  7. `migrate_notes`；
  8. marker 改 `state: Ready`；
  9. 重新扫描并返回 `OpenVault`。
- `unlock`：
  1. `workspace_from_root`；
  2. `read_metadata` 必须存在，否则报“not an encrypted library”；
  3. base64 解码 salt/vaultId/wrappedKey；
  4. `derive_kek`、`unwrap_dek`；失败统一返回 `"Could not unlock the library: the password is wrong or the vault is damaged."`；
  5. 扫描后调用 `migrate_notes`（已密文文件跳过）；若 `state == Migrating`，完成后 marker 改 `Ready`；
  6. 重新扫描并返回 `OpenVault`。
- `ensure_encrypted(root, session)`：扫描 → `migrate_notes`；供 `unlock` 和 `rescan_workspace` 复用，保证外部放入的明文 `.md` 在下次打开/刷新时被加密。
- `migrate_notes(root, session, notes)`：逐个 `security::resolve_note`；先读文件前 8 字节判断 magic，已密文则跳过（避免每次打开都整文件读取）；否则读取完整字节、取权限、`crypto::seal`、`notes::replace_file_atomically`。
- 所有 base64 使用 `base64::engine::general_purpose::STANDARD`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/vault.rs src-tauri/src/workspace.rs src-tauri/src/lib.rs
git commit -m "feat(vault): add encrypted library creation, unlock, and migration"
```

---

### Task 4: 后端状态与命令

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 `VaultSession`；Task 2 加密后的 notes 函数；Task 3 `vault::{inspect, create, unlock, OpenVault, VaultInspection}`。
- Produces:
  - `struct ActiveVault { workspace: Workspace, session: Arc<VaultSession> }`
  - `AppState { active: Mutex<Option<ActiveVault>> }`
  - `AppState::require() -> Result<(Workspace, Arc<VaultSession>), String>`
  - `AppState::set(workspace: Workspace, session: Arc<VaultSession>) -> Result<(), String>`
  - Tauri commands：`inspect_workspace`、`create_vault`、`open_vault`，以及改造后的 `read_note`/`save_note`/`create_note`。

- [ ] **Step 1: 写失败测试**

把 `lib.rs` 原有测试改为新状态模型，并增加：

```rust
#[test]
fn active_vault_is_kept_in_managed_state() {
    let state = AppState::default();
    let session = Arc::new(VaultSession::new(VaultKey::from_bytes([7u8; 32]), [9u8; 16]));
    state.set(
        Workspace { root: Path::new("/tmp/example-vault").to_path_buf(), name: "example-vault".to_string() },
        session,
    ).unwrap();
    let (workspace, _session) = state.require().unwrap();
    assert_eq!(workspace.name, "example-vault");
}

#[test]
fn failed_unlock_keeps_the_existing_active_vault() {
    use crate::test_support::TestDir;
    let old = TestDir::new("state-old");
    let session = Arc::new(VaultSession::new(VaultKey::from_bytes([7u8; 32]), [9u8; 16]));
    let state = AppState::default();
    state.set(Workspace { root: fs::canonicalize(old.path()).unwrap(), name: "old".into() }, session).unwrap();

    let new = TestDir::new("state-new");
    new.write("a.md", "alpha");
    crate::vault::create(new.path(), "right").unwrap();
    assert!(crate::vault::unlock(new.path(), "wrong").is_err());

    let (workspace, _session) = state.require().unwrap();
    assert_eq!(workspace.name, "old");
}
```

`lib.rs` 测试模块需要 `use std::sync::Arc; use crate::crypto::{VaultKey, VaultSession}; use std::fs;`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: 编译失败（`set` 参数数量、`require` 返回值不匹配）。

- [ ] **Step 3: 实现状态与命令**

要点：

- 删除 `open_workspace` 命令；新增：

```rust
#[tauri::command]
async fn inspect_workspace(path: String) -> Result<vault::VaultInspection, String>;

#[tauri::command]
async fn open_vault(path: String, password: String, state: State<'_, AppState>) -> Result<WorkspaceInfo, String>;

#[tauri::command]
async fn create_vault(path: String, password: String, state: State<'_, AppState>) -> Result<WorkspaceInfo, String>;
```

- `inspect_workspace` 用 `spawn_blocking` 调 `vault::inspect`。
- `open_vault` / `create_vault` 把密码包成 `Zeroizing<String>`，在 `spawn_blocking` 里调用 `vault::unlock` / `vault::create`；只有返回 `OpenVault` 后才 `state.set(...)`，失败时不触碰旧状态。
- 成功后 `let info = opened.workspace.info(opened.scan);`，再 `state.set(opened.workspace, opened.session)`。
- `read_note`/`save_note`/`create_note`：`let (workspace, session) = state.require()?;` 然后把 `session` move 进 `spawn_blocking`，调用 Task 2 的签名。
- `rescan_workspace`：取 `(workspace, session)`，在 `spawn_blocking` 里先 `vault::ensure_encrypted(&workspace.root, &session)`，再 `scan_workspace`，然后返回 `WorkspaceInfo`。
- `create_folder`/`rename_note`/`delete_note`：只需要 `state.require()?.0` 的 root，但仍然要求存在活动库。
- `generate_handler!` 列表改为：
  `inspect_workspace, create_vault, open_vault, rescan_workspace, read_note, save_note, create_folder, create_note, rename_note, delete_note`。
- 错误文案保持英文、可读；不要包含密码/密钥。

- [ ] **Step 4: 运行后端全部测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: `crypto`、`notes`、`vault`、`workspace`、`security`、`lib` 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(api): wire vault session into Tauri commands"
```

---

### Task 5: 前端 API 与内存元数据

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/lib/storage.ts`
- Modify: `src/main.ts`（启动流程与上次库移除）

**Interfaces:**
- Consumes: Task 4 命令。
- Produces:
  - `export type VaultKind = "ready" | "migrating" | "needsCreation";`
  - `export interface VaultInspection { kind: VaultKind; name: string; noteCount: number; }`
  - `workspaceApi.inspect(path: string): Promise<VaultInspection>`
  - `workspaceApi.openVault(path: string, password: string): Promise<WorkspaceInfo>`
  - `workspaceApi.createVault(path: string, password: string): Promise<WorkspaceInfo>`
  - `storage.purgeLegacyMetadata(): void`
  - 移除 `storage.getLastWorkspace/setLastWorkspace`。

- [ ] **Step 1: 更新 `api.ts`**

增加类型与三个方法；暂时保留 `open()`，等 Task 6 删除，保证本任务结束时 `npm run check` 通过：

```ts
export type VaultKind = "ready" | "migrating" | "needsCreation";

export interface VaultInspection {
  kind: VaultKind;
  name: string;
  noteCount: number;
}

// workspaceApi 内：
inspect(path: string): Promise<VaultInspection> {
  return invoke<VaultInspection>("inspect_workspace", { path });
},
openVault(path: string, password: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("open_vault", { path, password });
},
createVault(path: string, password: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("create_vault", { path, password });
},
```

- [ ] **Step 2: 改造 `storage.ts` 为内存元数据**

- 删除 `KEYS.lastWorkspace`、`KEYS.recent`、`KEYS.collapsed`。
- 增加模块级：

```ts
const memoryRecent = new Map<string, RecentNote[]>();
const memoryCollapsed = new Map<string, Set<string>>();
const LEGACY_KEYS = ["mojian.last-workspace", "mojian.recent", "mojian.collapsed"];
```

- `getRecent/pushRecent/removeRecent/renameRecent` 全部读写 `memoryRecent`，返回值用 `.slice()` 避免外部改内部数组。
- `getCollapsedFolders` 返回 `new Set(memoryCollapsed.get(path) ?? [])`；`setCollapsedFolders` 存入 `new Set(folders)`。
- 删除 `getLastWorkspace/setLastWorkspace`。
- 增加：

```ts
purgeLegacyMetadata(): void {
  try {
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch (_) {
    /* ignore */
  }
},
```

- 主题、侧栏宽度、侧栏折叠继续用 `localStorage`。

- [ ] **Step 3: 调整 `main.ts` 启动与上次库**

- 在 `init()` 中 `this.collectDom()` 之后调用 `storage.purgeLegacyMetadata();`。
- 删除 `void this.restoreLastWorkspace();`。
- 删除整个 `restoreLastWorkspace()` 方法（约 `src/main.ts:779-808`）。
- 删除 `adoptWorkspace()` 里的 `storage.setLastWorkspace(info.path);`（约 `src/main.ts:827`）。
- 欢迎页无库文案改为：

```text
打开或创建一个加密笔记库。笔记在磁盘上以密文保存，只有输入密码才能读取。
```

- [ ] **Step 4: 类型检查**

Run: `npm run check`

Expected: 0 errors（`workspaceApi.open` 仍存在，所以旧流程暂时可编译）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/api.ts src/lib/storage.ts src/main.ts
git commit -m "feat(ui): add vault API types and keep sensitive metadata in memory"
```

---

### Task 6: 密码对话框与打开/创建流程

**Files:**
- Modify: `index.html`
- Modify: `src/styles.css`
- Modify: `src/main.ts`
- Modify: `src/lib/api.ts`（删除旧的 `open`）

**Interfaces:**
- Consumes: Task 5 的 `VaultInspection`、`workspaceApi.{inspect,openVault,createVault}`、`storage`。
- Produces: `private promptVaultPassword(mode, inspection, error?): Promise<string | null>`；改造后的 `openWorkspaceDialog()`。

- [ ] **Step 1: 添加对话框标记**

在 `index.html` 的 `delete-dialog` 之后加入：

```html
<dialog id="vault-dialog" class="vault-dialog" aria-labelledby="vault-title">
  <form id="vault-form" class="vault-dialog__form" novalidate>
    <div class="vault-dialog__head">
      <div>
        <p id="vault-eyebrow" class="vault-dialog__eyebrow">ENCRYPTED LIBRARY</p>
        <h2 id="vault-title">解锁加密笔记库</h2>
      </div>
      <button id="vault-close" class="icon-btn" type="button" aria-label="关闭" data-icon="x"></button>
    </div>
    <p id="vault-description" class="vault-dialog__description"></p>
    <div id="vault-warning" class="vault-warning" hidden></div>
    <div class="vault-fields">
      <label class="name-field" for="vault-password">
        <span class="name-field__label">密码</span>
        <span class="name-field__control">
          <input id="vault-password" class="name-field__input" type="password"
                 autocomplete="current-password" aria-describedby="vault-error" />
        </span>
      </label>
      <label id="vault-confirm-field" class="name-field" for="vault-password-confirm" hidden>
        <span class="name-field__label">确认密码</span>
        <span class="name-field__control">
          <input id="vault-password-confirm" class="name-field__input" type="password"
                 autocomplete="new-password" aria-describedby="vault-error" />
        </span>
      </label>
    </div>
    <label id="vault-backup-field" class="vault-check" hidden>
      <input id="vault-backup" type="checkbox" />
      <span>我已了解密码无法找回，并已备份整个文件夹。</span>
    </label>
    <p id="vault-error" class="field-error" role="alert"></p>
    <div class="entry-dialog__actions">
      <button id="vault-cancel" class="dialog-btn" type="button">取消</button>
      <button id="vault-confirm" class="dialog-btn dialog-btn--primary" type="submit">解锁</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 2: 添加样式**

在 `src/styles.css` 的对话框区域：

- 把 `.vault-dialog` 加入现有 `.entry-dialog, .delete-dialog` 的共享规则（背景、边框、宽度、`::backdrop`、`[open]` 动画、`dialog--menu-open`）。
- 新增 `.vault-dialog__form`（沿用 `.entry-dialog__form` 的 padding）、`.vault-dialog__head` / `__eyebrow` / `__description`。
- `.vault-warning`：浅色警示背景、左侧强调色边框、11.5px/1.7 行高、上下 10px 间距。
- `.vault-check`：`display:flex; gap:8px; align-items:flex-start; margin:4px 0 2px; font-size:11.5px; color:var(--muted);`
- 密码字段之间用 `.vault-fields { display:flex; flex-direction:column; gap:12px; }` 包一层。

- [ ] **Step 3: 实现 `promptVaultPassword`**

在 `main.ts` 增加 DOM 字段并在 `collectDom()` 中绑定上述所有 ID。方法签名：

```ts
private promptVaultPassword(
  mode: "unlock" | "create" | "resume",
  inspection: VaultInspection,
  error?: string,
): Promise<string | null>
```

行为：

- `unlock`：标题“解锁加密笔记库”，eyebrow `ENCRYPTED LIBRARY`，描述 `「${name}」中有 ${noteCount} 篇笔记。输入密码后打开。`；确认框/备份框隐藏；按钮“解锁”；`autocomplete="current-password"`。
- `resume`：标题“继续完成加密”，描述“上次加密没有完成。解锁后会继续加密剩余笔记。”；按钮“解锁并继续”。
- `create`：标题“创建加密笔记库”，eyebrow `NEW ENCRYPTED LIBRARY`，描述：
  - `noteCount === 0`：`「${name}」将创建一个加密笔记库。密码只用于本机解锁。`
  - `noteCount > 0`：`「${name}」中的 ${noteCount} 篇明文笔记将被原地加密。`
  - 警告框固定文案：`密码不会被保存。忘记密码后无法找回，也无法解密任何笔记。加密会原地覆盖现有文件，创建前请先备份整个文件夹。`
  - 确认密码框显示；`noteCount > 0` 时备份复选框显示；按钮“创建并加密”；`autocomplete="new-password"`。
- 提交校验：密码非空；`create` 时两次密码一致；`noteCount > 0` 时必须勾选备份。失败时写入 `vault-error`，不关闭对话框。
- 取消、右上角关闭、`cancel` 事件（Esc）都 resolve `null`。
- 提交成功时先清空两个密码输入，再 `dialog.close()`，resolve 密码字符串。
- 显示上一次失败的错误信息（`error` 参数）；每次打开时清空错误和密码。
- 不要 `console.log` 密码。

实现时增加 `private vaultMode: "unlock" | "create" | "resume" | null`、`private vaultInspection: VaultInspection | null` 和 `private vaultResolver: ((value: string | null) => void) | null`。事件监听只在 `bindUi()` 绑定一次：

- `vault-form` 的 `submit` → 读取 `vaultMode`/`vaultInspection`，做校验；成功时 `finishVaultPrompt(password)`。
- `vault-cancel`、`vault-close`、`vault-dialog` 的 `cancel` → `finishVaultPrompt(null)`。
- `finishVaultPrompt(value)`：清空密码/复选框、关闭 dialog、清空 resolver 后 resolve。

`promptVaultPassword` 只负责设置模式/文案/错误、重置表单、`showModal()`，并返回一个新的 Promise。

- [ ] **Step 4: 改造 `openWorkspaceDialog()`**

替换现有“选文件夹 → `workspaceApi.open`”逻辑：

```ts
const inspection = await workspaceApi.inspect(path);
const mode = inspection.kind === "needsCreation"
  ? "create"
  : inspection.kind === "ready" ? "unlock" : "resume";
let error: string | undefined;
while (true) {
  const password = await this.promptVaultPassword(mode, inspection, error);
  if (password === null) return;
  this.setWorkspaceBusy(true);
  try {
    const info = mode === "create"
      ? await workspaceApi.createVault(path, password)
      : await workspaceApi.openVault(path, password);
    this.adoptWorkspace(info);
    this.showToast({
      kind: "success",
      message: mode === "create"
        ? `已创建加密库「${info.name}」 · ${info.notes.length} 篇笔记`
        : `已解锁「${info.name}」 · ${info.notes.length} 篇笔记`,
    });
    return;
  } catch (e) {
    this.setWorkspaceBusy(false);
    error = errorMessage(e);
  }
}
```

- `inspect` 本身失败（标记损坏等）时：`setWorkspaceBusy(false)` 后 toast `无法打开这个笔记库：…`，不进入创建流程。
- `inspect` 期间也 `setWorkspaceBusy(true)`，结束后恢复，避免大库扫描时 UI 可重入。
- 若 `createVault` 失败，重新调用 `inspect_workspace(path)`：如果 kind 已变成 `migrating`/`ready`（迁移已写标记但中途失败），把 `mode` 改成 `resume`/`unlock` 并继续重试；否则保留 `create` 模式。否则第二次 `createVault` 只会得到“库已存在”。
- 选择文件夹的标题改为“选择加密笔记库”。
- 保持现有“同路径则刷新”“切换前先 saveNow”的行为。

- [ ] **Step 5: 删除旧 API**

从 `src/lib/api.ts` 移除 `open()` 方法。确认 `main.ts` 不再调用 `workspaceApi.open`。

- [ ] **Step 6: 类型检查**

Run: `npm run check`

Expected: 0 errors。

- [ ] **Step 7: 手工冒烟**

Run: `npm run tauri dev`

检查：

1. 空文件夹 → 创建库对话框 → 设置密码后创建成功。
2. 直接重新打开同一库 → 错误密码被拒；正确密码打开。
3. 含明文 `.md` 的文件夹 → 显示“将原地加密 N 篇”警告和备份勾选；未勾选时不能提交。
4. 取消对话框 → 当前库不变。
5. 新建/编辑/自动保存/重命名/删除/刷新正常。

- [ ] **Step 8: 提交**

```bash
git add index.html src/styles.css src/main.ts src/lib/api.ts
git commit -m "feat(ui): add encrypted vault password dialogs and open flow"
```

---

### Task 7: 文档与完整验收

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 用户可见的加密说明和验收记录。

- [ ] **Step 1: 更新 README**

新增“加密笔记库”章节，必须包含：

- 创建库时设置密码；打开库时输入密码。
- 密码不保存、忘记不可恢复；创建前备份整个文件夹。
- 文件名、目录名、文件大小、修改时间仍然可见。
- 图片/附件不在加密范围。
- 原地加密可能在备份、云盘历史版本、文件系统未擦除块中留下旧明文。
- 首版不支持改密码、恢复密钥、自动锁定。

- [ ] **Step 2: 运行全部自动化检查**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run check
npm run build
```

Expected: 全部成功，0 失败。

- [ ] **Step 3: 手工验收**

按 spec 第 10 节逐项执行，并特别验证：

```bash
xxd -l 8 <库路径>/note.md          # 期望 4d4f4a49414e4d31 ("MOJIANM1")
grep -a -r "唯一短语" <库路径>     # 期望无输出
```

- DevTools → Application → Local Storage：只应有 `mojian.theme`、`mojian.sidebar-*`，不能有笔记名/目录名/库路径。
- 重启应用：不自动打开库，显示欢迎页。
- 迁移中断续传可由 Rust 测试 `resumes_a_migrating_vault_without_double_encryption` 证明；如做手工验证，在大库迁移中途结束进程后重新打开并输入密码。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/superpowers/specs/2026-11-11-encrypted-vault-design.md docs/superpowers/plans/2026-11-11-encrypted-vault.md
git commit -m "docs: document encrypted vault behavior and limitations"
```

---

## Self-Review Notes

- **Spec coverage:** 磁盘格式 → Task 1/3；密钥生命周期 → Task 1/3/4；后端命令 → Task 4；前端流程 → Task 5/6；迁移与崩溃安全 → Task 3；元数据策略 → Task 5；测试与验收 → Task 7。
- **Review Focus 对应测试:** 迁移续传 → Task 3 `resumes_a_migrating_vault_without_double_encryption`；失败保留旧库 → Task 4 `failed_unlock_keeps_the_existing_active_vault`；空笔记 → Task 2 `creates_an_empty_note_that_decrypts_to_empty`；改名仍可读 → Task 2 `rename_keeps_the_note_decryptable`；旧 localStorage 清理 → Task 5 `purgeLegacyMetadata` + Task 7 手工 DevTools 检查。
- **类型一致性:** `VaultSession` 定义在 `crypto.rs`，`OpenVault` 定义在 `vault.rs`，`workspace_from_root` 在 `workspace.rs`；后续任务使用同名和同签名。
