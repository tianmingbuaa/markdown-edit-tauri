//! Hard path validation and note resolution for the active workspace.
//!
//! Frontend code only ever supplies workspace-relative, forward-slash paths.
//! Everything in this module treats that input as untrusted.

use std::fs;
use std::path::{Path, PathBuf};

/// Markdown extensions accepted by the app, compared case-insensitively.
pub const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

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
}
