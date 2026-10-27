//! Reading and atomically saving individual Markdown notes.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::security;
use crate::workspace::modified_ms;

/// Full contents of a note, read only when explicitly requested.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
    /// Workspace-relative path using forward slashes.
    pub path: String,
    pub content: String,
    /// Last modification time as epoch milliseconds.
    pub modified: u64,
}

/// Result of writing a note.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    /// Last modification time as epoch milliseconds.
    pub modified: u64,
    /// Size of the saved file in bytes.
    pub size: u64,
}

/// Read one existing Markdown file inside the active workspace.
pub fn read_note(root: &Path, raw_path: &str) -> Result<NoteDocument, String> {
    let note = security::resolve_note(root, raw_path)?;
    let bytes = fs::read(&note.absolute)
        .map_err(|error| format!("Could not read note \"{}\": {error}", note.relative))?;
    let content = String::from_utf8(bytes).map_err(|_| {
        format!(
            "Note \"{}\" is not valid UTF-8 text and cannot be displayed.",
            note.relative
        )
    })?;
    let modified = fs::metadata(&note.absolute)
        .map(|metadata| modified_ms(&metadata))
        .unwrap_or(0);
    Ok(NoteDocument {
        path: note.relative,
        content,
        modified,
    })
}

/// Save one existing Markdown file inside the active workspace.
///
/// The content is written to a hidden temporary file in the note's directory,
/// given the original file permissions, flushed to disk, and then renamed over
/// the target so readers never observe a partially written note.
pub fn save_note(root: &Path, raw_path: &str, content: &str) -> Result<SavedNote, String> {
    let note = security::resolve_note(root, raw_path)?;
    let metadata = fs::metadata(&note.absolute)
        .map_err(|error| format!("Could not inspect note \"{}\": {error}", note.relative))?;
    let parent = note
        .absolute
        .parent()
        .ok_or_else(|| format!("Note \"{}\" does not have a parent folder.", note.relative))?;
    let temp_path = unique_temp_path(parent);
    let permissions = metadata.permissions();

    match write_file_atomically(&temp_path, &note.absolute, content.as_bytes(), permissions) {
        Ok(metadata) => Ok(SavedNote {
            modified: modified_ms(&metadata),
            size: metadata.len(),
        }),
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

fn write_file_atomically(
    temp_path: &Path,
    target: &Path,
    bytes: &[u8],
    permissions: fs::Permissions,
) -> Result<fs::Metadata, String> {
    let display = target.display();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)
        .map_err(|error| {
            format!("Could not prepare a temporary file for note \"{display}\": {error}")
        })?;

    let write_result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.flush()?;
        file.set_permissions(permissions)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        drop(file);
        let _ = fs::remove_file(temp_path);
        return Err(format!("Could not write note \"{display}\": {error}"));
    }
    drop(file);

    fs::rename(temp_path, target)
        .map_err(|error| format!("Could not replace note \"{display}\" atomically: {error}"))?;

    fs::metadata(target)
        .map_err(|error| format!("Note \"{display}\" was saved but could not be verified: {error}"))
}

/// A unique hidden name in the note's own directory. It starts with a dot so a
/// leftover file after a crash is ignored by workspace scans.
fn unique_temp_path(parent: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".markdown-edit-tmp-{}-{nonce}-{sequence}",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDir;

    #[test]
    fn reads_and_saves_a_note_roundtrip() {
        let workspace = TestDir::new("roundtrip");
        workspace.write("notes/launch.md", "# Launch\n");

        let document = read_note(workspace.path(), "notes/launch.md").unwrap();
        assert_eq!(document.path, "notes/launch.md");
        assert_eq!(document.content, "# Launch\n");
        assert!(document.modified > 0);

        let updated = "# Launch\n\nUpdated body.\n";
        let saved = save_note(workspace.path(), "notes/launch.md", updated).unwrap();
        assert_eq!(saved.size, updated.len() as u64);
        assert!(saved.modified > 0);

        let document = read_note(workspace.path(), "notes/launch.md").unwrap();
        assert_eq!(document.path, "notes/launch.md");
        assert_eq!(document.content, updated);

        // Atomic save leaves no temporary file behind.
        let entries = fs::read_dir(workspace.path().join("notes"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_name(), "launch.md");
    }

    #[test]
    fn refuses_missing_and_non_markdown_notes() {
        let workspace = TestDir::new("missing");
        workspace.write("note.md", "# Note");
        workspace.write("note.txt", "text");

        assert!(read_note(workspace.path(), "missing.md").is_err());
        assert!(read_note(workspace.path(), "note.txt").is_err());
        assert!(save_note(workspace.path(), "missing.md", "new").is_err());
        assert!(save_note(workspace.path(), "note.txt", "new").is_err());
    }

    #[test]
    fn refuses_to_save_outside_the_workspace() {
        let workspace = TestDir::new("outside-save");
        workspace.write("safe.md", "# Safe");
        let outside = TestDir::new("outside-save-target");
        let secret = outside.write("secret.md", "original");
        let absolute_secret = secret.to_string_lossy().into_owned();

        for raw in [
            "../secret.md",
            "notes/../../secret.md",
            absolute_secret.as_str(),
        ] {
            assert!(save_note(workspace.path(), raw, "hacked").is_err());
        }
        assert_eq!(fs::read_to_string(&secret).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_read_or_save_through_symlinks_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = TestDir::new("outside-symlink");
        workspace.write("safe.md", "# Safe");
        let outside = TestDir::new("outside-symlink-target");
        let secret = outside.write("secret.md", "original");
        symlink(&secret, workspace.path().join("escape.md")).unwrap();

        assert!(read_note(workspace.path(), "escape.md").is_err());
        assert!(save_note(workspace.path(), "escape.md", "hacked").is_err());
        assert_eq!(fs::read_to_string(&secret).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn save_preserves_unix_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let workspace = TestDir::new("permissions");
        let note = workspace.write("permissions.md", "# Old\n");
        fs::set_permissions(&note, fs::Permissions::from_mode(0o640)).unwrap();

        save_note(workspace.path(), "permissions.md", "# New\n").unwrap();

        let mode = fs::metadata(&note).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[test]
    fn rejects_invalid_utf8_content_with_a_readable_error() {
        let workspace = TestDir::new("invalid-utf8");
        fs::write(workspace.path().join("binary.md"), [0xff, 0xfe, 0x00]).unwrap();

        let error = read_note(workspace.path(), "binary.md").unwrap_err();
        assert!(error.contains("UTF-8"), "{error}");
    }
}
