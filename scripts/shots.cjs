const { chromium } = require("playwright-core");
const fs = require("node:fs");

const BASE = process.env.BASE || "http://127.0.0.1:3211";
const OUT = "/tmp/opencode/shots";

fs.mkdirSync(OUT, { recursive: true });

async function launch() {
  return chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: false,
    ignoreDefaultArgs: ["--headless"],
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
    ],
    timeout: 40000,
  });
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });

  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/home-top.png` });
  await page.screenshot({ path: `${OUT}/home-full.png`, fullPage: true });

  // Create a text secret through the real UI.
  await page.fill("textarea", "hoppers-9K!vault-rail");
  await page.click('button[type="submit"]');
  await page.waitForSelector("text=Link created", { timeout: 15000 });
  const link = await page.locator("p.break-all").first().innerText();
  await page.screenshot({ path: `${OUT}/created.png` });
  fs.writeFileSync(`${OUT}/link.txt`, link.trim());

  // Reveal it.
  const reveal = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await reveal.goto(link.trim(), { waitUntil: "networkidle" });
  await reveal.waitForTimeout(400);
  await reveal.screenshot({ path: `${OUT}/reveal-ready.png` });
  await reveal.click('button:has-text("Open")');
  await reveal.waitForTimeout(900);
  await reveal.screenshot({ path: `${OUT}/reveal-open.png` });

  // Second attempt should be gone.
  const gone = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await gone.goto(link.trim(), { waitUntil: "networkidle" });
  await gone.waitForTimeout(500);
  await gone.screenshot({ path: `${OUT}/reveal-gone.png` });

  // Mobile.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(BASE + "/", { waitUntil: "networkidle" });
  await mobile.waitForTimeout(300);
  await mobile.screenshot({ path: `${OUT}/home-mobile.png`, fullPage: true });

  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
})();
