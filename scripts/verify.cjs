const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://127.0.0.1:3211";
const OUT = "/tmp/opencode/shots";
fs.mkdirSync(OUT, { recursive: true });

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomId() {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

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

async function createSecret(browser, { mode = "text", text, file, files, ttl, passphrase, note }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  if (note) {
    await page.getByLabel("Note").fill(note);
  }

  if (mode === "file") {
    await page.click('button[role="tab"]:has-text("File")');
    await page.setInputFiles('input[type="file"]', files ?? file);
  } else if (mode === "url") {
    await page.click('button[role="tab"]:has-text("URL")');
    await page.fill('input[type="url"]', text);
  } else {
    await page.fill("textarea", text);
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
    // ---- 1. Text: create, reveal, verify plaintext, second reader still opens ----
    const textSecret = "hoppers-9K!vault-rail";
    const t1 = await createSecret(browser, { text: textSecret });
    track(t1.page);
    check(
      "text: link is eight characters with no key fragment",
      /^https?:\/\/[^/]+\/s\/[a-z0-9]{8}$/.test(t1.link) && !t1.link.includes("#"),
      t1.link,
    );
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
    const revealWords = await r1.locator("body").innerText();
    check("reveal: no read wording", !/\bread(s)?\b/i.test(revealWords), "clean");
    const openLabel = (await r1.locator('button:has-text("Open")').innerText()).trim();
    check("reveal: primary button says Open", openLabel === "Open", openLabel);
    const openIconCount = await r1.locator('button:has-text("Open") svg').count();
    check("reveal: Open button carries no icon", openIconCount === 0, String(openIconCount));
    const readyWords = await r1.locator("body").innerText();
    check(
      "reveal: no expiry footnote before opening",
      !readyWords.includes("Anyone with the link"),
      "clean",
    );
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
    const openedWords = await r1.locator("body").innerText();
    check("reveal: no read wording after opening", !/\bread(s)?\b/i.test(openedWords), "clean");
    check("copy: no character count in the opened view", !openedWords.includes("characters"), "clean");
    check("copy: no 'decrypted' status label", !/decrypted/i.test(openedWords), "clean");
    check("copy: no link-lifetime footnote", !openedWords.includes("Anyone with the link"), "clean");

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
      /^openvcore-[\w-]+\.txt$/.test(textDownload.suggestedFilename() ?? ""),
      textDownload.suggestedFilename(),
    );
    await r1.screenshot({ path: `${OUT}/reveal-open.png` });

    const again = await openLink(browser, t1.link);
    track(again);
    await again.click('button:has-text("Open")');
    await again.waitForSelector("pre", { timeout: 15000 });
    const againText = await again.locator("pre").innerText();
    check("text: a second reader still opens it", againText === textSecret, againText);
    await again.screenshot({ path: `${OUT}/reveal-second-read.png` });
    await again.close();

    // ---- 1b. URL mode: the link opens the target instead of a page ----
    const urlTarget = `${BASE}/#url-target`;
    const t1b = await createSecret(browser, { mode: "url", text: urlTarget });
    track(t1b.page);
    check("url: link created", /\/s\/[a-z0-9]{8}$/.test(t1b.link), t1b.link);
    check(
      "url: mode hides the note and the password toggle",
      (await t1b.page.locator("form input[type='text']").count()) === 0 &&
        (await t1b.page.locator("button:has-text('Add a password')").count()) === 0,
      "hidden",
    );
    await t1b.page.screenshot({ path: `${OUT}/url-created.png` });
    await t1b.page.close();

    const id1b = t1b.link.split("/s/")[1];
    const firstOpen = await fetch(`${BASE}/s/${id1b}`, { redirect: "manual" });
    check(
      "url: opening the link answers with a redirect",
      firstOpen.status === 307 || firstOpen.status === 308,
      String(firstOpen.status),
    );
    check(
      "url: the redirect points at the typed address",
      firstOpen.headers.get("location") === urlTarget,
      String(firstOpen.headers.get("location")),
    );

    const secondOpen = await fetch(`${BASE}/s/${id1b}`, { redirect: "manual" });
    check(
      "url: a second visit redirects the same way",
      secondOpen.status === firstOpen.status &&
        secondOpen.headers.get("location") === urlTarget,
      String(secondOpen.status),
    );

    const urlRaw = await fetch(`${BASE}/s/${id1b}/raw`);
    check("url: no raw view on a redirect link", urlRaw.status === 404, String(urlRaw.status));

    const urlMeta = await (await fetch(`${BASE}/api/secrets/${id1b}`)).json();
    check("url: kind is recorded as url", urlMeta.kind === "url", String(urlMeta.kind));
    check("url: visits spend no read", urlMeta.viewsLeft === null, String(urlMeta.viewsLeft));

    const urlVisit = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    track(urlVisit);
    await urlVisit.goto(t1b.link, { waitUntil: "domcontentloaded" });
    await urlVisit.waitForTimeout(500);
    check("url: the browser lands on the target", urlVisit.url() === urlTarget, urlVisit.url());
    await urlVisit.close();

    // ---- 2. Files: two uploads, per-file download, one zip ----
    const samplePath = "/tmp/opencode/sample.bin";
    const sampleBytes = Buffer.from(
      Array.from({ length: 2048 }, (_, i) => (i * 37 + 11) % 256),
    );
    fs.writeFileSync(samplePath, sampleBytes);

    const extraPath = "/tmp/opencode/notes.txt";
    const extraBytes = Buffer.from("second file inside the same sealed link\n", "utf8");
    fs.writeFileSync(extraPath, extraBytes);

    const t2 = await createSecret(browser, {
      mode: "file",
      files: [samplePath, extraPath],
    });
    check("file: link created", /\/s\/[a-z0-9]{8}$/.test(t2.link), t2.link);

    const r2 = await openLink(browser, t2.link);
    track(r2);
    await r2.click('button:has-text("Open")');
    await r2.waitForSelector("a[download]", { timeout: 15000 });

    const rows2 = await r2.locator("a[download]").count();
    check("file: both files listed in the opened view", rows2 === 2, String(rows2));

    const downloadName = await r2.locator("a[download]").first().getAttribute("download");
    const [download] = await Promise.all([
      r2.waitForEvent("download"),
      r2.locator("a[download]").first().click(),
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
    const textButtonInFile = await r2.locator('button:text-is("Download")').count();
    check(
      "file: text download button stays out of file mode",
      textButtonInFile === 0,
      String(textButtonInFile),
    );

    // ---- 2b. Download all: one archive holding both files ----
    const zipButton = r2.locator('button:has-text("Download all")');
    check("file: download all offered for two files", (await zipButton.count()) === 1, "1");
    const [zipDownload] = await Promise.all([
      r2.waitForEvent("download"),
      zipButton.click(),
    ]);
    const zipPath = "/tmp/opencode/downloaded.zip";
    await zipDownload.saveAs(zipPath);
    check(
      "file: zip download is named after the id",
      /^openvcore-[a-z0-9]{8}\.zip$/.test(zipDownload.suggestedFilename() ?? ""),
      zipDownload.suggestedFilename(),
    );
    const zipBytes = fs.readFileSync(zipPath);
    check(
      "file: zip starts with a local file header",
      zipBytes.subarray(0, 4).toString("latin1") === "PK\u0003\u0004",
      zipBytes.subarray(0, 4).toString("hex"),
    );
    const zipDir = "/tmp/opencode/unzip";
    fs.rmSync(zipDir, { recursive: true, force: true });
    require("node:child_process").execFileSync("unzip", ["-o", zipPath, "-d", zipDir]);
    const zippedSample = fs.readFileSync(path.join(zipDir, "sample.bin"));
    const zippedExtra = fs.readFileSync(path.join(zipDir, "notes.txt"));
    check(
      "file: zip extracts both files byte for byte",
      zippedSample.equals(sampleBytes) && zippedExtra.equals(extraBytes),
      `${zippedSample.length}+${zippedExtra.length} bytes`,
    );
    await r2.screenshot({ path: `${OUT}/reveal-file-zip.png` });

    // ---- 2c. Raw per file: text files only, one file per view ----
    const rawButtons = r2.locator('a[aria-label$="as raw text"]');
    check("file raw: only the text file offers a raw view", (await rawButtons.count()) === 1, "1");
    const rawNotes = r2.locator('a[aria-label="Open notes.txt as raw text"]');
    check("file raw: the button sits on the text file", (await rawNotes.count()) === 1, "notes.txt");
    const rawNotesHref = await rawNotes.getAttribute("href");
    check(
      "file raw: it points at /raw?file=<index> with no fragment",
      /^\/s\/[a-z0-9]{8}\/raw\?file=\d+$/.test(rawNotesHref ?? ""),
      String(rawNotesHref),
    );

    await rawNotes.click();
    await r2.waitForURL(/\/raw\?file=\d+$/, { timeout: 20000 });
    await r2.waitForTimeout(400);
    const fileRawType = await r2.evaluate(() => document.contentType);
    check("file raw: the browser sees a text/plain document", fileRawType === "text/plain", fileRawType);
    const fileRawText = (await r2.evaluate(() => document.body.innerText)).trim();
    check(
      "file raw: the view holds just that file",
      fileRawText === extraBytes.toString("utf8").trim(),
      fileRawText,
    );
    await r2.screenshot({ path: `${OUT}/raw-file.png` });

    await r2.goBack();
    await r2.waitForSelector("a[download]", { timeout: 20000 });
    const backRows = await r2.locator("a[download]").count();
    check("file raw: back returns to the opened file list", backRows === 2, String(backRows));

    const listingRaw = await fetch(`${BASE}/api/secrets/${t2.link.split("/s/")[1]}`).then((res) => res.json());
    check("file raw: none of it spent a read", listingRaw.viewsLeft === null, String(listingRaw.viewsLeft));
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
    check("password: wrong attempt spends no read", meta.viewsLeft === null, `viewsLeft=${meta.viewsLeft}`);

    await r3.fill('input[aria-label="Password"]', passphrase);
    await r3.click('button:has-text("Open")');
    await r3.waitForSelector("pre", { timeout: 15000 });
    const passText = await r3.locator("pre").innerText();
    check("password: correct pass decrypts", passText === "vault-token-771", passText);
    await r3.screenshot({ path: `${OUT}/reveal-password.png` });
    await r3.close();

    // A locked link's raw view needs the password appended to the URL.
    const rawPrompt = await fetch(`${BASE}/s/${id3}/raw`);
    const rawPromptBody = await rawPrompt.text();
    check(
      "password raw: no password explains how to add one",
      rawPrompt.status === 200 && rawPromptBody.includes(`/s/${id3}/raw/`),
      rawPromptBody.split("\n")[0],
    );
    const rawWrong = await fetch(`${BASE}/s/${id3}/raw/not-the-password`);
    check("password raw: a wrong password is refused", rawWrong.status === 401, String(rawWrong.status));
    const rawLocked = await fetch(`${BASE}/s/${id3}/raw/${encodeURIComponent(passphrase)}`);
    const rawLockedBody = (await rawLocked.text()).trim();
    check(
      "password raw: the right password returns the plaintext",
      rawLocked.status === 200 && rawLockedBody === "vault-token-771",
      rawLockedBody,
    );
    const rawLockedQuery = await fetch(
      `${BASE}/s/${id3}/raw?p=${encodeURIComponent(passphrase)}`,
    );
    check(
      "password raw: ?p= works too",
      rawLockedQuery.status === 200,
      String(rawLockedQuery.status),
    );

    // ---- 4. Readers: many reads leave the payload intact ----
    const t4 = await createSecret(browser, { text: "many-reader secret" });
    for (let read = 0; read < 3; read += 1) {
      const page = await openLink(browser, t4.link);
      track(page);
      await page.click('button:has-text("Open")');
      await page.waitForSelector("pre", { timeout: 15000 });
      await page.waitForTimeout(300);
      const body = await page.locator("pre").innerText();
      check(`readers: open ${read + 1} decrypts`, body === "many-reader secret", body);
      const words = await page.locator("body").innerText();
      check(`readers: open ${read + 1} has no read wording`, !/\bread(s)?\b/i.test(words), "clean");
      if (read === 2) {
        await page.screenshot({ path: `${OUT}/reveal-many-reads.png` });
      }
      await page.close();
    }
    const id4 = t4.link.split("/s/")[1].split("#")[0];
    const survivor = await fetch(`${BASE}/api/secrets/${id4}`);
    const survivorMeta = await survivor.json();
    check(
      "readers: the link survives every read",
      survivor.status === 200 && survivorMeta.viewsLeft === null,
      `${survivor.status} viewsLeft=${survivorMeta.viewsLeft}`,
    );

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
      if (read === 0) {
        await page.screenshot({ path: `${OUT}/reveal-nolimit.png` });
      }
      await page.click('button:has-text("Open")');
      await page.waitForSelector("pre", { timeout: 15000 });
      const body = await page.locator("pre").innerText();
      check(`no limit: open ${read + 1} still decrypts`, body === "no-limit-secret", body);
      await page.close();
    }
    await t5.page.close();

    // ---- 5b. Delete returns to the create form ----
    const t6 = await createSecret(browser, { text: "destroy-me", ttl: 24 });
    track(t6.page);
    await t6.page.click('button:has-text("Delete")');
    await t6.page.waitForSelector("text=Link deleted", { timeout: 10000 });
    check("delete: result panel flips to deleted", true);
    const backText = await t6.page.locator('button:has-text("Create a new link")').count();
    check("delete: offers a way back to the form", backText === 1, String(backText));
    await t6.page.click('button:has-text("Create a new link")');
    const formBack = await t6.page.locator('button[type="submit"]').count();
    const formLabel = (await t6.page.locator('button[type="submit"]').innerText()).trim();
    check(
      "delete: create form is reachable again",
      formBack === 1 && formLabel === "Create",
      `${formBack} ${formLabel}`,
    );
    const freshText = await t6.page.locator("textarea").inputValue();
    check("delete: form comes back empty", freshText === "", JSON.stringify(freshText));
    await t6.page.close();

    // ---- 5c. Raw page ----
    const t7 = await createSecret(browser, { text: "raw-view-secret", ttl: 24 });
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
      "raw: button points at /s/<id>/raw with no fragment",
      /\/s\/[a-z0-9]{8}\/raw$/.test(rawHref ?? ""),
      String(rawHref),
    );

    // The read did not consume the secret, so the server still has it. The key is
    // a hash of the id, so a request with no tab behind it can be opened here too.
    const rawId = rawHref.split("/")[2];
    const stillStored = await (
      await fetch(`${BASE}/api/secrets/${rawId}`)
    ).status;
    check("raw: opening a link does not delete it", stillStored === 200, String(stillStored));

    const direct = await fetch(`${BASE}${rawHref}`);
    const directBody = (await direct.text()).trim();
    check(
      "raw: a direct request answers text/plain",
      (direct.headers.get("content-type") ?? "").startsWith("text/plain"),
      direct.headers.get("content-type") ?? "",
    );
    check("raw: a direct request returns the plaintext", directBody === "raw-view-secret", directBody);
    const afterDirect = await (await fetch(`${BASE}/api/secrets/${rawId}`)).json();
    check(
      "raw: a direct request spends no read",
      afterDirect.viewsLeft === null,
      String(afterDirect.viewsLeft),
    );
    const unknown = await fetch(`${BASE}/s/zzzzzzzz/raw`);
    check("raw: an unknown id answers 404", unknown.status === 404, String(unknown.status));

    await rawLink.click();
    await r7.waitForURL(/\/raw/, { timeout: 20000 });
    await r7.waitForTimeout(500);

    const rawType = await r7.evaluate(() => document.contentType);
    check("raw: the browser sees a text/plain document", rawType === "text/plain", rawType);
    const rawText = (await r7.evaluate(() => document.body.innerText)).trim();
    check("raw: plaintext renders from the tab", rawText === "raw-view-secret", rawText);
    check("raw: tab sits on the raw route", /\/s\/[a-z0-9]{8}\/raw$/.test(r7.url()), r7.url());
    const chrome = await r7.evaluate(() => document.querySelectorAll("main, header, button").length);
    check("raw: no app chrome in the document", chrome === 0, String(chrome));
    await r7.screenshot({ path: `${OUT}/raw-text.png` });

    await r7.goBack();
    await r7.waitForURL(/\/s\/[a-z0-9]{8}$/, { timeout: 20000 });
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
    check("note: previewing it spends no read", meta10.viewsLeft === null, String(meta10.viewsLeft));

    // ---- 5e. Page furniture ----
    const home = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    track(home);
    await home.goto(BASE + "/", { waitUntil: "networkidle" });
    const footers = await home.locator("footer").count();
    check("layout: no site footer", footers === 0, String(footers));
    const bodyHome = await home.locator("body").innerText();
    check("layout: no stray destroy wording", !bodyHome.includes("Destroy now"), "clean");

    const submitLabel = (await home.locator('button[type="submit"]').innerText()).trim();
    check("create: submit button says Create", submitLabel === "Create", submitLabel);
    check("create: no algorithm label on the form", !bodyHome.includes("AES-256-GCM"), "clean");
    check("create: no plaintext caption", !bodyHome.includes("plaintext never leaves"), "clean");
    check("create: no one-time sharing sentence", !bodyHome.includes("shown once here"), "clean");
    check("create: no link-lifetime footnote", !bodyHome.includes("Anyone with the link"), "clean");

    const headerText = await home.locator("header").first().innerText();
    check("brand: wordmark says OpenVCore", headerText.includes("OpenVCore"), headerText.split("\n")[0]);
    check("brand: no Cinder left on the page", !bodyHome.includes("Cinder"), "clean");
    const iconOk = await home
      .locator('header img[src="/brand/openvcore.png"]')
      .first()
      .evaluate((img) => img.complete && img.naturalWidth > 0);
    check("brand: OpenVCore icon loads", iconOk === true, String(iconOk));
    const iconRes = await fetch(`${BASE}/icon.png`);
    check(
      "brand: favicon served as png",
      iconRes.ok && (iconRes.headers.get("content-type") ?? "").includes("png"),
      `${iconRes.status} ${iconRes.headers.get("content-type")}`,
    );
    const icoRes = await fetch(`${BASE}/favicon.ico`);
    check(
      "brand: the default favicon path answers",
      icoRes.ok && (icoRes.headers.get("content-type") ?? "").includes("png"),
      `${icoRes.status} ${icoRes.headers.get("content-type")}`,
    );
    await home.close();

    // ---- 5f. Ledger route contract ----
    const seedSecretId = randomId();
    const seed = await fetch(`${BASE}/api/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: seedSecretId,
        ciphertext: Buffer.alloc(48, 7).toString("base64"),
        iv: Buffer.alloc(12, 3).toString("base64"),
        kind: "text",
        bytes: 48,
        ttlHours: 24,
        note: null,
      }),
    });
    const seedId = (await seed.json()).id;
    check(
      "api: create stores under the client-chosen id",
      seed.status === 201 && seedId === seedSecretId,
      `${seed.status} ${seedId}`,
    );
    const ledgerPost = (payload, headers = {}) =>
      fetch(`${BASE}/api/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });

    const goodLedger = await ledgerPost(
      {
        id: seedId,
        link: `${BASE}/s/${seedId}`,
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
      link: `${BASE}/s/${randomId()}`,
      password: null,
    });
    check(
      "ledger api: rejects a link that names another id",
      badLink.status === 400,
      String(badLink.status),
    );

    const missing = await ledgerPost({
      id: "aaaaaaaa",
      link: `${BASE}/s/aaaaaaaa`,
      password: null,
    });
    check("ledger api: rejects an id with no secret", missing.status === 404, String(missing.status));

    // Clean the seeded secret so the store does not keep an unreadable row.
    await fetch(`${BASE}/api/secrets/${seedId}`, { method: "DELETE" });

    // ---- 5g. A views field in the request cannot bring the limit back ----
    const raceSeed = await fetch(`${BASE}/api/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: randomId(),
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
    const raceMeta = await (await fetch(`${BASE}/api/secrets/${raceId}`)).json();
    check(
      "store: a requested read limit is ignored",
      raceMeta.viewsAllowed === 0 && raceMeta.viewsLeft === null,
      `viewsAllowed=${raceMeta.viewsAllowed} viewsLeft=${raceMeta.viewsLeft}`,
    );
    const [raceA, raceB] = await Promise.all([
      fetch(`${BASE}/api/secrets/${raceId}/open`, { method: "POST" }),
      fetch(`${BASE}/api/secrets/${raceId}/open`, { method: "POST" }),
    ]);
    check(
      "store: two simultaneous opens both succeed",
      raceA.status === 200 && raceB.status === 200,
      `${raceA.status}/${raceB.status}`,
    );
    const raceAfter = await (await fetch(`${BASE}/api/secrets/${raceId}`)).json();
    check(
      "store: concurrent reads leave it intact",
      raceAfter.viewsLeft === null,
      `viewsLeft=${raceAfter.viewsLeft}`,
    );
    await fetch(`${BASE}/api/secrets/${raceId}`, { method: "DELETE" });

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
