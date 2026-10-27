import { invoke } from "@tauri-apps/api/core";

export interface NoteEntry {
  path: string;
  name: string;
  fileName: string;
  modified: number;
  size: number;
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  notes: NoteEntry[];
}

export interface NoteDocument {
  path: string;
  content: string;
  modified: number;
}

export interface SavedNote {
  modified: number;
  size: number;
}

export const workspaceApi = {
  open(path: string): Promise<WorkspaceInfo> {
    return invoke<WorkspaceInfo>("open_workspace", { path });
  },

  rescan(): Promise<WorkspaceInfo> {
    return invoke<WorkspaceInfo>("rescan_workspace");
  },

  read(path: string): Promise<NoteDocument> {
    return invoke<NoteDocument>("read_note", { path });
  },

  save(path: string, content: string): Promise<SavedNote> {
    return invoke<SavedNote>("save_note", { path, content });
  },
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "发生了未知错误，请稍后重试";
}

export function isDesktopRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
