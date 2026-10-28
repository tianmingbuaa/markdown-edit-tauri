import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

import { isDesktopRuntime } from "./api";

/** Read plain text from the system clipboard, tolerating unavailable APIs. */
export async function readClipboardText(): Promise<string> {
  if (isDesktopRuntime()) {
    try {
      return await readText();
    } catch {
      /* Fall through to the web clipboard API. */
    }
  }
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

/** Write plain text to the system clipboard. Returns false when unavailable. */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (isDesktopRuntime()) {
    try {
      await writeText(text);
      return true;
    } catch {
      /* Fall through to the web clipboard API. */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
