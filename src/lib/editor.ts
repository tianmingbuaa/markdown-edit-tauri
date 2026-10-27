import Vditor from "vditor";
import "vditor/dist/index.css";

export interface EditorHooks {
  input(value: string): void;
  after(): void;
}

const cdn = `${document.baseURI.replace(/\/+$/, "")}/vditor`;

const toolbar = [
  "headings",
  "bold",
  "italic",
  "strike",
  "|",
  "list",
  "ordered-list",
  "check",
  "|",
  "quote",
  "code",
  "inline-code",
  "link",
  "table",
  "|",
  "undo",
  "redo",
];

export function createEditor(
  element: HTMLElement,
  value: string,
  dark: boolean,
  hooks: EditorHooks,
): Vditor {
  return new Vditor(element, {
    mode: "ir",
    value,
    height: "100%",
    width: "100%",
    placeholder: "从这里开始书写…",
    lang: "zh_CN",
    icon: "material",
    cdn,
    theme: dark ? "dark" : "classic",
    cache: { enable: false },
    counter: { enable: false },
    undoDelay: 350,
    typewriterMode: false,
    resize: { enable: false },
    toolbar,
    toolbarConfig: { hide: false, pin: true },
    preview: {
      delay: 260,
      maxWidth: 840,
      theme: {
        current: dark ? "dark" : "light",
        path: `${cdn}/dist/css/content-theme`,
      },
      hljs: { enable: true, style: dark ? "github-dark" : "github", lineNumber: false },
      markdown: {
        autoSpace: true,
        footnotes: true,
        mark: true,
        toc: true,
        sanitize: true,
        codeBlockPreview: true,
        mathBlockPreview: false,
        inlineMath: false,
      },
    },
    link: { isOpen: false },
    image: { isPreview: true },
    input: hooks.input,
    after: hooks.after,
  });
}

export function applyEditorTheme(vditor: Vditor, dark: boolean): void {
  vditor.setTheme(
    dark ? "dark" : "classic",
    dark ? "dark" : "light",
    dark ? "github-dark" : "github",
  );
}
