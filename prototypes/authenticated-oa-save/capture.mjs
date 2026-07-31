import fs from "node:fs/promises";

const endpoint = process.argv[2];
const outputDir = process.argv[3];
const extensionOrigin = "chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb";
const cases = [
  { name: "authenticated-open-save", session: true },
  { name: "public-open-protected-save", session: true },
  { name: "public-open-protected-save-no-session", session: false },
  { name: "authenticated-reopen-save", session: true }
];

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
      const target = targets.find((item) => item.type === "page");
      if (target) return target;
    } catch (_) {
      // The debugging endpoint may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for Qaxbrowser");
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
    else handlers.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    opened,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return response.result.value;
}

const target = await waitForTarget();
const cdp = connect(target.webSocketDebuggerUrl);
await cdp.opened;
await cdp.send("Network.enable");
await navigate(cdp, "http://127.0.0.1:49234/oa/session/start");
const allCookies = await cdp.send("Network.getAllCookies");
const sessionCookie = allCookies.cookies.find((cookie) => cookie.name === "oa_session");
const results = [];

for (const probeCase of cases) {
  const caseName = probeCase.name;
  if (!probeCase.session) {
    await cdp.send("Network.deleteCookies", { name: "oa_session", domain: "127.0.0.1", path: "/" });
  } else {
    const cookies = await cdp.send("Network.getAllCookies");
    if (!cookies.cookies.some((cookie) => cookie.name === "oa_session")) {
      await navigate(cdp, "http://127.0.0.1:49234/oa/session/start");
    }
  }
  await navigate(cdp, `${extensionOrigin}/editor.html?case=${encodeURIComponent(caseName)}`);
  let value = null;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    value = await evaluate(cdp, "window.__AUTHENTICATED_OA_RESULT__ || null");
    if (value && value.complete) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!value) value = { case: caseName, complete: false, error: "probe timed out" };
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(`${outputDir}/${caseName}.png`, screenshot.data, "base64");
  results.push(value);
  await evaluate(cdp, "window.__QUIT_WPS__ ? window.__QUIT_WPS__() : false");
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

const serverEvidence = await fetch("http://127.0.0.1:49234/__evidence").then((response) => response.json());
const artifact = Buffer.from(await fetch("http://127.0.0.1:49234/__artifact").then((response) => response.arrayBuffer()));
await fs.writeFile(`${outputDir}/stored-artifact.bin`, artifact);
const artifactLatin1 = artifact.toString("latin1");
const artifactUtf16 = artifact.toString("utf16le");
serverEvidence.artifact.markerPresence = Object.fromEntries(
  results.map((result) => [
    result.case,
    artifactLatin1.includes(result.marker) || artifactUtf16.includes(result.marker)
  ])
);
const browser = await fetch(`${endpoint}/json/version`).then((response) => response.json());
const evidence = {
  capturedAt: new Date().toISOString(),
  browser: browser.Browser,
  extensionOrigin,
  browserSessionCookie: sessionCookie || null,
  cases: results,
  server: serverEvidence
};
await fs.writeFile(`${outputDir}/result.json`, `${JSON.stringify(evidence, null, 2)}\n`);
cdp.close();
console.log(JSON.stringify(evidence, null, 2));
