const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://127.0.0.1:3211";
const OUT = "/tmp/opencode/shots";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

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

async function createSecret(browser, { mode = "text", text, file, views = 1, ttl, passphrase, note }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  if (note) {
    await page.getByLabel("Note").fill(note);
  }

  if (mode === "file") {
    await page.click('button[role="tab"]:has-text("File")');
    await page.setInputFiles('input[type="file"]', file);
  } else {
    await page.fill("textarea", text);
  }

  if (views !== 1) {
    await page.getByLabel("Reads").selectOption(String(views));
  }

  if (ttl !== undefined && ttl !== 24) {
    await page.getByLabel("Expires").selectOption(String(ttl));
  }

  if (passphrase) {
    await page.click("text=Add a password");
    await page.fill('input[autocomplete="new-password"]', passphrase);
  }

  // The ledger POST is fired right after the create resolves, so listen before
  // submitting or the response can land first.
  const ledgerResponse = page
    .waitForResponse(
      (res) => res.url().includes("/api/links") && res.request().method() === "POST",
      { timeout: 20000 },
    )
    .catch(() => null);

  await page.click('button[type="submit"]');
  await page.waitForSelector("text=Link created", { timeout: 20000 });
  const ledger = await ledgerResponse;
  const link = (await page.locator("p.break-all").first().innerText()).trim();
  // Only the request side and the status are read here. Calling response.json()
  // forces Playwright to fetch the body out of the browser, which flakes when the
  // renderer is under memory pressure; the route's own body is checked by the
  // plain `fetch` contract block further down.
  return {
    page,
    link,
    ledger: ledger
      ? { status: ledger.status(), body: ledger.request().postDataJSON() ?? null }
      : null,
  };
}

async function openLink(browser, link) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // "load" rather than "networkidle": a route-handler response can stay
  // reported as pending by Chromium after its body has already rendered.
  await page.goto(link, { waitUntil: "load" });
  await page.waitForTimeout(600);
  return page;
}

(async () => {
  const browser = await launch();
  const consoleErrors = [];
  const badResponses = [];

  const track = (page) => {
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const where = m.location()?.url ?? "";
      consoleErrors.push(where ? `${m.text()} @ ${where}` : m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    page.on("response", (response) => {
      if (response.status() >= 400) {
        badResponses.push(`${response.status()} ${response.url()}`);
      }
    });
  };

  try {
    // ---- 1. Text: create, reveal, verify plaintext, gone on second visit ----
    const textSecret = "hoppers-9K!vault-rail";
    const t1 = await createSecret(browser, { text: textSecret });
    track(t1.page);
    check("text: link has fragment key", /\/s\/[\w-]+#[\w-]+$/.test(t1.link), t1.link);
    check(
      "ledger: create posts the finished link",
      t1.ledger?.status === 201 && t1.ledger?.body?.link === t1.link,
      `${t1.ledger?.status} ${t1.ledger?.body?.link}`,
    );
    check(
      "ledger: body carries the id, link and IP-free fields",
      t1.ledger?.body?.link === t1.link &&
        typeof t1.ledger?.body?.id === "string" &&
        t1.ledger?.body?.password === null,
      JSON.stringify(t1.ledger?.body),
    );
    await t1.page.screenshot({ path: `${OUT}/created.png` });

    const r1 = await openLink(browser, t1.link);
    track(r1);
    await r1.screenshot({ path: `${OUT}/reveal-ready.png` });
    const beforeLabel = await r1.locator('[role="img"]').first().getAttribute("aria-label");
    const openLabel = (await r1.locator('button:has-text("Open")').innerText()).trim();
    check("reveal: primary button says Open", openLabel === "Open", openLabel);
    const openIconCount = await r1.locator('button:has-text("Open") svg').count();
    check("reveal: Open button carries no icon", openIconCount === 0, String(openIconCount));
    const downloadBeforeOpen = await r1.locator('button:has-text("Download")').count();
    check(
      "text: download hidden until the secret is opened",
      downloadBeforeOpen === 0,
      String(downloadBeforeOpen),
    );
    await r1.click('button:has-text("Open")');
    await r1.waitForSelector("pre", { timeout: 15000 });
    await r1.waitForTimeout(500);
    const revealedText = await r1.locator("pre").innerText();
    check("text: decrypted payload matches", revealedText === textSecret, revealedText);
    const afterLabel = await r1.locator('[role="img"]').first().getAttribute("aria-label");
    check("text: burn line starts full", beforeLabel === "1 of 1 reads left", String(beforeLabel));
    check("text: burn line empties after read", afterLabel === "0 of 1 reads left", String(afterLabel));

    const [textDownload] = await Promise.all([
      r1.waitForEvent("download"),
      r1.click('button:has-text("Download")'),
    ]);
    const textSavedPath = "/tmp/opencode/downloaded.txt";
    await textDownload.saveAs(textSavedPath);
    const textSaved = fs.readFileSync(textSavedPath, "utf8");
    check("text: download writes the plaintext", textSaved === textSecret, `${textSaved.length} chars`);
    check(
      "text: download is named after the id",
      /^schemaload-[\w-]+\.txt$/.test(textDownload.suggestedFilename() ?? ""),
      textDownload.suggestedFilename(),
    );
    await r1.screenshot({ path: `${OUT}/reveal-open.png` });

    const gone = await openLink(browser, t1.link);
    await gone.waitForSelector("text=This secret is gone", { timeout: 10000 });
    check("text: second visit is gone", true);
    await gone.screenshot({ path: `${OUT}/reveal-gone.png` });
    await gone.close();

    // ---- 2. File: upload, download, byte-for-byte compare ----
    const samplePath = "/tmp/opencode/sample.bin";
    const sampleBytes = Buffer.from(
      Array.from({ length: 2048 }, (_, i) => (i * 37 + 11) % 256),
    );
    fs.writeFileSync(samplePath, sampleBytes);

    const t2 = await createSecret(browser, {
      mode: "file",
      file: samplePath,
      views: 3,
    });
    check("file: link created", t2.link.includes("/s/"));

    const r2 = await openLink(browser, t2.link);
    track(r2);
    await r2.click('button:has-text("Open")');
    await r2.waitForSelector("a[download]", { timeout: 15000 });
    const downloadName = await r2.locator("a[download]").getAttribute("download");
    const [download] = await Promise.all([
      r2.waitForEvent("download"),
      r2.click("a[download]"),
    ]);
    const savedPath = "/tmp/opencode/downloaded.bin";
    await download.saveAs(savedPath);
    const savedBytes = fs.readFileSync(savedPath);
    check("file: filename survives encryption", downloadName === "sample.bin", String(downloadName));
    check(
      "file: downloaded bytes match original",
      savedBytes.length === sampleBytes.length && savedBytes.equals(sampleBytes),
      `${savedBytes.length} bytes`,
    );
    await r2.screenshot({ path: `${OUT}/reveal-file.png` });
    const textButtonInFile = await r2.locator('button:has-text("Download")').count();
    check(
      "file: text download button stays out of file mode",
      textButtonInFile === 0,
      String(textButtonInFile),
    );
    await r2.close();

    // ---- 3. Password: no fragment, wrong pass does not burn ----
    const passphrase = "correct horse battery";
    const t3 = await createSecret(browser, {
      text: "vault-token-771",
      passphrase,
    });
    check("password: link carries no fragment key", !t3.link.includes("#"), t3.link);
    check(
      "ledger: locked link posts the password",
      t3.ledger?.body?.password === passphrase && t3.ledger?.body?.link === t3.link,
      JSON.stringify(t3.ledger?.body),
    );

    const r3 = await openLink(browser, t3.link);
    track(r3);
    await r3.waitForSelector("text=Enter the password", { timeout: 10000 });
    await r3.fill('input[aria-label="Password"]', "wrong passphrase");
    await r3.click('button:has-text("Open")');
    await r3.waitForSelector("text=That password does not match", { timeout: 15000 });

    const id3 = t3.link.split("/s/")[1];
    const meta = await (await fetch(`${BASE}/api/secrets/${id3}`)).json();
    check("password: wrong attempt spends no read", meta.viewsLeft === 1, `viewsLeft=${meta.viewsLeft}`);

    await r3.fill('input[aria-label="Password"]', passphrase);
    await r3.click('button:has-text("Open")');
    await r3.waitForSelector("pre", { timeout: 15000 });
    const passText = await r3.locator("pre").innerText();
    check("password: correct pass decrypts", passText === "vault-token-771", passText);
    await r3.screenshot({ path: `${OUT}/reveal-password.png` });
    await r3.close();

    // ---- 4. Multi-view: three reads, burn line depletes each time ----
    const t4 = await createSecret(browser, { text: "three-read secret", views: 3 });
    const expected = ["2 of 3 reads left", "1 of 3 reads left", "0 of 3 reads left"];
    for (let read = 0; read < 3; read += 1) {
      const page = await openLink(browser, t4.link);
      track(page);
      await page.click('button:has-text("Open")');
      await page.waitForSelector("pre", { timeout: 15000 });
      await page.waitForTimeout(450);
      const label = await page.locator('[role="img"]').first().getAttribute("aria-label");
      check(`multi-view: read ${read + 1} burn line`, label === expected[read], String(label));
      if (read === 0) {
        const dead = await page.locator('.burn-seg[data-live="false"]').count();
        check("multi-view: one segment burned out", dead === 1, `${dead} dead segments`);
        await page.screenshot({ path: `${OUT}/reveal-multiview.png` });
      }
      await page.close();
    }
    const dead = await openLink(browser, t4.link);
    await dead.waitForSelector("text=This secret is gone", { timeout: 10000 });
    check("multi-view: gone after final read", true);
    await dead.close();

    // ---- 5. No limit: unlimited reads and no expiry ----
    const t5 = await createSecret(browser, {
      text: "no-limit-secret",
      views: 0,
      ttl: 0,
    });
    track(t5.page);
    const noLimitId = t5.link.split("/s/")[1].split("#")[0];
    const noLimitMeta = await (await fetch(`${BASE}/api/secrets/${noLimitId}`)).json();
    check(
      "no limit: metadata reports unlimited reads",
      noLimitMeta.viewsLeft === null && noLimitMeta.viewsAllowed === 0,
      `viewsLeft=${noLimitMeta.viewsLeft} viewsAllowed=${noLimitMeta.viewsAllowed}`,
    );
    check("no limit: metadata reports no expiry", noLimitMeta.expiresAt === 0, `expiresAt=${noLimitMeta.expiresAt}`);

    for (let read = 0; read < 2; read += 1) {
      const page = await openLink(browser, t5.link);
      track(page);
      const trackLabel = await page.locator('[role="img"]').first().getAttribute("aria-label");
      if (read === 0) {
        check("no limit: burn line renders open track", trackLabel === "no read limit", String(trackLabel));
        await page.screenshot({ path: `${OUT}/reveal-nolimit.png` });
      }
      await page.click('button:has-text("Open")');
      await page.waitForSelector("pre", { timeout: 15000 });
      const body = await page.locator("pre").innerText();
      check(`no limit: read ${read + 1} still decrypts`, body === "no-limit-secret", body);
      const after = await page.locator('[role="img"]').first().getAttribute("aria-label");
      check(`no limit: read ${read + 1} track stays open`, after === "no read limit", String(after));
      await page.close();
    }
    await t5.page.close();

    // ---- 5b. Delete returns to the create form ----
    const t6 = await createSecret(browser, { text: "destroy-me", views: 1, ttl: 24 });
    track(t6.page);
    await t6.page.click('button:has-text("Delete")');
    await t6.page.waitForSelector("text=Link deleted", { timeout: 10000 });
    check("delete: result panel flips to deleted", true);
    const backText = await t6.page.locator('button:has-text("Create a new link")').count();
    check("delete: offers a way back to the form", backText === 1, String(backText));
    await t6.page.click('button:has-text("Create a new link")');
    const formBack = await t6.page.locator('button:has-text("Create one-time link")').count();
    check("delete: create form is reachable again", formBack === 1, String(formBack));
    const freshText = await t6.page.locator("textarea").inputValue();
    check("delete: form comes back empty", freshText === "", JSON.stringify(freshText));
    await t6.page.close();

    // ---- 5c. Raw page ----
    const t7 = await createSecret(browser, { text: "raw-view-secret", views: 1, ttl: 24 });
    track(t7.page);
    const r7 = await openLink(browser, t7.link);
    track(r7);
    const hiddenBefore = await r7.locator('a:has-text("Raw page")').count();
    check("raw: button hidden until the secret is opened", hiddenBefore === 0, String(hiddenBefore));

    await r7.click('button:has-text("Open")');
    await r7.waitForSelector("pre", { timeout: 15000 });

    const rawLink = r7.locator('a:has-text("Raw page")');
    await rawLink.waitFor({ timeout: 10000 });
    const rawHref = await rawLink.getAttribute("href");
    check(
      "raw: button points at /s/<id>/raw and keeps the key",
      /\/s\/[\w-]+\/raw#[\w-]+$/.test(rawHref ?? ""),
      String(rawHref),
    );

    // This link has one read, so the blob is already gone; the raw view can only
    // come from what this tab holds.
    const rawGone = await (await fetch(`${BASE}/api/secrets/${rawHref.split("/s/")[1].split("#")[0]}`)).status;
    check("raw: server copy already burned", rawGone === 404, String(rawGone));

    const direct = await fetch(`${BASE}${rawHref.split("#")[0]}`);
    const directBody = await direct.text();
    check(
      "raw: a direct request answers text/plain",
      (direct.headers.get("content-type") ?? "").startsWith("text/plain") &&
        directBody.includes("only be read as raw text"),
      direct.headers.get("content-type") ?? "",
    );

    await rawLink.click();
    await r7.waitForURL(/\/raw/, { timeout: 20000 });
    await r7.waitForTimeout(500);

    const rawType = await r7.evaluate(() => document.contentType);
    check("raw: the browser sees a text/plain document", rawType === "text/plain", rawType);
    const rawText = (await r7.evaluate(() => document.body.innerText)).trim();
    check("raw: plaintext renders from the tab", rawText === "raw-view-secret", rawText);
    check("raw: tab sits on the raw route", /\/s\/[\w-]+\/raw#/.test(r7.url()), r7.url());
    const chrome = await r7.evaluate(() => document.querySelectorAll("main, header, button").length);
    check("raw: no app chrome in the document", chrome === 0, String(chrome));
    await r7.screenshot({ path: `${OUT}/raw-text.png` });

    await r7.goBack();
    await r7.waitForURL(/\/s\/[\w-]+#/, { timeout: 20000 });
    await r7.waitForSelector("pre", { timeout: 20000 });
    const restored = (await r7.locator("pre").innerText()).trim();
    check("raw: back lands on the opened view", restored === "raw-view-secret", restored);
    const goneOnBack = await r7.locator("text=This secret is gone").count();
    check("raw: back does not land on the gone screen", goneOnBack === 0, String(goneOnBack));
    await r7.screenshot({ path: `${OUT}/raw-back.png` });

    // ---- 5d. Note ----
    const NOTE = "Vault code — read it once, then forget it";
    const t8 = await createSecret(browser, {
      text: "note-secret-482",
      note: NOTE,
      views: 3,
      ttl: 24,
    });
    track(t8.page);
    const r8 = await openLink(browser, t8.link);
    track(r8);
    await r8.waitForSelector("h1", { timeout: 10000 });
    const heading8 = (await r8.locator("h1").first().innerText()).trim();
    check("note: renders as the reveal heading", heading8 === NOTE, heading8);

    const id8 = t8.link.split("/s/")[1].split("#")[0];
    const meta8 = await (await fetch(`${BASE}/api/secrets/${id8}`)).json();
    check("note: metadata carries a sealed note", typeof meta8.note?.ciphertext === "string", typeof meta8.note);
    const sealedBytes8 = Buffer.from(meta8.note.ciphertext, "base64").toString("utf8");
    check(
      "note: never stored as plaintext",
      !sealedBytes8.includes("Vault") && !JSON.stringify(meta8).includes(NOTE),
      `${meta8.note.ciphertext.length} b64 chars`,
    );
    await r8.screenshot({ path: `${OUT}/note-heading.png` });

    const t9 = await createSecret(browser, { text: "quiet-secret-119", views: 3, ttl: 24 });
    track(t9.page);
    const r9 = await openLink(browser, t9.link);
    track(r9);
    await r9.waitForTimeout(600);
    const h1Count9 = await r9.locator("h1").count();
    const body9 = await r9.locator("body").innerText();
    check(
      "note: absent note leaves no heading at all",
      h1Count9 === 0 && !body9.includes("Open this secret?"),
      `h1=${h1Count9}`,
    );
    await r9.screenshot({ path: `${OUT}/no-note-heading.png` });

    const PASS10 = "correct-horse-staple";
    const t10 = await createSecret(browser, {
      text: "locked-note-secret",
      passphrase: PASS10,
      note: NOTE,
      views: 3,
      ttl: 24,
    });
    track(t10.page);
    const r10 = await openLink(browser, t10.link);
    track(r10);
    await r10.waitForSelector("h1", { timeout: 10000 });
    const lockedHeading = (await r10.locator("h1").first().innerText()).trim();
    check(
      "note: locked link asks for the password first",
      lockedHeading === "Enter the password",
      lockedHeading,
    );
    await r10.getByLabel("Password").fill(PASS10);
    await r10.waitForTimeout(1500);
    const unlockedHeading = (await r10.locator("h1").first().innerText()).trim();
    check("note: appears once the password matches", unlockedHeading === NOTE, unlockedHeading);
    const id10 = t10.link.split("/s/")[1].split("#")[0];
    const meta10 = await (await fetch(`${BASE}/api/secrets/${id10}`)).json();
    check("note: previewing it spends no read", meta10.viewsLeft === 3, String(meta10.viewsLeft));

    // ---- 5e. Page furniture ----
    const home = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    track(home);
    await home.goto(BASE + "/", { waitUntil: "networkidle" });
    const footers = await home.locator("footer").count();
    check("layout: no site footer", footers === 0, String(footers));
    const bodyHome = await home.locator("body").innerText();
    check("layout: no stray destroy wording", !bodyHome.includes("Destroy now"), "clean");

    const headerText = await home.locator("header").first().innerText();
    check("brand: wordmark says SchemaLoad", headerText.includes("SchemaLoad"), headerText.split("\n")[0]);
    check("brand: no Cinder left on the page", !bodyHome.includes("Cinder"), "clean");
    const iconOk = await home
      .locator('header img[src="/brand/schema-s.svg"]')
      .first()
      .evaluate((img) => img.complete && img.naturalWidth > 0);
    check("brand: orange S icon loads", iconOk === true, String(iconOk));
    const iconRes = await fetch(`${BASE}/icon.svg`);
    check(
      "brand: favicon served as svg",
      iconRes.ok && (iconRes.headers.get("content-type") ?? "").includes("svg"),
      `${iconRes.status} ${iconRes.headers.get("content-type")}`,
    );
    const icoRes = await fetch(`${BASE}/favicon.ico`);
    check(
      "brand: the default favicon path answers",
      icoRes.ok && (icoRes.headers.get("content-type") ?? "").includes("svg"),
      `${icoRes.status} ${icoRes.headers.get("content-type")}`,
    );
    await home.close();

    // ---- 5f. Ledger route contract ----
    const seed = await fetch(`${BASE}/api/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ciphertext: Buffer.alloc(48, 7).toString("base64"),
        iv: Buffer.alloc(12, 3).toString("base64"),
        kind: "text",
        bytes: 48,
        views: 2,
        ttlHours: 24,
        note: null,
      }),
    });
    const seedId = (await seed.json()).id;
    const ledgerPost = (payload, headers = {}) =>
      fetch(`${BASE}/api/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });

    const goodLedger = await ledgerPost(
      {
        id: seedId,
        link: `${BASE}/s/${seedId}#Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg`,
        password: null,
      },
      { "X-Forwarded-For": "198.51.100.24, 10.1.1.1" },
    );
    const goodBody = await goodLedger.json().catch(() => null);
    check(
      "ledger api: accepted row answers 201 logged",
      goodLedger.status === 201 && goodBody?.logged === true,
      `${goodLedger.status} ${JSON.stringify(goodBody)}`,
    );

    const repeatLedger = await ledgerPost({
      id: seedId,
      link: `${BASE}/s/${seedId}`,
      password: null,
    });
    check(
      "ledger api: a repeated id is not an error",
      repeatLedger.status === 201,
      String(repeatLedger.status),
    );

    const badId = await ledgerPost({ id: "nope", link: `${BASE}/s/nope`, password: null });
    check("ledger api: rejects a malformed id", badId.status === 400, String(badId.status));

    const badLink = await ledgerPost({
      id: seedId,
      link: `${BASE}/s/deadbeefdeadbeef`,
      password: null,
    });
    check(
      "ledger api: rejects a link that names another id",
      badLink.status === 400,
      String(badLink.status),
    );

    const missing = await ledgerPost({
      id: "aaaaaaaaaaaaaaaa",
      link: `${BASE}/s/aaaaaaaaaaaaaaaa`,
      password: null,
    });
    check("ledger api: rejects an id with no secret", missing.status === 404, String(missing.status));

    // Clean the seeded secret so the store does not keep an unreadable row.
    await fetch(`${BASE}/api/secrets/${seedId}`, { method: "DELETE" });

    // ---- 5g. The read counter is decided by the database, not by a mutex ----
    const raceSeed = await fetch(`${BASE}/api/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ciphertext: Buffer.alloc(32, 5).toString("base64"),
        iv: Buffer.alloc(12, 6).toString("base64"),
        kind: "text",
        bytes: 32,
        views: 1,
        ttlHours: 24,
        note: null,
      }),
    });
    const raceId = (await raceSeed.json()).id;
    const [raceA, raceB] = await Promise.all([
      fetch(`${BASE}/api/secrets/${raceId}/open`, { method: "POST" }),
      fetch(`${BASE}/api/secrets/${raceId}/open`, { method: "POST" }),
    ]);
    const raceCodes = [raceA.status, raceB.status].sort();
    check(
      "store: two simultaneous opens spend only one read",
      raceCodes[0] === 200 && raceCodes[1] === 404,
      raceCodes.join("/"),
    );

    // ---- 6. Mobile ----
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    track(mobile);
    await mobile.goto(BASE + "/", { waitUntil: "networkidle" });
    await mobile.waitForTimeout(600);
    await mobile.screenshot({ path: `${OUT}/home-mobile.png`, fullPage: true });
    await mobile.close();

    const errorDetail = [
      ...consoleErrors,
      ...[...new Set(badResponses)].map((line) => `response ${line}`),
    ].join(" | ");
    check("no console errors", errorDetail.length === 0, errorDetail.slice(0, 240));
  } catch (cause) {
    console.error("HARNESS ERROR:", cause);
    results.push({ name: "harness", ok: false, detail: String(cause) });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
