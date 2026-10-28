const numberFormatter = new Intl.NumberFormat("zh-CN");

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

export function countCharacters(markdown: string): number {
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

  return readable.replace(/\s/g, "").length;
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
