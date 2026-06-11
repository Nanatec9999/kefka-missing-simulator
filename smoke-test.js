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
const simulationStrategy = process.env.SMOKE_STRATEGY || "lean";
const simulationSpread = process.env.SMOKE_SPREAD || "kt";
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", {
    url: `http://127.0.0.1:4173/?autoplay=1&speed=20&role=MT&strategy=${simulationStrategy}&spread=${simulationSpread}`,
  });
  await sleep(250);
  const layoutResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const nextLabels = TIMELINE_ITEMS.slice(1).map(
        ([at, label], index) => \`\${index ? 10 : at}s \${label}\`
      );
      const assignmentLabels = [
        "1回目 塔1・外側",
        "2回目 塔1・内側扇",
        "3回目 塔2・左上頭割り",
        "4回目 塔2・外側円",
        "完了",
      ];
      const originalNext = UI.next.textContent;
      const originalAssignment = UI.towerAssignment.textContent;
      const gameTops = nextLabels.map((label) => {
        UI.next.textContent = label;
        return document.querySelector(".game-layout").getBoundingClientRect().top;
      });
      const assignmentHeights = assignmentLabels.map((label) => {
        UI.towerAssignment.textContent = label;
        return document.querySelector(".assignment-card").getBoundingClientRect().height;
      });
      UI.next.textContent = originalNext;
      UI.towerAssignment.textContent = originalAssignment;
      const spread = (values) => Math.max(...values) - Math.min(...values);
      return {
        ok: spread(gameTops) < 0.01 && spread(assignmentHeights) < 0.01,
        gameTops,
        assignmentHeights,
      };
    })())`,
    returnByValue: true,
  });
  const layout = JSON.parse(layoutResult.result.value);
  if (!layout.ok) {
    throw new Error(`Layout shifts when progress text changes: ${JSON.stringify(layout)}`);
  }
  const distributionResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const countMarks = (players, round) => players.reduce((counts, player) => {
        const mark = player.marks[round];
        counts[mark] = (counts[mark] || 0) + 1;
        return counts;
      }, {});
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const strategy = attempt % 2 ? "yarn" : "lean";
        const players = createPlayers(strategy);
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
        const strategyPairs = initialPriorityForStrategy(strategy).pairs;
        for (const pair of strategyPairs) {
          const groups = pair.map((id) => byId[id].group);
          if (strategy === "lean" && groups.filter((group) => group === "A").length !== 1) {
            return { ok: false, reason: "invalid lean pair split", pair, groups };
          }
          if (strategy === "yarn") {
            const expected = pair.some((id) => byId[id].mark === "share") ? "A" : "B";
            if (groups.some((group) => group !== expected)) {
              return { ok: false, reason: "invalid yarn pair grouping", pair, groups, expected };
            }
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
  const placementResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const original = {
        players: state.players,
        spread: state.spread,
        spellEffects: state.spellEffects,
        time: state.time,
      };
      for (const spread of ["kt", "piren", "dn"]) {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const strategy = attempt % 2 ? "yarn" : "lean";
          state.players = createPlayers(strategy);
          state.spread = spread;
          for (let round = 1; round <= 8; round += 1) {
            state.time = TOWER_TIMES[round - 1];
            state.spellEffects = [];
            for (const player of state.players) {
              player.mark = markForRound(player, round);
              const position = assignmentPositionFor(player, round);
              player.x = position.x;
              player.y = position.y;
            }
            const occupied = TOWERS.map((tower) =>
              state.players.filter((member) => distance(member, tower) <= tower.r).length
            );
            if (occupied.some((count) => count !== 2)) {
              return { ok: false, reason: "tower count", spread, strategy, round, occupied };
            }
            const info = towerInfo(round);
            const active = state.players.filter((member) => member.group === info.group);
            const effects = createSpellEffects(active, round);
            const hazard = spellHazardFailure(effects, round);
            if (hazard) {
              return { ok: false, reason: "hazard", spread, strategy, round, hazard };
            }
            if (round % 2 === 0) {
              const aoe = pastFutureAoeFailure(round);
              if (aoe) return { ok: false, reason: "pastFuture", spread, strategy, round, aoe };
            }
          }
        }
      }
      state.players = original.players;
      state.spread = original.spread;
      state.spellEffects = original.spellEffects;
      state.time = original.time;
      return { ok: true };
    })())`,
    returnByValue: true,
  });
  const placement = JSON.parse(placementResult.result.value);
  if (!placement.ok) {
    throw new Error(`Invalid spread placement: ${JSON.stringify(placement)}`);
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 667,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const selectionResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const modalWasHidden = UI.roleModal.classList.contains("hidden");
      UI.roleModal.classList.remove("hidden");
      resetSelection();
      const modalCard = UI.roleModal.querySelector(".modal-card");
      const fitsViewport = () => {
        const rect = modalCard.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight &&
          modalCard.scrollHeight <= modalCard.clientHeight;
      };
      const before = UI.roleSelection.classList.contains("hidden");
      const spreadBefore = UI.spreadSelection.classList.contains("hidden");
      const strategyFits = fitsViewport();
      selectStrategy("yarn");
      const afterStrategy = UI.roleSelection.classList.contains("hidden");
      const spreadAfterStrategy = UI.spreadSelection.classList.contains("hidden");
      const spreadFits = fitsViewport();
      selectSpread("piren");
      const afterSpread = UI.roleSelection.classList.contains("hidden");
      const roleFits = fitsViewport();
      const pair = pairIdFor("MT", "yarn");
      UI.roleModal.classList.toggle("hidden", modalWasHidden);
      return {
        ok: before && spreadBefore && afterStrategy && !spreadAfterStrategy && !afterSpread &&
          selectedStrategy === "yarn" && selectedSpread === "piren" && pair === "H1" &&
          UI.strategyName.textContent.includes("ヤーン/DN式") && UI.strategyName.textContent.includes("ぴれん式") &&
          strategyFits && spreadFits && roleFits,
        before,
        spreadBefore,
        afterStrategy,
        spreadAfterStrategy,
        afterSpread,
        strategyFits,
        spreadFits,
        roleFits,
        selectedStrategy,
        selectedSpread,
        pair,
      };
    })())`,
    returnByValue: true,
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const selection = JSON.parse(selectionResult.result.value);
  if (!selection.ok) {
    throw new Error(`Invalid strategy selection flow: ${JSON.stringify(selection)}`);
  }
  const shareCountResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const original = state.players.map((player) => ({ x: player.x, y: player.y }));
      const effect = { type: "share", sourceId: state.players[0].id, x: 100, y: 100 };
      state.players.forEach((player, index) => {
        player.x = index < 2 ? 100 + index * 20 : 700;
        player.y = index < 2 ? 100 : 700;
      });
      const twoPlayers = spellHazardFailure([effect], 1);
      state.players[2].x = 120;
      state.players[2].y = 120;
      const threePlayers = spellHazardFailure([effect], 1);
      state.players[3].x = 80;
      state.players[3].y = 120;
      const fourPlayers = spellHazardFailure([effect], 1);
      state.players.forEach((player, index) => {
        player.x = original[index].x;
        player.y = original[index].y;
      });
      return {
        ok: twoPlayers?.includes("現在2人") && threePlayers === null &&
          fourPlayers?.includes("現在4人"),
        twoPlayers,
        threePlayers,
        fourPlayers,
      };
    })())`,
    returnByValue: true,
  });
  const shareCount = JSON.parse(shareCountResult.result.value);
  if (!shareCount.ok) {
    throw new Error(`Invalid share count handling: ${JSON.stringify(shareCount)}`);
  }
  const directionResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const pointAt = (degrees, radius) => {
        const angle = degrees * Math.PI / 180;
        return {
          x: BOSS.x + Math.sin(angle) * radius,
          y: BOSS.y + Math.cos(angle) * radius,
        };
      };
      state.pastFuture[2] = "過去";
      const pastCenter = stackPositionFor(2);
      const inside = isDirectionLockPositionValid(pointAt(14, 100), 2);
      const outside = isDirectionLockPositionValid(pointAt(16, 100), 2);
      const tooFar = isDirectionLockPositionValid(pointAt(0, 190), 2);
      state.pastFuture[2] = "未来";
      const futureCenter = stackPositionFor(2);
      state.pastFuture[8] = "過去";
      const finalPastLock = directionLockPositionFor(8);
      const finalPastSafe = finalSafePositionFor(8);
      state.pastFuture[8] = "未来";
      const finalFutureLock = directionLockPositionFor(8);
      const finalFutureSafe = finalSafePositionFor(8);
      return {
        ok: pastCenter.x === BOSS.x && pastCenter.y === BOSS.y + 100 &&
          futureCenter.x === BOSS.x && futureCenter.y === BOSS.y - 100 &&
          finalPastLock.x === BOSS.x && finalPastLock.y === BOSS.y - 100 &&
          finalFutureLock.x === BOSS.x && finalFutureLock.y === BOSS.y - 100 &&
          finalPastSafe.x === BOSS.x && finalPastSafe.y === BOSS.y - 100 &&
          finalFutureSafe.x === BOSS.x && finalFutureSafe.y === BOSS.y + 100 &&
          inside && !outside && !tooFar,
        pastCenter,
        futureCenter,
        finalPastLock,
        finalFutureLock,
        finalPastSafe,
        finalFutureSafe,
        inside,
        outside,
        tooFar,
      };
    })())`,
    returnByValue: true,
  });
  const direction = JSON.parse(directionResult.result.value);
  if (!direction.ok) {
    throw new Error(`Invalid direction lock tolerance: ${JSON.stringify(direction)}`);
  }
  const npcMovementResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const mover = { x: 0, y: 0 };
      moveToward(mover, { x: 100, y: 0 }, 0.1);

      const originalTime = state.time;
      const originalResolvedTowers = state.resolvedTowers;
      const originalResolvedLocks = state.resolvedLocks;
      const originalPastFuture = state.pastFuture[8];
      const originalPosition = { x: state.players[0].x, y: state.players[0].y };
      state.resolvedTowers = new Set([1, 2]);
      state.resolvedLocks = new Set();
      const directionStaging = assignmentPositionFor(state.players[0], 2);
      state.players[0].x = directionStaging.x;
      state.players[0].y = directionStaging.y;
      state.time = TOWER_TIMES[1] + 0.1;
      const directionWait = npcTarget(state.players[0]);
      const expectedDirectionWait = wanderingTarget(
        state.players[0],
        directionStaging,
        TOWER_TIMES[1] + 5
      );
      state.time = TOWER_TIMES[1] + 4.999;
      const beforeCast = npcTarget(state.players[0]);
      state.time = TOWER_TIMES[1] + 5;
      state.resolvedLocks.add(2);
      const atCastStart = npcTarget(state.players[0]);
      const assignment = assignmentFor(state.players[0], 3) || supportPosition(state.players[0], 3);
      const staging = directionLockPositionFor(2);
      const expectedTarget = timedTarget(state.players[0], assignment, staging, TOWER_TIMES[2]);

      state.resolvedTowers = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
      state.resolvedLocks = new Set([2, 4, 6]);
      state.pastFuture[8] = "過去";
      state.time = TOWER_TIMES[7] + 4;
      const finalGather = npcTarget(state.players[0]);
      state.resolvedLocks.add(8);
      state.players[0].x = BOSS.x;
      state.players[0].y = BOSS.y - DIRECTION_LOCK_DISTANCE;
      state.time = TOWER_TIMES[7] + 5;
      const finalWait = npcTarget(state.players[0]);
      state.time = TOWER_TIMES[7] + 8.2;
      const finalMove = npcTarget(state.players[0]);
      state.time = originalTime;
      state.resolvedTowers = originalResolvedTowers;
      state.resolvedLocks = originalResolvedLocks;
      state.pastFuture[8] = originalPastFuture;
      state.players[0].x = originalPosition.x;
      state.players[0].y = originalPosition.y;

      return {
        ok: Math.abs(mover.x - 10) < 0.001 && mover.y === 0 &&
          distance(directionWait, expectedDirectionWait) < 0.001 &&
          distance(beforeCast, directionLockPositionFor(2)) < 1 &&
          distance(atCastStart, expectedTarget) < 0.001 &&
          distance(finalGather, { x: BOSS.x, y: BOSS.y - DIRECTION_LOCK_DISTANCE }) < 1 &&
          distance(finalWait, { x: BOSS.x, y: BOSS.y - DIRECTION_LOCK_DISTANCE }) < 20 &&
          finalMove.y < BOSS.y,
        mover,
        directionWait,
        expectedDirectionWait,
        beforeCast,
        atCastStart,
        expectedTarget,
        finalGather,
        finalWait,
        finalMove,
      };
    })())`,
    returnByValue: true,
  });
  const npcMovement = JSON.parse(npcMovementResult.result.value);
  if (!npcMovement.ok) {
    throw new Error(`Invalid NPC movement: ${JSON.stringify(npcMovement)}`);
  }
  const pastFutureAoeResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const original = state.players.map((player) => ({ x: player.x, y: player.y }));
      const targets = circleTargets(2);
      state.players.forEach((player, index) => {
        player.x = 100 + (index % 4) * 180;
        player.y = 100 + Math.floor(index / 4) * 300;
      });
      const solo = pastFutureAoeFailure(2);
      const target = targets[0];
      const other = state.players.find((player) => player.id !== target.id);
      other.x = target.x + 20;
      other.y = target.y;
      const shared = pastFutureAoeFailure(2);
      state.players.forEach((player, index) => {
        player.x = original[index].x;
        player.y = original[index].y;
      });
      return {
        ok: solo === null && shared?.includes("巻き込まれました"),
        solo,
        shared,
      };
    })())`,
    returnByValue: true,
  });
  const pastFutureAoe = JSON.parse(pastFutureAoeResult.result.value);
  if (!pastFutureAoe.ok) {
    throw new Error(`Invalid past/future AoE handling: ${JSON.stringify(pastFutureAoe)}`);
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
      time: document.getElementById("timeDisplay").textContent,
      player: { id: getPlayer().id, group: getPlayer().group, x: getPlayer().x, y: getPlayer().y },
      strategy: state.strategy,
      spread: state.spread
    })`,
    returnByValue: true,
  });
  const status = JSON.parse(result.result.value);

  if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join(", ")}`);
  if (status.hidden || status.title !== "ミッシング突破" ||
      status.strategy !== simulationStrategy || status.spread !== simulationSpread) {
    throw new Error(`Simulation did not clear: ${JSON.stringify(status)}`);
  }

  await send("Page.navigate", { url: "http://127.0.0.1:4173/?speed=20" });
  await sleep(300);
  await send("Runtime.evaluate", {
    expression: `selectStrategy("lean"); selectSpread("kt"); document.querySelector(".role-button").click()`,
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
  if (failureStatus.hidden || failureStatus.title !== "GAME OVER") {
    throw new Error(`Failure state was not triggered: ${JSON.stringify(failureStatus)}`);
  }
  await send("Runtime.evaluate", {
    expression: `document.getElementById("retryButton").click()`,
  });
  const retryResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      running: state.running,
      playerId: state.playerId,
      strategy: state.strategy,
      spread: state.spread,
      roleModalHidden: document.getElementById("roleModal").classList.contains("hidden"),
      resultModalHidden: document.getElementById("resultModal").classList.contains("hidden")
    })`,
    returnByValue: true,
  });
  const retryStatus = JSON.parse(retryResult.result.value);
  socket.close();
  if (!retryStatus.running || retryStatus.playerId !== "MT" || retryStatus.strategy !== "lean" ||
      retryStatus.spread !== "kt" ||
      !retryStatus.roleModalHidden || !retryStatus.resultModalHidden) {
    throw new Error(`Retry did not preserve the selection: ${JSON.stringify(retryStatus)}`);
  }
  console.log(`Browser smoke test passed at ${status.time}: ${status.reason}`);
  console.log(`Failure check passed: ${failureStatus.reason}`);
  console.log(`Retry check passed: ${retryStatus.playerId} / ${retryStatus.strategy} / ${retryStatus.spread}`);
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
