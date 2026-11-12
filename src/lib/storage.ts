const PREFIX = "mojian.";
const KEYS = {
  theme: `${PREFIX}theme`,
  sidebarWidth: `${PREFIX}sidebar-width`,
  sidebarCollapsed: `${PREFIX}sidebar-collapsed`,
} as const;

const LEGACY_KEYS = ["mojian.last-workspace", "mojian.recent", "mojian.collapsed"];

const memoryRecent = new Map<string, RecentNote[]>();
const memoryCollapsed = new Map<string, Set<string>>();

export interface RecentNote {
  path: string;
  name: string;
  at: number;
}

export type StoredTheme = "light" | "dark" | null;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (_) {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch (_) {
    /* Persistence is a convenience, not a requirement. */
  }
}

export const storage = {
  getTheme(): StoredTheme {
    try {
      const value = localStorage.getItem(KEYS.theme);
      return value === "light" || value === "dark" ? value : null;
    } catch (_) {
      return null;
    }
  },

  setTheme(theme: "light" | "dark"): void {
    try {
      localStorage.setItem(KEYS.theme, theme);
    } catch (_) {
      /* ignore */
    }
  },

  purgeLegacyMetadata(): void {
    try {
      for (const key of LEGACY_KEYS) localStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
  },

  getRecent(workspacePath: string): RecentNote[] {
    return (memoryRecent.get(workspacePath) ?? []).slice();
  },

  pushRecent(workspacePath: string, note: { path: string; name: string }): RecentNote[] {
    const previous = memoryRecent.get(workspacePath) ?? [];
    const next: RecentNote[] = [
      { path: note.path, name: note.name, at: Date.now() },
      ...previous.filter((item) => item.path !== note.path),
    ].slice(0, 6);
    memoryRecent.set(workspacePath, next);
    return next.slice();
  },

  removeRecent(workspacePath: string, notePath: string): void {
    const previous = memoryRecent.get(workspacePath) ?? [];
    memoryRecent.set(
      workspacePath,
      previous.filter((item) => item.path !== notePath),
    );
  },

  renameRecent(workspacePath: string, oldPath: string, next: { path: string; name: string }): void {
    const previous = memoryRecent.get(workspacePath) ?? [];
    memoryRecent.set(
      workspacePath,
      previous.map((item) =>
        item.path === oldPath ? { ...item, path: next.path, name: next.name } : item,
      ),
    );
  },

  getCollapsedFolders(workspacePath: string): Set<string> {
    return new Set(memoryCollapsed.get(workspacePath) ?? []);
  },

  setCollapsedFolders(workspacePath: string, folders: Set<string>): void {
    memoryCollapsed.set(workspacePath, new Set(folders));
  },

  getSidebarWidth(): number | null {
    const value = read<number | null>(KEYS.sidebarWidth, null);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  },

  setSidebarWidth(width: number): void {
    write(KEYS.sidebarWidth, Math.round(width));
  },

  getSidebarCollapsed(): boolean {
    return read<boolean>(KEYS.sidebarCollapsed, false);
  },

  setSidebarCollapsed(collapsed: boolean): void {
    write(KEYS.sidebarCollapsed, collapsed);
  },
};
