import { expect, test, type Page } from "@playwright/test";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function parseDisplayedTotal(raw: string): number | null {
  const rangeMatch = raw.match(/(\d[\d,]*)\s*[–-]\s*(\d[\d,]*)\s+of\s+(\d[\d,]*)/i);
  if (rangeMatch) return Number(rangeMatch[3].replace(/,/g, ""));
  const zeroMatch = raw.match(/\b0\s+of\s+0\b/i);
  if (zeroMatch) return 0;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function login(page: Page): Promise<void> {
  const email = requiredEnv("E2E_EMAIL");
  const password = requiredEnv("E2E_PASSWORD");

  await page.goto("/login");
  if (!page.url().includes("/login")) return;

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20_000 });
}

async function getDisplayedRangeTotal(scope: ReturnType<Page["locator"]>): Promise<number | null> {
  const text = await scope.innerText();
  return parseDisplayedTotal(text);
}

async function getRangeLocator(page: Page) {
  return page.locator("div").filter({ hasText: /((\d[\d,]*)\s*[–-]\s*(\d[\d,]*)\s+of\s+(\d[\d,]*)|0\s+of\s+0)/ }).first();
}

test.describe("Category regressions", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    if (new URL(page.url()).pathname !== "/") {
      await page.goto("/");
    }
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  });

  test("settings no longer exposes auto-refresh interval control", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByText("Auto-refresh")).toHaveCount(0);
    await expect(page.getByText("Automatically check for new emails at a regular interval")).toHaveCount(0);
  });

  test("category selection uses category mailbox query and displayed total follows backend total", async ({ page }) => {
    const categoryLink = page.locator('a[href*="filter=category%3A"]').first();
    await expect(categoryLink).toBeVisible();
    const categoryName = (await categoryLink.innerText()).trim();
    expect(categoryName.length).toBeGreaterThan(0);

    const inboxRange = await getRangeLocator(page);
    const inboxTotal = await getDisplayedRangeTotal(inboxRange);
    expect(inboxTotal).not.toBeNull();

    await categoryLink.click();
    await expect(page).toHaveURL(/filter=category%3A/i);
    await expect(page.getByRole("heading", { name: categoryName, exact: true })).toBeVisible();
    const categoryRange = await getRangeLocator(page);
    const displayedCategoryTotal = await getDisplayedRangeTotal(categoryRange);
    expect(displayedCategoryTotal).not.toBeNull();
    expect(displayedCategoryTotal!).toBeGreaterThan(0);
    expect(displayedCategoryTotal).not.toBe(inboxTotal);

    await page.getByRole("button", { name: /clear filter/i }).click();
    await expect(page).toHaveURL(/\/$/);
    const inboxRangeAfter = await getRangeLocator(page);
    const displayedInboxTotal = await getDisplayedRangeTotal(inboxRangeAfter);
    expect(displayedInboxTotal).not.toBeNull();
    expect(displayedInboxTotal).toBe(inboxTotal);
  });

  test("switching category tabs updates totals and returns to primary total", async ({ page }) => {
    const inboxRange = await getRangeLocator(page);
    const inboxTotal = await getDisplayedRangeTotal(inboxRange);
    expect(inboxTotal).not.toBeNull();

    const categoryLinks = page.locator('a[href*="filter=category%3A"]');
    const count = await categoryLinks.count();
    expect(count).toBeGreaterThan(0);
    const maxTabs = Math.min(3, count);
    let sawDifferentTotal = false;

    for (let i = 0; i < maxTabs; i += 1) {
      await categoryLinks.nth(i).click();
      await expect(page).toHaveURL(/filter=category%3A/i);
      const catRange = await getRangeLocator(page);
      const catTotal = await getDisplayedRangeTotal(catRange);
      expect(catTotal).not.toBeNull();
      if (catTotal !== inboxTotal) sawDifferentTotal = true;
    }
    expect(sawDifferentTotal).toBeTruthy();

    await page.getByRole("button", { name: /clear filter/i }).click();
    await expect(page).toHaveURL(/\/$/);
    const inboxRangeBack = await getRangeLocator(page);
    const inboxTotalBack = await getDisplayedRangeTotal(inboxRangeBack);
    expect(inboxTotalBack).not.toBeNull();
    expect(inboxTotalBack).toBe(inboxTotal);
  });

  test("browser tab title follows selected category and selected section", async ({ page }) => {
    const categoryLink = page.locator('a[href*="filter=category%3A"]').first();
    await expect(categoryLink).toBeVisible();
    const categoryName = (await categoryLink.innerText()).trim();
    expect(categoryName.length).toBeGreaterThan(0);

    await categoryLink.click();
    await expect(page).toHaveURL(/filter=category%3A/i);
    await expect(page.getByRole("heading", { name: categoryName, exact: true })).toBeVisible();
    await expect.poll(async () => page.title()).toMatch(
      new RegExp(`^(\\(\\d+\\)\\s)?${escapeRegExp(categoryName)} - Homerow$`)
    );

    await page.getByRole("link", { name: /^Important(?:\s+\d+)?$/ }).first().click();
    await expect(page).toHaveURL(/filter=important/i);
    await expect(page.getByRole("heading", { name: "Important", exact: true })).toBeVisible();
    await expect.poll(async () => page.title()).toMatch(/^(?:\(\d+\)\s)?Important - Homerow$/);
  });

  test("rapid category switching keeps list and total aligned with selected tab", async ({ page }) => {
    const categoryLinks = page.locator('a[href*="filter=category%3A"]');
    const count = await categoryLinks.count();
    test.skip(count < 2, "Need at least two configured categories");

    const first = categoryLinks.nth(0);
    const second = categoryLinks.nth(1);
    const firstName = (await first.innerText()).trim();
    const secondName = (await second.innerText()).trim();

    await first.click();
    await expect(page.getByRole("heading", { name: firstName, exact: true })).toBeVisible();
    const firstTotal = await getDisplayedRangeTotal(await getRangeLocator(page));
    expect(firstTotal).not.toBeNull();

    for (let i = 0; i < 6; i += 1) {
      await second.click();
      await first.click();
    }

    await second.click();
    await expect(page).toHaveURL(/filter=category%3A/i);
    await expect(page.getByRole("heading", { name: secondName, exact: true })).toBeVisible();
    const secondTotal = await getDisplayedRangeTotal(await getRangeLocator(page));
    expect(secondTotal).not.toBeNull();

    if (firstTotal !== secondTotal) {
      expect(secondTotal).not.toBe(firstTotal);
    }
  });

  test("rapid sidebar category clicks do not strand the final category in loading state", async ({ page }) => {
    const categoryLinks = page.locator('a[href*="filter=category%3A"]');
    const count = await categoryLinks.count();
    test.skip(count < 2, "Need at least two configured categories");

    const first = categoryLinks.nth(0);
    const second = categoryLinks.nth(1);
    const secondName = (await second.innerText()).trim();
    expect(secondName.length).toBeGreaterThan(0);

    for (let i = 0; i < 4; i += 1) {
      await first.click();
      await second.click();
    }

    await expect(page).toHaveURL(/filter=category%3A/i);
    await expect(page.getByRole("heading", { name: secondName, exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".skeleton")).toHaveCount(0);

    const displayedTotal = await getDisplayedRangeTotal(await getRangeLocator(page));
    expect(displayedTotal).not.toBeNull();
  });

  test("dragging email row to a category via real mouse does not trigger flags runtime error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message || String(err)));

    const row = page.locator(".email-row").first();
    await expect(row).toBeVisible();

    const categoryTabButton = page.locator('[data-testid^="category-drop-tab-"]').filter({ hasText: /Promotions|Social|Updates/i }).first();
    await expect(categoryTabButton).toBeVisible();

    // Use real mouse events (pointerdown → pointermove → pointerup) to drag from row
    const rowBox = await row.boundingBox();
    const tabBox = await categoryTabButton.boundingBox();
    expect(rowBox).toBeTruthy();
    expect(tabBox).toBeTruthy();

    const startX = rowBox!.x + rowBox!.width / 2;
    const startY = rowBox!.y + rowBox!.height / 2;
    const endX = tabBox!.x + tabBox!.width / 2;
    const endY = tabBox!.y + tabBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move past the 5px drag threshold in steps
    await page.mouse.move(startX, startY - 10, { steps: 3 });
    await page.mouse.move(endX, endY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(2000);

    const flagsErrors = errors.filter((msg) => msg.includes("reading 'flags'") || msg.includes("reading \"flags\""));
    expect(flagsErrors, `Page errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("dragging multiple selected emails shows multi-drag UI with per-category hints", async ({ page }) => {
    const rows = page.locator(".email-row");
    test.skip((await rows.count()) < 2, "Need at least two email rows");

    const rowCheckboxes = page.locator(".email-row .mail-checkbox");
    await rowCheckboxes.nth(0).check();
    await rowCheckboxes.nth(1).check();

    const categoryTabs = page.locator('[data-testid^="category-drop-tab-"]');
    const tabCount = await categoryTabs.count();
    test.skip(tabCount < 2, "Need at least two category tabs");

    const firstRow = rows.first();
    await expect(firstRow).toBeVisible();

    // Use real mouse to initiate pointer drag past threshold — start from middle of row
    const rowBox = await firstRow.boundingBox();
    expect(rowBox).toBeTruthy();
    const startX = rowBox!.x + rowBox!.width / 2;
    const startY = rowBox!.y + rowBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move 20px down to exceed the 5px drag threshold and activate drag UI
    await page.mouse.move(startX, startY + 20, { steps: 5 });

    const dragPreview = page.locator('[data-testid="drag-preview-box"]');
    await expect(dragPreview).toBeVisible();
    await expect(dragPreview).toContainText("Move 2 messages");

    const hints = page.locator('[data-testid^="category-drop-hint-"]');
    await expect(hints).toHaveCount(tabCount);
    await expect(hints.first()).toContainText("Drag here to move 2 messages");

    // Release to cancel drag (not over a tab)
    await page.mouse.up();
    await expect(hints).toHaveCount(0);
  });

  test("real mouse drag from row does not open email in reading pane", async ({ page }) => {
    const row = page.locator(".email-row").first();
    await expect(row).toBeVisible();

    // Perform a short drag gesture on the row body (not on a button/checkbox)
    const rowBox = await row.boundingBox();
    expect(rowBox).toBeTruthy();
    const startX = rowBox!.x + rowBox!.width / 2;
    const startY = rowBox!.y + rowBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 15, startY, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    // The reading pane should NOT have opened
    const readingPane = page.locator(".reading-pane-enter");
    await expect(readingPane).toHaveCount(0);
  });
});
