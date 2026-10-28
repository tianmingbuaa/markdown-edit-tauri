import "@fontsource-variable/manrope";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type Vditor from "vditor";

import { errorMessage, isDesktopRuntime, workspaceApi } from "./lib/api";
import type { NoteDocument, NoteEntry, WorkspaceInfo } from "./lib/api";
import { readClipboardText, writeClipboardText } from "./lib/clipboard";
import { applyEditorTheme, createEditor } from "./lib/editor";
import {
  buildFileTree,
  countNotes,
  folderAncestors,
  parentDirectory,
  searchNotes,
} from "./lib/file-tree";
import type { FileNode, FolderNode } from "./lib/file-tree";
import {
  countCharacters,
  directoryLabel,
  formatCharacters,
  timeLabel,
  updatedLabel,
} from "./lib/format";
import { hydrateIcons, iconSvg, setIcon } from "./icons";
import type { IconName } from "./icons";
import { storage } from "./lib/storage";
import "./styles.css";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type ToastKind = "info" | "success" | "error";
type EntryDialogMode = "new-note" | "new-folder" | "rename-note";

interface ActionMenuItem {
  id: "new-note" | "new-folder" | "rename-note" | "delete-note";
  label: string;
  icon: IconName;
  shortcut?: string;
  danger?: boolean;
}

interface ContextMenuItem {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

type TextMenuTarget = "editor" | HTMLInputElement | HTMLTextAreaElement;

interface ToastOptions {
  kind: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

const AUTO_SAVE_MS = 720;
const MIN_SIDEBAR_WIDTH = 236;
const MAX_SIDEBAR_WIDTH = 392;
const DEFAULT_SIDEBAR_WIDTH = 286;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

class MojianApp {
  private app!: HTMLDivElement;
  private sidebar!: HTMLElement;
  private sidebarResizer!: HTMLElement;
  private sidebarToggle!: HTMLButtonElement;
  private collapseSidebar!: HTMLButtonElement;
  private openWorkspaceSide!: HTMLButtonElement;
  private openWorkspaceHero!: HTMLButtonElement;
  private refreshWorkspaceButton!: HTMLButtonElement;
  private refreshHero!: HTMLButtonElement;
  private createEntryButton!: HTMLButtonElement;
  private renameNoteButton!: HTMLButtonElement;
  private deleteNoteButton!: HTMLButtonElement;
  private contextMenu!: HTMLElement;
  private entryDialog!: HTMLDialogElement;
  private entryForm!: HTMLFormElement;
  private entryEyebrow!: HTMLElement;
  private entryTitle!: HTMLElement;
  private entryDescription!: HTMLElement;
  private entryInput!: HTMLInputElement;
  private entrySuffix!: HTMLElement;
  private entryError!: HTMLElement;
  private entryConfirm!: HTMLButtonElement;
  private entryCancel!: HTMLButtonElement;
  private entryClose!: HTMLButtonElement;
  private deleteDialog!: HTMLDialogElement;
  private deleteDescription!: HTMLElement;
  private deletePath!: HTMLElement;
  private deleteError!: HTMLElement;
  private deleteConfirm!: HTMLButtonElement;
  private deleteCancel!: HTMLButtonElement;
  private themeToggle!: HTMLButtonElement;
  private themeLabel!: HTMLElement;
  private topbar!: HTMLElement;
  private windowMinimizeButton!: HTMLButtonElement;
  private windowMaximizeButton!: HTMLButtonElement;
  private windowCloseButton!: HTMLButtonElement;
  private saveStatus!: HTMLButtonElement;
  private saveStatusText!: HTMLElement;
  private saveStatusTime!: HTMLElement;
  private autosaveIndicator!: HTMLElement;
  private sidebarSaveMessage!: HTMLElement;
  private fileTree!: HTMLElement;
  private fileSearch!: HTMLInputElement;
  private searchKbd!: HTMLElement;
  private clearSearchButton!: HTMLButtonElement;
  private noteCount!: HTMLElement;
  private workspaceCard!: HTMLElement;
  private workspaceNameSide!: HTMLElement;
  private workspacePathSide!: HTMLElement;
  private breadcrumbWorkspace!: HTMLElement;
  private breadcrumbNote!: HTMLElement;
  private dirtyDot!: HTMLElement;
  private welcome!: HTMLElement;
  private welcomeEyebrow!: HTMLElement;
  private welcomeTitle!: HTMLElement;
  private welcomeDescription!: HTMLElement;
  private recentSection!: HTMLElement;
  private recentList!: HTMLElement;
  private editorView!: HTMLElement;
  private editorLoading!: HTMLElement;
  private editorMount!: HTMLElement;
  private editorFrame!: HTMLElement;
  private documentTitle!: HTMLElement;
  private documentPath!: HTMLElement;
  private documentUpdated!: HTMLElement;
  private wordCount!: HTMLElement;
  private toastRegion!: HTMLElement;
  private shortcutDialog!: HTMLDialogElement;

  private workspace: WorkspaceInfo | null = null;
  private tree: FolderNode | null = null;
  private collapsedFolders = new Set<string>();
  private query = "";
  private currentNote: NoteEntry | null = null;
  private characterCount = 0;

  private editor: Vditor | null = null;
  private editorReady = false;
  private editorToken = 0;
  private editorInitTimer: number | null = null;
  private loadToken = 0;

  private pendingContent: string | null = null;
  private lastPersistedContent: string | null = null;
  private saveState: SaveState = "idle";
  private saveTimer: number | null = null;
  private savePromise: Promise<boolean> | null = null;
  private lastSavedAt = 0;
  private lastSaveErrorMessage = "";
  private lastErrorToastAt = 0;

  private entryMode: EntryDialogMode | null = null;
  private entryParent = "";
  private entryNote: NoteEntry | null = null;
  private entryExtension = ".md";
  private entryBusy = false;
  private deleteTarget: NoteEntry | null = null;
  private deleteBusy = false;
  private contextMenuAnchor: HTMLElement | null = null;
  private contextMenuHostDialog: HTMLDialogElement | null = null;

  private dark = false;
  private sidebarCollapsed = false;
  private workspaceBusy = false;
  private isClosing = false;

  async init(): Promise<void> {
    hydrateIcons();
    this.collectDom();
    this.dark = document.documentElement.dataset.theme === "dark";
    this.bindUi();
    this.bindKeyboard();
    this.bindWindowLifecycle();

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", (event) => {
      if (!storage.getTheme()) {
        this.dark = event.matches;
        this.applyTheme(true, false);
      }
    });

    this.applySidebarWidth(storage.getSidebarWidth() ?? DEFAULT_SIDEBAR_WIDTH, false);
    this.applySidebarCollapsed(storage.getSidebarCollapsed(), false);
    this.applyTheme(false, false);
    this.updateShortcutLabels();
    this.updateWorkspaceChrome();
    this.updateDocumentChrome();
    this.updateSaveStatus();
    this.setDirtyDot(false);
    this.updateWelcome();

    this.app.dataset.ready = "true";
    void this.restoreLastWorkspace();
  }

  private collectDom(): void {
    this.app = byId<HTMLDivElement>("app");
    this.topbar = byId<HTMLElement>("topbar");
    this.windowMinimizeButton = byId<HTMLButtonElement>("window-minimize");
    this.windowMaximizeButton = byId<HTMLButtonElement>("window-maximize");
    this.windowCloseButton = byId<HTMLButtonElement>("window-close");
    this.sidebar = byId<HTMLElement>("sidebar");
    this.sidebarResizer = byId<HTMLElement>("sidebar-resizer");
    this.sidebarToggle = byId<HTMLButtonElement>("sidebar-toggle");
    this.collapseSidebar = byId<HTMLButtonElement>("collapse-sidebar");
    this.openWorkspaceSide = byId<HTMLButtonElement>("open-workspace-side");
    this.openWorkspaceHero = byId<HTMLButtonElement>("open-workspace-hero");
    this.refreshWorkspaceButton = byId<HTMLButtonElement>("refresh-workspace");
    this.refreshHero = byId<HTMLButtonElement>("refresh-hero");
    this.createEntryButton = byId<HTMLButtonElement>("create-entry");
    this.renameNoteButton = byId<HTMLButtonElement>("rename-note");
    this.deleteNoteButton = byId<HTMLButtonElement>("delete-note");
    this.contextMenu = byId<HTMLElement>("context-menu");
    this.entryDialog = byId<HTMLDialogElement>("entry-dialog");
    this.entryForm = byId<HTMLFormElement>("entry-form");
    this.entryEyebrow = byId<HTMLElement>("entry-eyebrow");
    this.entryTitle = byId<HTMLElement>("entry-title");
    this.entryDescription = byId<HTMLElement>("entry-description");
    this.entryInput = byId<HTMLInputElement>("entry-input");
    this.entrySuffix = byId<HTMLElement>("entry-suffix");
    this.entryError = byId<HTMLElement>("entry-error");
    this.entryConfirm = byId<HTMLButtonElement>("entry-confirm");
    this.entryCancel = byId<HTMLButtonElement>("entry-cancel");
    this.entryClose = byId<HTMLButtonElement>("entry-close");
    this.deleteDialog = byId<HTMLDialogElement>("delete-dialog");
    this.deleteDescription = byId<HTMLElement>("delete-description");
    this.deletePath = byId<HTMLElement>("delete-path");
    this.deleteError = byId<HTMLElement>("delete-error");
    this.deleteConfirm = byId<HTMLButtonElement>("delete-confirm");
    this.deleteCancel = byId<HTMLButtonElement>("delete-cancel");
    this.themeToggle = byId<HTMLButtonElement>("theme-toggle");
    this.themeLabel = byId<HTMLElement>("theme-label");
    this.saveStatus = byId<HTMLButtonElement>("save-status");
    this.saveStatusText = byId<HTMLElement>("save-status-text");
    this.saveStatusTime = byId<HTMLElement>("save-status-time");
    this.autosaveIndicator = document.querySelector<HTMLElement>(".autosave-indicator")!;
    this.sidebarSaveMessage = byId<HTMLElement>("sidebar-save-message");
    this.fileTree = byId<HTMLElement>("file-tree");
    this.fileSearch = byId<HTMLInputElement>("file-search");
    this.searchKbd = byId<HTMLElement>("search-kbd");
    this.clearSearchButton = byId<HTMLButtonElement>("clear-search");
    this.noteCount = byId<HTMLElement>("note-count");
    this.workspaceCard = byId<HTMLElement>("workspace-card");
    this.workspaceNameSide = byId<HTMLElement>("workspace-name-side");
    this.workspacePathSide = byId<HTMLElement>("workspace-path-side");
    this.breadcrumbWorkspace = byId<HTMLElement>("breadcrumb-workspace");
    this.breadcrumbNote = byId<HTMLElement>("breadcrumb-note");
    this.dirtyDot = byId<HTMLElement>("dirty-dot");
    this.welcome = byId<HTMLElement>("welcome");
    this.welcomeEyebrow = byId<HTMLElement>("welcome-eyebrow");
    this.welcomeTitle = byId<HTMLElement>("welcome-title");
    this.welcomeDescription = byId<HTMLElement>("welcome-description");
    this.recentSection = byId<HTMLElement>("recent-section");
    this.recentList = byId<HTMLElement>("recent-list");
    this.editorView = byId<HTMLElement>("editor-view");
    this.editorLoading = byId<HTMLElement>("editor-loading");
    this.editorMount = byId<HTMLElement>("vditor");
    this.editorFrame = this.editorMount.parentElement as HTMLElement;
    this.documentTitle = byId<HTMLElement>("document-title");
    this.documentPath = byId<HTMLElement>("document-path");
    this.documentUpdated = byId<HTMLElement>("document-updated");
    this.wordCount = byId<HTMLElement>("word-count");
    this.toastRegion = byId<HTMLElement>("toast-region");
    this.shortcutDialog = byId<HTMLDialogElement>("shortcuts-dialog");
  }

  private bindUi(): void {
    const openWorkspace = (): void => {
      void this.openWorkspaceDialog();
    };
    this.openWorkspaceSide.addEventListener("click", openWorkspace);
    this.openWorkspaceHero.addEventListener("click", openWorkspace);

    this.refreshWorkspaceButton.addEventListener("click", () => void this.refreshWorkspace(true));
    this.refreshHero.addEventListener("click", () => void this.refreshWorkspace(true));
    this.createEntryButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleCreateMenu();
    });
    this.renameNoteButton.addEventListener("click", () => {
      if (this.currentNote) {
        this.openEntryDialog("rename-note", parentDirectory(this.currentNote.path), this.currentNote);
      }
    });
    this.deleteNoteButton.addEventListener("click", () => {
      if (this.currentNote) this.openDeleteDialog(this.currentNote);
    });
    document.addEventListener("contextmenu", (event) => {
      this.handleContextMenu(event);
    });
    document.addEventListener("scroll", () => this.closeContextMenu(), {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", () => this.closeContextMenu());

    this.collapseSidebar.addEventListener("click", () => {
      this.applySidebarCollapsed(true, true);
    });
    this.sidebarToggle.addEventListener("click", () => {
      this.applySidebarCollapsed(!this.sidebarCollapsed, true);
    });

    this.themeToggle.addEventListener("click", () => this.toggleTheme());

    this.saveStatus.addEventListener("click", () => {
      void this.saveNow(true);
    });

    this.fileSearch.addEventListener("input", () => {
      this.query = this.fileSearch.value;
      this.renderTree();
    });
    this.fileSearch.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.query) {
          this.clearSearch(true);
        } else {
          this.fileSearch.blur();
        }
        return;
      }
      if (event.key === "Enter" && this.workspace) {
        const result = searchNotes(this.workspace.notes, this.query)[0];
        if (result) {
          event.preventDefault();
          void this.loadNote(result);
        }
      }
    });
    this.clearSearchButton.addEventListener("click", () => this.clearSearch(true));

    this.bindSidebarResizer();

    byId<HTMLButtonElement>("shortcut-help").addEventListener("click", () => {
      if (!this.shortcutDialog.open) this.shortcutDialog.showModal();
    });
    byId<HTMLButtonElement>("close-shortcuts").addEventListener("click", () => {
      this.shortcutDialog.close();
    });
    this.shortcutDialog.addEventListener("click", (event) => {
      if (event.target === this.shortcutDialog) this.shortcutDialog.close();
    });

    this.entryForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitEntryDialog();
    });
    this.entryInput.addEventListener("input", () => {
      this.entryError.textContent = "";
    });
    this.entryCancel.addEventListener("click", () => this.closeEntryDialog());
    this.entryClose.addEventListener("click", () => this.closeEntryDialog());
    this.entryDialog.addEventListener("click", (event) => {
      if (event.target === this.entryDialog && !this.entryBusy) this.closeEntryDialog();
    });
    this.entryDialog.addEventListener("cancel", (event) => {
      if (this.entryBusy) event.preventDefault();
    });
    this.entryDialog.addEventListener("close", () => {
      if (!this.entryBusy) {
        this.entryMode = null;
        this.entryNote = null;
        this.entryError.textContent = "";
      }
    });

    this.deleteCancel.addEventListener("click", () => this.closeDeleteDialog());
    this.deleteConfirm.addEventListener("click", () => void this.confirmDelete());
    this.deleteDialog.addEventListener("click", (event) => {
      if (event.target === this.deleteDialog && !this.deleteBusy) this.closeDeleteDialog();
    });
    this.deleteDialog.addEventListener("cancel", (event) => {
      if (this.deleteBusy) event.preventDefault();
    });
    this.deleteDialog.addEventListener("close", () => {
      if (!this.deleteBusy) {
        this.deleteTarget = null;
        this.deleteError.textContent = "";
      }
    });

    document.addEventListener("pointerdown", (event) => {
      if (this.contextMenu.hidden) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.contextMenu.contains(target) || this.createEntryButton.contains(target)) return;
      this.closeContextMenu();
    });

    this.contextMenu.addEventListener("keydown", (event) => {
      const items = [
        ...this.contextMenu.querySelectorAll<HTMLButtonElement>(".context-menu__item"),
      ].filter((button) => !button.disabled);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeContextMenu(true);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length === 0) return;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const next =
          index === -1
            ? direction === 1
              ? 0
              : items.length - 1
            : (index + direction + items.length) % items.length;
        items[next]?.focus();
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (items.length === 0) return;
        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      const anchor = target instanceof Element ? target.closest("a") : null;
      if (!anchor || !this.editorFrame.contains(anchor)) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      event.preventDefault();
      if (/^(https?:|mailto:)/i.test(href)) {
        if (isDesktopRuntime()) {
          void openUrl(href).catch((error: unknown) => {
            this.showToast({ kind: "error", message: `无法打开链接：${errorMessage(error)}` });
          });
        } else {
          window.open(href, "_blank", "noopener,noreferrer");
        }
      } else {
        this.showToast({ kind: "info", message: "本地链接不会在此窗口中直接打开。" });
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && this.pendingContent !== null) {
        void this.saveNow(false);
      }
    });
  }

  private bindKeyboard(): void {
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !this.contextMenu.hidden) {
          event.preventDefault();
          this.closeContextMenu(true);
          return;
        }

        const dialogOpen =
          this.entryDialog.open || this.deleteDialog.open || this.shortcutDialog.open;
        if (dialogOpen) return;

        if (event.key === "F2") {
          if (this.currentNote && !this.workspaceBusy) {
            event.preventDefault();
            this.openEntryDialog(
              "rename-note",
              parentDirectory(this.currentNote.path),
              this.currentNote,
            );
          }
          return;
        }

        const modifier = event.metaKey || event.ctrlKey;
        if (!modifier || event.altKey) return;
        const key = event.key.toLowerCase();

        if (key === "s") {
          event.preventDefault();
          void this.saveNow(true);
          return;
        }
        if (key === "o") {
          event.preventDefault();
          void this.openWorkspaceDialog();
          return;
        }
        if (key === "p") {
          event.preventDefault();
          if (!this.workspace) {
            this.showToast({ kind: "info", message: "请先打开一个笔记库。" });
            return;
          }
          this.fileSearch.focus();
          this.fileSearch.select();
          return;
        }
        if (key === "n") {
          event.preventDefault();
          if (!this.workspace) {
            this.showToast({ kind: "info", message: "请先打开一个笔记库。" });
            return;
          }
          this.openEntryDialog(event.shiftKey ? "new-folder" : "new-note", this.defaultParentPath());
          return;
        }
        if (key === "\\") {
          event.preventDefault();
          this.applySidebarCollapsed(!this.sidebarCollapsed, true);
          return;
        }
        if (key === "l" && event.shiftKey) {
          event.preventDefault();
          this.toggleTheme();
        }
      },
      { capture: true },
    );
  }

  private bindWindowLifecycle(): void {
    if (!isDesktopRuntime()) {
      this.windowMinimizeButton.disabled = true;
      this.windowMaximizeButton.disabled = true;
      this.windowCloseButton.disabled = true;
      return;
    }

    const currentWindow = getCurrentWindow();

    this.windowMinimizeButton.addEventListener("click", () => void this.minimizeWindow());
    this.windowMaximizeButton.addEventListener("click", () => void this.toggleMaximizeWindow());
    this.windowCloseButton.addEventListener("click", () => void this.closeWindowFromControl());
    void this.updateMaximizeControl();

    void currentWindow
      .onResized(() => {
        void this.updateMaximizeControl();
      })
      .catch(() => undefined);

    const isInteractive = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      Boolean(target.closest("button, a, input, textarea, select, [data-no-drag]"));

    this.topbar.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.detail > 1 || isInteractive(event.target)) return;
      void currentWindow.startDragging().catch(() => undefined);
    });

    this.topbar.addEventListener("dblclick", (event) => {
      if (event.button !== 0 || isInteractive(event.target)) return;
      void this.toggleMaximizeWindow();
    });

    void currentWindow
      .onCloseRequested(async (event) => {
        if (this.isClosing) {
          event.preventDefault();
          return;
        }
        if (!this.hasUnsavedChanges()) return;
        event.preventDefault();
        this.isClosing = true;
        const saved = await this.saveNow(false);
        if (!saved) {
          this.isClosing = false;
          this.showToast({
            kind: "error",
            message: "笔记尚未保存成功，窗口保持打开。请重试保存后再关闭。",
            duration: 8500,
          });
          return;
        }
        try {
          await currentWindow.destroy();
        } catch (error) {
          this.isClosing = false;
          this.showToast({
            kind: "error",
            message: `无法关闭窗口：${errorMessage(error)}`,
          });
        }
      })
      .catch(() => undefined);

    window.addEventListener("blur", () => {
      if (this.pendingContent !== null) void this.saveNow(false);
    });
  }

  private async minimizeWindow(): Promise<void> {
    if (!isDesktopRuntime()) return;
    try {
      await getCurrentWindow().minimize();
    } catch (error) {
      this.showToast({
        kind: "error",
        message: `无法最小化窗口：${errorMessage(error)}`,
      });
    }
  }

  private async toggleMaximizeWindow(): Promise<void> {
    if (!isDesktopRuntime()) return;
    try {
      await getCurrentWindow().toggleMaximize();
      await this.updateMaximizeControl();
    } catch (error) {
      this.showToast({
        kind: "error",
        message: `无法切换窗口大小：${errorMessage(error)}`,
      });
    }
  }

  private async updateMaximizeControl(): Promise<void> {
    if (!isDesktopRuntime() || !this.windowMaximizeButton) return;
    try {
      const maximized = await getCurrentWindow().isMaximized();
      const label = maximized ? "还原" : "最大化";
      setIcon(this.windowMaximizeButton, maximized ? "restore" : "maximize", 13);
      this.windowMaximizeButton.setAttribute("aria-label", label);
      this.windowMaximizeButton.title = label;
    } catch (_) {
      /* Window state is cosmetic; controls still work if this query fails. */
    }
  }

  private async closeWindowFromControl(): Promise<void> {
    if (!isDesktopRuntime() || this.isClosing) return;
    const currentWindow = getCurrentWindow();
    this.isClosing = true;
    const saved = await this.saveNow(false);
    if (!saved) {
      this.isClosing = false;
      this.showToast({
        kind: "error",
        message: "笔记尚未保存成功，窗口保持打开。请重试保存后再关闭。",
        duration: 8500,
      });
      return;
    }
    try {
      await currentWindow.destroy();
    } catch (error) {
      this.isClosing = false;
      this.showToast({
        kind: "error",
        message: `无法关闭窗口：${errorMessage(error)}`,
      });
    }
  }

  private bindSidebarResizer(): void {
    let startX = 0;
    let startWidth = DEFAULT_SIDEBAR_WIDTH;

    this.sidebarResizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.sidebarCollapsed) return;
      event.preventDefault();
      startX = event.clientX;
      startWidth = this.sidebar.getBoundingClientRect().width;
      this.app.classList.add("is-resizing-sidebar");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const move = (moveEvent: PointerEvent): void => {
        this.applySidebarWidth(startWidth + (moveEvent.clientX - startX), false);
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.app.classList.remove("is-resizing-sidebar");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        storage.setSidebarWidth(this.sidebar.getBoundingClientRect().width);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });

    this.sidebarResizer.addEventListener("dblclick", () => {
      this.applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, true);
    });

    this.sidebarResizer.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") {
        return;
      }
      event.preventDefault();
      if (event.key === "Home") {
        this.applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, true);
        return;
      }
      const direction = event.key === "ArrowRight" ? 14 : -14;
      this.applySidebarWidth(this.sidebar.getBoundingClientRect().width + direction, true);
    });
  }

  private updateShortcutLabels(): void {
    const apple = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const labels: Record<string, string> = {
      "open-folder": apple ? "⌘ O" : "Ctrl O",
      search: apple ? "⌘ P" : "Ctrl P",
      save: apple ? "⌘ S" : "Ctrl S",
      "new-note": apple ? "⌘ N" : "Ctrl N",
      "new-folder": apple ? "⌘ ⇧ N" : "Ctrl ⇧ N",
      "rename-note": "F2",
      sidebar: apple ? "⌘ \\" : "Ctrl \\",
      theme: apple ? "⌘ ⇧ L" : "Ctrl ⇧ L",
    };
    document.querySelectorAll<HTMLElement>("[data-shortcut]").forEach((element) => {
      const key = element.dataset.shortcut;
      if (key && labels[key]) element.textContent = labels[key];
    });
    this.searchKbd.textContent = apple ? "⌘ P" : "Ctrl P";
  }

  private applyTheme(updateEditor: boolean, persist: boolean): void {
    document.documentElement.dataset.theme = this.dark ? "dark" : "light";
    document.documentElement.style.colorScheme = this.dark ? "dark" : "light";
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = this.dark ? "#171614" : "#f7f4ee";

    const action = this.dark ? "浅色" : "深色";
    this.themeLabel.textContent = action;
    const themeIcon = this.dark ? "sun" : "moon";
    setIcon(this.themeToggle.querySelector(".icon-slot"), themeIcon);
    this.themeToggle.setAttribute("aria-label", `切换为${action}主题`);

    if (persist) storage.setTheme(this.dark ? "dark" : "light");
    if (updateEditor && this.editor && this.editorReady) {
      applyEditorTheme(this.editor, this.dark);
    }
  }

  private toggleTheme(): void {
    this.dark = !this.dark;
    this.applyTheme(true, true);
  }

  private applySidebarWidth(width: number, persist: boolean): void {
    const bounded = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
    this.app.style.setProperty("--sidebar-width", `${Math.round(bounded)}px`);
    this.sidebarResizer.setAttribute("aria-valuenow", String(Math.round(bounded)));
    this.sidebarResizer.setAttribute("aria-valuemin", String(MIN_SIDEBAR_WIDTH));
    this.sidebarResizer.setAttribute("aria-valuemax", String(MAX_SIDEBAR_WIDTH));
    if (persist) storage.setSidebarWidth(bounded);
  }

  private applySidebarCollapsed(collapsed: boolean, persist: boolean): void {
    this.sidebarCollapsed = collapsed;
    this.app.classList.toggle("sidebar-collapsed", collapsed);
    this.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    this.collapseSidebar.setAttribute("aria-label", collapsed ? "展开侧边栏" : "收起侧边栏");
    if (persist) storage.setSidebarCollapsed(collapsed);
  }

  private async restoreLastWorkspace(): Promise<void> {
    const last = storage.getLastWorkspace();
    if (!last) {
      this.updateWelcome();
      return;
    }

    this.setWorkspaceBusy(true);
    this.fileTree.innerHTML = `
      <div class="tree-skeleton" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
      </div>`;

    try {
      const info = await workspaceApi.open(last);
      this.adoptWorkspace(info);
      this.fileTree.scrollTop = 0;
    } catch (error) {
      storage.setLastWorkspace(null);
      this.setWorkspaceBusy(false);
      this.renderTree();
      this.updateWorkspaceChrome();
      this.updateWelcome();
      this.showToast({
        kind: "info",
        message: `未能恢复上次的笔记库：${errorMessage(error)}`,
        duration: 6500,
      });
    }
  }

  private adoptWorkspace(info: WorkspaceInfo): void {
    this.workspace = info;
    this.tree = buildFileTree(info.notes, info.folders ?? []);
    this.collapsedFolders = storage.getCollapsedFolders(info.path);
    this.currentNote = null;
    this.pendingContent = null;
    this.lastSavedAt = 0;
    this.query = "";
    this.fileSearch.value = "";
    this.loadToken += 1;
    this.editorToken += 1;
    this.cancelSaveTimer();
    this.destroyEditor();
    this.showWelcomeView();
    this.setWorkspaceBusy(false);
    this.setSaveState("idle");
    this.setDirtyDot(false);
    storage.setLastWorkspace(info.path);

    this.updateWorkspaceChrome();
    this.renderTree();
    this.updateWelcome();
    this.updateDocumentChrome();
    this.updateSaveStatus();
    this.fileTree.scrollTop = 0;
  }

  private setWorkspaceBusy(busy: boolean): void {
    this.workspaceBusy = busy;
    this.app.classList.toggle("is-busy", busy);
    if (busy) this.editor?.blur();
    const disabled = busy || !this.workspace;
    this.refreshWorkspaceButton.disabled = disabled;
    this.refreshHero.disabled = disabled;
    this.openWorkspaceSide.disabled = busy;
    this.openWorkspaceHero.disabled = busy;
    this.fileTree.setAttribute("aria-busy", String(busy));
    if (this.workspace) {
      this.refreshWorkspaceButton.title = busy ? "正在刷新…" : "刷新笔记库";
    }
    this.updateManagementActions();
  }

  private updateWorkspaceChrome(): void {
    const hasWorkspace = this.workspace !== null;
    this.workspaceCard.dataset.empty = String(!hasWorkspace);
    this.workspaceNameSide.textContent = this.workspace?.name ?? "尚未打开笔记库";
    this.workspacePathSide.textContent = this.workspace?.path ?? "选择一个本地文件夹";
    this.workspacePathSide.title = this.workspace?.path ?? "选择一个本地文件夹";
    this.breadcrumbWorkspace.textContent = this.workspace?.name ?? "墨笺";
    this.breadcrumbWorkspace.title = this.workspace?.path ?? "";
    this.fileSearch.disabled = !hasWorkspace;
    this.fileSearch.placeholder = hasWorkspace ? "搜索笔记…" : "打开笔记库后搜索";
    this.refreshWorkspaceButton.disabled = this.workspaceBusy || !hasWorkspace;
    this.refreshHero.hidden = !hasWorkspace;
    this.refreshHero.disabled = this.workspaceBusy || !hasWorkspace;
    this.clearSearchButton.hidden = !this.query;
    this.searchKbd.hidden = Boolean(this.query);
    this.updateManagementActions();
  }

  private updateWelcome(): void {
    if (this.currentNote) return;
    this.welcome.hidden = false;
    this.editorView.hidden = true;
    this.recentSection.hidden = true;
    this.recentList.replaceChildren();

    const workspace = this.workspace;
    if (!workspace) {
      this.welcomeEyebrow.innerHTML =
        '<span class="welcome__eyebrow-rule" aria-hidden="true"></span>MOJIAN · MARKDOWN STUDIO';
      this.welcomeTitle.innerHTML = "把思绪，<br /><em>写进纸间。</em>";
      this.welcomeDescription.textContent =
        "打开一个本地文件夹，把它变成你的 Markdown 笔记库。选择、书写，余下的一切交给自动保存。";
      return;
    }

    if (workspace.notes.length === 0) {
      this.welcomeEyebrow.innerHTML =
        '<span class="welcome__eyebrow-rule" aria-hidden="true"></span>EMPTY LIBRARY';
      this.welcomeTitle.innerHTML = "这里还是一张<br /><em>空白稿纸。</em>";
      this.welcomeDescription.textContent = `“${workspace.name}” 中还没有 Markdown 笔记。点击左侧 + 新建第一篇，或把 .md 文件放入文件夹。`;
      return;
    }

    this.welcomeEyebrow.innerHTML =
      '<span class="welcome__eyebrow-rule" aria-hidden="true"></span>MOJIAN · READY TO WRITE';
    this.welcomeTitle.innerHTML = "从一篇笔记，<br /><em>重新开始。</em>";
    this.welcomeDescription.textContent = `“${workspace.name}” 中已有 ${workspace.notes.length} 篇笔记。文件只会在你选中时读取，每一次修改都会自动保存。`;
    this.renderRecentNotes(workspace);
  }

  private renderRecentNotes(workspace: WorkspaceInfo): void {
    const byPath = new Map(workspace.notes.map((note) => [note.path, note]));
    const notes = storage
      .getRecent(workspace.path)
      .map((recent) => byPath.get(recent.path))
      .filter((note): note is NoteEntry => Boolean(note))
      .slice(0, 3);

    if (notes.length === 0) {
      this.recentSection.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const note of notes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recent-item";
      button.title = note.path;

      const icon = document.createElement("span");
      icon.className = "recent-item__icon";
      icon.innerHTML = iconSvg("file-text", 16);

      const body = document.createElement("span");
      body.className = "recent-item__body";
      const name = document.createElement("span");
      name.className = "recent-item__name";
      name.textContent = note.name;
      const path = document.createElement("span");
      path.className = "recent-item__path";
      path.textContent = directoryLabel(note.path);
      body.append(name, path);

      const arrow = document.createElement("span");
      arrow.className = "recent-item__arrow";
      arrow.innerHTML = iconSvg("arrow-up-right", 15);
      button.append(icon, body, arrow);
      button.addEventListener("click", () => void this.loadNote(note));
      fragment.append(button);
    }

    this.recentList.replaceChildren(fragment);
    this.recentSection.hidden = false;
  }

  private renderTree(): void {
    const scrollTop = this.fileTree.scrollTop;
    const workspace = this.workspace;

    if (!workspace) {
      this.noteCount.textContent = "0";
      this.fileTree.replaceChildren(this.buildTreeEmpty());
      this.fileTree.scrollTop = scrollTop;
      return;
    }

    const total = workspace.notes.length;
    const folders = workspace.folders ?? [];
    const filtered = searchNotes(workspace.notes, this.query);
    this.noteCount.textContent = this.query ? `${filtered.length} / ${total}` : String(total);
    this.noteCount.classList.toggle("count-pill--filtered", Boolean(this.query));
    this.clearSearchButton.hidden = !this.query;
    this.searchKbd.hidden = Boolean(this.query);

    if (total === 0 && folders.length === 0) {
      this.fileTree.replaceChildren(
        this.buildTreeMessage("file-text", "还没有 Markdown 笔记", "使用左侧 + 新建第一篇笔记。"),
      );
      this.fileTree.scrollTop = scrollTop;
      return;
    }

    if (this.query && filtered.length === 0) {
      this.fileTree.replaceChildren(
        this.buildTreeMessage("search", "没有匹配的笔记", "换一个关键词试试。"),
      );
      this.fileTree.scrollTop = scrollTop;
      return;
    }

    const fragment = document.createDocumentFragment();
    if (this.query) {
      for (const note of filtered) fragment.append(this.buildSearchRow(note));
    } else if (this.tree) {
      this.appendTreeChildren(this.tree, 0, fragment);
    }
    this.fileTree.replaceChildren(fragment);
    this.fileTree.scrollTop = scrollTop;
  }

  private buildTreeEmpty(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-empty";
    const icon = document.createElement("span");
    icon.className = "tree-empty__icon";
    icon.innerHTML = iconSvg("book-open", 24);
    const text = document.createElement("span");
    text.innerHTML = "打开一个文件夹<br />建立你的笔记库";
    wrapper.append(icon, text);
    return wrapper;
  }

  private buildTreeMessage(
    iconName: "file-text" | "search",
    title: string,
    hint: string,
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-empty tree-empty--compact";
    const icon = document.createElement("span");
    icon.className = "tree-empty__icon";
    icon.innerHTML = iconSvg(iconName, 22);
    const heading = document.createElement("span");
    heading.className = "tree-empty__title";
    heading.textContent = title;
    const detail = document.createElement("span");
    detail.className = "tree-empty__hint";
    detail.textContent = hint;
    wrapper.append(icon, heading, detail);
    return wrapper;
  }

  private appendTreeChildren(
    folder: FolderNode,
    depth: number,
    parent: DocumentFragment | HTMLElement,
  ): void {
    for (const child of folder.children) {
      if (child.type === "folder") {
        const wrapper = document.createElement("div");
        wrapper.className = "tree-node tree-node--folder";

        const expanded = !this.collapsedFolders.has(child.path);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `tree-row tree-row--folder${expanded ? " is-expanded" : ""}`;
        button.style.setProperty("--tree-depth", String(depth));
        button.setAttribute("aria-expanded", String(expanded));
        button.title = child.path;

        const chevron = document.createElement("span");
        chevron.className = "tree-row__chevron";
        chevron.innerHTML = iconSvg("chevron-right", 13);
        const folderIcon = document.createElement("span");
        folderIcon.className = "tree-row__folder-icon";
        folderIcon.innerHTML = iconSvg(expanded ? "folder-open" : "folder", 16);
        button.dataset.contextKind = "folder";
        button.dataset.contextPath = child.path;
        if (child.children.length === 0) button.classList.add("is-empty");
        const label = document.createElement("span");
        label.className = "tree-row__label";
        label.textContent = child.name;
        const count = countNotes(child);
        const countPill = document.createElement("span");
        countPill.className = "tree-row__count";
        countPill.textContent = count > 0 ? String(count) : "";
        button.append(chevron, folderIcon, label, countPill);

        const children = document.createElement("div");
        children.className = "tree-children";
        children.hidden = !expanded;
        this.appendTreeChildren(child, depth + 1, children);

        button.addEventListener("click", () => {
          const currentlyExpanded = !this.collapsedFolders.has(child.path);
          if (currentlyExpanded) {
            this.collapsedFolders.add(child.path);
          } else {
            this.collapsedFolders.delete(child.path);
          }
          const nowExpanded = !currentlyExpanded;
          children.hidden = !nowExpanded;
          button.classList.toggle("is-expanded", nowExpanded);
          button.setAttribute("aria-expanded", String(nowExpanded));
          setIcon(folderIcon, nowExpanded ? "folder-open" : "folder", 16);
          if (this.workspace) {
            storage.setCollapsedFolders(this.workspace.path, this.collapsedFolders);
          }
        });

        wrapper.append(button, children);
        parent.append(wrapper);
      } else {
        parent.append(this.buildFileRow(child, depth));
      }
    }
  }

  private buildFileRow(file: FileNode, depth: number): HTMLButtonElement {
    const active = this.currentNote?.path === file.path;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-row tree-row--file${active ? " is-active" : ""}`;
    button.style.setProperty("--tree-depth", String(depth));
    button.dataset.notePath = file.path;
    button.dataset.contextKind = "file";
    button.dataset.contextPath = file.path;
    button.title = file.path;
    if (active) button.setAttribute("aria-current", "page");

    const icon = document.createElement("span");
    icon.className = "tree-row__file-icon";
    icon.innerHTML = iconSvg("file-text", 15);
    const label = document.createElement("span");
    label.className = "tree-row__label";
    label.textContent = file.entry.name;
    button.append(icon, label);
    button.addEventListener("click", () => void this.loadNote(file.entry));
    return button;
  }

  private buildSearchRow(note: NoteEntry): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-row tree-row--search";
    button.dataset.notePath = note.path;
    button.dataset.contextKind = "file";
    button.dataset.contextPath = note.path;
    button.title = note.path;

    const icon = document.createElement("span");
    icon.className = "tree-row__file-icon";
    icon.innerHTML = iconSvg("file-text", 15);
    const body = document.createElement("span");
    body.className = "tree-row__search-body";
    const name = document.createElement("span");
    name.className = "tree-row__label";
    name.textContent = note.name;
    const path = document.createElement("span");
    path.className = "tree-row__search-path";
    path.textContent = directoryLabel(note.path);
    body.append(name, path);
    const arrow = document.createElement("span");
    arrow.className = "tree-row__arrow";
    arrow.innerHTML = iconSvg("arrow-up-right", 14);
    button.append(icon, body, arrow);
    button.addEventListener("click", () => void this.loadNote(note));
    return button;
  }

  private clearSearch(focus: boolean): void {
    this.query = "";
    this.fileSearch.value = "";
    this.clearSearchButton.hidden = true;
    this.renderTree();
    if (focus) this.fileSearch.focus();
  }

  private scrollActiveNote(): void {
    requestAnimationFrame(() => {
      const rows = this.fileTree.querySelectorAll<HTMLElement>("[data-note-path]");
      const row = [...rows].find((item) => item.dataset.notePath === this.currentNote?.path);
      row?.scrollIntoView({ block: "nearest" });
    });
  }

  private async loadNote(entry: NoteEntry): Promise<void> {
    if (!this.workspace || this.workspaceBusy) return;
    if (this.currentNote?.path === entry.path) {
      this.editor?.focus();
      return;
    }

    const loadId = ++this.loadToken;
    const saved = await this.saveNow(false);
    if (!saved || loadId !== this.loadToken || !this.workspace) return;

    if (this.currentNote) {
      this.showEditorLoading(true);
      this.editor?.blur();
    }

    try {
      const noteDocument = await workspaceApi.read(entry.path);
      if (loadId !== this.loadToken || !this.workspace) {
        this.showEditorLoading(false);
        return;
      }
      this.mountDocument(entry, noteDocument, loadId);
    } catch (error) {
      if (loadId === this.loadToken) {
        this.showEditorLoading(false);
        this.showToast({
          kind: "error",
          message: `无法打开「${entry.name}」：${errorMessage(error)}`,
          actionLabel: "重试",
          onAction: () => void this.loadNote(entry),
        });
      }
    }
  }

  private mountDocument(entry: NoteEntry, noteDocument: NoteDocument, loadId: number): void {
    if (loadId !== this.loadToken) return;

    this.currentNote = entry;
    this.lastSavedAt = noteDocument.modified;
    this.pendingContent = null;
    this.lastPersistedContent = noteDocument.content;
    this.cancelSaveTimer();
    this.query = "";
    this.fileSearch.value = "";
    this.clearSearchButton.hidden = true;
    this.ensureActiveAncestors(entry.path);

    this.welcome.hidden = true;
    this.editorView.hidden = false;
    this.setSaveState("saved");
    this.setDirtyDot(false);
    this.showEditorLoading(true);
    this.updateStats(noteDocument.content);
    this.updateDocumentChrome();
    this.renderTree();
    this.scrollActiveNote();
    if (this.workspace) {
      storage.pushRecent(this.workspace.path, { path: entry.path, name: entry.name });
    }

    this.destroyEditor();
    const editorToken = ++this.editorToken;
    this.editorMount.replaceChildren();

    try {
      this.editor = createEditor(this.editorMount, noteDocument.content, this.dark, {
        input: (value) => {
          if (this.editorToken !== editorToken || !this.editorReady) return;
          this.handleEditorInput(value);
        },
        after: () => {
          if (this.editorToken !== editorToken || this.currentNote?.path !== entry.path) return;
          this.editorReady = true;
          this.lastPersistedContent = this.editor?.getValue() ?? noteDocument.content;
          if (this.editor) applyEditorTheme(this.editor, this.dark);
          this.clearEditorInitTimer();
          this.showEditorLoading(false);
          this.editor?.focus();
        },
      });
    } catch (error) {
      this.clearEditorInitTimer();
      this.showEditorLoading(false);
      this.currentNote = null;
      this.setSaveState("idle");
      this.showWelcomeView();
      this.updateDocumentChrome();
      this.updateWelcome();
      this.showToast({
        kind: "error",
        message: `编辑器加载失败：${errorMessage(error)}`,
      });
      return;
    }

    this.editorInitTimer = window.setTimeout(() => {
      if (this.editorToken !== editorToken || this.editorReady) return;
      this.showEditorLoading(false);
      this.showToast({
        kind: "error",
        message: "编辑器资源加载超时，请重启应用后再试。",
        duration: 8000,
      });
    }, 12000);
  }

  private handleEditorInput(value: string): void {
    if (!this.currentNote) return;
    this.pendingContent = value;
    this.updateStats(value);
    this.setSaveState("pending");
    this.setDirtyDot(true);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.cancelSaveTimer();
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow(false);
    }, AUTO_SAVE_MS);
  }

  private cancelSaveTimer(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private captureEditorValue(): void {
    if (
      !this.currentNote ||
      !this.editor ||
      !this.editorReady ||
      this.lastPersistedContent === null
    ) {
      return;
    }
    const value = this.editor.getValue();
    if (value === this.lastPersistedContent) return;

    this.pendingContent = value;
    this.updateStats(value);
    this.setDirtyDot(true);
    if (!this.savePromise) this.setSaveState("pending");
  }

  private async saveNow(manual: boolean): Promise<boolean> {
    this.cancelSaveTimer();

    if (!this.currentNote) return true;
    this.captureEditorValue();

    if (this.savePromise) {
      const inFlight = await this.savePromise;
      if (!inFlight) return false;
      if (this.pendingContent !== null) return this.saveNow(manual);
      return true;
    }

    if (this.pendingContent === null) {
      if (manual) {
        this.setSaveState("saved");
        this.showToast({ kind: "success", message: "当前内容已是最新版本。" });
      }
      return true;
    }

    const path = this.currentNote.path;
    const content = this.pendingContent;
    this.pendingContent = null;
    this.setSaveState("saving");

    const operation = (async (): Promise<boolean> => {
      try {
        const saved = await workspaceApi.save(path, content);
        this.lastPersistedContent = content;
        if (this.currentNote?.path === path) {
          this.currentNote.modified = saved.modified;
          this.currentNote.size = saved.size;
          this.lastSavedAt = saved.modified;
          this.updateUpdatedLabel();
          if (this.pendingContent === null) {
            this.setDirtyDot(false);
            this.setSaveState("saved");
          }
        }
        return true;
      } catch (error) {
        const message = errorMessage(error);
        this.lastSaveErrorMessage = message;
        if (this.currentNote?.path === path) {
          if (this.pendingContent === null) this.pendingContent = content;
          this.setDirtyDot(true);
          this.setSaveState("error");
          this.notifySaveError(message);
        }
        return false;
      }
    })();

    this.savePromise = operation;
    const saved = await operation;
    this.savePromise = null;

    if (this.currentNote?.path === path && this.pendingContent !== null) {
      if (saved) return this.saveNow(manual);
      return false;
    }

    if (manual && saved && this.currentNote?.path === path) {
      this.showToast({ kind: "success", message: "笔记已保存。" });
    }
    return saved;
  }

  private notifySaveError(message: string): void {
    const now = Date.now();
    if (now - this.lastErrorToastAt < 6000) return;
    this.lastErrorToastAt = now;
    this.showToast({
      kind: "error",
      message: `自动保存失败：${message}`,
      actionLabel: "立即重试",
      onAction: () => void this.saveNow(true),
      duration: 9000,
    });
  }

  private hasUnsavedChanges(): boolean {
    this.captureEditorValue();
    return (
      this.pendingContent !== null ||
      this.savePromise !== null ||
      this.saveTimer !== null ||
      this.saveState === "saving" ||
      this.saveState === "error"
    );
  }

  private setSaveState(state: SaveState): void {
    this.saveState = state;
    this.updateSaveStatus();
  }

  private updateSaveStatus(): void {
    const labels: Record<SaveState, string> = {
      idle: "未选择笔记",
      pending: "待保存",
      saving: "正在保存…",
      saved: "已保存",
      error: "保存失败",
    };
    this.saveStatus.dataset.state = this.saveState;
    this.autosaveIndicator.dataset.state = this.saveState;
    this.saveStatusText.textContent = labels[this.saveState];
    this.saveStatusTime.textContent =
      this.saveState === "saved" && this.lastSavedAt ? timeLabel(this.lastSavedAt) : "";
    this.saveStatus.disabled = !this.currentNote;

    if (this.saveState === "error") {
      this.saveStatus.title = `保存失败，点击重试。${this.lastSaveErrorMessage}`.trim();
    } else if (this.saveState === "saved") {
      this.saveStatus.title = "所有修改均已保存，点击可手动保存 (Ctrl + S)";
    } else {
      this.saveStatus.title = "立即保存 (Ctrl + S)";
    }

    const sideMessages: Record<SaveState, string> = {
      idle: this.currentNote ? "自动保存已开启" : "等待打开笔记",
      pending: "等待自动保存…",
      saving: "正在保存…",
      saved: this.lastSavedAt ? `自动保存 · ${timeLabel(this.lastSavedAt)}` : "自动保存已开启",
      error: "自动保存已暂停",
    };
    this.sidebarSaveMessage.textContent = sideMessages[this.saveState];
    this.dirtyDot.hidden =
      !this.currentNote ||
      (this.saveState !== "pending" && this.saveState !== "saving" && this.saveState !== "error");
    this.dirtyDot.setAttribute(
      "aria-label",
      this.saveState === "error" ? "保存失败，修改尚未写入磁盘" : "有未保存的修改",
    );
  }

  private setDirtyDot(dirty: boolean): void {
    this.dirtyDot.hidden = !this.currentNote || !dirty;
  }

  private updateStats(value: string): void {
    this.characterCount = countCharacters(value);
    this.wordCount.textContent = formatCharacters(this.characterCount);
  }

  private updateUpdatedLabel(): void {
    if (!this.currentNote) return;
    this.documentUpdated.textContent = updatedLabel(this.currentNote.modified);
  }

  private updateDocumentChrome(): void {
    if (!this.currentNote) {
      this.breadcrumbNote.textContent = "未选择笔记";
      this.dirtyDot.hidden = true;
      document.title = "墨笺 · Markdown";
      this.updateManagementActions();
      return;
    }

    const note = this.currentNote;
    const workspaceName = this.workspace?.name ?? "笔记库";
    this.breadcrumbNote.textContent = note.name;
    this.documentTitle.textContent = note.name;
    this.documentPath.textContent = `${workspaceName} / ${note.path}`;
    this.documentPath.title = note.path;
    this.updateUpdatedLabel();
    document.title = `${note.name} · 墨笺`;
    this.updateManagementActions();
  }

  private showWelcomeView(): void {
    this.welcome.hidden = false;
    this.editorView.hidden = true;
    this.lastPersistedContent = null;
    this.documentTitle.textContent = "未命名笔记";
    this.documentPath.textContent = this.workspace?.name ?? "笔记库";
    this.documentUpdated.textContent = "刚刚更新";
    this.wordCount.textContent = "0 字符";
    this.characterCount = 0;
    document.title = "墨笺 · Markdown";
  }

  private showEditorLoading(visible: boolean): void {
    this.editorLoading.classList.toggle("is-visible", visible);
    this.editorView.setAttribute("aria-busy", String(visible));
  }

  private clearEditorInitTimer(): void {
    if (this.editorInitTimer !== null) {
      window.clearTimeout(this.editorInitTimer);
      this.editorInitTimer = null;
    }
  }

  private destroyEditor(): void {
    this.closeContextMenu();
    this.clearEditorInitTimer();
    this.editorReady = false;
    const editor = this.editor;
    this.editor = null;
    if (editor) {
      try {
        editor.destroy();
      } catch (_) {
        /* Vditor may already have torn itself down */
      }
    }
    this.editorMount.replaceChildren();
    this.showEditorLoading(false);
  }

  private ensureActiveAncestors(path: string): void {
    let changed = false;
    for (const ancestor of folderAncestors(path)) {
      if (this.collapsedFolders.delete(ancestor)) changed = true;
    }
    if (changed && this.workspace) {
      storage.setCollapsedFolders(this.workspace.path, this.collapsedFolders);
    }
  }

  private defaultParentPath(): string {
    return this.currentNote ? parentDirectory(this.currentNote.path) : "";
  }

  private folderLabel(path: string): string {
    return path || "笔记库根目录";
  }

  private noteExtension(note: NoteEntry): string {
    return /\.markdown$/i.test(note.fileName) ? ".markdown" : ".md";
  }

  private menuShortcut(action: ActionMenuItem["id"]): string {
    const apple = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
    switch (action) {
      case "new-note":
        return apple ? "⌘ N" : "Ctrl N";
      case "new-folder":
        return apple ? "⌘ ⇧ N" : "Ctrl ⇧ N";
      case "rename-note":
        return "F2";
      default:
        return "";
    }
  }

  private createActionItems(): ActionMenuItem[] {
    return [
      {
        id: "new-note",
        label: "新建笔记",
        icon: "file-plus",
        shortcut: this.menuShortcut("new-note"),
      },
      {
        id: "new-folder",
        label: "新建文件夹",
        icon: "folder-plus",
        shortcut: this.menuShortcut("new-folder"),
      },
    ];
  }

  private uniqueEntryName(parentPath: string, mode: "new-note" | "new-folder"): string {
    const base = mode === "new-folder" ? "新建文件夹" : "未命名笔记";
    const existing = new Set<string>();

    if (mode === "new-folder") {
      for (const folder of this.workspace?.folders ?? []) {
        if (parentDirectory(folder) === parentPath) {
          existing.add((folder.split("/").pop() ?? "").toLocaleLowerCase("zh-Hans-CN"));
        }
      }
    } else {
      for (const note of this.workspace?.notes ?? []) {
        if (parentDirectory(note.path) === parentPath) {
          existing.add(note.name.toLocaleLowerCase("zh-Hans-CN"));
        }
      }
    }

    let index = 1;
    let candidate = base;
    while (existing.has(candidate.toLocaleLowerCase("zh-Hans-CN"))) {
      index += 1;
      candidate = `${base} ${index}`;
    }
    return candidate;
  }

  private validateEntryName(raw: string, mode: EntryDialogMode): string | null {
    const name = raw.trim();
    if (!name) return "名称不能为空。";
    if (name.length > 80) return "名称过长，请控制在 80 个字符以内。";
    if (name === "." || name === "..") return "这个名称不可用。";
    if (name.startsWith(".")) return "名称不能以点号开头。";
    if (/[\\/]/.test(name)) return "名称中不能包含斜杠。";
    if (/[\u0000-\u001f<>:"|?*]/.test(name)) return "名称包含不支持的字符。";
    if (/[. ]$/.test(name)) return "名称不能以空格或点号结尾。";

    const stem = mode === "new-folder" ? name : name.replace(/\.(md|markdown)$/i, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
      return "这个名称是系统保留名称，请换一个。";
    }
    return null;
  }

  private showEntryError(message: string): void {
    this.entryError.textContent = message;
    if (this.entryDialog.open) {
      this.entryInput.focus();
      this.entryInput.select();
    }
  }

  private setEntryBusy(busy: boolean): void {
    this.entryBusy = busy;
    this.entryInput.disabled = busy;
    this.entryConfirm.disabled = busy;
    this.entryCancel.disabled = busy;
    this.entryClose.disabled = busy;
    this.entryDialog.setAttribute("aria-busy", String(busy));
    this.entryConfirm.textContent = busy
      ? "处理中…"
      : this.entryMode === "rename-note"
        ? "重命名"
        : "创建";
  }

  private closeEntryDialog(): void {
    if (this.entryBusy) return;
    this.entryDialog.close();
    this.entryMode = null;
    this.entryNote = null;
    this.entryError.textContent = "";
  }

  private openEntryDialog(
    mode: EntryDialogMode,
    parentPath: string,
    note: NoteEntry | null = null,
  ): void {
    if (!this.workspace || this.workspaceBusy) return;
    if (mode === "rename-note" && !note) return;

    this.closeContextMenu();
    if (this.entryDialog.open) this.entryDialog.close();

    this.entryMode = mode;
    this.entryParent = parentPath;
    this.entryNote = note;
    this.entryExtension = note ? this.noteExtension(note) : ".md";
    this.entryError.textContent = "";
    this.setEntryBusy(false);

    const target = this.folderLabel(parentPath);
    this.entrySuffix.hidden = mode === "new-folder";
    this.entrySuffix.textContent = this.entryExtension;
    this.entryInput.disabled = false;

    if (mode === "new-note") {
      this.entryEyebrow.textContent = "NEW NOTE";
      this.entryTitle.textContent = "新建笔记";
      this.entryDescription.textContent = `在「${target}」中创建一篇 Markdown 笔记。`;
      this.entryInput.value = this.uniqueEntryName(parentPath, "new-note");
      this.entryInput.placeholder = "为这篇笔记命名";
      this.entryConfirm.textContent = "创建";
    } else if (mode === "new-folder") {
      this.entryEyebrow.textContent = "NEW FOLDER";
      this.entryTitle.textContent = "新建文件夹";
      this.entryDescription.textContent = `在「${target}」中创建一个文件夹。`;
      this.entryInput.value = this.uniqueEntryName(parentPath, "new-folder");
      this.entryInput.placeholder = "为文件夹命名";
      this.entryConfirm.textContent = "创建";
    } else if (note) {
      this.entryEyebrow.textContent = "RENAME NOTE";
      this.entryTitle.textContent = "重命名笔记";
      this.entryDescription.textContent = `将「${note.fileName}」更名，笔记内容不会改变。`;
      this.entryInput.value = note.name;
      this.entryInput.placeholder = "输入新的文件名";
      this.entryConfirm.textContent = "重命名";
    }

    this.entryDialog.showModal();
    requestAnimationFrame(() => {
      this.entryInput.focus();
      this.entryInput.select();
    });
  }

  private async submitEntryDialog(): Promise<void> {
    const mode = this.entryMode;
    const workspace = this.workspace;
    if (!mode || this.entryBusy || !workspace) return;

    const parentPath = this.entryParent;
    const source = this.entryNote;
    let base = this.entryInput.value.trim();
    if (mode !== "new-folder") base = base.replace(/\.(md|markdown)$/i, "").trim();

    const nameError = this.validateEntryName(base, mode);
    if (nameError) {
      this.showEntryError(nameError);
      return;
    }

    const extension = mode === "new-note" ? ".md" : this.entryExtension;
    const fileName = mode === "new-folder" ? base : `${base}${extension}`;
    const targetPath = parentPath ? `${parentPath}/${fileName}` : fileName;
    const targetKey = targetPath.toLocaleLowerCase("zh-Hans-CN");

    if (mode === "new-folder") {
      if ((workspace.folders ?? []).some((folder) => folder.toLocaleLowerCase("zh-Hans-CN") === targetKey)) {
        this.showEntryError("这个文件夹已经存在。");
        return;
      }
    } else if (mode === "rename-note" && source) {
      if (targetPath === source.path) {
        this.showEntryError("新名称与当前名称相同。");
        return;
      }
      const conflict = workspace.notes.find(
        (note) => note.path !== source.path && note.path.toLocaleLowerCase("zh-Hans-CN") === targetKey,
      );
      if (conflict) {
        this.showEntryError("同一目录下已经存在同名笔记。");
        return;
      }
    } else {
      const conflict = workspace.notes.find(
        (note) => note.path.toLocaleLowerCase("zh-Hans-CN") === targetKey,
      );
      if (conflict) {
        this.showEntryError("同一目录下已经存在同名笔记。");
        return;
      }
    }

    this.entryError.textContent = "";
    this.setEntryBusy(true);

    let resultPath = "";
    try {
      if (mode === "new-note") {
        if (!(await this.saveNow(false))) {
          throw new Error("当前笔记保存失败，请重试后再新建。");
        }
        resultPath = await workspaceApi.createNote(parentPath, fileName);
      } else if (mode === "new-folder") {
        resultPath = await workspaceApi.createFolder(parentPath, base);
      } else if (source) {
        if (this.currentNote?.path === source.path && !(await this.saveNow(false))) {
          throw new Error("当前笔记保存失败，请重试后再重命名。");
        }
        resultPath = await workspaceApi.renameNote(source.path, fileName);
      }
    } catch (error) {
      this.setEntryBusy(false);
      this.showEntryError(
        `${mode === "new-folder" ? "新建文件夹" : mode === "new-note" ? "新建笔记" : "重命名"}失败：${errorMessage(error)}`,
      );
      return;
    }

    this.setEntryBusy(false);
    this.closeEntryDialog();

    if (mode === "new-note") {
      this.resetSearchQuery();
      this.expandFolderChain(parentPath);
      const info = await this.rescanWorkspace(false);
      if (!info) {
        this.showToast({
          kind: "info",
          message: `笔记「${base}」已创建，请刷新笔记库查看。`,
        });
        return;
      }
      const entry = info.notes.find((note) => note.path === resultPath);
      if (!entry) {
        this.showToast({ kind: "info", message: "笔记已创建，但暂时无法定位它，请刷新笔记库。" });
        return;
      }
      await this.loadNote(entry);
      this.showToast({ kind: "success", message: `已创建笔记「${base}」` });
      return;
    }

    if (mode === "new-folder") {
      this.resetSearchQuery();
      this.expandFolderChain(parentPath);
      const info = await this.rescanWorkspace(false);
      if (info) this.scrollTreeToPath("folder", resultPath);
      this.showToast({
        kind: info ? "success" : "info",
        message: info ? `已创建文件夹「${base}」` : `文件夹「${base}」已创建，请刷新笔记库查看。`,
      });
      return;
    }

    if (mode === "rename-note" && source) {
      storage.renameRecent(workspace.path, source.path, { path: resultPath, name: base });
      const wasCurrent = this.currentNote?.path === source.path;
      if (wasCurrent) {
        this.currentNote = {
          ...source,
          path: resultPath,
          name: base,
          fileName,
        };
        this.updateDocumentChrome();
      }

      const info = await this.rescanWorkspace(false);
      if (wasCurrent) {
        this.updateDocumentChrome();
      } else if (info) {
        this.scrollTreeToPath("file", resultPath);
      }
      this.showToast({
        kind: info ? "success" : "info",
        message: info ? `已重命名为「${base}」` : `已重命名为「${base}」，请刷新笔记库查看。`,
      });
    }
  }

  private setDeleteBusy(busy: boolean): void {
    this.deleteBusy = busy;
    this.deleteConfirm.disabled = busy;
    this.deleteCancel.disabled = busy;
    this.deleteDialog.setAttribute("aria-busy", String(busy));
    this.deleteConfirm.textContent = busy ? "删除中…" : "删除笔记";
  }

  private closeDeleteDialog(): void {
    if (this.deleteBusy) return;
    this.deleteDialog.close();
    this.deleteTarget = null;
    this.deleteError.textContent = "";
  }

  private openDeleteDialog(note: NoteEntry): void {
    if (!this.workspace || this.workspaceBusy) return;
    this.closeContextMenu();
    this.deleteTarget = note;
    this.deleteError.textContent = "";
    this.setDeleteBusy(false);
    const isCurrent = this.currentNote?.path === note.path;
    this.deleteDescription.textContent = isCurrent
      ? "这篇正在编辑的笔记会从磁盘永久删除，编辑区将关闭，未保存的修改也会丢失。"
      : "这篇笔记会从磁盘永久删除，此操作无法撤销。";
    this.deletePath.textContent = note.path;
    this.deleteDialog.showModal();
    requestAnimationFrame(() => this.deleteCancel.focus());
  }

  private async confirmDelete(): Promise<void> {
    const target = this.deleteTarget;
    const workspace = this.workspace;
    if (!target || !workspace || this.deleteBusy) return;

    const isCurrent = this.currentNote?.path === target.path;
    this.deleteError.textContent = "";
    this.setDeleteBusy(true);

    if (isCurrent) {
      // Finish any pending write before deleting. Leaving a save in flight
      // could otherwise recreate the file just after removal.
      const saved = await this.saveNow(false);
      if (!saved) {
        this.setDeleteBusy(false);
        this.deleteError.textContent = "当前笔记保存失败，删除已取消。请先重试保存。";
        return;
      }
      this.cancelSaveTimer();
    }

    try {
      await workspaceApi.deleteNote(target.path);
    } catch (error) {
      this.setDeleteBusy(false);
      this.deleteError.textContent = `删除失败：${errorMessage(error)}`;
      if (isCurrent && this.pendingContent !== null) {
        this.setSaveState("pending");
        this.scheduleSave();
      }
      return;
    }

    this.setDeleteBusy(false);
    this.deleteDialog.close();
    this.deleteTarget = null;
    storage.removeRecent(workspace.path, target.path);

    if (isCurrent) {
      this.closeCurrentNoteForRemoval();
    }

    const info = await this.rescanWorkspace(false);
    this.showToast({
      kind: info ? "success" : "info",
      message: info
        ? `已删除笔记「${target.name}」`
        : `笔记「${target.name}」已删除，请刷新笔记库查看。`,
    });
  }

  private expandFolderChain(folderPath: string): void {
    if (!folderPath) return;
    let changed = false;
    for (const ancestor of folderAncestors(folderPath)) {
      if (this.collapsedFolders.delete(ancestor)) changed = true;
    }
    if (this.collapsedFolders.delete(folderPath)) changed = true;
    if (changed && this.workspace) {
      storage.setCollapsedFolders(this.workspace.path, this.collapsedFolders);
    }
  }

  private resetSearchQuery(): void {
    this.query = "";
    this.fileSearch.value = "";
    this.clearSearchButton.hidden = true;
    this.searchKbd.hidden = false;
  }

  private scrollTreeToPath(kind: "folder" | "file", path: string): void {
    requestAnimationFrame(() => {
      const rows = this.fileTree.querySelectorAll<HTMLElement>(`[data-context-kind="${kind}"]`);
      const row = [...rows].find((item) => item.dataset.contextPath === path);
      row?.scrollIntoView({ block: "nearest" });
      if (row) {
        row.classList.add("is-new-entry");
        window.setTimeout(() => row.classList.remove("is-new-entry"), 1400);
      }
    });
  }

  private handleContextMenu(event: MouseEvent): void {
    // Suppress the system/webview menu everywhere. Only the note tree and
    // editable text get an application menu.
    event.preventDefault();

    const target = event.target;
    if (!(target instanceof Element)) {
      this.closeContextMenu();
      return;
    }
    if (this.contextMenu.contains(target)) return;

    if (this.fileTree.contains(target)) {
      if (this.workspace) {
        this.handleTreeContextMenu(event);
      } else {
        this.closeContextMenu();
      }
      return;
    }

    const textTarget = this.resolveTextMenuTarget(target);
    if (textTarget) {
      this.openTextMenu(event.clientX, event.clientY, textTarget);
      return;
    }
    this.closeContextMenu();
  }

  private resolveTextMenuTarget(target: Element): TextMenuTarget | null {
    if (this.editorMount.contains(target)) {
      const editable = target.closest('[contenteditable="true"]');
      if (editable && this.editorMount.contains(editable)) return "editor";
    }

    const field = target.closest("input, textarea");
    if (field instanceof HTMLInputElement) {
      if (field.disabled || field.readOnly) return null;
      if (["text", "search", "url", "email", "tel"].includes(field.type)) return field;
      return null;
    }
    if (field instanceof HTMLTextAreaElement) {
      if (field.disabled || field.readOnly) return null;
      return field;
    }
    return null;
  }

  private textShortcut(key: string, shift = false): string {
    const apple = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return apple ? `⌘${shift ? " ⇧" : ""} ${key}` : `Ctrl${shift ? " ⇧" : ""} ${key}`;
  }

  private openTextMenu(x: number, y: number, target: TextMenuTarget): void {
    if (target === "editor") {
      if (!this.editor || !this.editorReady) {
        this.closeContextMenu();
        return;
      }
      this.placeEditorCaret(x, y);
      const anchor =
        this.editorMount.querySelector<HTMLElement>(".vditor-ir pre.vditor-reset") ?? undefined;

      const hasSelection = this.editorSelectionText().length > 0;
      const items: Array<ContextMenuItem | null> = [
        {
          id: "undo",
          label: "撤销",
          icon: "undo",
          shortcut: this.textShortcut("Z"),
          disabled: !this.editorCommandAvailable("undo"),
          run: () => this.runEditorHistory("undo"),
        },
        {
          id: "redo",
          label: "重做",
          icon: "redo",
          shortcut: this.textShortcut("Z", true),
          disabled: !this.editorCommandAvailable("redo"),
          run: () => this.runEditorHistory("redo"),
        },
        null,
        {
          id: "cut",
          label: "剪切",
          icon: "scissors",
          shortcut: this.textShortcut("X"),
          disabled: !hasSelection,
          run: () => this.runEditorClipboard("cut"),
        },
        {
          id: "copy",
          label: "复制",
          icon: "copy",
          shortcut: this.textShortcut("C"),
          disabled: !hasSelection,
          run: () => this.runEditorClipboard("copy"),
        },
        {
          id: "paste",
          label: "粘贴",
          icon: "clipboard",
          shortcut: this.textShortcut("V"),
          disabled: true,
          run: () => this.pasteIntoEditor(false),
        },
        {
          id: "paste-plain",
          label: "粘贴为纯文本",
          icon: "clipboard-text",
          shortcut: this.textShortcut("V", true),
          disabled: true,
          run: () => this.pasteIntoEditor(true),
        },
        null,
        {
          id: "select-all",
          label: "全选",
          icon: "select-all",
          shortcut: this.textShortcut("A"),
          run: () => this.selectEditorContent(),
        },
      ];
      this.showTextMenu({ x, y, items, anchor });
      return;
    }

    const input = target;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const hasSelection = start !== end;
    const items: Array<ContextMenuItem | null> = [
      {
        id: "cut",
        label: "剪切",
        icon: "scissors",
        shortcut: this.textShortcut("X"),
        disabled: !hasSelection,
        run: () => this.runInputClipboard(input, start, end, "cut"),
      },
      {
        id: "copy",
        label: "复制",
        icon: "copy",
        shortcut: this.textShortcut("C"),
        disabled: !hasSelection,
        run: () => this.runInputClipboard(input, start, end, "copy"),
      },
      {
        id: "paste",
        label: "粘贴",
        icon: "clipboard",
        shortcut: this.textShortcut("V"),
        disabled: true,
        run: () => this.pasteIntoInput(input, start, end),
      },
      null,
      {
        id: "select-all",
        label: "全选",
        icon: "select-all",
        shortcut: this.textShortcut("A"),
        run: () => {
          input.focus();
          input.select();
        },
      },
    ];
    this.showTextMenu({
      x,
      y,
      items,
      anchor: input,
      hostDialog: input.closest("dialog") as HTMLDialogElement | null,
    });
  }

  private showTextMenu(options: {
    x: number;
    y: number;
    items: Array<ContextMenuItem | null>;
    anchor?: HTMLElement;
    hostDialog?: HTMLDialogElement | null;
  }): void {
    const buttons = this.renderMenu({
      x: options.x,
      y: options.y,
      anchor: options.anchor,
      hostDialog: options.hostDialog,
      ariaLabel: "文本操作",
      items: options.items,
    });

    void readClipboardText().then((text) => {
      if (!text) return;
      for (const id of ["paste", "paste-plain"]) {
        const button = buttons.get(id);
        if (button?.isConnected) button.disabled = false;
      }
    });
  }

  private placeEditorCaret(x: number, y: number): void {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return;

    const caretRangeFromPoint = (
      document as Document & {
        caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
      }
    ).caretRangeFromPoint;
    const range = caretRangeFromPoint?.call(document, x, y);
    if (!range || !this.editorMount.contains(range.startContainer)) return;

    selection.removeAllRanges();
    selection.addRange(range);
  }

  private editorSelectionText(): string {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return "";
    const range = selection.getRangeAt(0);
    if (!this.editorMount.contains(range.commonAncestorContainer)) return "";
    return selection.toString();
  }

  private editorCommandAvailable(command: "undo" | "redo"): boolean {
    const button = this.editorMount.querySelector<HTMLElement>(
      `.vditor-toolbar [data-type="${command}"]`,
    );
    return button !== null && !button.classList.contains("vditor-menu--disabled");
  }

  private runEditorHistory(action: "undo" | "redo"): void {
    const editor = this.editor;
    const undo = editor?.vditor.undo;
    if (!editor || !undo) return;
    editor.focus();
    if (action === "undo") {
      undo.undo(editor.vditor);
    } else {
      undo.redo(editor.vditor);
    }
    this.handleEditorInput(editor.getValue());
  }

  private runEditorClipboard(action: "cut" | "copy"): void {
    const text = this.editorSelectionText();
    if (!text) return;

    const editor = this.editor;
    editor?.focus();
    if (document.execCommand(action)) return;

    void writeClipboardText(text).then((written) => {
      if (!written) {
        this.showToast({ kind: "error", message: "无法写入剪贴板。" });
        return;
      }
      if (action === "cut") {
        editor?.deleteValue();
        if (editor) this.handleEditorInput(editor.getValue());
      }
    });
  }

  private async pasteIntoEditor(plainText: boolean): Promise<void> {
    const editor = this.editor;
    if (!editor || !this.editorReady) return;

    const text = await readClipboardText();
    if (!text) {
      this.showToast({ kind: "info", message: "剪贴板为空或无法读取。" });
      return;
    }

    editor.focus();
    const markdown = plainText ? this.escapePlainText(text) : this.escapeHtml(text);
    editor.insertMD(markdown);
    this.handleEditorInput(editor.getValue());
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private escapePlainText(text: string): string {
    return this.escapeHtml(text)
      .replace(/\\/g, "\\\\")
      .replace(/([`*_{}\[\]()#+\-.!|~])/g, "\\$1");
  }

  private selectEditorContent(): void {
    const editor = this.editor;
    if (!editor) return;
    editor.focus();

    const element = this.editorMount.querySelector<HTMLElement>(".vditor-ir pre.vditor-reset");
    if (!element) return;

    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private runInputClipboard(
    input: HTMLInputElement | HTMLTextAreaElement,
    start: number,
    end: number,
    action: "cut" | "copy",
  ): void {
    input.focus();
    input.setSelectionRange(start, end);

    if (document.execCommand(action)) return;

    void writeClipboardText(input.value.slice(start, end)).then((written) => {
      if (!written || action !== "cut") return;
      input.focus();
      input.setRangeText("", start, end, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  private async pasteIntoInput(
    input: HTMLInputElement | HTMLTextAreaElement,
    start: number,
    end: number,
  ): Promise<void> {
    const text = await readClipboardText();
    if (!text) {
      this.showToast({ kind: "info", message: "剪贴板为空或无法读取。" });
      return;
    }

    input.focus();
    input.setSelectionRange(start, end);
    if (document.execCommand("insertText", false, text)) return;

    input.setRangeText(text, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private handleTreeContextMenu(event: MouseEvent): void {
    if (!this.workspace) return;
    event.preventDefault();

    const row = (event.target as Element | null)?.closest<HTMLElement>("[data-context-kind]");
    const kind = row?.dataset.contextKind;
    const path = row?.dataset.contextPath;

    if (kind === "file" && path) {
      const note = this.workspace.notes.find((item) => item.path === path);
      if (note) {
        this.openFileActions(event.clientX, event.clientY, note);
        return;
      }
    }
    if (kind === "folder" && path) {
      this.openFolderActions(event.clientX, event.clientY, path);
      return;
    }
    this.openFolderActions(event.clientX, event.clientY, "");
  }

  private openFileActions(x: number, y: number, note: NoteEntry): void {
    const parentPath = parentDirectory(note.path);
    const items: Array<ActionMenuItem | null> = [
      ...this.createActionItems(),
      null,
      {
        id: "rename-note",
        label: "重命名笔记",
        icon: "pencil",
        shortcut: this.menuShortcut("rename-note"),
      },
      { id: "delete-note", label: "删除笔记", icon: "trash", danger: true },
    ];

    this.showActionMenu({
      x,
      y,
      eyebrow: "NOTE",
      targetLabel: note.path,
      items,
      onSelect: (action) => {
        if (action === "new-note" || action === "new-folder") {
          this.openEntryDialog(action, parentPath);
        } else if (action === "rename-note") {
          this.openEntryDialog("rename-note", parentPath, note);
        } else if (action === "delete-note") {
          this.openDeleteDialog(note);
        }
      },
    });
  }

  private openFolderActions(x: number, y: number, folderPath: string): void {
    this.showActionMenu({
      x,
      y,
      eyebrow: "FOLDER",
      targetLabel: this.folderLabel(folderPath),
      items: this.createActionItems(),
      onSelect: (action) => {
        if (action === "new-note" || action === "new-folder") {
          this.openEntryDialog(action, folderPath);
        }
      },
    });
  }

  private toggleCreateMenu(): void {
    if (!this.workspace || this.workspaceBusy) return;
    if (!this.contextMenu.hidden && this.contextMenuAnchor === this.createEntryButton) {
      this.closeContextMenu();
      return;
    }

    const parentPath = this.defaultParentPath();
    const rect = this.createEntryButton.getBoundingClientRect();
    this.showActionMenu({
      x: rect.left,
      y: rect.bottom + 5,
      anchor: this.createEntryButton,
      eyebrow: "NEW IN",
      targetLabel: this.folderLabel(parentPath),
      items: this.createActionItems(),
      onSelect: (action) => {
        if (action === "new-note" || action === "new-folder") {
          this.openEntryDialog(action, parentPath);
        }
      },
    });
  }

  private showActionMenu(options: {
    x: number;
    y: number;
    anchor?: HTMLElement;
    eyebrow: string;
    targetLabel: string;
    items: Array<ActionMenuItem | null>;
    onSelect: (action: ActionMenuItem["id"]) => void;
  }): void {
    const items = options.items.map<ContextMenuItem | null>((item) =>
      item
        ? {
            id: item.id,
            label: item.label,
            icon: item.icon,
            shortcut: item.shortcut,
            danger: item.danger,
            run: () => options.onSelect(item.id),
          }
        : null,
    );

    this.renderMenu({
      x: options.x,
      y: options.y,
      anchor: options.anchor,
      ariaLabel: "笔记操作",
      head: { eyebrow: options.eyebrow, targetLabel: options.targetLabel },
      items,
    });
  }

  private renderMenu(options: {
    x: number;
    y: number;
    anchor?: HTMLElement;
    hostDialog?: HTMLDialogElement | null;
    ariaLabel: string;
    head?: { eyebrow: string; targetLabel: string };
    items: Array<ContextMenuItem | null>;
  }): Map<string, HTMLButtonElement> {
    this.closeContextMenu();
    this.contextMenu.replaceChildren();
    this.contextMenu.setAttribute("aria-label", options.ariaLabel);
    this.contextMenu.classList.toggle("context-menu--text", !options.head);

    if (options.hostDialog?.open) {
      options.hostDialog.classList.add("dialog--menu-open");
      options.hostDialog.append(this.contextMenu);
      this.contextMenuHostDialog = options.hostDialog;
    }

    if (options.head) {
      const head = document.createElement("div");
      head.className = "context-menu__head";
      const eyebrow = document.createElement("span");
      eyebrow.className = "context-menu__eyebrow";
      eyebrow.textContent = options.head.eyebrow;
      const target = document.createElement("span");
      target.className = "context-menu__target";
      target.textContent = options.head.targetLabel;
      head.append(eyebrow, target);
      this.contextMenu.append(head);
    }

    const buttons = new Map<string, HTMLButtonElement>();
    for (const item of options.items) {
      if (!item) {
        const separator = document.createElement("div");
        separator.className = "context-menu__separator";
        this.contextMenu.append(separator);
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = `context-menu__item${item.danger ? " context-menu__item--danger" : ""}`;
      button.setAttribute("role", "menuitem");
      button.dataset.menuItem = item.id;
      button.disabled = item.disabled ?? false;

      const icon = document.createElement("span");
      icon.className = "context-menu__item-icon";
      icon.innerHTML = iconSvg(item.icon, 16);

      const label = document.createElement("span");
      label.className = "context-menu__item-label";
      label.textContent = item.label;

      const shortcut = document.createElement("span");
      shortcut.className = "context-menu__shortcut";
      shortcut.textContent = item.shortcut ?? "";

      button.append(icon, label, shortcut);
      button.addEventListener("click", () => {
        if (button.disabled) return;
        this.closeContextMenu();
        void item.run();
      });

      buttons.set(item.id, button);
      this.contextMenu.append(button);
    }

    this.contextMenu.hidden = false;
    if (options.anchor) {
      this.contextMenuAnchor = options.anchor;
      if (options.anchor === this.createEntryButton) {
        this.createEntryButton.setAttribute("aria-expanded", "true");
        this.createEntryButton.classList.add("is-menu-open");
      }
    }

    const rect = this.contextMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(options.x, window.innerWidth - rect.width - 8));
    const top =
      options.y + rect.height > window.innerHeight - 8
        ? Math.max(8, options.y - rect.height - 6)
        : options.y;
    this.contextMenu.style.left = `${Math.round(left)}px`;
    this.contextMenu.style.top = `${Math.round(top)}px`;

    requestAnimationFrame(() => {
      [...buttons.values()].find((button) => !button.disabled)?.focus();
    });

    return buttons;
  }

  private closeContextMenu(restoreFocus = false): void {
    if (this.contextMenu.hidden) return;
    const anchor = this.contextMenuAnchor;
    this.contextMenu.hidden = true;
    this.contextMenu.replaceChildren();
    this.contextMenuAnchor = null;
    if (this.contextMenuHostDialog) {
      this.contextMenuHostDialog.classList.remove("dialog--menu-open");
      this.contextMenuHostDialog = null;
    }
    if (this.contextMenu.parentElement !== document.body) {
      document.body.append(this.contextMenu);
    }
    if (anchor) {
      anchor.classList.remove("is-menu-open");
      if (anchor === this.createEntryButton) {
        this.createEntryButton.setAttribute("aria-expanded", "false");
      }
    }
    if (restoreFocus) anchor?.focus();
  }

  private updateManagementActions(): void {
    const disabled = this.workspaceBusy || !this.workspace;
    this.createEntryButton.disabled = disabled;
    const noteDisabled = disabled || !this.currentNote;
    this.renameNoteButton.disabled = noteDisabled;
    this.deleteNoteButton.disabled = noteDisabled;
    if (disabled) this.closeContextMenu();
  }

  private async openWorkspaceDialog(): Promise<void> {
    if (this.workspaceBusy) return;
    if (!isDesktopRuntime()) {
      this.showToast({
        kind: "info",
        message: "打开本地笔记库需要使用桌面应用运行。",
      });
      return;
    }

    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择 Markdown 笔记库",
        defaultPath: this.workspace?.path,
      });
    } catch (error) {
      this.showToast({ kind: "error", message: `无法打开文件夹选择器：${errorMessage(error)}` });
      return;
    }

    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;

    const normalized = path.replace(/[/\\]+$/, "");
    if (this.workspace && normalized === this.workspace.path.replace(/[/\\]+$/, "")) {
      await this.refreshWorkspace(true);
      return;
    }

    const saved = await this.saveNow(false);
    if (!saved) {
      this.showToast({
        kind: "error",
        message: "当前笔记保存失败，已暂停切换笔记库。请先重试保存。",
      });
      return;
    }

    this.setWorkspaceBusy(true);
    try {
      const info = await workspaceApi.open(path);
      this.adoptWorkspace(info);
      this.showToast({
        kind: "success",
        message: `已打开「${info.name}」 · ${info.notes.length} 篇笔记`,
      });
    } catch (error) {
      this.setWorkspaceBusy(false);
      this.showToast({
        kind: "error",
        message: `无法打开这个笔记库：${errorMessage(error)}`,
        actionLabel: "重试",
        onAction: () => void this.openWorkspaceDialog(),
      });
    }
  }

  private async refreshWorkspace(showFeedback: boolean): Promise<void> {
    if (!this.workspace || this.workspaceBusy) return;
    const saved = await this.saveNow(false);
    if (!saved) {
      this.showToast({
        kind: "error",
        message: "当前笔记尚未保存，已暂停刷新。请先重试保存。",
      });
      return;
    }
    await this.rescanWorkspace(showFeedback);
  }

  private async rescanWorkspace(showFeedback: boolean): Promise<WorkspaceInfo | null> {
    if (!this.workspace || this.workspaceBusy) return null;
    const previousPath = this.currentNote?.path ?? null;
    this.setWorkspaceBusy(true);

    try {
      const info = await workspaceApi.rescan();
      this.applyWorkspaceInfo(info, previousPath);
      if (showFeedback) {
        this.showToast({
          kind: "success",
          message: `笔记库已刷新 · ${info.notes.length} 篇笔记`,
        });
      }
      return info;
    } catch (error) {
      this.showToast({
        kind: "error",
        message: `刷新笔记库失败：${errorMessage(error)}`,
        actionLabel: "重试",
        onAction: () => void this.refreshWorkspace(showFeedback),
      });
      return null;
    } finally {
      this.setWorkspaceBusy(false);
    }
  }

  private applyWorkspaceInfo(info: WorkspaceInfo, previousPath: string | null): void {
    this.workspace = info;
    this.tree = buildFileTree(info.notes, info.folders ?? []);
    const freshCurrent = previousPath
      ? (info.notes.find((note) => note.path === previousPath) ?? null)
      : null;

    if (previousPath && !freshCurrent) {
      this.closeCurrentNoteForRemoval();
      this.showToast({
        kind: "info",
        message: "当前笔记已不在笔记库中，编辑区已关闭。",
      });
    } else if (freshCurrent) {
      this.currentNote = freshCurrent;
    }

    this.updateWorkspaceChrome();
    this.updateDocumentChrome();
    this.renderTree();
    this.updateWelcome();
    this.updateSaveStatus();
    this.updateManagementActions();
    this.scrollActiveNote();
  }

  private closeCurrentNoteForRemoval(): void {
    this.currentNote = null;
    this.pendingContent = null;
    this.lastPersistedContent = null;
    this.lastSavedAt = 0;
    this.lastSaveErrorMessage = "";
    this.loadToken += 1;
    this.editorToken += 1;
    this.cancelSaveTimer();
    this.destroyEditor();
    this.resetSearchQuery();
    this.setSaveState("idle");
    this.setDirtyDot(false);
    this.showWelcomeView();
    this.updateDocumentChrome();
    this.updateManagementActions();
    this.updateWelcome();
  }

  private showToast(options: ToastOptions): void {
    const { kind, message, actionLabel, onAction } = options;
    while (this.toastRegion.children.length >= 3) {
      this.toastRegion.firstElementChild?.remove();
    }

    const toast = document.createElement("div");
    toast.className = `toast toast--${kind}`;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");

    const icon = document.createElement("span");
    icon.className = "toast__icon";
    icon.innerHTML = iconSvg(
      kind === "success" ? "check" : kind === "error" ? "alert-triangle" : "info",
      17,
    );

    const text = document.createElement("span");
    text.className = "toast__text";
    text.textContent = message;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast__close";
    close.setAttribute("aria-label", "关闭提示");
    close.innerHTML = iconSvg("x", 14);

    let removed = false;
    let dismissTimer = 0;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      window.clearTimeout(dismissTimer);
      toast.classList.remove("is-visible");
      window.setTimeout(() => toast.remove(), 220);
    };

    toast.append(icon, text);
    if (actionLabel && onAction) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "toast__action";
      action.textContent = actionLabel;
      action.addEventListener("click", () => {
        remove();
        onAction();
      });
      toast.append(action);
    }
    toast.append(close);
    this.toastRegion.append(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    dismissTimer = window.setTimeout(remove, options.duration ?? 4200);
    close.addEventListener("click", remove);
  }
}

const application = new MojianApp();
void application.init().catch((error: unknown) => {
  console.error(error);
  const title = document.getElementById("welcome-title");
  const description = document.getElementById("welcome-description");
  if (title) title.textContent = "应用未能启动";
  if (description) description.textContent = `初始化失败：${errorMessage(error)}`;
});
