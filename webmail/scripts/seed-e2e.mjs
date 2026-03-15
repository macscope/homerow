import nodemailer from "nodemailer";
import { chromium } from "@playwright/test";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean env var ${name}: ${raw}`);
}

function baseUrl() {
  return process.env.E2E_BASE_URL || "https://webmail.inout.email";
}

function smtpHost() {
  const explicit = process.env.E2E_SMTP_HOST;
  if (explicit) return explicit;

  const parsed = new URL(baseUrl());
  if (parsed.hostname.startsWith("webmail.")) {
    return parsed.hostname.replace(/^webmail\./, "mail.");
  }
  return "mail.inout.email";
}

function smtpPort() {
  const explicit = process.env.E2E_SMTP_PORT;
  if (explicit) return Number.parseInt(explicit, 10) || 587;
  return 587;
}

async function seedSmtpMessages({ email, password, count }) {
  const transport = nodemailer.createTransport({
    host: smtpHost(),
    port: smtpPort(),
    secure: smtpPort() === 465,
    auth: {
      user: process.env.E2E_SMTP_USER || email,
      pass: process.env.E2E_SMTP_PASSWORD || password,
    },
    tls: { rejectUnauthorized: false },
  });

  const stamp = Date.now();
  for (let i = 1; i <= count; i += 1) {
    const subject = `E2E Seed ${stamp} #${i}`;
    await transport.sendMail({
      from: email,
      to: email,
      subject,
      text: `seed ${i}`,
    });
  }
  transport.close();
  return stamp;
}

async function login(page, email, password) {
  await page.goto("/login");
  if (!page.url().includes("/login")) return;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
}

async function waitForRows(page, minimum) {
  const rows = page.locator(".email-row");
  const refresh = page.getByTitle("Refresh");

  for (let i = 0; i < 20; i += 1) {
    const count = await rows.count();
    if (count >= minimum) return count;
    if (await refresh.count()) await refresh.click();
    await page.waitForTimeout(2_000);
  }
  return rows.count();
}

async function dragFirstRowToCategory(page, categoryText) {
  const row = page.locator(".email-row").first();
  const categoryTab = page
    .locator('[data-testid^="category-drop-tab-"]')
    .filter({ hasText: new RegExp(categoryText, "i") })
    .first();

  await row.scrollIntoViewIfNeeded();
  await categoryTab.scrollIntoViewIfNeeded();
  await Promise.all([expectVisible(row), expectVisible(categoryTab)]);

  const rowBox = await row.boundingBox();
  const tabBox = await categoryTab.boundingBox();
  if (!rowBox || !tabBox) return false;

  const startX = rowBox.x + rowBox.width / 2;
  const startY = rowBox.y + rowBox.height / 2;
  const endX = tabBox.x + tabBox.width / 2;
  const endY = tabBox.y + tabBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 12, { steps: 3 });
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  return true;
}

async function expectVisible(locator) {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
}

async function seedCategoryAssignments({ email, password }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      baseURL: baseUrl(),
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    await login(page, email, password);
    await page.goto("/");
    await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    const rowCount = await waitForRows(page, 3);
    if (rowCount < 1) throw new Error("No inbox rows available for category seeding");

    await dragFirstRowToCategory(page, "Promotions");
    await dragFirstRowToCategory(page, "Promotions");
    await dragFirstRowToCategory(page, "Social");
  } finally {
    await browser.close();
  }
}

async function main() {
  const email = requiredEnv("E2E_EMAIL");
  const password = requiredEnv("E2E_PASSWORD");
  const seedCount = Number.parseInt(process.env.E2E_SEED_COUNT || "6", 10) || 6;
  const skipCategoryAssignments = envBool("E2E_SEED_SKIP_CATEGORY_ASSIGNMENTS", false);

  console.log(`[seed:e2e] Seeding ${seedCount} messages via SMTP...`);
  const stamp = await seedSmtpMessages({ email, password, count: seedCount });
  console.log(`[seed:e2e] Seed batch ${stamp} sent.`);

  if (skipCategoryAssignments) {
    console.log("[seed:e2e] Skipping category assignment (E2E_SEED_SKIP_CATEGORY_ASSIGNMENTS=true).");
  } else {
    console.log("[seed:e2e] Assigning categories via UI drag-and-drop...");
    await seedCategoryAssignments({ email, password });
  }
  console.log("[seed:e2e] Done.");
}

main().catch((err) => {
  console.error("[seed:e2e] Failed:", err);
  process.exit(1);
});
