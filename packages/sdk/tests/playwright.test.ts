import { existsSync } from "node:fs";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CommandHandlers } from "../src/index.js";
import { playwrightWebDriver } from "../src/playwright/index.js";

const PAGE = `
  <input id="name" style="position:absolute; left:20px; top:20px; width:200px; height:30px">
  <select id="pet" style="position:absolute; left:20px; top:80px; width:200px; height:30px">
    <option>Select a pet</option><option>Cat</option><option>Dog</option>
  </select>
  <div style="height:3000px"></div>`;

const pngSize = (b64: string) => {
  const png = Buffer.from(b64, "base64");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

describe.skipIf(!existsSync(chromium.executablePath()))("playwrightWebDriver", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let driver: CommandHandlers;

  beforeAll(async () => {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
    page = await context.newPage();
    driver = playwrightWebDriver(context);
  });
  beforeEach(async () => {
    await page.setContent(PAGE);
    await page.evaluate(() => window.scrollTo(0, 0));
  });
  afterAll(() => browser?.close());

  it("observes at CSS pixels with integer metadata, as the agent's models require", async () => {
    await driver.scroll_page!({ dx: 0, dy: 101.5 });

    const bundle = (await driver.observation_bundle!({ include_markdown: false })) as any;

    expect(pngSize(bundle.screenshot_and_metadata.screenshot_b64)).toEqual([800, 600]);
    const metadata = bundle.screenshot_and_metadata.metadata;
    expect(metadata).toMatchObject({ screen_size: [800, 600], tabs: ["tab-1"], active_tab: "tab-1" });
    for (const value of [...metadata.page_size, ...metadata.scroll_position, ...metadata.mouse_position]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("types, selects and runs scripts with the agent's arguments", async () => {
    expect(await driver.write_at!({ x: 100, y: 35, text: "Ada", overwrite: true, enter: false })).toBe("not_checked");
    expect(await page.inputValue("#name")).toBe("Ada");

    const select = (await driver.get_select_at!({ x: 100, y: 95, n_unsafe_attempts: 2 })) as any;
    expect(select).toMatchObject({ options: ["Select a pet", "Cat", "Dog"], selected_idx: 0 });
    await driver.set_select_option_idx!({ select_xpath: select.xpath, option_idx: 2, n_unsafe_attempts: 2 });
    expect(await page.inputValue("#pet")).toBe("Dog");

    expect(await driver.execute_script!({ script: "return arguments[0] + arguments[1]", args: [2, 3] })).toBe(5);
  });
});
