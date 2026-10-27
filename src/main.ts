import "@fontsource-variable/manrope";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type Vditor from "vditor";

import { errorMessage, isDesktopRuntime, workspaceApi } from "./lib/api";
import type { NoteDocument, NoteEntry, WorkspaceInfo } from "./lib/api";
import { applyEditorTheme, createEditor } from "./lib/editor";
import {
  buildFileTree,
  countNotes,
  folderAncestors,
  searchNotes,
} from "./lib/file-tree";
import type { FileNode, FolderNode } from "./lib/file-tree";
import {
  directoryLabel,
  formatCharacters,
  readingStats,
  readingTimeLabel,
  timeLabel,
  updatedLabel,
} from "./lib/format";
import type { ReadingStats } from "./lib/format";
import { hydrateIcons, iconSvg, setIcon } from "./icons";
import { storage } from "./lib/storage";
import "./styles.css";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type ToastKind = "info" | "success" | "error";

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
  private openWorkspaceTop!: HTMLButtonElement;
  private openWorkspaceHero!: HTMLButtonElement;
  private refreshWorkspaceButton!: HTMLButtonElement;
  private refreshHero!: HTMLButtonElement;
  private themeToggle!: HTMLButtonElement;
  private themeToggleTop!: HTMLButtonElement;
  private themeLabel!: HTMLElement;
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
  private docReadingTime!: HTMLElement;
  private wordCount!: HTMLElement;
  private readTime!: HTMLElement;
  private toastRegion!: HTMLElement;
  private shortcutDialog!: HTMLDialogElement;

  private workspace: WorkspaceInfo | null = null;
  private tree: FolderNode | null = null;
  private collapsedFolders = new Set<string>();
  private query = "";
  private currentNote: NoteEntry | null = null;
  private currentStats: ReadingStats = { characters: 0, minutes: 0 };

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
    this.sidebar = byId<HTMLElement>("sidebar");
    this.sidebarResizer = byId<HTMLElement>("sidebar-resizer");
    this.sidebarToggle = byId<HTMLButtonElement>("sidebar-toggle");
    this.collapseSidebar = byId<HTMLButtonElement>("collapse-sidebar");
    this.openWorkspaceSide = byId<HTMLButtonElement>("open-workspace-side");
    this.openWorkspaceTop = byId<HTMLButtonElement>("open-workspace-top");
    this.openWorkspaceHero = byId<HTMLButtonElement>("open-workspace-hero");
    this.refreshWorkspaceButton = byId<HTMLButtonElement>("refresh-workspace");
    this.refreshHero = byId<HTMLButtonElement>("refresh-hero");
    this.themeToggle = byId<HTMLButtonElement>("theme-toggle");
    this.themeToggleTop = byId<HTMLButtonElement>("theme-toggle-top");
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
    this.docReadingTime = byId<HTMLElement>("doc-reading-time");
    this.wordCount = byId<HTMLElement>("word-count");
    this.readTime = byId<HTMLElement>("read-time");
    this.toastRegion = byId<HTMLElement>("toast-region");
    this.shortcutDialog = byId<HTMLDialogElement>("shortcuts-dialog");
  }

  private bindUi(): void {
    const openWorkspace = (): void => {
      void this.openWorkspaceDialog();
    };
    this.openWorkspaceSide.addEventListener("click", openWorkspace);
    this.openWorkspaceTop.addEventListener("click", openWorkspace);
    this.openWorkspaceHero.addEventListener("click", openWorkspace);

    this.refreshWorkspaceButton.addEventListener("click", () => void this.refreshWorkspace(true));
    this.refreshHero.addEventListener("click", () => void this.refreshWorkspace(true));

    this.collapseSidebar.addEventListener("click", () => {
      this.applySidebarCollapsed(true, true);
    });
    this.sidebarToggle.addEventListener("click", () => {
      this.applySidebarCollapsed(!this.sidebarCollapsed, true);
    });

    this.themeToggle.addEventListener("click", () => this.toggleTheme());
    this.themeToggleTop.addEventListener("click", () => this.toggleTheme());

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
    if (!isDesktopRuntime()) return;
    const currentWindow = getCurrentWindow();

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
    setIcon(this.themeToggleTop, themeIcon);
    this.themeToggle.setAttribute("aria-label", `切换为${action}主题`);
    this.themeToggleTop.setAttribute("aria-label", `切换为${action}主题`);

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
    this.tree = buildFileTree(info.notes);
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
    this.openWorkspaceTop.disabled = busy;
    this.openWorkspaceHero.disabled = busy;
    this.fileTree.setAttribute("aria-busy", String(busy));
    if (this.workspace) {
      this.refreshWorkspaceButton.title = busy ? "正在刷新…" : "刷新笔记库";
    }
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
      this.welcomeDescription.textContent = `“${workspace.name}” 中还没有 Markdown 笔记。往文件夹里放入 .md 文件，然后刷新笔记库。`;
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
    const filtered = searchNotes(workspace.notes, this.query);
    this.noteCount.textContent = this.query ? `${filtered.length} / ${total}` : String(total);
    this.noteCount.classList.toggle("count-pill--filtered", Boolean(this.query));
    this.clearSearchButton.hidden = !this.query;
    this.searchKbd.hidden = Boolean(this.query);

    if (total === 0) {
      this.fileTree.replaceChildren(
        this.buildTreeMessage("file-text", "还没有 Markdown 笔记", "在文件夹中添加 .md 文件后刷新。"),
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
    this.currentStats = readingStats(value);
    this.wordCount.textContent = formatCharacters(this.currentStats.characters);
    this.readTime.textContent =
      this.currentStats.minutes === 0
        ? "空白笔记"
        : `约 ${this.currentStats.minutes} 分钟阅读`;
    this.docReadingTime.textContent = readingTimeLabel(this.currentStats);
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
      return;
    }

    const note = this.currentNote;
    const workspaceName = this.workspace?.name ?? "笔记库";
    this.breadcrumbNote.textContent = note.name;
    this.documentTitle.textContent = note.name;
    this.documentPath.textContent = `${workspaceName} / ${note.path}`;
    this.documentPath.title = note.path;
    this.updateUpdatedLabel();
    this.docReadingTime.textContent = readingTimeLabel(this.currentStats);
    document.title = `${note.name} · 墨笺`;
  }

  private showWelcomeView(): void {
    this.welcome.hidden = false;
    this.editorView.hidden = true;
    this.lastPersistedContent = null;
    this.documentTitle.textContent = "未命名笔记";
    this.documentPath.textContent = this.workspace?.name ?? "笔记库";
    this.documentUpdated.textContent = "刚刚更新";
    this.docReadingTime.textContent = "约 1 分钟";
    this.wordCount.textContent = "0 字符";
    this.readTime.textContent = "空白笔记";
    this.currentStats = { characters: 0, minutes: 0 };
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

    this.setWorkspaceBusy(true);
    const previousPath = this.currentNote?.path ?? null;
    try {
      const info = await workspaceApi.rescan();
      this.workspace = info;
      this.tree = buildFileTree(info.notes);
      const freshCurrent = previousPath
        ? (info.notes.find((note) => note.path === previousPath) ?? null)
        : null;

      if (previousPath && !freshCurrent) {
        this.currentNote = null;
        this.loadToken += 1;
        this.editorToken += 1;
        this.destroyEditor();
        this.setSaveState("idle");
        this.setDirtyDot(false);
        this.showWelcomeView();
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
      this.scrollActiveNote();

      if (showFeedback) {
        this.showToast({
          kind: "success",
          message: `笔记库已刷新 · ${info.notes.length} 篇笔记`,
        });
      }
    } catch (error) {
      this.showToast({
        kind: "error",
        message: `刷新笔记库失败：${errorMessage(error)}`,
        actionLabel: "重试",
        onAction: () => void this.refreshWorkspace(showFeedback),
      });
    } finally {
      this.setWorkspaceBusy(false);
    }
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
