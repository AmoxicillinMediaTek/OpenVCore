/**
 * Proves that a link outlives the process that created it.
 *
 * Creates a secret over the API, kills the running next-server, starts a
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
  const wanted = Array.from({ length: 8 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789"[
      Math.floor(Math.random() * 36)
    ],
  ).join("");
  const created = await fetch(`${BASE}/api/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: wanted,
      ciphertext: Buffer.from(plaintext).toString("base64"),
      iv: Buffer.alloc(12, 9).toString("base64"),
      kind: "text",
      bytes: plaintext.length,
      ttlHours: 24,
      note: null,
    }),
  });
  const { id } = await created.json();
  check(
    "created a link under the chosen id",
    created.status === 201 && /^[a-z0-9]{8}$/.test(id) && id === wanted,
    id,
  );

  const dataDir = path.join(ROOT, ".openvcore-data");
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
    peeked.status === 200 && info.viewsLeft === null,
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

  const again = await fetch(`${BASE}/api/secrets/${id}/open`, { method: "POST" });
  const againPayload = await again.json();
  check(
    "reading it did not delete it",
    again.status === 200 &&
      Buffer.from(againPayload.ciphertext, "base64").toString("utf8") === plaintext,
    String(again.status),
  );

  const after = await fetch(`${BASE}/api/secrets/${id}`, { cache: "no-store" });
  check("it is still there for the next reader", after.status === 200, String(after.status));

  await fetch(`${BASE}/api/secrets/${id}`, { method: "DELETE" });
})();
