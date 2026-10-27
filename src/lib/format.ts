const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const numberFormatter = new Intl.NumberFormat("zh-CN");

export interface ReadingStats {
  characters: number;
  minutes: number;
}

export function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function updatedLabel(timestamp: number): string {
  if (!timestamp) return "刚刚更新";
  const date = new Date(timestamp);
  const now = new Date();
  const clock = timeLabel(timestamp);

  if (date.toDateString() === now.toDateString()) {
    return `今天 ${clock} 更新`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `昨天 ${clock} 更新`;
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return sameYear ? `${day} ${clock} 更新` : `${date.getFullYear()} 年 ${day} 更新`;
}

export function formatCharacters(characters: number): string {
  return `${numberFormatter.format(characters)} 字符`;
}

export function readingStats(markdown: string): ReadingStats {
  const readable = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[#>*_~|^=\-[+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const cjkCount = (readable.match(CJK) ?? []).length;
  const latinWords = (
    readable.replace(CJK, " ").match(/[A-Za-z0-9]+(?:['’_-][A-Za-z0-9]+)*/g) ?? []
  ).length;
  const characters = readable.replace(/\s/g, "").length;
  const minutes =
    cjkCount + latinWords === 0
      ? 0
      : Math.max(1, Math.ceil(cjkCount / 380 + latinWords / 230));

  return { characters, minutes };
}

export function readingTimeLabel(stats: ReadingStats): string {
  if (stats.minutes === 0) return "空白笔记";
  return `约 ${stats.minutes} 分钟`;
}

export function directoryLabel(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "笔记库根目录" : path.slice(0, slash);
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function truncateMiddle(value: string, maxLength = 42): string {
  if (value.length <= maxLength) return value;
  const side = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, side)}…${value.slice(value.length - side)}`;
}
