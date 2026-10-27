//! Hard path validation and note resolution for the active workspace.
//!
//! Frontend code only ever supplies workspace-relative, forward-slash paths.
//! Everything in this module treats that input as untrusted.

use std::fs;
use std::path::{Path, PathBuf};

/// Markdown extensions accepted by the app, compared case-insensitively.
pub const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

/// Maximum byte length accepted for a single new file or folder name.
pub const MAX_ENTRY_NAME_BYTES: usize = 255;

/// Windows reserved device names, rejected on every platform so a workspace
/// created on Linux still opens on Windows.
const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Return `true` when `path` has an accepted Markdown extension.
pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

/// Validate an untrusted relative note path and normalize it to forward slashes.
///
/// Rejects empty paths, absolute paths, Windows drive/UNC prefixes, backslash
/// separators, `.`/`..` components, empty segments, and non-Markdown files.
pub fn validate_relative_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("Note path is empty.".to_string());
    }
    if raw.contains('\0') {
        return Err("Note path contains an invalid character.".to_string());
    }
    if raw.contains('\\') {
        return Err(format!(
            "Invalid note path \"{raw}\": backslashes are not allowed; use forward slashes."
        ));
    }
    if raw.starts_with('/') || Path::new(raw).is_absolute() {
        return Err(format!(
            "Invalid note path \"{raw}\": absolute paths are not allowed."
        ));
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(format!(
            "Invalid note path \"{raw}\": Windows drive paths are not allowed."
        ));
    }

    let mut components = Vec::new();
    for component in raw.split('/') {
        if component.is_empty() {
            return Err(format!(
                "Invalid note path \"{raw}\": empty path segments are not allowed."
            ));
        }
        if component == ".." {
            return Err(format!(
                "Invalid note path \"{raw}\": path traversal is not allowed."
            ));
        }
        if component == "." {
            return Err(format!(
                "Invalid note path \"{raw}\": current-directory segments are not allowed."
            ));
        }
        components.push(component);
    }
    if components.is_empty() {
        return Err("Note path is empty.".to_string());
    }

    let normalized = components.join("/");
    if !is_markdown_path(Path::new(&normalized)) {
        return Err(format!(
            "Invalid note path \"{raw}\": only .md and .markdown files are supported."
        ));
    }
    Ok(normalized)
}

/// An existing workspace-relative directory that passed validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDirectory {
    /// Normalized path relative to the workspace root, using forward slashes.
    /// An empty string means the workspace root itself.
    pub relative: String,
    /// Canonical filesystem path of the directory.
    pub absolute: PathBuf,
}

/// Validate an untrusted workspace-relative parent directory path.
///
/// An empty string is the workspace root. Otherwise the path must be relative,
/// forward-slash separated, and made of visible, non-empty segments without
/// `.`/`..` components or backslashes.
pub fn validate_parent_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.contains('\0') {
        return Err("Folder path contains an invalid character.".to_string());
    }
    if raw.contains('\\') {
        return Err(format!(
            "Invalid folder path \"{raw}\": backslashes are not allowed; use forward slashes."
        ));
    }
    if raw.starts_with('/') || Path::new(raw).is_absolute() {
        return Err(format!(
            "Invalid folder path \"{raw}\": absolute paths are not allowed."
        ));
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(format!(
            "Invalid folder path \"{raw}\": Windows drive paths are not allowed."
        ));
    }

    let mut components = Vec::new();
    for component in raw.split('/') {
        if component.is_empty() {
            return Err(format!(
                "Invalid folder path \"{raw}\": empty path segments are not allowed."
            ));
        }
        if component == ".." {
            return Err(format!(
                "Invalid folder path \"{raw}\": path traversal is not allowed."
            ));
        }
        if component == "." {
            return Err(format!(
                "Invalid folder path \"{raw}\": current-directory segments are not allowed."
            ));
        }
        if component.starts_with('.') {
            return Err(format!(
                "Invalid folder path \"{raw}\": hidden folders are not supported."
            ));
        }
        components.push(component);
    }

    Ok(components.join("/"))
}

/// Resolve an untrusted parent directory against the canonical workspace root.
///
/// The directory must already exist and canonicalize to a descendant of the
/// root, so symlinks that leave the workspace are rejected. The returned
/// absolute path is canonical and safe to join a validated child name onto.
pub fn resolve_parent_dir(root: &Path, raw: &str) -> Result<ResolvedDirectory, String> {
    let relative = validate_parent_path(raw)?;
    let root = canonical_workspace_root(root)?;
    let candidate = if relative.is_empty() {
        root.clone()
    } else {
        root.join(&relative)
    };
    let absolute = fs::canonicalize(&candidate).map_err(|_| {
        format!(
            "Folder {} does not exist in the active workspace.",
            describe_folder(&relative)
        )
    })?;

    if !absolute.starts_with(&root) {
        return Err(format!(
            "Access denied for folder {}: path resolves outside the workspace.",
            describe_folder(&relative)
        ));
    }
    if !absolute.is_dir() {
        return Err(format!(
            "Folder {} is not a folder.",
            describe_folder(&relative)
        ));
    }

    Ok(ResolvedDirectory { relative, absolute })
}

/// Validate a single new folder name (a single path segment).
pub fn validate_folder_name(name: &str) -> Result<(), String> {
    validate_entry_name(name)
}

/// Validate a single new note file name, including its Markdown extension.
pub fn validate_note_file_name(name: &str) -> Result<(), String> {
    validate_entry_name(name)?;
    if !is_markdown_path(Path::new(name)) {
        return Err(format!(
            "Invalid note name \"{name}\": only .md and .markdown files are supported."
        ));
    }
    Ok(())
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name is empty.".to_string());
    }
    if name.len() > MAX_ENTRY_NAME_BYTES {
        return Err(format!(
            "Name \"{name}\" is too long: at most {MAX_ENTRY_NAME_BYTES} bytes are allowed."
        ));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!(
            "Invalid name \"{name}\": path separators are not allowed."
        ));
    }
    if name.contains('\0') {
        return Err(format!(
            "Invalid name \"{name}\": it contains an invalid character."
        ));
    }
    if name == "." || name == ".." {
        return Err(format!(
            "Invalid name \"{name}\": current-directory and parent-directory names are not allowed."
        ));
    }
    if name.starts_with('.') {
        return Err(format!(
            "Invalid name \"{name}\": names starting with a dot are not allowed."
        ));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(format!(
            "Invalid name \"{name}\": names must not end with a dot or a space."
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(format!(
            "Invalid name \"{name}\": control characters are not allowed."
        ));
    }
    if is_reserved_windows_name(name) {
        return Err(format!(
            "Invalid name \"{name}\": this is a reserved device name on Windows."
        ));
    }
    Ok(())
}

fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    WINDOWS_RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Join an already-validated parent path and child name with a forward slash.
pub fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// Human-readable description of a workspace-relative folder.
pub fn describe_folder(relative: &str) -> String {
    if relative.is_empty() {
        "the workspace root".to_string()
    } else {
        format!("\"{relative}\"")
    }
}

/// Reject a creation or rename target that already exists.
///
/// `symlink_metadata` is used so broken symlinks also count as existing rather
/// than silently being overwritten.
pub fn ensure_vacant(target: &Path, name: &str, parent_relative: &str) -> Result<(), String> {
    if fs::symlink_metadata(target).is_ok() {
        return Err(format!(
            "\"{name}\" already exists in {}.",
            describe_folder(parent_relative)
        ));
    }
    Ok(())
}

/// Validate that an untrusted workspace path exists and is a directory, then
/// return its canonical form.
pub fn verify_workspace_dir(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("Workspace path is empty.".to_string());
    }
    let display = path.display();
    let metadata = fs::metadata(path).map_err(|error| {
        format!("Workspace folder \"{display}\" does not exist or cannot be read: {error}")
    })?;
    if !metadata.is_dir() {
        return Err(format!("Workspace path \"{display}\" is not a folder."));
    }
    fs::canonicalize(path)
        .map_err(|error| format!("Workspace folder \"{display}\" could not be resolved: {error}"))
}

/// Canonicalize an already-trusted workspace root and verify it is a folder.
pub fn canonical_workspace_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(root).map_err(|error| {
        format!(
            "Workspace folder \"{}\" is not accessible: {error}",
            root.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "Workspace path \"{}\" is not a folder.",
            root.display()
        ));
    }
    Ok(canonical)
}

/// A note path that has passed validation and descendant checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedNote {
    /// Normalized path relative to the workspace root, using forward slashes.
    pub relative: String,
    /// Canonical filesystem path of the note.
    pub absolute: PathBuf,
}

/// Resolve a frontend-supplied relative note path against the workspace root.
///
/// The file must exist, be a Markdown file, and canonicalize to a descendant of
/// the canonical workspace root. Symlinks that escape the workspace are
/// therefore rejected.
pub fn resolve_note(root: &Path, raw: &str) -> Result<ResolvedNote, String> {
    let relative = validate_relative_path(raw)?;
    let root = canonical_workspace_root(root)?;
    let candidate = root.join(Path::new(&relative));
    let absolute = fs::canonicalize(&candidate)
        .map_err(|_| format!("Note \"{relative}\" does not exist in the active workspace."))?;

    if absolute == root || !absolute.starts_with(&root) {
        return Err(format!(
            "Access denied for note \"{relative}\": path resolves outside the workspace."
        ));
    }
    if !absolute.is_file() {
        return Err(format!("Note \"{relative}\" is not a file."));
    }
    if !is_markdown_path(&absolute) {
        return Err(format!(
            "Invalid note path \"{relative}\": only .md and .markdown files are supported."
        ));
    }

    Ok(ResolvedNote { relative, absolute })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDir;

    #[test]
    fn rejects_path_traversal_and_non_relative_paths() {
        let invalid = [
            "",
            "../outside.md",
            "notes/../../outside.md",
            "notes/../outside.md",
            "./note.md",
            "/etc/passwd.md",
            "//server/share/note.md",
            "C:/notes/note.md",
            "C:\\notes\\note.md",
            "\\\\server\\share\\note.md",
            "notes\\note.md",
            "notes//note.md",
            "notes/",
        ];
        for raw in invalid {
            assert!(
                validate_relative_path(raw).is_err(),
                "expected rejection for {raw:?}"
            );
        }
    }

    #[test]
    fn rejects_non_markdown_extensions() {
        for raw in [
            "note.txt",
            "note",
            "note.md.txt",
            "note.MDX",
            "notes/photo.png",
        ] {
            assert!(
                validate_relative_path(raw).is_err(),
                "expected extension rejection for {raw:?}"
            );
        }
        assert_eq!(
            validate_relative_path("notes/Launch.MD").unwrap(),
            "notes/Launch.MD"
        );
        assert_eq!(
            validate_relative_path("notes/long.markdown").unwrap(),
            "notes/long.markdown"
        );
        assert_eq!(
            validate_relative_path("notes/part.one.md").unwrap(),
            "notes/part.one.md"
        );
        assert!(is_markdown_path(Path::new("NOTE.Md")));
        assert!(!is_markdown_path(Path::new("NOTE.md.bak")));
    }

    #[test]
    fn resolves_notes_inside_the_workspace_only() {
        let workspace = TestDir::new("security");
        let inside = workspace.write("notes/inside.md", "inside");
        let outside = TestDir::new("security-outside");
        let outside_file = outside.write("secret.md", "secret");

        let resolved = resolve_note(workspace.path(), "notes/inside.md").unwrap();
        assert_eq!(resolved.relative, "notes/inside.md");
        assert_eq!(resolved.absolute, fs::canonicalize(inside).unwrap());

        assert!(resolve_note(workspace.path(), "../secret.md").is_err());
        assert!(resolve_note(workspace.path(), &outside_file.to_string_lossy()).is_err());
        assert!(resolve_note(workspace.path(), "notes/missing.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_escaping_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = TestDir::new("security-symlink");
        workspace.write("inside.md", "inside");
        let outside = TestDir::new("security-symlink-outside");
        let secret = outside.write("secret.md", "secret");

        let escape = workspace.path().join("escape.md");
        symlink(&secret, &escape).unwrap();
        let error = resolve_note(workspace.path(), "escape.md").unwrap_err();
        assert!(error.contains("outside the workspace"), "{error}");

        // A symlink that stays inside the workspace is not an escape.
        let alias = workspace.path().join("alias.md");
        symlink(workspace.path().join("inside.md"), &alias).unwrap();
        let resolved = resolve_note(workspace.path(), "alias.md").unwrap();
        assert_eq!(resolved.relative, "alias.md");
    }

    #[test]
    fn validates_parent_folder_requests() {
        for invalid in [
            "/etc",
            "..",
            "../outside",
            "notes/../outside",
            "notes/..",
            "./notes",
            "notes/.",
            "notes//nested",
            "notes/",
            ".hidden",
            "notes/.hidden",
            "notes\\nested",
            "C:/notes",
            "notes\0",
        ] {
            assert!(
                validate_parent_path(invalid).is_err(),
                "expected parent rejection for {invalid:?}"
            );
        }

        assert_eq!(validate_parent_path("").unwrap(), "");
        assert_eq!(validate_parent_path("notes").unwrap(), "notes");
        assert_eq!(validate_parent_path("a/b/c").unwrap(), "a/b/c");
    }

    #[test]
    fn resolves_existing_parent_folders_inside_the_workspace() {
        let workspace = TestDir::new("security-parent");
        workspace.write("notes/nested/inside.md", "inside");
        let root = fs::canonicalize(workspace.path()).unwrap();

        let root_dir = resolve_parent_dir(workspace.path(), "").unwrap();
        assert_eq!(root_dir.relative, "");
        assert_eq!(root_dir.absolute, root);

        let nested = resolve_parent_dir(workspace.path(), "notes/nested").unwrap();
        assert_eq!(nested.relative, "notes/nested");
        assert_eq!(nested.absolute, root.join("notes/nested"));

        assert!(resolve_parent_dir(workspace.path(), "notes/missing").is_err());
        assert!(resolve_parent_dir(workspace.path(), "../outside").is_err());
        assert!(resolve_parent_dir(workspace.path(), ".hidden").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn parent_resolution_rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let workspace = TestDir::new("security-parent-symlink");
        let outside = TestDir::new("security-parent-symlink-outside");
        symlink(outside.path(), workspace.path().join("escape")).unwrap();

        assert!(resolve_parent_dir(workspace.path(), "escape").is_err());
    }

    #[test]
    fn validates_new_entry_names() {
        for valid in [
            "note.md",
            "NOTE.MD",
            "long.markdown",
            "part.one.md",
            "folder",
            "folder with space",
            "folder.with.dots",
            "日本語.md",
        ] {
            validate_entry_name(valid).unwrap_or_else(|error| panic!("{valid:?}: {error}"));
        }
        validate_folder_name("CON0").unwrap();
        validate_folder_name("COM10").unwrap();

        for invalid in [
            "",
            ".",
            "..",
            ".hidden",
            ".hidden.md",
            "a/b",
            "a/b.md",
            "a\\b",
            "a\\b.md",
            "trailing.",
            "trailing ",
            "note.md.",
            "note.md ",
            "note\0.md",
            "CON",
            "con",
            "con.md",
            "PRN",
            "AUX",
            "NUL",
            "NUL.md",
            "COM1",
            "com9.md",
            "LPT1.md",
            "lpt9",
        ] {
            assert!(
                validate_entry_name(invalid).is_err(),
                "expected name rejection for {invalid:?}"
            );
        }

        let too_long = "a".repeat(MAX_ENTRY_NAME_BYTES + 1);
        assert!(validate_entry_name(&too_long).is_err());
        let longest = "a".repeat(MAX_ENTRY_NAME_BYTES);
        validate_entry_name(&longest).unwrap();

        // Only Markdown note names require a Markdown extension; folder names
        // do not.
        validate_note_file_name("note.md").unwrap();
        validate_note_file_name("note.MARKDOWN").unwrap();
        for invalid in ["folder", "note.txt", "note.md.bak", "note.MDX"] {
            assert!(
                validate_note_file_name(invalid).is_err(),
                "expected note name rejection for {invalid:?}"
            );
        }
    }

    #[test]
    fn joins_and_describes_relative_paths() {
        assert_eq!(join_relative("", "note.md"), "note.md");
        assert_eq!(join_relative("notes", "note.md"), "notes/note.md");
        assert_eq!(join_relative("a/b", "c"), "a/b/c");
        assert_eq!(describe_folder(""), "the workspace root");
        assert_eq!(describe_folder("notes"), "\"notes\"");
    }
}
