import type { BrowserContext, Cookie, Page } from "playwright-core";
import type { CommandHandlers } from "../bridge/bridge.js";
import { PAGE_DIMENSIONS, playwrightKey, scriptExpression } from "./page.js";

type Button = "left" | "right" | "middle";

const NAVIGATION_TIMEOUT_MS = 45_000;
const LOAD_GRACE_MS = 10_000;
const SCROLL_SETTLE_MS = 250;

/**
 * Commands for a `user_device` web environment, executed in a Playwright browser context you own.
 * Screenshots are taken at CSS pixels, so agent coordinates map 1:1 to the page.
 */
export function playwrightWebDriver(context: BrowserContext): CommandHandlers {
  const ids = new WeakMap<Page, string>();
  const tabs = new Map<string, Page>();
  let active: Page | undefined;
  let mouse: [number, number] = [0, 0];
  let opened = 0;

  const track = (page: Page): string => {
    const known = ids.get(page);
    if (known) return known;
    const id = `tab-${++opened}`;
    ids.set(page, id);
    tabs.set(id, page);
    page.once("close", () => {
      tabs.delete(id);
      if (active === page) active = [...tabs.values()].at(-1);
    });
    return id;
  };
  context.pages().forEach(track);
  active = context.pages().at(-1);
  context.on("page", (page) => {
    track(page);
    active = page;
  });

  const page = (): Page => {
    if (!active) throw new Error("no open tab");
    return active;
  };
  const tab = (id: string): Page => {
    const found = tabs.get(id);
    if (!found) throw new Error(`no tab with id ${id}`);
    return found;
  };
  const run = <T>(script: string, ...args: unknown[]): Promise<T> => page().evaluate(scriptExpression(script, args)) as Promise<T>;

  const moveTo = async (x: number, y: number) => {
    await page().mouse.move(x, y);
    mouse = [x, y];
  };
  const click = async (button: Button, delaySeconds: number) => {
    await page().mouse.down({ button });
    await sleep(delaySeconds * 1000);
    await page().mouse.up({ button });
  };
  const scroll = async (dx: number, dy: number) => {
    await page().mouse.move(...mouse);
    await page().mouse.wheel(dx, dy);
    await sleep(SCROLL_SETTLE_MS);
  };
  const goto = async (url: string) => {
    try {
      await page().goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`${url} is not reachable : ${(error as Error).message}`);
    }
    await page().waitForLoadState("load", { timeout: LOAD_GRACE_MS }).catch(() => {});
  };
  const newTab = async (): Promise<string> => {
    const created = await context.newPage();
    active = created;
    return track(created);
  };
  const screenSize = () => run<[number, number]>("return [window.innerWidth, window.innerHeight]");
  const screenshot = async () => (await page().screenshot({ type: "png", scale: "css" })).toString("base64");
  const metadata = async () => {
    const screen = await screenSize();
    const dims = (await run<number[] | null>(`return ${PAGE_DIMENSIONS}`)) ?? [...screen, 0, 0];
    return {
      mouse_position: mouse.map(Math.round),
      screen_size: screen,
      tabs: [...tabs.keys()],
      active_tab: track(page()),
      url: page().url(),
      title: await page().title(),
      page_size: [dims[0], dims[1]].map(Math.round),
      scroll_position: [dims[2], dims[3]].map(Math.round),
    };
  };
  const screenshotAndMetadata = async () => ({ screenshot_b64: await screenshot(), metadata: await metadata() });
  const keyDown = (key: string) => page().keyboard.down(playwrightKey(key));
  const keyUp = (key: string) => page().keyboard.up(playwrightKey(key));

  return {
    get_mouse_position: () => mouse,
    mouse_move_to: ({ x, y }) => moveTo(x, y),
    mouse_move_by: ({ dx, dy }) => moveTo(mouse[0] + dx, mouse[1] + dy),
    mouse_press: ({ button }) => page().mouse.down({ button }),
    mouse_release: ({ button }) => page().mouse.up({ button }),
    click: ({ button = "left", delay_before_release = 0.05 }) => click(button, delay_before_release),
    click_at: async ({ x, y, button = "left", delay_before_release = 0.05 }) => {
      await moveTo(x, y);
      await click(button, delay_before_release);
    },
    double_click: () => page().mouse.dblclick(...mouse),
    drag_and_drop: async ({ origin_x, origin_y, target_x, target_y, button = "left" }) => {
      await moveTo(origin_x, origin_y);
      await page().mouse.down({ button });
      await page().mouse.move(target_x, target_y, { steps: 10 });
      mouse = [target_x, target_y];
      await page().mouse.up({ button });
    },

    input_text: ({ text, delay_between_inputs = 0 }) => page().keyboard.type(text, { delay: delay_between_inputs * 1000 }),
    press_key: ({ key }) => keyDown(key),
    release_key: ({ key }) => keyUp(key),
    press_and_release_keys: async ({ keys, delay_between_keys = 0.05 }) => {
      for (const key of keys) await keyDown(key).then(() => sleep(delay_between_keys * 1000));
      for (const key of [...keys].reverse()) await keyUp(key).then(() => sleep(delay_between_keys * 1000));
    },
    hold_and_tap_keys: async ({ hold_keys, tap_keys, delay_between_keys = 0.05 }) => {
      const pause = () => sleep(delay_between_keys * 1000);
      for (const key of hold_keys) await keyDown(key).then(pause);
      for (const key of tap_keys) await keyDown(key).then(pause).then(() => keyUp(key)).then(pause);
      for (const key of [...hold_keys].reverse()) await keyUp(key).then(pause);
    },
    write_at: async ({ x, y, text, overwrite = true, enter = false }) => {
      await moveTo(x, y);
      await click("left", 0.05);
      if (overwrite) await page().keyboard.press("ControlOrMeta+a");
      await page().keyboard.type(text);
      if (enter) await page().keyboard.press("Enter");
      return "not_checked";
    },

    screenshot_png_bytes: screenshot,
    screenshot_b64: screenshot,
    get_screen_size: screenSize,
    webpage_metadata: metadata,
    screenshot_and_metadata: screenshotAndMetadata,
    observation_bundle: async ({ include_markdown = true }) => ({
      screenshot_and_metadata: await screenshotAndMetadata(),
      viewport_markdown: include_markdown ? await run<string>("return document.body?.innerText ?? ''") : "",
    }),

    goto: ({ url }) => goto(url),
    current_url: () => page().url(),
    back: () => page().goBack({ waitUntil: "domcontentloaded" }).then(() => null),
    forward: () => page().goForward({ waitUntil: "domcontentloaded" }).then(() => null),
    refresh: () => page().reload({ waitUntil: "domcontentloaded" }).then(() => null),
    get_html: () => page().content(),
    get_viewport_html: () => run<string>("return hjs_0x2a.collectViewportHTML()"),
    scroll: ({ dx = 0, dy = 0 }) => scroll(dx, dy),
    scroll_at: async ({ x, y, dx = 0, dy = 0 }) => {
      await moveTo(x, y);
      await scroll(dx, dy);
    },
    scroll_page: ({ dx = 0, dy = 0 }) =>
      run<boolean>("if (document.contentType === 'application/pdf') return false; window.scrollBy(arguments[0], arguments[1]); return true;", dx, dy),
    find_in_page: ({ query }) => run<boolean>("return window.find(arguments[0], false, false, true, false, true, false)", query),

    new_tab: newTab,
    open_new_tab: async ({ url }) => {
      const id = await newTab();
      await goto(url);
      return { tab_id: id, title: await page().title() };
    },
    get_tabs: () => [...tabs.keys()],
    get_active_tab: () => track(page()),
    get_tab_title: ({ tab_id }) => (tab_id ? tab(tab_id) : page()).title(),
    switch_tab_by_id: async ({ tab_id }) => {
      active = tab(tab_id);
      await active.bringToFront();
    },
    close_active_tab: () => page().close(),
    close_tab: ({ tab_id }) => tab(tab_id).close(),
    focus_latest_tab: async () => {
      active = [...tabs.values()].at(-1) ?? active;
      await active?.bringToFront();
    },

    execute_script: ({ script, args = [] }) => run(script, ...args),
    get_select_at: ({ x, y }) => run("return hjs_0x2a.get_select_at(arguments[0], arguments[1])", x, y),
    set_select_option_idx: ({ select_xpath, option_idx }) =>
      run("return hjs_0x2a.set_select_option_idx(arguments[0], arguments[1])", select_xpath, option_idx),

    add_cookies: async ({ cookies }) => {
      const fallbackUrl = page().url();
      await context.addCookies(cookies.map((cookie: SeleniumCookie) => toPlaywrightCookie(cookie, fallbackUrl)));
    },
    get_cookies: async () => (await context.cookies()).map(toSeleniumCookie),
    delete_cookies: () => context.clearCookies(),

    destroy: () => null,
  };
}

interface SeleniumCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expiry?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function toPlaywrightCookie(cookie: SeleniumCookie, fallbackUrl: string) {
  const where = cookie.domain ? { domain: cookie.domain, path: cookie.path ?? "/" } : { url: fallbackUrl };
  return {
    name: cookie.name,
    value: cookie.value,
    ...where,
    ...(cookie.expiry !== undefined && { expires: cookie.expiry }),
    ...(cookie.secure !== undefined && { secure: cookie.secure }),
    ...(cookie.httpOnly !== undefined && { httpOnly: cookie.httpOnly }),
    ...(cookie.sameSite !== undefined && { sameSite: cookie.sameSite }),
  };
}

function toSeleniumCookie(cookie: Cookie): SeleniumCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expires > 0 && { expiry: Math.floor(cookie.expires) }),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
