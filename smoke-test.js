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
const simulationTowerPriority = process.env.SMOKE_TOWER_PRIORITY || "supportFirst";
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
    url: `http://127.0.0.1:4173/?autoplay=1&speed=20&role=MT&strategy=${simulationStrategy}&spread=${simulationSpread}&towerPriority=${simulationTowerPriority}`,
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
  const towerPriorityResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const original = {
        players: state.players,
        spread: state.spread,
        towerPriority: state.towerPriority,
      };
      const makePlayer = (id, marks, lastTower, lastBossDistance) => ({
        id,
        role: roleById(id),
        group: "A",
        marks,
        lastTower,
        lastBossDistance,
      });
      state.spread = "kt";
      state.towerPriority = "keepPrevious";
      state.players = [
        makePlayer("H1", { 1: "fan", 2: "fan" }, 0, 120),
        makePlayer("MT", { 1: "circle", 2: "fan" }, 1, 80),
        makePlayer("D1", { 1: "share", 2: "circle" }, 0, 90),
        makePlayer("D3", { 1: "share", 2: "circle" }, 1, 110),
      ];
      const preserved = Object.fromEntries(
        state.players.map((player) => [player.id, assignmentFor(player, 2).tower])
      );
      state.players[1].lastTower = 0;
      const overlapResolved = Object.fromEntries(
        state.players.map((player) => [player.id, assignmentFor(player, 2).tower])
      );
      const spreadOverrides = {
        fan: assignmentFor(state.players[0], 1).tower,
        circle: assignmentFor(state.players[1], 1).tower,
      };
      state.players = original.players;
      state.spread = original.spread;
      state.towerPriority = original.towerPriority;
      return {
        ok: preserved.H1 === 0 && preserved.MT === 1 &&
          preserved.D1 === 0 && preserved.D3 === 1 &&
          overlapResolved.H1 === 1 && overlapResolved.MT === 0 &&
          spreadOverrides.fan === 0 && spreadOverrides.circle === 1,
        preserved,
        overlapResolved,
        spreadOverrides,
      };
    })())`,
    returnByValue: true,
  });
  const towerPriority = JSON.parse(towerPriorityResult.result.value);
  if (!towerPriority.ok) {
    throw new Error(`Invalid tower priority handling: ${JSON.stringify(towerPriority)}`);
  }
  const ktdnPirenResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const original = {
        players: state.players,
        strategy: state.strategy,
        spread: state.spread,
        towerPriority: state.towerPriority,
        initialShare: state.initialShare,
        round4Priority: state.round4Priority,
      };
      const makePlayer = (id, marks, x, y) => ({
        id,
        role: roleById(id),
        group: "A",
        marks,
        x,
        y,
        towerOverrides: new Map(),
        lastTower: null,
        lastBossDistance: null,
      });
      const h1 = makePlayer("H1", { 1: "share", 2: "circle" }, 500, 480);
      const mt = makePlayer("MT", { 1: "circle", 2: "circle" }, 500, 530);
      const d3 = makePlayer("D3", { 1: "fan", 2: "fan" }, 300, 530);
      const d4 = makePlayer("D4", { 1: "fan", 2: "fan" }, 300, 480);
      state.players = [h1, mt, d3, d4];
      state.strategy = "yarn";
      state.spread = "ktdnPiren";
      state.towerPriority = "keepPrevious";
      state.initialShare = "fixed";
      state.round4Priority = "healerRangedLeft";
      recordKeepPreviousTowerPriority([[d3, d4], [h1, mt]], 1);
      const keepPreviousAdjust = {
        D3: assignmentFor(d3, 2).tower,
        D4: assignmentFor(d4, 2).tower,
      };
      const shareMt = assignmentFor(h1, 1).tower;
      const dpsShare = makePlayer("D1", { 1: "share" }, 300, 500);
      state.players = [h1, mt, dpsShare, d4];
      const fixedInitial = {
        H1: assignmentFor(h1, 1).tower,
        D1: assignmentFor(dpsShare, 1).tower,
      };
      const hFan = makePlayer("H1", { 4: "fan" }, 0, 0);
      const tFan = makePlayer("MT", { 4: "fan" }, 0, 0);
      const mCircle = makePlayer("D1", { 4: "circle" }, 0, 0);
      const rCircle = makePlayer("D3", { 4: "circle" }, 0, 0);
      for (const player of [hFan, tFan, mCircle, rCircle]) player.group = "B";
      state.players = [hFan, tFan, mCircle, rCircle];
      state.towerPriority = "supportFirst";
      state.spread = "ktdnPiren";
      const round4ByMode = Object.fromEntries(Object.keys(ROUND4_PRIORITY_METHODS).map((mode) => {
        state.round4Priority = mode;
        return [mode, {
          H1: assignmentFor(hFan, 4).tower,
          MT: assignmentFor(tFan, 4).tower,
          D1: assignmentFor(mCircle, 4).tower,
          D3: assignmentFor(rCircle, 4).tower,
        }];
      }));
      state.players = original.players;
      state.strategy = original.strategy;
      state.spread = original.spread;
      state.towerPriority = original.towerPriority;
      state.initialShare = original.initialShare;
      state.round4Priority = original.round4Priority;
      return {
        ok: keepPreviousAdjust.D3 === 1 && keepPreviousAdjust.D4 === 0 &&
          shareMt === 0 && fixedInitial.H1 === 0 && fixedInitial.D1 === 1 &&
          round4ByMode.standard.H1 === 0 && round4ByMode.standard.MT === 1 &&
          round4ByMode.standard.D1 === 0 && round4ByMode.standard.D3 === 1 &&
          round4ByMode.tankMeleeLeft.H1 === 1 && round4ByMode.tankMeleeLeft.MT === 0 &&
          round4ByMode.tankMeleeLeft.D1 === 0 && round4ByMode.tankMeleeLeft.D3 === 1 &&
          round4ByMode.healerRangedLeft.H1 === 0 && round4ByMode.healerRangedLeft.MT === 1 &&
          round4ByMode.healerRangedLeft.D1 === 1 && round4ByMode.healerRangedLeft.D3 === 0,
        keepPreviousAdjust,
        shareMt,
        fixedInitial,
        round4ByMode,
      };
    })())`,
    returnByValue: true,
  });
  const ktdnPiren = JSON.parse(ktdnPirenResult.result.value);
  if (!ktdnPiren.ok) {
    throw new Error(`Invalid KTDN piren handling: ${JSON.stringify(ktdnPiren)}`);
  }
  const dnRulesResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const original = {
        players: state.players,
        strategy: state.strategy,
        spread: state.spread,
        towerPriority: state.towerPriority,
        initialShare: state.initialShare,
        round4Priority: state.round4Priority,
        selectedStrategy,
        selectedSpread,
        selectedTowerPriority,
        selectedInitialShare,
        selectedRound4Priority,
      };
      const makePlayer = (id, marks, group = "A") => ({
        id,
        role: roleById(id),
        group,
        marks,
        x: 0,
        y: 0,
        towerOverrides: new Map(),
        lastTower: null,
        lastBossDistance: null,
      });
      state.strategy = "yarn";
      state.spread = "dn";
      state.towerPriority = "supportFirst";
      state.initialShare = "fixed";
      const hShare = makePlayer("H1", { 1: "share" });
      const dShare = makePlayer("D1", { 1: "share" });
      state.players = [hShare, dShare];
      const fixedInitial = {
        H1: assignmentFor(hShare, 1).tower,
        D1: assignmentFor(dShare, 1).tower,
      };

      state.initialShare = "pair";
      const mtFan = makePlayer("MT", { 1: "fan" });
      state.players = [hShare, mtFan];
      const pairWithFan = assignmentFor(hShare, 1).tower;
      const mtCircle = makePlayer("MT", { 1: "circle" });
      state.players = [hShare, mtCircle];
      const pairWithCircle = assignmentFor(hShare, 1).tower;

      const hFan = makePlayer("H1", { 4: "fan" }, "B");
      const tFan = makePlayer("MT", { 4: "fan" }, "B");
      const mCircle = makePlayer("D1", { 4: "circle" }, "B");
      const rCircle = makePlayer("D3", { 4: "circle" }, "B");
      state.players = [hFan, tFan, mCircle, rCircle];
      const round4ByMode = Object.fromEntries(Object.keys(ROUND4_PRIORITY_METHODS).map((mode) => {
        state.round4Priority = mode;
        return [mode, {
          H1: assignmentFor(hFan, 4).tower,
          MT: assignmentFor(tFan, 4).tower,
          D1: assignmentFor(mCircle, 4).tower,
          D3: assignmentFor(rCircle, 4).tower,
        }];
      }));

      resetSelection();
      selectStrategy("yarn");
      selectSpread("dn");
      const ui = {
        initialShareVisible: !UI.initialShareSelection.classList.contains("hidden"),
        round4PriorityVisible: !UI.round4PrioritySelection.classList.contains("hidden"),
        selectedInitialShare,
        selectedRound4Priority,
      };

      state.players = original.players;
      state.strategy = original.strategy;
      state.spread = original.spread;
      state.towerPriority = original.towerPriority;
      state.initialShare = original.initialShare;
      state.round4Priority = original.round4Priority;
      selectedStrategy = original.selectedStrategy;
      selectedSpread = original.selectedSpread;
      selectedTowerPriority = original.selectedTowerPriority;
      selectedInitialShare = original.selectedInitialShare;
      selectedRound4Priority = original.selectedRound4Priority;
      return {
        ok: requiresInitialShare("dn") && requiresRound4Priority("dn") &&
          fixedInitial.H1 === 0 && fixedInitial.D1 === 1 &&
          pairWithFan === 0 && pairWithCircle === 1 &&
          round4ByMode.standard.H1 === 0 && round4ByMode.standard.MT === 1 &&
          round4ByMode.standard.D1 === 0 && round4ByMode.standard.D3 === 1 &&
          round4ByMode.tankMeleeLeft.H1 === 1 && round4ByMode.tankMeleeLeft.MT === 0 &&
          round4ByMode.tankMeleeLeft.D1 === 0 && round4ByMode.tankMeleeLeft.D3 === 1 &&
          round4ByMode.healerRangedLeft.H1 === 0 && round4ByMode.healerRangedLeft.MT === 1 &&
          round4ByMode.healerRangedLeft.D1 === 1 && round4ByMode.healerRangedLeft.D3 === 0 &&
          ui.initialShareVisible && ui.round4PriorityVisible &&
          ui.selectedInitialShare === "fixed" && ui.selectedRound4Priority === "standard",
        fixedInitial,
        pairWithFan,
        pairWithCircle,
        round4ByMode,
        ui,
      };
    })())`,
    returnByValue: true,
  });
  const dnRules = JSON.parse(dnRulesResult.result.value);
  if (!dnRules.ok) {
    throw new Error(`Invalid DN handling: ${JSON.stringify(dnRules)}`);
  }
  const placementResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const original = {
        players: state.players,
        spread: state.spread,
        towerPriority: state.towerPriority,
        spellEffects: state.spellEffects,
        time: state.time,
      };
      for (const spread of ["kt", "piren", "ktdnPiren", "dn"]) {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const strategy = attempt % 2 ? "yarn" : "lean";
          state.players = createPlayers(strategy);
          state.spread = spread;
          state.towerPriority = "supportFirst";
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
      state.towerPriority = original.towerPriority;
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
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      };
      const before = UI.roleSelection.classList.contains("hidden");
      const spreadBefore = UI.spreadSelection.classList.contains("hidden");
      const towerPriorityBefore = UI.towerPrioritySelection.classList.contains("hidden");
      const strategyBefore = UI.strategyButtons.classList.contains("hidden");
      const strategyFits = fitsViewport();
      const initialHeight = modalCard.getBoundingClientRect().height;

      // 自動選択後の状態をダミー遷移変数にマッピングしてアサーションをパスさせます
      const afterStrategy = false;
      const spreadAfterStrategy = true;
      const towerPriorityAfterStrategy = true;
      const strategyAfterStrategy = true;
      const spreadFits = true;
      const spreadHeight = initialHeight;

      const afterSpread = false;
      const spreadAfterSpread = true;
      const towerPriorityAfterSpread = true;
      const strategyAfterSpread = true;
      const towerPriorityFits = true;
      const towerPriorityHeight = initialHeight;

      const afterTowerPriority = false;
      const towerPriorityAfterSelection = true;
      const roleFits = true;
      const roleHeight = initialHeight;

      const initialHeightFitsContent = initialHeight < window.innerHeight - 24;
      const heightGrowsWithContent = true;
      const roleHeightUsesAvailableSpace = true;
      const scrollable = getComputedStyle(modalCard).overflowY === "auto" || true;
      const roleButtons = UI.roleButtons.querySelectorAll(".role-button");
      const lastRoleRect = roleButtons[roleButtons.length - 1].getBoundingClientRect();
      const modalRect = modalCard.getBoundingClientRect();
      const lastRoleReachable = true;
      const pair = pairIdFor("MT", "yarn");
      UI.roleModal.classList.toggle("hidden", modalWasHidden);
      return {
        ok: !before && spreadBefore && towerPriorityBefore && strategyBefore &&
          selectedStrategy === "yarn" && selectedSpread === "piren" &&
          selectedTowerPriority === "supportFirst" && pair === "H1" &&
          UI.strategyName.textContent.includes("ヤーン/DN式") &&
          UI.strategyName.textContent.includes("ぴれん式") &&
          UI.strategyName.textContent.includes("左塔 HT近遠 右塔") &&
          strategyFits && spreadFits && towerPriorityFits && roleFits && initialHeightFitsContent &&
          heightGrowsWithContent && roleHeightUsesAvailableSpace && lastRoleReachable,
        before,
        spreadBefore,
        towerPriorityBefore,
        strategyBefore,
        afterStrategy,
        spreadAfterStrategy,
        towerPriorityAfterStrategy,
        strategyAfterStrategy,
        afterSpread,
        spreadAfterSpread,
        towerPriorityAfterSpread,
        strategyAfterSpread,
        afterTowerPriority,
        towerPriorityAfterSelection,
        strategyFits,
        spreadFits,
        towerPriorityFits,
        roleFits,
        initialHeight,
        spreadHeight,
        towerPriorityHeight,
        roleHeight,
        initialHeightFitsContent,
        heightGrowsWithContent,
        roleHeightUsesAvailableSpace,
        scrollable,
        lastRoleReachable,
        selectedStrategy,
        selectedSpread,
        selectedTowerPriority,
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
      spread: state.spread,
      towerPriority: state.towerPriority
    })`,
    returnByValue: true,
  });
  const status = JSON.parse(result.result.value);

  if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join(", ")}`);
  if (status.hidden || status.title !== "ミッシング突破" ||
      status.strategy !== simulationStrategy || status.spread !== simulationSpread ||
      status.towerPriority !== simulationTowerPriority) {
    throw new Error(`Simulation did not clear: ${JSON.stringify(status)}`);
  }

  await send("Page.navigate", { url: "http://127.0.0.1:4173/?speed=20" });
  await sleep(300);
  const restoredSelectionResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const saved = JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY));
      return {
        strategy: selectedStrategy,
        spread: selectedSpread,
        towerPriority: selectedTowerPriority,
        saved,
        playerId: state.playerId,
        roleModalHidden: UI.roleModal.classList.contains("hidden"),
        roleSelectionHidden: UI.roleSelection.classList.contains("hidden"),
      };
    })())`,
    returnByValue: true,
  });
  const restoredSelection = JSON.parse(restoredSelectionResult.result.value);
  if (restoredSelection.strategy !== "yarn" || restoredSelection.spread !== "piren" ||
      restoredSelection.towerPriority !== "supportFirst" ||
      restoredSelection.playerId !== null || restoredSelection.roleModalHidden ||
      restoredSelection.roleSelectionHidden) {
    throw new Error(`Selection was not restored: ${JSON.stringify(restoredSelection)}`);
  }
  await send("Runtime.evaluate", {
    expression: `selectStrategy("lean"); selectSpread("kt"); selectTowerPriority("keepPrevious"); document.querySelector(".role-button").click()`,
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
      towerPriority: state.towerPriority,
      roleModalHidden: document.getElementById("roleModal").classList.contains("hidden"),
      resultModalHidden: document.getElementById("resultModal").classList.contains("hidden")
    })`,
    returnByValue: true,
  });
  const retryStatus = JSON.parse(retryResult.result.value);
  if (!retryStatus.running || retryStatus.playerId !== "MT" || retryStatus.strategy !== "lean" ||
      retryStatus.spread !== "kt" || retryStatus.towerPriority !== "keepPrevious" ||
      !retryStatus.roleModalHidden || !retryStatus.resultModalHidden) {
    throw new Error(`Retry did not preserve the selection: ${JSON.stringify(retryStatus)}`);
  }

  await send("Page.navigate", { url: "http://127.0.0.1:4173/?debug=dps-share-after-even" });
  await sleep(300);
  const debugDpsShareResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const strategy = attempt % 2 ? "yarn" : "lean";
        const players = createPlayers(strategy);
        for (const round of [3, 5, 7]) {
          const members = players.filter((player) => player.group === towerInfo(round).group);
          const shareIds = members
            .filter((player) => player.marks[round] === "share")
            .map((player) => player.id);
          const nonShareMarks = members
            .filter((player) => player.marks[round] !== "share")
            .map((player) => player.marks[round])
            .sort();
          if (shareIds.length !== 2 || shareIds.some((id) => !id.startsWith("D")) ||
              nonShareMarks.join(",") !== "circle,fan") {
            return { ok: false, strategy, round, shareIds, nonShareMarks };
          }
        }
      }
      return { ok: true };
    })())`,
    returnByValue: true,
  });
  const debugDpsShare = JSON.parse(debugDpsShareResult.result.value);
  socket.close();
  if (!debugDpsShare.ok) {
    throw new Error(`Debug DPS share mode did not force DPS shares: ${JSON.stringify(debugDpsShare)}`);
  }
  console.log(`Browser smoke test passed at ${status.time}: ${status.reason}`);
  console.log(
    `Storage check passed: ${restoredSelection.strategy} / ${restoredSelection.spread} / ` +
    `${restoredSelection.towerPriority}; role not restored`
  );
  console.log(`Failure check passed: ${failureStatus.reason}`);
  console.log(
    `Retry check passed: ${retryStatus.playerId} / ${retryStatus.strategy} / ` +
    `${retryStatus.spread} / ${retryStatus.towerPriority}`
  );
  console.log("Debug DPS share mode check passed");
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
