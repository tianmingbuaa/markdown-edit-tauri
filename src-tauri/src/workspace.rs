//! Workspace opening, recursive Markdown discovery, and workspace metadata.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::security;

/// Maximum directory nesting traversed below the workspace root.
const MAX_SCAN_DEPTH: usize = 32;

/// Directory names ignored during scans. Hidden entries are skipped separately
/// so `.git`, `.obsidian`, and `.trash` are covered twice on purpose.
const NOISY_DIRECTORIES: [&str; 7] = [
    "node_modules",
    "target",
    ".git",
    ".obsidian",
    ".trash",
    "dist",
    "build",
];

/// One Markdown file discovered in the workspace.
///
/// The frontend builds the folder tree from this flat, deterministically sorted
/// list; no file contents are read during a scan.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    /// Workspace-relative path using forward slashes, e.g. `ideas/launch.md`.
    pub path: String,
    /// Human-readable file stem, e.g. `launch`.
    pub name: String,
    /// File name including extension, e.g. `launch.md`.
    pub file_name: String,
    /// Last modification time as epoch milliseconds (0 when unavailable).
    pub modified: u64,
    /// File size in bytes.
    pub size: u64,
}

/// The active workspace plus its full note listing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// Canonical absolute folder path.
    pub path: String,
    /// Human-readable folder name.
    pub name: String,
    pub notes: Vec<NoteEntry>,
}

/// The securely stored active workspace.
#[derive(Debug, Clone)]
pub struct Workspace {
    /// Canonical absolute root directory.
    pub root: PathBuf,
    /// Display name of the workspace folder.
    pub name: String,
}

impl Workspace {
    pub fn info(&self, notes: Vec<NoteEntry>) -> WorkspaceInfo {
        WorkspaceInfo {
            path: self.root.to_string_lossy().into_owned(),
            name: self.name.clone(),
            notes,
        }
    }
}

/// Validate and canonicalize a user-chosen folder, then scan it.
///
/// Scanning happens before the caller stores the workspace so a failed open
/// never leaves a half-initialized workspace in state.
pub fn open_workspace_folder(path: &Path) -> Result<(Workspace, Vec<NoteEntry>), String> {
    let root = security::verify_workspace_dir(path)?;
    let name = workspace_name(&root);
    let notes = scan_workspace(&root)?;
    Ok((Workspace { root, name }, notes))
}

/// Recursively scan `root` for Markdown files.
///
/// Hidden entries and common noisy directories are skipped. Symlinked entries
/// are never followed, which prevents both directory loops and escaping the
/// workspace. Unreadable nested entries are skipped; an unreadable root is an
/// error. Results are sorted by relative path.
pub fn scan_workspace(root: &Path) -> Result<Vec<NoteEntry>, String> {
    let root = security::canonical_workspace_root(root)?;
    let mut notes = Vec::new();
    // (directory, relative prefix, depth of the directory below the root)
    let mut pending: Vec<(PathBuf, String, usize)> = vec![(root.clone(), String::new(), 0)];

    while let Some((directory, prefix, depth)) = pending.pop() {
        let read_dir = match fs::read_dir(&directory) {
            Ok(read_dir) => read_dir,
            Err(error) => {
                if directory == root {
                    return Err(format!(
                        "Could not read workspace folder \"{}\": {error}",
                        root.display()
                    ));
                }
                // One unreadable subdirectory should not make the whole
                // workspace unusable.
                continue;
            }
        };

        for entry in read_dir {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let file_name_os = entry.file_name();
            let Some(file_name) = file_name_os.to_str() else {
                continue;
            };
            if file_name.starts_with('.') {
                continue;
            }
            // Backslashes cannot appear in paths accepted by the path security
            // layer, so don't advertise files whose relative path would be
            // unreadable through the API.
            if file_name.contains('\\') {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            // Never follow symlinks: this is both loop protection and an
            // escape guard. Symlinks are not listed either.
            if file_type.is_symlink() {
                continue;
            }

            let relative = if prefix.is_empty() {
                file_name.to_string()
            } else {
                format!("{prefix}/{file_name}")
            };

            if file_type.is_dir() {
                if depth >= MAX_SCAN_DEPTH || is_noisy_directory(file_name) {
                    continue;
                }
                pending.push((entry.path(), relative, depth + 1));
            } else if file_type.is_file() {
                if !security::is_markdown_path(Path::new(file_name)) {
                    continue;
                }
                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                notes.push(NoteEntry {
                    path: relative,
                    name: note_name(file_name),
                    file_name: file_name.to_string(),
                    modified: modified_ms(&metadata),
                    size: metadata.len(),
                });
            }
        }
    }

    notes.sort_unstable_by(|left, right| left.path.cmp(&right.path));
    Ok(notes)
}

/// Convert a filesystem modification time to epoch milliseconds.
pub(crate) fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn is_noisy_directory(name: &str) -> bool {
    NOISY_DIRECTORIES
        .iter()
        .any(|noisy| name.eq_ignore_ascii_case(noisy))
}

fn note_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or(file_name)
        .to_string()
}

fn workspace_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDir;

    fn paths(notes: &[NoteEntry]) -> Vec<&str> {
        notes.iter().map(|note| note.path.as_str()).collect()
    }

    #[test]
    fn scan_skips_hidden_and_noisy_directories_and_includes_nested_notes() {
        let workspace = TestDir::new("scan");
        workspace.write("README.MD", "# Read me");
        workspace.write("notes/ideas/launch.md", "# Launch");
        workspace.write("notes/deep/nested/plan.markdown", "# Plan");
        workspace.write("assets/notes.md", "# Assets");
        workspace.write("targets/keep.md", "# Not the noisy target folder");
        workspace.write("notes/picture.png", "not markdown");
        workspace.write(".hidden.md", "# Hidden file");
        workspace.write(".private/inside.md", "# Hidden directory");

        for noisy in [
            "node_modules",
            "target",
            ".git",
            ".obsidian",
            ".trash",
            "dist",
            "build",
        ] {
            workspace.write(&format!("{noisy}/ignored.md"), "# Ignored");
            workspace.write(&format!("{noisy}/nested/ignored.md"), "# Ignored");
        }

        let notes = scan_workspace(workspace.path()).unwrap();
        assert_eq!(
            paths(&notes),
            vec![
                "README.MD",
                "assets/notes.md",
                "notes/deep/nested/plan.markdown",
                "notes/ideas/launch.md",
                "targets/keep.md",
            ]
        );

        let launch = notes
            .iter()
            .find(|note| note.path == "notes/ideas/launch.md")
            .unwrap();
        assert_eq!(launch.name, "launch");
        assert_eq!(launch.file_name, "launch.md");
        assert_eq!(launch.size, "# Launch".len() as u64);
        assert!(launch.modified > 0);

        // Scanning is repeatable and deterministically sorted.
        assert_eq!(
            paths(&notes),
            paths(&scan_workspace(workspace.path()).unwrap())
        );
    }

    #[test]
    fn scan_respects_the_depth_limit() {
        let workspace = TestDir::new("depth");
        workspace.write("shallow.md", "# Shallow");
        let deep_directory = vec!["level"; MAX_SCAN_DEPTH + 1].join("/");
        workspace.write(&format!("{deep_directory}/too-deep.md"), "# Deep");

        let notes = scan_workspace(workspace.path()).unwrap();
        assert_eq!(paths(&notes), vec!["shallow.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn scan_does_not_follow_symlinks_or_symlink_loops() {
        use std::os::unix::fs::symlink;

        let workspace = TestDir::new("scan-symlink");
        workspace.write("real.md", "# Real");
        let outside = TestDir::new("scan-symlink-outside");
        outside.write("outside.md", "# Outside");

        symlink(workspace.path(), workspace.path().join("loop")).unwrap();
        symlink(outside.path(), workspace.path().join("external")).unwrap();
        symlink(
            outside.path().join("outside.md"),
            workspace.path().join("linked.md"),
        )
        .unwrap();

        let notes = scan_workspace(workspace.path()).unwrap();
        assert_eq!(paths(&notes), vec!["real.md"]);
    }

    #[test]
    fn opens_a_valid_folder_and_rejects_non_folders() {
        let workspace = TestDir::new("open");
        workspace.write("note.md", "# Note");
        let (active, notes) = open_workspace_folder(workspace.path()).unwrap();
        assert_eq!(active.root, fs::canonicalize(workspace.path()).unwrap());
        assert_eq!(
            active.name,
            workspace.path().file_name().unwrap().to_str().unwrap()
        );

        let info = active.info(notes);
        assert_eq!(info.path, active.root.to_string_lossy());
        assert_eq!(info.name, active.name);
        assert_eq!(info.notes.len(), 1);

        let file = workspace.write("plain.txt", "not a folder");
        assert!(open_workspace_folder(&file).is_err());
        assert!(open_workspace_folder(&workspace.path().join("missing")).is_err());
    }

    #[test]
    fn workspace_payloads_use_camel_case_field_names() {
        let entry = NoteEntry {
            path: "ideas/launch.md".to_string(),
            name: "launch".to_string(),
            file_name: "launch.md".to_string(),
            modified: 1_700_000_000_000,
            size: 42,
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["path"], "ideas/launch.md");
        assert_eq!(value["name"], "launch");
        assert_eq!(value["fileName"], "launch.md");
        assert_eq!(value["modified"], 1_700_000_000_000_u64);
        assert_eq!(value["size"], 42);
        assert!(value.get("file_name").is_none());

        let workspace = Workspace {
            root: PathBuf::from("/tmp/library"),
            name: "library".to_string(),
        };
        let info = workspace.info(vec![entry]);
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["path"], "/tmp/library");
        assert_eq!(value["name"], "library");
        assert_eq!(value["notes"][0]["fileName"], "launch.md");
    }
}
