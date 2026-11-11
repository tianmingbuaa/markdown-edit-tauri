//! Encrypted library markers: inspection, creation, unlocking, and migration.
//!
//! A library is a folder containing a `.mojian-vault.json` marker. The marker
//! stores the Argon2id parameters, salt, vault identifier, and the DEK wrapped
//! under the password-derived KEK. Every Markdown note in the folder is sealed
//! with the DEK; plaintext notes found during creation or later opens are
//! migrated in place.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

use crate::crypto::{self, VaultKey, VaultSession};
use crate::notes;
use crate::security;
use crate::workspace::{self, NoteEntry, Workspace, WorkspaceScan};

/// File name of the encrypted library marker at the workspace root.
pub const MARKER_FILE: &str = ".mojian-vault.json";

/// Format identifier written into the marker.
pub const FORMAT: &str = "mojian-vault";

/// Current on-disk marker version.
pub const VERSION: u32 = 1;

/// Cipher identifier written into the marker.
const CIPHER: &str = "xchacha20poly1305";

/// KDF algorithm written into the marker.
const KDF_ALGORITHM: &str = "argon2id";

/// Length of a wrapped DEK: nonce (24) plus ciphertext and tag (32 + 16).
const WRAPPED_KEY_LEN: usize = crypto::NONCE_LEN + crypto::KEY_LEN + crypto::TAG_LEN;

/// Failure returned for every password- or damage-related unlock problem.
const UNLOCK_FAILURE: &str =
    "Could not unlock the library: the password is wrong or the vault is damaged.";

/// Kind of library a folder currently holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultKind {
    Ready,
    Migrating,
    NeedsCreation,
}

/// Result of inspecting a folder before opening it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInspection {
    pub kind: VaultKind,
    pub name: String,
    pub note_count: usize,
}

/// An unlocked library: its workspace, session, and fresh scan.
pub struct OpenVault {
    pub workspace: Workspace,
    pub session: Arc<VaultSession>,
    pub scan: WorkspaceScan,
}

/// KDF metadata as it appears in the marker.
///
/// This is separate from `crypto::KdfParams` because the file format fixes
/// the algorithm name and the exact `memoryKiB` spelling, while key derivation
/// only needs the numeric cost parameters.
#[derive(Clone, Serialize, Deserialize)]
pub struct VaultKdf {
    pub algorithm: String,
    #[serde(rename = "memoryKiB")]
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl VaultKdf {
    /// Build marker metadata from the parameters used for derivation.
    fn from_params(params: &crypto::KdfParams) -> Self {
        Self {
            algorithm: KDF_ALGORITHM.to_string(),
            memory_kib: params.memory_kib,
            iterations: params.iterations,
            parallelism: params.parallelism,
        }
    }

    /// Convert to the derivation parameters accepted by the `crypto` module.
    fn to_params(&self) -> crypto::KdfParams {
        crypto::KdfParams {
            memory_kib: self.memory_kib,
            iterations: self.iterations,
            parallelism: self.parallelism,
        }
    }
}

/// The on-disk library marker.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultMetadata {
    pub format: String,
    pub version: u32,
    pub state: VaultState,
    pub vault_id: String,
    pub kdf: VaultKdf,
    pub salt: String,
    pub cipher: String,
    pub wrapped_key: String,
}

/// Migration phase recorded in the marker.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultState {
    Migrating,
    Ready,
}

/// Inspect a folder without requiring the password.
pub fn inspect(root: &Path) -> Result<VaultInspection, String> {
    let workspace = workspace::workspace_from_root(root)?;
    let metadata = read_metadata(&workspace.root)?;
    let scan = workspace::scan_workspace(&workspace.root)?;
    let kind = match metadata {
        None => VaultKind::NeedsCreation,
        Some(metadata) => match metadata.state {
            VaultState::Ready => VaultKind::Ready,
            VaultState::Migrating => VaultKind::Migrating,
        },
    };
    Ok(VaultInspection {
        kind,
        name: workspace.name,
        note_count: scan.notes.len(),
    })
}

/// Create a new encrypted library from a folder of plaintext notes.
///
/// The marker is written in the `migrating` state before any note is touched,
/// so a crash mid-migration can be resumed by [`unlock`] without re-encrypting
/// already sealed files.
pub fn create(root: &Path, password: &str) -> Result<OpenVault, String> {
    let workspace = workspace::workspace_from_root(root)?;
    let marker = workspace.root.join(MARKER_FILE);
    match fs::symlink_metadata(&marker) {
        Ok(_) => {
            return Err("This folder is already an encrypted library.".to_string());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not inspect the library folder \"{}\": {error}",
                workspace.root.display()
            ));
        }
    }

    let scan = workspace::scan_workspace(&workspace.root)?;

    let mut salt = [0u8; crypto::SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut vault_id = [0u8; crypto::VAULT_ID_LEN];
    OsRng.fill_bytes(&mut vault_id);
    let key = VaultKey::generate();
    let kdf = crypto::KdfParams::default();

    let kek = crypto::derive_kek(password, &salt, &kdf)
        .map_err(|error| format!("Could not derive the library key: {error}"))?;
    let wrapped = crypto::wrap_dek(&kek, &key, &vault_id)
        .map_err(|error| format!("Could not wrap the library key: {error}"))?;
    let session = VaultSession::new(key, vault_id);

    let mut metadata = VaultMetadata {
        format: FORMAT.to_string(),
        version: VERSION,
        state: VaultState::Migrating,
        vault_id: STANDARD.encode(vault_id),
        kdf: VaultKdf::from_params(&kdf),
        salt: STANDARD.encode(salt),
        cipher: CIPHER.to_string(),
        wrapped_key: STANDARD.encode(&wrapped),
    };

    write_metadata(&workspace.root, &metadata)?;
    migrate_notes(&workspace.root, &session, &scan.notes)?;
    metadata.state = VaultState::Ready;
    write_metadata(&workspace.root, &metadata)?;

    let scan = workspace::scan_workspace(&workspace.root)?;
    Ok(OpenVault {
        workspace,
        session: Arc::new(session),
        scan,
    })
}

/// Unlock an existing encrypted library.
///
/// Any plaintext Markdown files added since the last open are sealed before the
/// library is returned. A marker left in `migrating` state by an interrupted
/// creation is finished and promoted to `ready`.
pub fn unlock(root: &Path, password: &str) -> Result<OpenVault, String> {
    let workspace = workspace::workspace_from_root(root)?;
    let Some(mut metadata) = read_metadata(&workspace.root)? else {
        return Err("This folder is not an encrypted library.".to_string());
    };

    let salt = decode_base64("salt", &metadata.salt).map_err(|_| UNLOCK_FAILURE.to_string())?;
    let vault_id_bytes =
        decode_base64("vaultId", &metadata.vault_id).map_err(|_| UNLOCK_FAILURE.to_string())?;
    let wrapped = decode_base64("wrappedKey", &metadata.wrapped_key)
        .map_err(|_| UNLOCK_FAILURE.to_string())?;
    let vault_id: [u8; crypto::VAULT_ID_LEN] = vault_id_bytes
        .try_into()
        .map_err(|_| UNLOCK_FAILURE.to_string())?;

    let kdf = metadata.kdf.to_params();
    let kek = crypto::derive_kek(password, &salt, &kdf).map_err(|_| UNLOCK_FAILURE.to_string())?;
    let key =
        crypto::unwrap_dek(&kek, &wrapped, &vault_id).map_err(|_| UNLOCK_FAILURE.to_string())?;
    let session = VaultSession::new(key, vault_id);

    let scan = workspace::scan_workspace(&workspace.root)?;
    migrate_notes(&workspace.root, &session, &scan.notes)?;
    if metadata.state == VaultState::Migrating {
        metadata.state = VaultState::Ready;
        write_metadata(&workspace.root, &metadata)?;
    }

    let scan = workspace::scan_workspace(&workspace.root)?;
    Ok(OpenVault {
        workspace,
        session: Arc::new(session),
        scan,
    })
}

/// Seal any plaintext Markdown files that appeared since the last scan.
pub fn ensure_encrypted(root: &Path, session: &VaultSession) -> Result<(), String> {
    let scan = workspace::scan_workspace(root)?;
    migrate_notes(root, session, &scan.notes)
}

/// Read and validate the marker, or return `None` when there is none.
fn read_metadata(root: &Path) -> Result<Option<VaultMetadata>, String> {
    let marker = root.join(MARKER_FILE);
    let bytes = match fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!("Could not read the library marker: {error}"));
        }
    };
    let metadata: VaultMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The library marker is corrupt: {error}"))?;
    validate_metadata(&metadata)?;
    Ok(Some(metadata))
}

/// Reject markers with an unknown format, version, cipher, or invalid fields.
fn validate_metadata(metadata: &VaultMetadata) -> Result<(), String> {
    if metadata.format != FORMAT {
        return Err("The library marker has an unknown format.".to_string());
    }
    if metadata.version != VERSION {
        return Err(format!(
            "The library marker uses unsupported version {}.",
            metadata.version
        ));
    }
    if metadata.cipher != CIPHER {
        return Err("The library marker uses an unsupported cipher.".to_string());
    }
    if metadata.kdf.algorithm != KDF_ALGORITHM {
        return Err("The library marker uses an unsupported KDF algorithm.".to_string());
    }
    metadata.kdf.to_params().validate()?;

    let salt = decode_base64("salt", &metadata.salt)?;
    if salt.len() != crypto::SALT_LEN {
        return Err("The library marker has an invalid salt.".to_string());
    }
    let vault_id = decode_base64("vaultId", &metadata.vault_id)?;
    if vault_id.len() != crypto::VAULT_ID_LEN {
        return Err("The library marker has an invalid vault identifier.".to_string());
    }
    let wrapped_key = decode_base64("wrappedKey", &metadata.wrapped_key)?;
    if wrapped_key.len() != WRAPPED_KEY_LEN {
        return Err("The library marker has an invalid wrapped key.".to_string());
    }
    Ok(())
}

/// Atomically write the marker with private permissions.
fn write_metadata(root: &Path, metadata: &VaultMetadata) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| format!("Could not serialize the library marker: {error}"))?;
    let marker = root.join(MARKER_FILE);
    let permissions = marker_permissions(root, &marker)?;
    notes::replace_file_atomically(&marker, &bytes, permissions)
        .map(|_| ())
        .map_err(|error| format!("Could not write the library marker: {error}"))
}

/// Marker permissions: private on Unix, inherited from the existing marker or
/// the library folder elsewhere.
fn marker_permissions(root: &Path, marker: &Path) -> Result<fs::Permissions, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = (root, marker);
        Ok(fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        let metadata = fs::metadata(marker)
            .or_else(|_| fs::metadata(root))
            .map_err(|error| format!("Could not read library permissions: {error}"))?;
        Ok(metadata.permissions())
    }
}

/// Decode one base64 marker field.
fn decode_base64(field: &str, value: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(value)
        .map_err(|_| format!("The library marker has an invalid {field}."))
}

/// Seal every plaintext file in `entries`, skipping files that already start
/// with the vault magic.
fn migrate_notes(root: &Path, session: &VaultSession, entries: &[NoteEntry]) -> Result<(), String> {
    for entry in entries {
        let note = security::resolve_note(root, &entry.path)?;
        if has_vault_magic(&note.absolute, &entry.path)? {
            continue;
        }

        let bytes = fs::read(&note.absolute)
            .map_err(|error| format!("Could not read note \"{}\": {error}", entry.path))?;
        let permissions = fs::metadata(&note.absolute)
            .map_err(|error| format!("Could not inspect note \"{}\": {error}", entry.path))?
            .permissions();
        // Seal before touching disk: the atomic writer only ever sees
        // ciphertext, never the plaintext temp file the old format would leak.
        let sealed = crypto::seal(&session.key, &session.vault_id, &bytes)?;
        notes::replace_file_atomically(&note.absolute, &sealed, permissions)?;
    }
    Ok(())
}

/// Check just the first bytes of a file to avoid reading whole sealed notes.
fn has_vault_magic(path: &Path, relative: &str) -> Result<bool, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not read note \"{relative}\": {error}"))?;
    let mut prefix = Vec::with_capacity(crypto::MAGIC.len());
    file.take(crypto::MAGIC.len() as u64)
        .read_to_end(&mut prefix)
        .map_err(|error| format!("Could not read note \"{relative}\": {error}"))?;
    Ok(prefix.starts_with(crypto::MAGIC.as_slice()))
}

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
        assert_eq!(
            crate::notes::read_note(dir.path(), "a.md", &opened.session)
                .unwrap()
                .content,
            "alpha-secret"
        );
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
        assert_eq!(
            crate::notes::read_note(dir.path(), "a.md", &opened.session)
                .unwrap()
                .content,
            "alpha"
        );
    }

    #[test]
    fn unlock_encrypts_plaintext_files_added_later() {
        let dir = TestDir::new("vault-late-plaintext");
        dir.write("a.md", "alpha");
        create(dir.path(), "pw").unwrap();
        dir.write("late.md", "later-secret");
        let opened = unlock(dir.path(), "pw").unwrap();
        assert!(crypto::is_sealed(
            &fs::read(dir.path().join("late.md")).unwrap()
        ));
        assert_eq!(
            crate::notes::read_note(dir.path(), "late.md", &opened.session)
                .unwrap()
                .content,
            "later-secret"
        );
    }

    #[test]
    fn resumes_a_migrating_vault_without_double_encryption() {
        let dir = TestDir::new("vault-resume");
        dir.write("a.md", "first");
        let _opened = create(dir.path(), "pw").unwrap();
        let original = fs::read(dir.path().join("a.md")).unwrap();

        let marker = dir.path().join(MARKER_FILE);
        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        json["state"] = serde_json::json!("migrating");
        fs::write(&marker, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        dir.write("late.md", "second");

        let resumed = unlock(dir.path(), "pw").unwrap();
        assert_eq!(resumed.scan.notes.len(), 2);
        assert_eq!(
            fs::read(dir.path().join("a.md")).unwrap(),
            original,
            "already encrypted file was rewritten"
        );
        assert!(crypto::is_sealed(
            &fs::read(dir.path().join("late.md")).unwrap()
        ));
        assert_eq!(inspect(dir.path()).unwrap().kind, VaultKind::Ready);
        assert_eq!(
            crate::notes::read_note(dir.path(), "late.md", &resumed.session)
                .unwrap()
                .content,
            "second"
        );
    }

    #[test]
    fn rejects_unknown_versions_and_corrupt_markers() {
        let dir = TestDir::new("vault-version");
        dir.write("a.md", "alpha");
        create(dir.path(), "pw").unwrap();
        let marker = dir.path().join(MARKER_FILE);

        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        json["version"] = serde_json::json!(2);
        fs::write(&marker, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        assert!(inspect(dir.path()).is_err());
        assert!(unlock(dir.path(), "pw").is_err());

        fs::write(&marker, b"{not json").unwrap();
        assert!(inspect(dir.path()).is_err());
    }

    #[test]
    fn rejects_an_unknown_kdf_algorithm() {
        let dir = TestDir::new("vault-kdf-algorithm");
        dir.write("a.md", "alpha");
        create(dir.path(), "pw").unwrap();
        let marker = dir.path().join(MARKER_FILE);

        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        json["kdf"]["algorithm"] = serde_json::json!("scrypt");
        fs::write(&marker, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        assert!(inspect(dir.path()).is_err());
        assert!(unlock(dir.path(), "pw").is_err());
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
        assert!(
            scan.folders
                .iter()
                .all(|folder| folder != ".mojian-vault.json")
        );
    }

    #[test]
    fn marker_uses_the_fixed_format_fields_and_private_permissions() {
        let dir = TestDir::new("vault-marker-format");
        dir.write("a.md", "alpha");
        create(dir.path(), "pw").unwrap();

        let marker = dir.path().join(MARKER_FILE);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(json["format"], serde_json::json!(FORMAT));
        assert_eq!(json["version"].as_u64(), Some(u64::from(VERSION)));
        assert_eq!(json["state"], serde_json::json!("ready"));
        assert_eq!(json["cipher"], serde_json::json!("xchacha20poly1305"));
        assert_eq!(json["kdf"]["algorithm"], serde_json::json!("argon2id"));
        assert_eq!(json["kdf"]["memoryKiB"].as_u64(), Some(65_536));
        assert_eq!(json["kdf"]["iterations"].as_u64(), Some(3));
        assert_eq!(json["kdf"]["parallelism"].as_u64(), Some(1));
        assert!(json["kdf"].get("memoryKib").is_none());
        assert!(json.get("vaultId").is_some());
        assert!(json.get("wrappedKey").is_some());
        assert!(json.get("salt").is_some());

        let decoded_len = |field: &str| {
            STANDARD
                .decode(json[field].as_str().unwrap())
                .unwrap()
                .len()
        };
        assert_eq!(decoded_len("salt"), crypto::SALT_LEN);
        assert_eq!(decoded_len("vaultId"), crypto::VAULT_ID_LEN);
        assert_eq!(decoded_len("wrappedKey"), WRAPPED_KEY_LEN);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
