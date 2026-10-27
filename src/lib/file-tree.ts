import type { NoteEntry } from "./api";

const collator = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

export interface FileNode {
  type: "file";
  name: string;
  path: string;
  entry: NoteEntry;
}

export interface FolderNode {
  type: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

export type TreeNode = FileNode | FolderNode;

export function buildFileTree(notes: NoteEntry[], folderPaths: string[] = []): FolderNode {
  const root: FolderNode = { type: "folder", name: "", path: "", children: [] };
  const folders = new Map<string, FolderNode>();

  const ensureFolder = (path: string): FolderNode => {
    if (!path) return root;
    const parts = path.split("/").filter(Boolean);
    let parent = root;
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = folders.get(currentPath);
      if (!folder) {
        folder = {
          type: "folder",
          name: part,
          path: currentPath,
          children: [],
        };
        folders.set(currentPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    return parent;
  };

  // Directories are known even when they are empty, which is how freshly
  // created folders remain visible before they contain a note.
  for (const path of folderPaths) ensureFolder(path);

  for (const note of notes) {
    const parentPath = parentDirectory(note.path);
    const parent = ensureFolder(parentPath);
    parent.children.push({
      type: "file",
      name: note.name,
      path: note.path,
      entry: note,
    });
  }

  sortChildren(root);
  return root;
}

function sortChildren(folder: FolderNode): void {
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    const byName = collator.compare(a.name, b.name);
    return byName !== 0 ? byName : collator.compare(a.path, b.path);
  });

  for (const child of folder.children) {
    if (child.type === "folder") sortChildren(child);
  }
}

export function countNotes(folder: FolderNode): number {
  return folder.children.reduce((total, child) => {
    return total + (child.type === "file" ? 1 : countNotes(child));
  }, 0);
}

export function folderAncestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    ancestors.push(current);
  }
  return ancestors;
}

export function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

export function noteStem(fileName: string): string {
  return fileName.replace(/\.(md|markdown)$/i, "");
}

export function searchNotes(notes: NoteEntry[], query: string): NoteEntry[] {
  const needle = query.trim().toLocaleLowerCase("zh-Hans-CN");
  if (!needle) return notes;
  return notes.filter((note) => {
    return (
      note.path.toLocaleLowerCase("zh-Hans-CN").includes(needle) ||
      note.name.toLocaleLowerCase("zh-Hans-CN").includes(needle)
    );
  });
}
