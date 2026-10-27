const PREFIX = "mojian.";
const KEYS = {
  theme: `${PREFIX}theme`,
  lastWorkspace: `${PREFIX}last-workspace`,
  recent: `${PREFIX}recent`,
  collapsed: `${PREFIX}collapsed`,
  sidebarWidth: `${PREFIX}sidebar-width`,
  sidebarCollapsed: `${PREFIX}sidebar-collapsed`,
} as const;

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

  getLastWorkspace(): string | null {
    try {
      return localStorage.getItem(KEYS.lastWorkspace);
    } catch (_) {
      return null;
    }
  },

  setLastWorkspace(path: string | null): void {
    try {
      if (path) {
        localStorage.setItem(KEYS.lastWorkspace, path);
      } else {
        localStorage.removeItem(KEYS.lastWorkspace);
      }
    } catch (_) {
      /* ignore */
    }
  },

  getRecent(workspacePath: string): RecentNote[] {
    const all = read<Record<string, RecentNote[]>>(KEYS.recent, {});
    return Array.isArray(all[workspacePath]) ? all[workspacePath] : [];
  },

  pushRecent(workspacePath: string, note: { path: string; name: string }): RecentNote[] {
    const all = read<Record<string, RecentNote[]>>(KEYS.recent, {});
    const previous = Array.isArray(all[workspacePath]) ? all[workspacePath] : [];
    const next: RecentNote[] = [
      { path: note.path, name: note.name, at: Date.now() },
      ...previous.filter((item) => item.path !== note.path),
    ].slice(0, 6);
    all[workspacePath] = next;
    write(KEYS.recent, all);
    return next;
  },

  removeRecent(workspacePath: string, notePath: string): void {
    const all = read<Record<string, RecentNote[]>>(KEYS.recent, {});
    const previous = Array.isArray(all[workspacePath]) ? all[workspacePath] : [];
    all[workspacePath] = previous.filter((item) => item.path !== notePath);
    write(KEYS.recent, all);
  },

  getCollapsedFolders(workspacePath: string): Set<string> {
    const all = read<Record<string, string[]>>(KEYS.collapsed, {});
    return new Set(Array.isArray(all[workspacePath]) ? all[workspacePath] : []);
  },

  setCollapsedFolders(workspacePath: string, folders: Set<string>): void {
    const all = read<Record<string, string[]>>(KEYS.collapsed, {});
    all[workspacePath] = [...folders];
    write(KEYS.collapsed, all);
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
