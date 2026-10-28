//! Tauri backend for the Markdown note editor.
//!
//! The frontend owns the folder picker (the dialog plugin) and sends the chosen
//! absolute folder path to `open_workspace`. This module keeps the active
//! workspace in managed state and exposes commands for scanning, reading, and
//! saving notes. All path validation lives in [`security`].

mod notes;
mod security;
mod workspace;

#[cfg(test)]
mod test_support;

use std::path::Path;
use std::sync::Mutex;

use tauri::State;

use notes::{NoteDocument, SavedNote};
use workspace::{Workspace, WorkspaceInfo};

/// Managed application state. The active workspace is stored behind a mutex so
/// every command sees a consistent snapshot.
#[derive(Default)]
pub struct AppState {
    workspace: Mutex<Option<Workspace>>,
}

impl AppState {
    fn current(&self) -> Result<Option<Workspace>, String> {
        self.workspace
            .lock()
            .map(|workspace| workspace.clone())
            .map_err(|_| "Internal error: the workspace state is unavailable.".to_string())
    }

    fn require(&self) -> Result<Workspace, String> {
        self.current()?
            .ok_or_else(|| "No workspace is open. Choose a folder first.".to_string())
    }

    fn set(&self, workspace: Workspace) -> Result<(), String> {
        let mut active = self
            .workspace
            .lock()
            .map_err(|_| "Internal error: the workspace state is unavailable.".to_string())?;
        *active = Some(workspace);
        Ok(())
    }
}

/// Validate, canonicalize, scan, and activate a workspace folder.
#[tauri::command]
async fn open_workspace(path: String, state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    let (workspace, scan) = tauri::async_runtime::spawn_blocking(move || {
        workspace::open_workspace_folder(Path::new(&path))
    })
    .await
    .map_err(|error| format!("Workspace scan failed: {error}"))??;

    let info = workspace.info(scan);
    state.set(workspace)?;
    Ok(info)
}

/// Rescan the currently active workspace.
#[tauri::command]
async fn rescan_workspace(state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    let workspace = state.require()?;
    let root = workspace.root.clone();
    let scan = tauri::async_runtime::spawn_blocking(move || workspace::scan_workspace(&root))
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
    let root = state.require()?.root;
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
    let root = state.require()?.root;
    tauri::async_runtime::spawn_blocking(move || notes::create_note(&root, &parent, &name))
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
    let root = state.require()?.root;
    tauri::async_runtime::spawn_blocking(move || notes::rename_note(&root, &path, &new_name))
        .await
        .map_err(|error| format!("Renaming the note failed: {error}"))?
}

/// Delete one existing note. Folders are never deleted.
#[tauri::command]
async fn delete_note(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = state.require()?.root;
    tauri::async_runtime::spawn_blocking(move || notes::delete_note(&root, &path))
        .await
        .map_err(|error| format!("Deleting the note failed: {error}"))?
}

/// Read one note on demand by its workspace-relative path.
#[tauri::command]
async fn read_note(path: String, state: State<'_, AppState>) -> Result<NoteDocument, String> {
    let root = state.require()?.root;
    tauri::async_runtime::spawn_blocking(move || notes::read_note(&root, &path))
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
    let root = state.require()?.root;
    tauri::async_runtime::spawn_blocking(move || notes::save_note(&root, &path, &content))
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
            open_workspace,
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

    #[test]
    fn commands_require_an_active_workspace() {
        let state = AppState::default();
        let error = state.require().unwrap_err();
        assert!(error.contains("No workspace"), "{error}");
    }

    #[test]
    fn active_workspace_is_kept_in_managed_state() {
        let state = AppState::default();
        state
            .set(Workspace {
                root: Path::new("/tmp/example-workspace").to_path_buf(),
                name: "example-workspace".to_string(),
            })
            .unwrap();

        let workspace = state.require().unwrap();
        assert_eq!(workspace.name, "example-workspace");
        assert_eq!(workspace.root, Path::new("/tmp/example-workspace"));
    }
}
