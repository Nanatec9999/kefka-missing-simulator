const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const chrome = chromeCandidates.find(fs.existsSync);
if (!chrome) throw new Error("Google Chrome was not found.");

const port = 9333;
const profile = path.join(os.tmpdir(), `gimmick-smoke-${Date.now()}`);
const browser = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPage() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((entry) => entry.type === "page");
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

async function run() {
  const page = await getPage();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let commandId = 0;
  const exceptions = [];

  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails.text);
    }
  };
  await new Promise((resolve) => {
    socket.onopen = resolve;
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", {
    url: "http://127.0.0.1:4173/?autoplay=1&speed=20&role=MT",
  });
  await sleep(250);
  const distributionResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const countMarks = (players, round) => players.reduce((counts, player) => {
        const mark = player.marks[round];
        counts[mark] = (counts[mark] || 0) + 1;
        return counts;
      }, {});
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const players = createPlayers();
        const byId = Object.fromEntries(players.map((player) => [player.id, player]));
        const th = ["MT", "ST", "H1", "H2"].map((id) => byId[id]);
        const dps = ["D1", "D2", "D3", "D4"].map((id) => byId[id]);
        for (const family of [th, dps]) {
          const marks = family.map((player) => player.mark);
          const secondary = marks.filter((mark) => mark !== "share");
          if (marks.filter((mark) => mark === "share").length !== 1 ||
              new Set(secondary).size !== 1 || secondary.length !== 3) {
            return { ok: false, reason: "invalid opening family", marks };
          }
        }
        const thSecondary = th.find((player) => player.mark !== "share").mark;
        const dpsSecondary = dps.find((player) => player.mark !== "share").mark;
        if (thSecondary === dpsSecondary) {
          return { ok: false, reason: "opening families duplicated", thSecondary, dpsSecondary };
        }
        for (const pair of PAIRS) {
          const groups = pair.map((id) => byId[id].group);
          if (groups.filter((group) => group === "A").length !== 1) {
            return { ok: false, reason: "invalid lean pair split", pair, groups };
          }
        }
        for (const [group, rounds] of Object.entries(GROUP_ROUNDS)) {
          const members = players.filter((player) => player.group === group);
          if (new Set(members.map((player) => player.role.category)).size !== 4) {
            return { ok: false, reason: "group role composition", group };
          }
          for (const round of rounds) {
            const counts = countMarks(members, round);
            const expected = round % 2
              ? { share: 2, fan: 1, circle: 1 }
              : { fan: 2, circle: 2 };
            if (Object.keys(expected).some((mark) => counts[mark] !== expected[mark]) ||
                Object.keys(counts).some((mark) => counts[mark] !== expected[mark])) {
              return { ok: false, reason: "round composition", group, round, counts };
            }
          }
        }
      }
      return { ok: true };
    })())`,
    returnByValue: true,
  });
  const distribution = JSON.parse(distributionResult.result.value);
  if (!distribution.ok) {
    throw new Error(`Invalid spell hazard distribution: ${JSON.stringify(distribution)}`);
  }
  await sleep(1950);
  if (process.env.SMOKE_SCREENSHOT) {
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.SMOKE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
  await sleep(5300);

  const result = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      hidden: document.getElementById("resultModal").classList.contains("hidden"),
      title: document.getElementById("resultTitle").textContent,
      reason: document.getElementById("resultReason").textContent,
      time: document.getElementById("timeDisplay").textContent
    })`,
    returnByValue: true,
  });
  const status = JSON.parse(result.result.value);

  if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join(", ")}`);
  if (status.hidden || status.title !== "ミッシング突破") {
    throw new Error(`Simulation did not clear: ${JSON.stringify(status)}`);
  }

  await send("Page.navigate", { url: "http://127.0.0.1:4173/?speed=20" });
  await sleep(300);
  await send("Runtime.evaluate", {
    expression: `document.querySelector(".role-button").click()`,
  });
  await sleep(1500);
  const failureResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      hidden: document.getElementById("resultModal").classList.contains("hidden"),
      title: document.getElementById("resultTitle").textContent,
      reason: document.getElementById("resultReason").textContent
    })`,
    returnByValue: true,
  });
  const failureStatus = JSON.parse(failureResult.result.value);
  socket.close();
  if (failureStatus.hidden || failureStatus.title !== "GAME OVER") {
    throw new Error(`Failure state was not triggered: ${JSON.stringify(failureStatus)}`);
  }
  console.log(`Browser smoke test passed at ${status.time}: ${status.reason}`);
  console.log(`Failure check passed: ${failureStatus.reason}`);
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    browser.kill();
    await sleep(100);
    fs.rmSync(profile, { recursive: true, force: true });
  });
