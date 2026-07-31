import fs from "node:fs/promises";

const endpoint = process.argv[2];
const outputDir = process.argv[3];
const probeUrl = "chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb/probe.html";

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
      const target = targets.find((item) => item.type === "page");
      if (target) return target;
    } catch (_) {
      // The browser's debugging endpoint may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the extension probe page");
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    opened,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

const target = await waitForTarget();
const cdp = connect(target.webSocketDebuggerUrl);
await cdp.opened;
await cdp.send("Page.navigate", { url: probeUrl });

let probeResult = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: "window.__NPAPI_EXTENSION_HOST_RESULT__ || null",
    returnByValue: true
  });
  probeResult = evaluation.result.value;
  if (probeResult) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (!probeResult) throw new Error("The extension page did not complete the probe");

const version = await fetch(`${endpoint}/json/version`).then((response) => response.json());
const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(`${outputDir}/extension-host-probe.png`, screenshot.data, "base64");
await fs.writeFile(
  `${outputDir}/extension-host-probe.json`,
  `${JSON.stringify({ browser: version.Browser, ...probeResult }, null, 2)}\n`
);
cdp.close();

console.log(JSON.stringify({ browser: version.Browser, ...probeResult }, null, 2));
