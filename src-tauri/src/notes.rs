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

/// Create one new empty Markdown file below `raw_parent`.
///
/// `raw_parent` is a workspace-relative folder path (`""` is the root) and
/// `raw_name` is a complete Markdown file name. `create_new` guarantees the
/// target is never overwritten. Returns the new relative path.
pub fn create_note(root: &Path, raw_parent: &str, raw_name: &str) -> Result<String, String> {
    security::validate_note_file_name(raw_name)?;
    let parent = security::resolve_parent_dir(root, raw_parent)?;
    let target = parent.absolute.join(raw_name);
    let relative = security::join_relative(&parent.relative, raw_name);
    security::ensure_vacant(&target, raw_name, &parent.relative)?;

    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!(
                    "\"{raw_name}\" already exists in {}.",
                    security::describe_folder(&parent.relative)
                )
            } else {
                format!("Could not create note \"{relative}\": {error}")
            }
        })?;
    drop(file);

    Ok(relative)
}

/// Rename one existing Markdown file within its current folder.
///
/// `new_name` must be a complete Markdown file name without path separators.
/// The target must not exist and must stay in the same canonical directory, so
/// content is never overwritten and folders are never moved.
pub fn rename_note(root: &Path, raw_path: &str, raw_new_name: &str) -> Result<String, String> {
    security::validate_note_file_name(raw_new_name)?;
    let note = security::resolve_note(root, raw_path)?;
    let parent_relative = relative_parent(&note.relative);
    let parent = security::resolve_parent_dir(root, &parent_relative)?;
    let source_parent = note
        .absolute
        .parent()
        .ok_or_else(|| format!("Note \"{}\" does not have a parent folder.", note.relative))?;

    if parent.absolute != source_parent {
        return Err(format!(
            "Note \"{}\" cannot be renamed: its folder resolves through a symbolic link.",
            note.relative
        ));
    }

    let target = source_parent.join(raw_new_name);
    if !target.starts_with(&parent.absolute) {
        return Err(format!(
            "Access denied for note \"{}\": the new path resolves outside the workspace.",
            note.relative
        ));
    }
    security::ensure_vacant(&target, raw_new_name, &parent_relative)?;

    fs::rename(&note.absolute, &target).map_err(|error| {
        format!(
            "Could not rename note \"{}\" to \"{raw_new_name}\": {error}",
            note.relative
        )
    })?;

    Ok(security::join_relative(&parent_relative, raw_new_name))
}

/// Delete one existing Markdown file. Only that file is removed; folders and
/// other entries are never touched.
pub fn delete_note(root: &Path, raw_path: &str) -> Result<(), String> {
    let note = security::resolve_note(root, raw_path)?;
    fs::remove_file(&note.absolute)
        .map_err(|error| format!("Could not delete note \"{}\": {error}", note.relative))?;
    Ok(())
}

fn relative_parent(relative: &str) -> String {
    relative
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
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

    #[test]
    fn creates_an_empty_note_and_rejects_duplicates_and_bad_requests() {
        let workspace = TestDir::new("create-note");
        workspace.write("notes/existing.md", "existing");
        let root = workspace.path();

        let relative = create_note(root, "notes", "fresh.markdown").unwrap();
        assert_eq!(relative, "notes/fresh.markdown");
        let created = root.join("notes/fresh.markdown");
        assert!(created.is_file());
        assert_eq!(fs::metadata(&created).unwrap().len(), 0);

        assert_eq!(create_note(root, "", "root.md").unwrap(), "root.md");
        assert_eq!(fs::metadata(root.join("root.md")).unwrap().len(), 0);
        assert_eq!(create_note(root, "", "UPPER.MD").unwrap(), "UPPER.MD");

        // Neither an existing note nor an existing folder is overwritten.
        assert!(create_note(root, "notes", "existing.md").is_err());
        assert!(create_note(root, "notes", "fresh.markdown").is_err());
        fs::create_dir_all(root.join("directory.md")).unwrap();
        assert!(create_note(root, "", "directory.md").is_err());
        assert!(root.join("directory.md").is_dir());

        // Parent must exist and must not traverse or be absolute.
        for parent in [
            "missing",
            "..",
            "../outside",
            "notes/../../outside",
            "notes//nested",
            "notes/..",
            "notes/.",
            ".hidden",
            "/tmp",
            "C:/notes",
            "notes\\nested",
        ] {
            assert!(
                create_note(root, parent, "new.md").is_err(),
                "expected invalid parent {parent:?}"
            );
        }

        // Names must be one visible segment with a Markdown extension.
        for name in [
            "",
            ".",
            "..",
            ".hidden.md",
            "no-extension",
            "note.txt",
            "note.MDX",
            "note.md.bak",
            "a/b.md",
            "a\\b.md",
            "note.md.",
            "note.md ",
            "CON.md",
            "nul.md",
            "COM1.md",
            "LPT9.markdown",
            "note\0.md",
        ] {
            assert!(
                create_note(root, "", name).is_err(),
                "expected invalid name {name:?}"
            );
        }

        // An absolute path supplied as the name is rejected too.
        let absolute_name = root.join("absolute.md").to_string_lossy().into_owned();
        assert!(create_note(root, "", &absolute_name).is_err());
        assert!(!root.join("absolute.md").exists());
    }

    #[test]
    fn creates_notes_only_inside_the_active_workspace() {
        let workspace = TestDir::new("create-note-safety");
        workspace.write("safe.md", "# Safe");
        let outside = TestDir::new("create-note-safety-outside");

        let absolute_parent = outside.path().to_string_lossy().into_owned();
        let escaped = outside.path().join("created.md");
        assert!(create_note(workspace.path(), &absolute_parent, "created.md").is_err());
        assert!(!escaped.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(outside.path(), workspace.path().join("escape-folder")).unwrap();
            assert!(create_note(workspace.path(), "escape-folder", "created.md").is_err());
            assert!(!escaped.exists());
        }
    }

    #[test]
    fn renames_a_note_in_place_and_rejects_unsafe_targets() {
        let workspace = TestDir::new("rename");
        workspace.write("notes/old.md", "# Original");
        workspace.write("notes/taken.md", "# Taken");
        workspace.write("other/elsewhere.md", "# Elsewhere");
        let root = workspace.path();

        let relative = rename_note(root, "notes/old.md", "new.markdown").unwrap();
        assert_eq!(relative, "notes/new.markdown");
        assert!(!root.join("notes/old.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("notes/new.markdown")).unwrap(),
            "# Original"
        );

        // The supplied extension is preserved, including its case.
        assert_eq!(
            rename_note(root, "notes/new.markdown", "renamed.MD").unwrap(),
            "notes/renamed.MD"
        );
        assert_eq!(
            fs::read_to_string(root.join("notes/renamed.MD")).unwrap(),
            "# Original"
        );

        // The target must not already exist.
        assert!(rename_note(root, "notes/renamed.MD", "taken.md").is_err());
        assert_eq!(
            fs::read_to_string(root.join("notes/taken.md")).unwrap(),
            "# Taken"
        );
        assert_eq!(
            fs::read_to_string(root.join("notes/renamed.MD")).unwrap(),
            "# Original"
        );

        // The new name must be a single valid Markdown file name.
        for new_name in [
            "",
            ".",
            "..",
            ".hidden.md",
            "../moved.md",
            "nested/moved.md",
            "nested\\moved.md",
            "moved.txt",
            "moved",
            "CON.md",
            "moved.md.",
        ] {
            assert!(
                rename_note(root, "notes/renamed.MD", new_name).is_err(),
                "expected invalid new name {new_name:?}"
            );
        }

        // Sources outside the workspace or that do not exist are rejected.
        let outside = TestDir::new("rename-outside");
        let secret = outside.write("secret.md", "secret");
        let absolute_secret = secret.to_string_lossy().into_owned();
        for raw in [
            "../secret.md",
            "notes/../../secret.md",
            "missing.md",
            absolute_secret.as_str(),
        ] {
            assert!(rename_note(root, raw, "stolen.md").is_err());
        }
        assert_eq!(fs::read_to_string(&secret).unwrap(), "secret");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let escape = root.join("escape.md");
            symlink(&secret, &escape).unwrap();
            assert!(rename_note(root, "escape.md", "stolen.md").is_err());
            assert!(escape.exists());
            assert_eq!(fs::read_to_string(&secret).unwrap(), "secret");
        }
    }

    #[test]
    fn rename_keeps_the_note_in_its_original_folder() {
        let workspace = TestDir::new("rename-same-folder");
        workspace.write("a/note.md", "# A");
        workspace.write("b/keep.md", "# B");

        let relative = rename_note(workspace.path(), "a/note.md", "renamed.md").unwrap();
        assert_eq!(relative, "a/renamed.md");
        assert!(workspace.path().join("a/renamed.md").is_file());
        assert!(!workspace.path().join("b/renamed.md").exists());
    }

    #[test]
    fn deletes_only_the_requested_note() {
        let workspace = TestDir::new("delete");
        workspace.write("notes/target.md", "target");
        workspace.write("notes/keep.md", "keep");
        workspace.write("other.md", "other");
        workspace.write("not-a-note.txt", "text");
        fs::create_dir_all(workspace.path().join("folder.md")).unwrap();
        let root = workspace.path();

        delete_note(root, "notes/target.md").unwrap();
        assert!(!root.join("notes/target.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("notes/keep.md")).unwrap(),
            "keep"
        );
        assert_eq!(fs::read_to_string(root.join("other.md")).unwrap(), "other");
        assert_eq!(
            fs::read_to_string(root.join("not-a-note.txt")).unwrap(),
            "text"
        );
        assert!(root.join("notes").is_dir());
        assert!(root.join("folder.md").is_dir());

        // Missing, non-Markdown, folder, traversal, and absolute paths fail.
        assert!(delete_note(root, "notes/target.md").is_err());
        assert!(delete_note(root, "notes/keep.txt").is_err());
        assert!(delete_note(root, "folder.md").is_err());
        assert!(root.join("notes/keep.md").exists());

        let outside = TestDir::new("delete-outside");
        let secret = outside.write("secret.md", "secret");
        let absolute_secret = secret.to_string_lossy().into_owned();
        for raw in [
            "../secret.md",
            "notes/../../secret.md",
            absolute_secret.as_str(),
        ] {
            assert!(delete_note(root, raw).is_err());
        }
        assert_eq!(fs::read_to_string(&secret).unwrap(), "secret");

        let documents = fs::read_dir(root).unwrap().count();
        assert_eq!(documents, 4, "only the requested note was removed");
    }
}
