// The in-page helpers (`window.hjs_0x2a`) that the agent's default web methods call through `execute_script`.
export const PAGE_HELPERS = `(() => {
  if (window.hjs_0x2a) return;
  const xpathOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index++;
      }
      parts.unshift(node.tagName.toLowerCase() + "[" + index + "]");
    }
    return "/" + parts.join("/");
  };
  window.hjs_0x2a = {
    get_local_storage: () => Object.fromEntries(Object.entries(localStorage)),
    set_local_storage: (values) => {
      for (const [key, value] of Object.entries(values)) {
        localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    },
    get_select_at: (x, y) => {
      const select = document.elementFromPoint(x, y)?.closest("select");
      if (!select) return null;
      return { xpath: xpathOf(select), options: [...select.options].map((o) => o.text), selected_idx: select.selectedIndex };
    },
    set_select_option_idx: (xpath, index) => {
      const select = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!(select instanceof HTMLSelectElement)) throw new Error("no <select> at " + xpath);
      select.selectedIndex = index;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    collectViewportHTML: () => {
      const body = document.body.cloneNode(true);
      body.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
      return body.outerHTML;
    },
  };
})()`;

/** A Selenium-style script body (`return ...`, `arguments[i]`) as a Playwright expression. */
export function scriptExpression(script: string, args: unknown[]): string {
  return `${PAGE_HELPERS};(function () {\n${script}\n}).apply(null, ${JSON.stringify(args)})`;
}

export const PAGE_DIMENSIONS =
  "[document.body?.scrollWidth ?? 0, document.body?.scrollHeight ?? 0, Math.ceil(window.pageXOffset), Math.ceil(window.pageYOffset)]";

const KEYS: Record<string, string> = {
  "\t": "Tab",
  "\n": "Enter",
  "\r": "Enter",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  escape: "Escape",
  esc: "Escape",
  space: " ",
  ctrl: "Control",
  ctrlleft: "Control",
  ctrlright: "Control",
  shift: "Shift",
  shiftleft: "Shift",
  shiftright: "Shift",
  alt: "Alt",
  altleft: "Alt",
  altright: "Alt",
  option: "Alt",
  optionleft: "Alt",
  optionright: "Alt",
  command: "Meta",
  win: "Meta",
  winleft: "Meta",
  winright: "Meta",
  universal_command: "ControlOrMeta",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  pause: "Pause",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  printscreen: "PrintScreen",
  prtsc: "PrintScreen",
  prtscr: "PrintScreen",
  prntscrn: "PrintScreen",
  add: "NumpadAdd",
  subtract: "NumpadSubtract",
  multiply: "NumpadMultiply",
  divide: "NumpadDivide",
  decimal: "NumpadDecimal",
};

/** The Playwright key name for an agent key (`"ctrl"`, `"pagedown"`, `"f5"`, `"num3"`, `"a"`). */
export function playwrightKey(key: string): string {
  const mapped = KEYS[key];
  if (mapped) return mapped;
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  if (/^num\d$/.test(key)) return `Numpad${key.slice(3)}`;
  return key;
}
