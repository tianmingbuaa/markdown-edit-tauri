const ICONS = {
  "panel-left": `
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
    <path d="M5.6 7.5h.8M5.6 10.5h.8" stroke-linecap="round" opacity=".6" />`,
  folder: `
    <path d="M3.5 7.4a2 2 0 0 1 2-2h3.2l2.1 2h7.7a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.4Z" />`,
  "folder-open": `
    <path d="M3.5 7.4a2 2 0 0 1 2-2h3.2l2.1 2h7.7a2 2 0 0 1 2 2v1.2" />
    <path d="M4.3 20h13.5a1.6 1.6 0 0 0 1.55-1.2l1.35-5.1a1.1 1.1 0 0 0-1.06-1.4H6.6a1.6 1.6 0 0 0-1.55 1.2l-1.7 6.3" />`,
  "folder-plus": `
    <path d="M3.5 7.4a2 2 0 0 1 2-2h3.2l2.1 2h7.7a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.4Z" />
    <path d="M12 11.5v5M9.5 14h5" stroke-linecap="round" />`,
  library: `
    <path d="M4 4.5h4v15H4zM10 4.5h4v15h-4z" />
    <path d="m16.3 5 3.3.9-3.4 13.3-3.3-.9" />
    <path d="M5.8 7.2h.4M11.8 7.2h.4" stroke-linecap="round" opacity=".55" />`,
  "book-open": `
    <path d="M12 6.6C10.4 5.1 8.3 4.4 5 4.3v13.9c3.3 0 5.4.7 7 2.2 1.6-1.5 3.7-2.2 7-2.2V4.3c-3.3.1-5.4.8-7 2.3Z" />
    <path d="M12 6.7v13.6" />`,
  search: `
    <circle cx="10.8" cy="10.8" r="6.6" />
    <path d="m15.7 15.7 4.1 4.1" stroke-linecap="round" />`,
  x: `
    <path d="m6.3 6.3 11.4 11.4M17.7 6.3 6.3 17.7" stroke-linecap="round" />`,
  refresh: `
    <path d="M20 11a8 8 0 1 0-.7 4.3" stroke-linecap="round" />
    <path d="M20 5.2V11h-5.8" stroke-linecap="round" stroke-linejoin="round" />`,
  moon: `
    <path d="M20.7 14.4A8.6 8.6 0 0 1 9.6 3.3a8.7 8.7 0 1 0 11.1 11.1Z" stroke-linejoin="round" />`,
  sun: `
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.4v2.2M12 19.4v2.2M4.2 12H2M22 12h-2.2M5.7 5.7 4.1 4.1M19.9 19.9l-1.6-1.6M18.3 5.7l1.6-1.6M4.1 19.9l1.6-1.6" stroke-linecap="round" />`,
  keyboard: `
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.4h.01M8.5 13.4h.01M11 13.4h.01M13.5 13.4h.01M16 13.4h.01M18.5 13.4h.01" stroke-linecap="round" stroke-width="1.8" />
    <path d="M7.5 16h9" stroke-linecap="round" />`,
  "arrow-up-right": `
    <path d="M7 17 17 7M8.2 7H17v8.8" stroke-linecap="round" stroke-linejoin="round" />`,
  "file-text": `
    <path d="M6 3.8h7.2L18.8 9v11.2H6z" stroke-linejoin="round" />
    <path d="M13 3.9V9h5.7M9 12.5h6M9 16h4.6" stroke-linecap="round" stroke-linejoin="round" />`,
  "chevron-right": `
    <path d="m9.5 6.5 5.5 5.5-5.5 5.5" stroke-linecap="round" stroke-linejoin="round" />`,
  "alert-triangle": `
    <path d="M12 3.7 21 20H3L12 3.7Z" stroke-linejoin="round" />
    <path d="M12 9v4.8M12 17.2h.01" stroke-linecap="round" />`,
  check: `
    <path d="m4.5 12.5 5 5 10-11" stroke-linecap="round" stroke-linejoin="round" />`,
  info: `
    <circle cx="12" cy="12" r="9" />
    <path d="M12 10.6v5.2M12 7.8h.01" stroke-linecap="round" />`,
  save: `
    <path d="M5 4.5h11.5L20 8v11.5H5z" stroke-linejoin="round" />
    <path d="M8 4.5v5h7v-5M8 19.5v-6h8v6" stroke-linejoin="round" />`,
  clock: `
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.4v5l3.2 2" stroke-linecap="round" stroke-linejoin="round" />`,
  "external-link": `
    <path d="M13 4.5h6.5V11M19 5l-8 8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" stroke-linecap="round" />`,
  sparkles: `
    <path d="m12 3 1.2 4.1L17 8.5l-3.8 1.4L12 14l-1.2-4.1L7 8.5l3.8-1.4L12 3Z" stroke-linejoin="round" />
    <path d="m18.5 14 .7 2.4 2.3.8-2.3.8-.7 2.5-.7-2.5-2.3-.8 2.3-.8.7-2.4ZM5 15l.6 1.9 1.9.6-1.9.6L5 20l-.6-1.9-1.9-.6 1.9-.6L5 15Z" stroke-linejoin="round" />`,
  "file-check": `
    <path d="M6 3.8h7.2L18.8 9v11.2H6z" stroke-linejoin="round" />
    <path d="M13 3.9V9h5.7M9 14.6l1.8 1.8 3.3-3.4" stroke-linecap="round" stroke-linejoin="round" />`,
  plus: `
    <path d="M12 5v14M5 12h14" stroke-linecap="round" />`,
  "file-plus": `
    <path d="M6 3.8h7.2L18.8 9v11.2H6z" stroke-linejoin="round" />
    <path d="M13 3.9V9h5.7M9.3 14.8h6.4M12.5 11.6v6.4" stroke-linecap="round" stroke-linejoin="round" />`,
  pencil: `
    <path d="m4.8 19.2 4.1-1 10.4-10.4a2.1 2.1 0 0 0-3-3L5.9 15.2l-1.1 4Z" stroke-linejoin="round" />
    <path d="m13.8 6.3 4 4M5.9 15.2l3 3" stroke-linecap="round" />`,
  trash: `
    <path d="M4.5 7h15M9.2 7V4.7h5.6V7M6.8 7.2l.9 12h8.6l.9-12" stroke-linejoin="round" />
    <path d="M10 10.6v5.6M14 10.6v5.6" stroke-linecap="round" />`,
  minimize: `
    <path d="M5 12h14" stroke-linecap="round" />`,
  maximize: `
    <rect x="5.2" y="5.2" width="13.6" height="13.6" rx="1.2" />`,
  restore: `
    <rect x="8.4" y="4.6" width="11" height="11" rx="1.4" />
    <path d="M15.4 19.4H5.9a1.1 1.1 0 0 1-1.1-1.1V8.9" stroke-linecap="round" stroke-linejoin="round" />`,
} as const;

export type IconName = keyof typeof ICONS;

export function iconSvg(name: IconName, size = 18, className = ""): string {
  return `<svg class="app-icon ${className}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((element) => {
    const name = element.dataset.icon as IconName | undefined;
    if (!name || !(name in ICONS)) return;
    element.insertAdjacentHTML("afterbegin", iconSvg(name));
  });
}

export function setIcon(element: Element | null, name: IconName, size = 18): void {
  if (!element) return;
  const isSlot = element.classList.contains("icon-slot");
  element.innerHTML = iconSvg(name, size);
  if (!isSlot) {
    element.setAttribute("data-icon", name);
  }
}
