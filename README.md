# 墨笺 · Mojian

> 安静地写，自动地存。

墨笺是一款基于 **Tauri 2** 的桌面 Markdown 编辑器。打开一个本地文件夹作为笔记库，在左侧选择 `.md` 文件，用 [Vditor](https://github.com/Vanessa219/vditor) 的 **IR 即时渲染模式**在单屏内写作。文件只在被选中时读取，每一次编辑都会自动原子写回磁盘。

![墨笺 · 浅色欢迎页](docs/screenshots/welcome-light.png)

<p align="center">
  <img src="docs/screenshots/editor-light.png" width="49%" alt="浅色编辑界面" />
  <img src="docs/screenshots/editor-dark.png" width="49%" alt="深色编辑界面" />
</p>

## 特性

- **文件夹即笔记库**：通过原生文件夹选择器打开任意本地目录，递归发现其中的 `.md` / `.markdown` 文件。
- **按需加载**：扫描阶段只读取文件元信息；正文只在你选中某篇笔记时读取，不做全量预加载。
- **单屏 IR 编辑**：Vditor IR 模式将 Markdown 语法与排版结果放在同一张“纸”上，没有左右分栏。
- **实时自动保存**：编辑停止约 720ms 后自动保存；点击保存状态或 `Ctrl/⌘ + S` 可立即写入。
- **离开也不丢字**：切换笔记、刷新笔记库、窗口失焦与关闭窗口前都会按编辑器当前值强制保存；保存失败时窗口不会关闭。
- **安全文件操作**：工作区状态保存在 Rust 端；路径经过规范化、扩展名检查、工作区后代校验与符号链接逃逸防护；保存采用同目录临时文件 + 原子重命名。
- **安静的界面**：温暖纸张色、朱砂强调色、Noto Serif 正文、可折叠文件夹树、搜索过滤、最近打开、深浅双主题。
- **完全离线**：Vditor 的 Lute 解析器、图标、代码高亮、主题 CSS 与中文字体均随应用打包，不请求 CDN。
- **原生桌面体验**：Tauri 2 窗口、系统文件夹选择器、外部链接交给系统浏览器、退出前保存保护。

## 快速开始

环境要求：

- Node.js 20+
- Rust stable（`cargo`、`rustc`）
- Tauri 2 的 Linux 系统依赖：`webkit2gtk-4.1`、`gtk3`、`libsoup3` 等。Debian/Ubuntu 可参考 [Tauri prerequisites](https://tauri.app/start/prerequisites/)。

安装与开发：

```bash
npm install
npm run tauri dev
```

生产构建：

```bash
npm run tauri build
```

只构建前端与检查类型：

```bash
npm run check
npm run build
```

运行 Rust 测试（17 项）：

```bash
cd src-tauri
cargo test
```

## 使用说明

1. 点击 **打开笔记库**，选择任意包含 Markdown 文件的文件夹。
2. 在左侧文件夹树中选择一篇笔记，正文随即载入 Vditor。
3. 直接写作。右上角状态会依次显示“待保存 → 正在保存 → 已保存”，并记录保存时间。
4. 使用搜索框或 `Ctrl/⌘ + P` 按文件名与相对路径筛选笔记。
5. 点击右上角主题按钮，在浅色 / 深色间切换；主题和上次打开的笔记库会保留。

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl/⌘ + O` | 打开 / 切换笔记库 |
| `Ctrl/⌘ + P` | 聚焦笔记搜索 |
| `Ctrl/⌘ + S` | 立即保存 |
| `Ctrl/⌘ + \` | 显示 / 收起侧边栏 |
| `Ctrl/⌘ + ⇧ + L` | 切换主题 |
| `Ctrl/⌘ + B` / `I` | 加粗 / 斜体（Vditor） |

文件夹会记住展开 / 收起状态；侧边栏宽度也能拖动调整并持久化。

## 技术架构

```text
.
├── index.html                    # 应用壳层、欢迎页、编辑器容器
├── src/
│   ├── main.ts                   # 应用状态、文件选择、自动保存、窗口生命周期
│   ├── icons.ts                  # 线性图标与图标注入
│   ├── styles.css                # 设计令牌、布局、Vditor 外观、主题
│   └── lib/
│       ├── api.ts                # Tauri command 类型化封装
│       ├── editor.ts             # Vditor IR 配置与主题同步
│       ├── file-tree.ts          # 扁平笔记列表 → 文件夹树 / 搜索
│       ├── format.ts             # 时间、字数、阅读时长
│       └── storage.ts            # 主题、最近打开、侧边栏状态等本地偏好
├── src-tauri/
│   ├── src/lib.rs                # Tauri 入口、命令注册、工作区状态
│   ├── src/workspace.rs          # 文件夹校验、递归扫描、元信息
│   ├── src/security.rs           # 相对路径校验、工作区后代 / 符号链接防护
│   ├── src/notes.rs              # 按需读取、原子保存、权限保留
│   ├── capabilities/default.json # 最小化插件权限
│   └── tauri.conf.json
├── scripts/sync-vditor-assets.mjs # 将 Vditor 离线运行时资源同步到 public/
└── docs/screenshots/
```

### Rust 命令接口

| Command | 作用 |
| --- | --- |
| `open_workspace(path)` | 校验并激活文件夹，扫描出扁平笔记列表 |
| `rescan_workspace()` | 重新扫描当前笔记库 |
| `read_note(path)` | 按工作区相对路径读取单篇正文 |
| `save_note(path, content)` | 原子保存已存在的 Markdown 文件 |

返回字段均为 camelCase，与 `src/lib/api.ts` 一一对应。

### 安全边界

- 前端不能直接访问任意路径：当前工作区是 Rust 端受管状态。
- 笔记路径必须是工作区内的相对路径；拒绝绝对路径、`C:\` / UNC、反斜杠、`.`、`..`、空段与非 Markdown 扩展名。
- 读取与写入都会 canonicalize 目标并验证其仍是工作区后代，逃逸的符号链接会被拒绝。
- 扫描不跟随符号链接；跳过隐藏项以及 `node_modules`、`target`、`dist`、`build` 等常见噪声目录。
- 保存：同目录隐藏临时文件 → 写入 → 保留原权限 → `sync_all` → 原子重命名；失败时清理临时文件。
- 只写已存在的 `.md` / `.markdown`；应用不会创建、删除或重命名文件。

### 自动保存策略

- 输入后 720ms 防抖自动保存，避免每个按键都写盘。
- 保存操作串行化；保存过程中出现的新内容会在本次写入完成后继续落盘。
- 关闭窗口 / 切换笔记 / 刷新前，会直接读取 Vditor 当前值并强制保存，不依赖输入回调的调度时序。
- 保存失败时状态变为“保存失败”，并提供重试；关闭窗口会因此被阻止，直到保存成功。

### 离线资源

`npm run dev` 与 `npm run build` 之前会自动执行 `scripts/sync-vditor-assets.mjs`，把 Lute、Material 图标、中文 i18n、GitHub 代码高亮主题等从 `node_modules` 同步到 `public/vditor`。Vditor 的 `cdn` 指向本地 `/vditor`，因此运行期无需网络。

## 开发路线

本项目按以下阶段完成：

1. **基础与设计系统** —— Tauri 2 + Vite + TypeScript 脚手架，窗口配置、字体、主题令牌与应用图标。
2. **安全文件层** —— Rust 工作区状态、递归扫描、路径校验、按需读取、原子保存与 17 项单元测试。
3. **编辑体验** —— Vditor IR 单屏编辑器、工具栏、文件树、搜索、最近打开、字数统计与自动保存状态。
4. **集成与验收** —— 原生文件夹选择、浏览器预览截图、自动保存写盘验证、关闭前保存验证、深浅主题验收。
5. **交付与文档** —— 离线资源同步、应用元数据、README、截图和 Git 历史。

## 已知边界

- 这是桌面应用；直接运行纯浏览器版本时，打开本地文件夹功能不可用。
- 外部程序修改文件后需要点击“刷新笔记库”重新扫描；当前不监听底层文件变化。
- 符号链接会被有意忽略（既是逃逸防护，也避免环路）。
- 为保持离线与轻量，当前未启用数学公式 / Mermaid 等重运行时渲染；代码高亮与完整 Markdown 排版可用。
- 不创建新笔记、不提供重命名 / 删除；所有写操作只针对已存在的 Markdown 文件。

## 设计说明

界面的核心是“纸感”而不是“后台面板感”：暖白纸张底色、极细分割线、朱砂色焦点、衬线正文，以及尽量退后的工具栏。深色主题使用墨色背景与更柔和的暖珊瑚色强调，保持夜间阅读的对比度而不刺眼。

---

用 Markdown 写 Markdown。愿你在这里找到自己的节奏。
