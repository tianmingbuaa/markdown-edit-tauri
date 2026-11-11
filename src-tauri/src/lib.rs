//! Tauri backend for the Markdown note editor.
//!
//! The frontend owns the folder picker (the dialog plugin) and sends the chosen
//! absolute folder path to `inspect_workspace`, `create_vault`, or `open_vault`.
//! This module keeps the active encrypted library (its workspace and unlocked
//! session) in managed state and exposes commands for scanning, reading, and
//! saving notes. All path validation lives in [`security`].

mod crypto;
mod notes;
mod security;
mod vault;
mod workspace;

#[cfg(test)]
mod test_support;

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::State;
use zeroize::Zeroizing;

use crate::crypto::VaultSession;
use crate::vault::OpenVault;
use notes::{NoteDocument, SavedNote};
use workspace::{Workspace, WorkspaceInfo};

/// A workspace together with the session that can decrypt its notes.
///
/// The workspace and its key are always stored as one unit so a command can
/// never observe a workspace without the session that belongs to it.
pub struct ActiveVault {
    pub workspace: Workspace,
    pub session: Arc<VaultSession>,
}

/// Managed application state. The active vault is stored behind a mutex so
/// every command sees a consistent snapshot.
#[derive(Default)]
pub struct AppState {
    active: Mutex<Option<ActiveVault>>,
}

impl AppState {
    /// Snapshot the active workspace and session, or fail when no vault is open.
    fn require(&self) -> Result<(Workspace, Arc<VaultSession>), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Internal error: the vault state is unavailable.".to_string())?;
        match active.as_ref() {
            Some(active) => Ok((active.workspace.clone(), Arc::clone(&active.session))),
            None => Err("No encrypted library is open. Choose a vault first.".to_string()),
        }
    }

    /// Replace the active vault, keeping the workspace and session in sync.
    fn set(&self, workspace: Workspace, session: Arc<VaultSession>) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Internal error: the vault state is unavailable.".to_string())?;
        *active = Some(ActiveVault { workspace, session });
        Ok(())
    }
}

/// Inspect a folder without opening it or requiring its password.
#[tauri::command]
async fn inspect_workspace(path: String) -> Result<vault::VaultInspection, String> {
    tauri::async_runtime::spawn_blocking(move || vault::inspect(Path::new(&path)))
        .await
        .map_err(|error| format!("Vault inspection failed: {error}"))?
}

/// Create a new encrypted library from the chosen folder and activate it.
#[tauri::command]
async fn create_vault(
    path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    let password = Zeroizing::new(password);
    let opened = tauri::async_runtime::spawn_blocking(move || {
        vault::create(Path::new(&path), password.as_str())
    })
    .await
    .map_err(|error| format!("Creating the vault failed: {error}"))??;

    activate(opened, &state)
}

/// Unlock an existing encrypted library and activate it.
#[tauri::command]
async fn open_vault(
    path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    let password = Zeroizing::new(password);
    let opened = tauri::async_runtime::spawn_blocking(move || {
        vault::unlock(Path::new(&path), password.as_str())
    })
    .await
    .map_err(|error| format!("Opening the vault failed: {error}"))??;

    activate(opened, &state)
}

/// Build the response before committing the new vault to managed state.
fn activate(opened: OpenVault, state: &AppState) -> Result<WorkspaceInfo, String> {
    let OpenVault {
        workspace,
        session,
        scan,
    } = opened;
    let info = workspace.info(scan);
    state.set(workspace, session)?;
    Ok(info)
}

/// Rescan the currently active vault, sealing any plaintext notes first.
#[tauri::command]
async fn rescan_workspace(state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    let (workspace, session) = state.require()?;
    let root = workspace.root.clone();
    let scan = tauri::async_runtime::spawn_blocking(move || {
        vault::ensure_encrypted(&root, &session)?;
        workspace::scan_workspace(&root)
    })
    .await
    .map_err(|error| format!("Workspace scan failed: {error}"))??;
    Ok(workspace.info(scan))
}

/// Create one new folder below a workspace-relative parent folder.
#[tauri::command]
async fn create_folder(
    parent: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = state.require()?.0.root;
    tauri::async_runtime::spawn_blocking(move || workspace::create_folder(&root, &parent, &name))
        .await
        .map_err(|error| format!("Creating the folder failed: {error}"))?
}

/// Create one new empty Markdown note below a workspace-relative parent folder.
#[tauri::command]
async fn create_note(
    parent: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (workspace, session) = state.require()?;
    let root = workspace.root;
    tauri::async_runtime::spawn_blocking(move || {
        notes::create_note(&root, &parent, &name, &session)
    })
    .await
    .map_err(|error| format!("Creating the note failed: {error}"))?
}

/// Rename one existing note within its current folder.
#[tauri::command]
async fn rename_note(
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = state.require()?.0.root;
    tauri::async_runtime::spawn_blocking(move || notes::rename_note(&root, &path, &new_name))
        .await
        .map_err(|error| format!("Renaming the note failed: {error}"))?
}

/// Delete one existing note. Folders are never deleted.
#[tauri::command]
async fn delete_note(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = state.require()?.0.root;
    tauri::async_runtime::spawn_blocking(move || notes::delete_note(&root, &path))
        .await
        .map_err(|error| format!("Deleting the note failed: {error}"))?
}

/// Read one note on demand by its workspace-relative path.
#[tauri::command]
async fn read_note(path: String, state: State<'_, AppState>) -> Result<NoteDocument, String> {
    let (workspace, session) = state.require()?;
    let root = workspace.root;
    tauri::async_runtime::spawn_blocking(move || notes::read_note(&root, &path, &session))
        .await
        .map_err(|error| format!("Reading the note failed: {error}"))?
}

/// Save one existing note by its workspace-relative path.
#[tauri::command]
async fn save_note(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<SavedNote, String> {
    let (workspace, session) = state.require()?;
    let root = workspace.root;
    tauri::async_runtime::spawn_blocking(move || notes::save_note(&root, &path, &content, &session))
        .await
        .map_err(|error| format!("Saving the note failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            inspect_workspace,
            create_vault,
            open_vault,
            rescan_workspace,
            read_note,
            save_note,
            create_folder,
            create_note,
            rename_note,
            delete_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{VaultKey, VaultSession};
    use std::fs;
    use std::sync::Arc;

    #[test]
    fn commands_require_an_active_workspace() {
        let state = AppState::default();
        let error = state
            .require()
            .err()
            .expect("requiring a vault without one must fail");
        assert!(error.contains("No encrypted library"), "{error}");
    }

    #[test]
    fn active_vault_is_kept_in_managed_state() {
        let state = AppState::default();
        let session = Arc::new(VaultSession::new(
            VaultKey::from_bytes([7u8; 32]),
            [9u8; 16],
        ));
        state
            .set(
                Workspace {
                    root: Path::new("/tmp/example-vault").to_path_buf(),
                    name: "example-vault".to_string(),
                },
                session,
            )
            .unwrap();

        let (workspace, _session) = state.require().unwrap();
        assert_eq!(workspace.name, "example-vault");
        assert_eq!(workspace.root, Path::new("/tmp/example-vault"));
    }

    #[test]
    fn failed_unlock_keeps_the_existing_active_vault() {
        use crate::test_support::TestDir;

        let old = TestDir::new("state-old");
        let session = Arc::new(VaultSession::new(
            VaultKey::from_bytes([7u8; 32]),
            [9u8; 16],
        ));
        let state = AppState::default();
        state
            .set(
                Workspace {
                    root: fs::canonicalize(old.path()).unwrap(),
                    name: "old".into(),
                },
                session,
            )
            .unwrap();

        let new = TestDir::new("state-new");
        new.write("a.md", "alpha");
        crate::vault::create(new.path(), "right").unwrap();
        assert!(crate::vault::unlock(new.path(), "wrong").is_err());

        let (workspace, _session) = state.require().unwrap();
        assert_eq!(workspace.name, "old");
    }
}
