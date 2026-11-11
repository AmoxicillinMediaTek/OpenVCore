/**
 * Proves that a link outlives the process that created it.
 *
 * Creates a one-read secret over the API, kills the running next-server, starts a
 * new one, then peeks and opens the same id. With the filesystem store this failed
 * whenever the project directory was replaced; with the Postgres store the row is
 * independent of both the process and the checkout.
 *
 * Usage: node scripts/persist.cjs
 */
const { execSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://127.0.0.1:3211";
const LOG = "/tmp/opencode/persist-server.log";
const ROOT = path.resolve(__dirname, "..");

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/`, { cache: "no-store" });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

function killServer() {
  try {
    const pids = execSync(
      "ps -eo pid,args | grep -i next-server | grep -v grep | awk '{print $1}'",
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    return pids.length;
  } catch {
    return 0;
  }
}

async function startServer() {
  const out = fs.openSync(LOG, "w");
  const child = spawn("npm", ["run", "start"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
}

(async () => {
  const up = await waitForServer(20000);
  check("server is reachable before the test", up, BASE);
  if (!up) return;

  const plaintext = "survives-a-deploy-48f1";
  const created = await fetch(`${BASE}/api/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ciphertext: Buffer.from(plaintext).toString("base64"),
      iv: Buffer.alloc(12, 9).toString("base64"),
      kind: "text",
      bytes: plaintext.length,
      views: 1,
      ttlHours: 24,
      note: null,
    }),
  });
  const { id } = await created.json();
  check("created a one-read link", created.status === 201 && /^[a-f0-9]{16}$/.test(id), id);

  const dataDir = path.join(ROOT, ".schemaload-data");
  check(
    "nothing was written to the project directory",
    !fs.existsSync(dataDir) || fs.readdirSync(dataDir).length === 0,
    dataDir,
  );

  const killed = killServer();
  check("stopped the running server", killed > 0, `${killed} process(es)`);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  await startServer();
  const back = await waitForServer(60000);
  check("new server answered after the restart", back, BASE);
  if (!back) return;

  const peeked = await fetch(`${BASE}/api/secrets/${id}`, { cache: "no-store" });
  const info = await peeked.json();
  check(
    "the link is still readable after the restart",
    peeked.status === 200 && info.viewsLeft === 1,
    `${peeked.status} ${JSON.stringify(info).slice(0, 90)}`,
  );

  const opened = await fetch(`${BASE}/api/secrets/${id}/open`, { method: "POST" });
  const payload = await opened.json();
  check(
    "the payload still opens after the restart",
    opened.status === 200 &&
      Buffer.from(payload.ciphertext, "base64").toString("utf8") === plaintext,
    `${opened.status}`,
  );

  const spent = await fetch(`${BASE}/api/secrets/${id}/open`, { method: "POST" });
  check("the single read was still honoured once", spent.status === 404, String(spent.status));
})();
