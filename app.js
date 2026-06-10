const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");

const UI = {
  time: document.getElementById("timeDisplay"),
  next: document.getElementById("nextDisplay"),
  stacks: document.getElementById("stackDisplay"),
  roleModal: document.getElementById("roleModal"),
  resultModal: document.getElementById("resultModal"),
  resultKicker: document.getElementById("resultKicker"),
  resultTitle: document.getElementById("resultTitle"),
  resultReason: document.getElementById("resultReason"),
  retry: document.getElementById("retryButton"),
  selectionTitle: document.getElementById("selectionTitle"),
  strategyButtons: document.getElementById("strategyButtons"),
  spreadSelection: document.getElementById("spreadSelection"),
  spreadButtons: document.getElementById("spreadButtons"),
  roleSelection: document.getElementById("roleSelection"),
  roleButtons: document.getElementById("roleButtons"),
  strategyName: document.getElementById("strategyName"),
  roleIcon: document.getElementById("roleIcon"),
  roleName: document.getElementById("roleName"),
  pairName: document.getElementById("pairName"),
  markBadge: document.getElementById("markBadge"),
  groupName: document.getElementById("groupName"),
  towerAssignment: document.getElementById("towerAssignment"),
  round: document.getElementById("roundDisplay"),
  timeline: document.getElementById("timeline"),
  speed: document.getElementById("speedSelect"),
  castBar: document.getElementById("castBar"),
  castName: document.getElementById("castName"),
  castFill: document.getElementById("castFill"),
  banner: document.getElementById("banner"),
};

const W = 800;
const ARENA = { x: 400, y: 400, r: 350 };
const BOSS = { x: 400, y: 400, r: 29 };
const TOWERS = [
  { x: 300, y: 505, r: 66, label: "塔1" },
  { x: 500, y: 505, r: 66, label: "塔2" },
];
const SPELL_RADII = {
  share: 87,
  circle: 72,
};
const FAN_LENGTH = 235;
const FAN_HALF_ANGLE = Math.PI / 4;
const PAST_FUTURE_RADIUS = SPELL_RADII.circle * 1.1;
const DIRECTION_LOCK_DISTANCE = 100;
const DIRECTION_LOCK_TOLERANCE = 82;
const DIRECTION_LOCK_HALF_ANGLE = 15 * Math.PI / 180;
const PLAYER_MOVE_SPEED = 100;
const NPC_ARRIVAL_MARGIN = 0.12;
const ROLES = [
  { id: "MT", pair: "ST", kind: "tank", category: "tank", color: "#3b8ded", icon: "assets/TankRole.png" },
  { id: "ST", pair: "MT", kind: "tank", category: "tank", color: "#3b8ded", icon: "assets/TankRole.png" },
  { id: "H1", pair: "H2", kind: "healer", category: "healer", color: "#43a06b", icon: "assets/HealerRole.png" },
  { id: "H2", pair: "H1", kind: "healer", category: "healer", color: "#43a06b", icon: "assets/HealerRole.png" },
  { id: "D1", pair: "D2", kind: "dps", category: "melee", color: "#e34f57", icon: "assets/DPSRole.png" },
  { id: "D2", pair: "D1", kind: "dps", category: "melee", color: "#e34f57", icon: "assets/DPSRole.png" },
  { id: "D3", pair: "D4", kind: "dps", category: "ranged", color: "#e34f57", icon: "assets/DPSRole.png" },
  { id: "D4", pair: "D3", kind: "dps", category: "ranged", color: "#e34f57", icon: "assets/DPSRole.png" },
];
const PAIRS = [["MT", "ST"], ["H1", "H2"], ["D1", "D2"], ["D3", "D4"]];
const YARN_PAIRS = [["MT", "H1"], ["ST", "H2"], ["D1", "D3"], ["D2", "D4"]];
const STRATEGIES = {
  lean: { name: "りーん式" },
  yarn: { name: "ヤーン式" },
};
const SPREAD_METHODS = {
  kt: { name: "KT式" },
  piren: { name: "ぴれん式" },
};
const GROUP_ROUNDS = { A: [1, 2, 3, 8], B: [4, 5, 6, 7] };
const TOWER_TIMES = [10, 20, 30, 40, 50, 60, 70, 80];
const TIMELINE_ITEMS = [
  [0, "ミッシング / 塔出現"],
  [10, "塔1回目"],
  [20, "塔2回目 + 過去/未来"],
  [30, "半面 + 塔3回目"],
  [40, "塔4回目 + 過去/未来"],
  [50, "半面 + 塔5回目"],
  [60, "塔6回目 + 過去/未来"],
  [70, "半面 + 塔7回目"],
  [80, "塔8回目 + 過去/未来"],
  [90, "最後の半面 / 終了"],
];
const MARK_LABEL = { share: "頭割り", fan: "扇", circle: "円" };
const TOWER_PRIORITY = ["healer", "tank", "melee", "ranged"];
const keys = new Set();
const query = new URLSearchParams(location.search);
const querySpeed = Number(query.get("speed"));
const autoplay = query.get("autoplay") === "1";

let state = {
  running: false,
  finished: false,
  time: 0,
  lastFrame: 0,
  playerId: null,
  players: [],
  resolvedTowers: new Set(),
  resolvedCircles: new Set(),
  resolvedLocks: new Set(),
  resolvedHalves: new Set(),
  spellEffects: [],
  pastFuture: {},
  moveTarget: null,
  bannerUntil: 0,
  strategy: null,
  spread: null,
};
let selectedStrategy = null;
let selectedSpread = null;

if (querySpeed > 0) {
  if (![...UI.speed.options].some((option) => Number(option.value) === querySpeed)) {
    UI.speed.add(new Option(`${querySpeed}x`, String(querySpeed)));
  }
  UI.speed.value = String(querySpeed);
}

function roleById(id) {
  return ROLES.find((role) => role.id === id);
}

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function createOpeningMarks() {
  const marks = {};
  const thSecondary = randomChoice(["fan", "circle"]);
  const dpsSecondary = thSecondary === "fan" ? "circle" : "fan";
  for (const [ids, secondary] of [
    [["MT", "ST", "H1", "H2"], thSecondary],
    [["D1", "D2", "D3", "D4"], dpsSecondary],
  ]) {
    for (const id of ids) marks[id] = secondary;
    marks[randomChoice(ids)] = "share";
  }
  return marks;
}

function buildGroups(openingMarks, strategy = "lean") {
  const groupA = new Set();
  if (strategy === "yarn") {
    for (const pair of YARN_PAIRS) {
      if (pair.some((id) => openingMarks[id] === "share")) {
        pair.forEach((id) => groupA.add(id));
      }
    }
    return groupA;
  }
  for (const [higher, lower] of PAIRS) {
    if (openingMarks[higher] === "share") groupA.add(higher);
    else if (openingMarks[lower] === "share") groupA.add(lower);
    else groupA.add(higher);
  }
  return groupA;
}

function markForRound(player, round) {
  return player.marks[round];
}

function randomRoundMarks(round) {
  return shuffled(round % 2
    ? ["share", "share", "fan", "circle"]
    : ["fan", "fan", "circle", "circle"]);
}

function nextRoundFor(player, afterRound = 0) {
  return GROUP_ROUNDS[player.group].find((round) => round > afterRound) || null;
}

function createPlayers(strategy = "lean") {
  const openingMarks = createOpeningMarks();
  const groupA = buildGroups(openingMarks, strategy);
  const players = ROLES.map((role, index) => {
    const group = groupA.has(role.id) ? "A" : "B";
    const firstRound = GROUP_ROUNDS[group][0];
    return {
      id: role.id,
      role,
      group,
      x: 330 + (index % 4) * 46,
      y: 675 + Math.floor(index / 4) * 38,
      startX: 330 + (index % 4) * 46,
      startY: 675 + Math.floor(index / 4) * 38,
      targetX: 400,
      targetY: 640,
      stacks: 4,
      lastSoaked: 0,
      marks: { [firstRound]: openingMarks[role.id] },
      mark: openingMarks[role.id],
      markUpdatedAt: 0,
      wanderPhase: index * 1.73 + Math.random() * 0.8,
      tower: null,
    };
  });
  for (const [group, rounds] of Object.entries(GROUP_ROUNDS)) {
    const members = players.filter((player) => player.group === group);
    for (const round of rounds.slice(1)) {
      const marks = randomRoundMarks(round);
      members.forEach((player, index) => {
        player.marks[round] = marks[index];
      });
    }
  }
  return players;
}

function setupRoleButtons() {
  UI.roleButtons.innerHTML = "";
  for (const role of ROLES) {
    const button = document.createElement("button");
    button.className = "role-button";
    button.innerHTML = `<img src="${role.icon}" alt=""><strong>${role.id}</strong>`;
    button.addEventListener("click", () => startGame(role.id, selectedStrategy, selectedSpread));
    UI.roleButtons.appendChild(button);
  }
}

function selectStrategy(strategy) {
  if (!STRATEGIES[strategy]) return;
  selectedStrategy = strategy;
  for (const button of UI.strategyButtons.querySelectorAll(".strategy-button")) {
    const selected = button.dataset.strategy === strategy;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  UI.selectionTitle.textContent = "散開位置を選択";
  UI.strategyButtons.classList.add("hidden");
  selectedSpread = null;
  for (const button of UI.spreadButtons.querySelectorAll(".spread-button")) {
    button.classList.remove("selected");
    button.setAttribute("aria-pressed", "false");
  }
  UI.spreadSelection.classList.remove("hidden");
  UI.roleSelection.classList.add("hidden");
}

function selectSpread(spread) {
  if (!selectedStrategy || !SPREAD_METHODS[spread]) return;
  selectedSpread = spread;
  for (const button of UI.spreadButtons.querySelectorAll(".spread-button")) {
    const selected = button.dataset.spread === spread;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  UI.selectionTitle.textContent = "担当ロールを選択";
  UI.strategyName.textContent = `${STRATEGIES[selectedStrategy].name} / ${SPREAD_METHODS[spread].name} · 1238 / 4567`;
  UI.spreadSelection.classList.add("hidden");
  UI.roleSelection.classList.remove("hidden");
}

function resetSelection() {
  selectedStrategy = null;
  selectedSpread = null;
  UI.selectionTitle.textContent = "攻略法を選択";
  UI.strategyButtons.classList.remove("hidden");
  UI.spreadSelection.classList.add("hidden");
  UI.roleSelection.classList.add("hidden");
  for (const button of UI.strategyButtons.querySelectorAll(".strategy-button")) {
    button.classList.remove("selected");
    button.setAttribute("aria-pressed", "false");
  }
  for (const button of UI.spreadButtons.querySelectorAll(".spread-button")) {
    button.classList.remove("selected");
    button.setAttribute("aria-pressed", "false");
  }
}

function pairIdFor(playerId, strategy) {
  const pairs = strategy === "yarn" ? YARN_PAIRS : PAIRS;
  const pair = pairs.find((ids) => ids.includes(playerId));
  return pair?.find((id) => id !== playerId) || "—";
}

function startGame(playerId, strategy = "lean", spread = "kt") {
  const activeStrategy = STRATEGIES[strategy] ? strategy : "lean";
  const activeSpread = SPREAD_METHODS[spread] ? spread : "kt";
  state = {
    running: true,
    finished: false,
    time: -3,
    lastFrame: performance.now(),
    playerId,
    players: createPlayers(activeStrategy),
    resolvedTowers: new Set(),
    resolvedCircles: new Set(),
    resolvedLocks: new Set(),
    resolvedHalves: new Set(),
    spellEffects: [],
    pastFuture: {
      2: randomChoice(["過去", "未来"]),
      4: randomChoice(["過去", "未来"]),
      6: randomChoice(["過去", "未来"]),
      8: randomChoice(["過去", "未来"]),
    },
    moveTarget: null,
    bannerUntil: 0,
    strategy: activeStrategy,
    spread: activeSpread,
  };
  const player = getPlayer();
  player.x = 400;
  player.y = 650;
  player.startX = player.x;
  player.startY = player.y;
  UI.roleModal.classList.add("hidden");
  UI.resultModal.classList.add("hidden");
  updateAssignment();
  requestAnimationFrame(loop);
}

function getPlayer() {
  return state.players.find((player) => player.id === state.playerId);
}

function activeRound() {
  for (let round = 1; round <= 8; round += 1) {
    if (!state.resolvedTowers.has(round)) return round;
  }
  return 8;
}

function towerInfo(round) {
  const group = round <= 3 || round === 8 ? "A" : "B";
  return { round, group, odd: round % 2 === 1, time: TOWER_TIMES[round - 1] };
}

function markSide(player, round) {
  const info = towerInfo(round);
  const peers = state.players
    .filter((member) => member.group === info.group && markForRound(member, round) === markForRound(player, round))
    .sort((a, b) =>
      TOWER_PRIORITY.indexOf(a.role.category) - TOWER_PRIORITY.indexOf(b.role.category)
    );
  return peers.indexOf(player);
}

function ktAssignmentFor(player, round) {
  const info = towerInfo(round);
  if (player.group !== info.group) return null;
  const mark = markForRound(player, round);
  if (info.odd) {
    if (mark === "fan") return { tower: 0, x: 260, y: 530, name: "塔1・外側" };
    if (mark === "circle") return { tower: 1, x: 545, y: 550, name: "塔2・外側" };
    if (markSide(player, round) === 0) {
      const radius = TOWERS[0].r / 2;
      return {
        tower: 0,
        x: TOWERS[0].x + Math.cos(-Math.PI / 4) * radius,
        y: TOWERS[0].y + Math.sin(-Math.PI / 4) * radius,
        name: "塔1・右上頭割り",
      };
    }
    const radius = TOWERS[1].r * 0.82;
    return {
      tower: 1,
      x: TOWERS[1].x + Math.cos(-3 * Math.PI / 4) * radius,
      y: TOWERS[1].y + Math.sin(-3 * Math.PI / 4) * radius,
      name: "塔2・左上頭割り",
    };
  }
  const side = markSide(player, round);
  if (mark === "fan") {
    return side === 0
      ? { tower: 0, x: 330, y: 460, name: "塔1・内側扇" }
      : { tower: 1, x: 475, y: 460, name: "塔2・内側扇" };
  }
  return side === 0
    ? { tower: 0, x: 285, y: 555, name: "塔1・外側円" }
    : { tower: 1, x: 515, y: 555, name: "塔2・外側円" };
}

function pirenAssignmentFor(player, round) {
  const info = towerInfo(round);
  if (player.group !== info.group) return null;
  const mark = markForRound(player, round);
  if (info.odd) {
    if (mark === "fan") return { tower: 0, x: 300, y: 560, name: "塔1・左誘導扇" };
    if (mark === "circle") return { tower: 1, x: 500, y: 560, name: "塔2・下円" };
    return markSide(player, round) === 0
      ? { tower: 0, x: 300, y: 485, name: "塔1・縦頭割り" }
      : { tower: 1, x: 500, y: 450, name: "塔2・縦頭割り" };
  }
  const side = markSide(player, round);
  if (mark === "fan") {
    return side === 0
      ? { tower: 0, x: 300, y: 450, name: "塔1・上扇" }
      : { tower: 1, x: 500, y: 450, name: "塔2・上扇" };
  }
  return side === 0
    ? { tower: 0, x: 300, y: 565, name: "塔1・下円" }
    : { tower: 1, x: 500, y: 565, name: "塔2・下円" };
}

function assignmentFor(player, round, spread = state.spread || "kt") {
  return spread === "piren"
    ? pirenAssignmentFor(player, round)
    : ktAssignmentFor(player, round);
}

function supportPosition(player, round, spread = state.spread || "kt") {
  const info = towerInfo(round);
  if (spread === "piren") {
    const positions = info.odd
      ? {
          tank: [320, 430],
          healer: [300, 580],
          melee: [450, 420],
          ranged: [455, 415],
        }
      : {
          tank: [320, 320],
          healer: [215, 505],
          melee: [480, 320],
          ranged: [585, 505],
        };
    const [x, y] = positions[player.role.category];
    return { x, y };
  }
  if (!info.odd) {
    const positions = {
      tank: [330, 285],
      healer: [240, 455],
      melee: [470, 285],
      ranged: [560, 455],
    };
    const [x, y] = positions[player.role.category];
    return { x, y };
  }
  const positions = {
    tank: [355, 450],
    healer: [225, 560],
    melee: [445, 450],
    ranged: [475, 440],
  };
  const [x, y] = positions[player.role.category];
  return { x, y };
}

function stackPositionFor(sourceRound) {
  const flavor = state.pastFuture[sourceRound] || "過去";
  return {
    x: BOSS.x,
    y: BOSS.y + (flavor === "過去" ? DIRECTION_LOCK_DISTANCE : -DIRECTION_LOCK_DISTANCE),
  };
}

function directionLockPositionFor(sourceRound) {
  if (sourceRound === 8) {
    return { x: BOSS.x, y: BOSS.y - DIRECTION_LOCK_DISTANCE };
  }
  return stackPositionFor(sourceRound);
}

function finalSafePositionFor(sourceRound) {
  const flavor = state.pastFuture[sourceRound] || "過去";
  return {
    x: BOSS.x,
    y: BOSS.y + (flavor === "過去" ? -DIRECTION_LOCK_DISTANCE : DIRECTION_LOCK_DISTANCE),
  };
}

function assignmentPositionFor(player, round) {
  return assignmentFor(player, round) || supportPosition(player, round);
}

function stagingPositionFor(player, round) {
  if (round === 1) return { x: player.startX, y: player.startY };
  const previousRound = round - 1;
  if (previousRound % 2 === 0) {
    return directionLockPositionFor(previousRound);
  }
  return assignmentPositionFor(player, previousRound);
}

function wanderingTarget(player, base, settleAt) {
  const remaining = settleAt - state.time;
  const amplitude = Math.min(34, Math.max(0, (remaining - 1.4) * 4.5));
  const wave = state.time * 1.15 + player.wanderPhase;
  return {
    x: base.x + Math.sin(wave) * amplitude,
    y: base.y + Math.cos(wave * 0.73) * amplitude * 0.55,
  };
}

function timedTarget(player, destination, staging, deadline) {
  const remaining = deadline - state.time;
  const travelTime = distance(player, destination) / PLAYER_MOVE_SPEED;
  const target = remaining <= travelTime + NPC_ARRIVAL_MARGIN ? destination : staging;
  return wanderingTarget(player, target, deadline);
}

function npcTarget(player) {
  const round = activeRound();
  const info = towerInfo(round);
  for (const sourceRound of [2, 4, 6, 8]) {
    const base = TOWER_TIMES[sourceRound - 1];
    if (state.resolvedTowers.has(sourceRound) && !state.resolvedLocks.has(sourceRound)) {
      const stack = directionLockPositionFor(sourceRound);
      if (sourceRound === 8) {
        return wanderingTarget(player, stack, base + 4.15);
      }
      return timedTarget(
        player,
        stack,
        assignmentPositionFor(player, sourceRound),
        base + 5
      );
    }
    if (sourceRound === 8 && state.resolvedLocks.has(sourceRound) &&
        state.time < base + 10.6) {
      return timedTarget(
        player,
        finalSafePositionFor(sourceRound),
        directionLockPositionFor(sourceRound),
        base + 10
      );
    }
  }

  return timedTarget(
    player,
    assignmentPositionFor(player, round),
    stagingPositionFor(player, round),
    info.time
  );
}

function moveToward(player, target, dt) {
  const tx = target.x - player.x;
  const ty = target.y - player.y;
  const distance = Math.hypot(tx, ty);
  if (distance <= 1) return;
  const step = Math.min(distance, PLAYER_MOVE_SPEED * dt);
  player.x += (tx / distance) * step;
  player.y += (ty / distance) * step;
}

function movePlayers(dt) {
  const player = getPlayer();
  if (autoplay) {
    moveToward(player, npcTarget(player), dt);
  }
  const sprint = keys.has("Shift") ? 1.55 : 1;
  let dx = 0;
  let dy = 0;
  if (keys.has("w") || keys.has("ArrowUp")) dy -= 1;
  if (keys.has("s") || keys.has("ArrowDown")) dy += 1;
  if (keys.has("a") || keys.has("ArrowLeft")) dx -= 1;
  if (keys.has("d") || keys.has("ArrowRight")) dx += 1;

  if (!autoplay && (dx || dy)) {
    state.moveTarget = null;
    const length = Math.hypot(dx, dy);
    player.x += (dx / length) * PLAYER_MOVE_SPEED * sprint * dt;
    player.y += (dy / length) * PLAYER_MOVE_SPEED * sprint * dt;
  } else if (!autoplay && state.moveTarget) {
    const tx = state.moveTarget.x - player.x;
    const ty = state.moveTarget.y - player.y;
    const distance = Math.hypot(tx, ty);
    const step = PLAYER_MOVE_SPEED * sprint * dt;
    if (distance <= step) {
      player.x = state.moveTarget.x;
      player.y = state.moveTarget.y;
      state.moveTarget = null;
    } else {
      player.x += (tx / distance) * step;
      player.y += (ty / distance) * step;
    }
  }

  for (const npc of state.players) {
    if (npc.id === state.playerId) continue;
    moveToward(npc, npcTarget(npc), dt);
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function checkArena() {
  if (state.time < 0) return;
  if (distance(getPlayer(), ARENA) > ARENA.r - 12) {
    fail("フィールド外へ落下しました。");
  }
}

function resolveTower(round) {
  if (state.resolvedTowers.has(round) || !state.running) return;
  state.resolvedTowers.add(round);
  const info = towerInfo(round);
  const occupied = TOWERS.map((tower) =>
    state.players.filter((member) => distance(member, tower) <= tower.r)
  );

  if (occupied.some((members) => members.length !== 2)) {
    fail(`${round}回目：塔はそれぞれ2人で処理します。`);
    return;
  }

  const active = state.players.filter((member) => member.group === info.group);
  const effects = createSpellEffects(active, round);
  const hazardFailure = spellHazardFailure(effects, round);
  if (hazardFailure) {
    fail(`${round}回目：${hazardFailure}`);
    return;
  }
  for (const member of active) {
    member.stacks -= 1;
    member.lastSoaked = round;
    const next = nextRoundFor(member, round);
    if (next) {
      member.mark = markForRound(member, next);
      member.markUpdatedAt = state.time;
    }
  }
  showBanner(`塔 ${round} / 8  処理成功`, 1.6);
  updateAssignment();
}

function createSpellEffects(activePlayers, round) {
  const snapshots = state.players.map((player) => ({
    id: player.id,
    x: player.x,
    y: player.y,
  }));
  for (const player of activePlayers) {
    const origin = snapshots.find((snapshot) => snapshot.id === player.id);
    const mark = player.mark;
    const effect = {
      type: mark,
      sourceId: player.id,
      x: origin.x,
      y: origin.y,
      startedAt: state.time,
      endsAt: state.time + 1.4,
    };
    if (mark === "fan") {
      const nearest = snapshots
        .filter((snapshot) => snapshot.id !== player.id)
        .sort((a, b) => distance(origin, a) - distance(origin, b))[0];
      effect.targetId = nearest.id;
      effect.angle = Math.atan2(nearest.y - origin.y, nearest.x - origin.x);
    }
    state.spellEffects.push(effect);
  }
  return state.spellEffects.slice(-activePlayers.length);
}

function angleDifference(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function isHitBySpell(player, effect) {
  if (effect.type === "fan") {
    if (player.id === effect.sourceId) return false;
    const range = distance(player, effect);
    if (range > FAN_LENGTH) return false;
    const angle = Math.atan2(player.y - effect.y, player.x - effect.x);
    return Math.abs(angleDifference(angle, effect.angle)) <= FAN_HALF_ANGLE;
  }
  return distance(player, effect) <= SPELL_RADII[effect.type];
}

function spellHazardFailure(effects, round) {
  const pastFutureTargets = round % 2 === 0 ? circleTargets(round) : [];
  for (const player of state.players) {
    const spellHits = effects.filter((effect) => isHitBySpell(player, effect));
    if (spellHits.length > 1) {
      return `${player.id}がスペルハザードを複数同時に受けて戦闘不能になりました。`;
    }
    const fanHit = spellHits.some((effect) => effect.type === "fan");
    const pastFutureHit = pastFutureTargets.some(
      (target) => distance(player, target) <= PAST_FUTURE_RADIUS
    );
    if (fanHit && pastFutureHit) {
      return `${player.id}が扇と過去/未来のAoEを同時に受けて戦闘不能になりました。`;
    }
  }

  for (const effect of effects.filter((candidate) => candidate.type === "share")) {
    const targets = state.players.filter((player) => isHitBySpell(player, effect));
    if (targets.length !== 3) {
      const source = state.players.find((player) => player.id === effect.sourceId);
      return `${source?.id || "頭割り対象"}の頭割りは3人で受けます（現在${targets.length}人）。`;
    }
  }
  return null;
}

function circleTargets(round) {
  const info = towerInfo(round);
  const activeFans = state.players.filter(
    (player) => player.group === info.group && markForRound(player, round) === "fan"
  );
  const inactive = state.players.filter((player) => player.group !== info.group);
  const tank = inactive.find((player) => player.role.category === "tank");
  const melee = inactive.find((player) => player.role.category === "melee");
  return [...activeFans, tank, melee].filter(Boolean);
}

function pastFutureAoeFailure(round) {
  for (const target of circleTargets(round)) {
    const hits = state.players.filter(
      (player) => distance(player, target) <= PAST_FUTURE_RADIUS
    );
    if (hits.length !== 1 || hits[0].id !== target.id) {
      const others = hits.filter((player) => player.id !== target.id);
      if (others.length) {
        return `${target.id}の過去/未来AoEに${others.map((player) => player.id).join("・")}が巻き込まれました。`;
      }
      return `${target.id}が自身の過去/未来AoEを正しく受けられていません。`;
    }
  }
  return null;
}

function resolveCircle(round) {
  if (state.resolvedCircles.has(round) || !state.running) return;
  state.resolvedCircles.add(round);
  const aoeFailure = pastFutureAoeFailure(round);
  if (aoeFailure) {
    fail(`${round}回目：${aoeFailure}`);
  }
}

function isDirectionLockPositionValid(player, sourceRound) {
  const stack = directionLockPositionFor(sourceRound);
  const targetAngle = Math.atan2(stack.y - BOSS.y, stack.x - BOSS.x);
  const playerAngle = Math.atan2(player.y - BOSS.y, player.x - BOSS.x);
  const radialDifference = Math.abs(distance(player, BOSS) - DIRECTION_LOCK_DISTANCE);
  const angleOffset = Math.abs(angleDifference(playerAngle, targetAngle));
  return radialDifference <= DIRECTION_LOCK_TOLERANCE &&
    angleOffset <= DIRECTION_LOCK_HALF_ANGLE;
}

function resolveDirectionLock(sourceRound) {
  if (state.resolvedLocks.has(sourceRound) || !state.running) return;
  state.resolvedLocks.add(sourceRound);
  if (!isDirectionLockPositionValid(getPlayer(), sourceRound)) {
    fail(`${state.pastFuture[sourceRound]}：向き確定時に誘導位置へ集合できていません。`);
  }
}

function resolveHalf(sourceRound) {
  if (state.resolvedHalves.has(sourceRound) || !state.running) return;
  state.resolvedHalves.add(sourceRound);
  const player = getPlayer();
  const safePosition = sourceRound === 8
    ? finalSafePositionFor(sourceRound)
    : { x: BOSS.x, y: BOSS.y + DIRECTION_LOCK_DISTANCE };
  const onUnsafeSide = safePosition.y < BOSS.y
    ? player.y > BOSS.y - 4
    : player.y < BOSS.y + 4;
  if (onUnsafeSide) {
    fail(`${state.pastFuture[sourceRound]}：分身の半面AoEを受けました。`);
    return;
  }
}

function resolveEvents() {
  for (let round = 1; round <= 8; round += 1) {
    const hitTime = TOWER_TIMES[round - 1];
    if (state.time >= hitTime) resolveTower(round);
    if (round % 2 === 0 && state.time >= hitTime) resolveCircle(round);
    if (round % 2 === 0 && state.time >= hitTime + 5) resolveDirectionLock(round);
    if (round % 2 === 0 && state.time >= hitTime + 10) resolveHalf(round);
  }
  if (state.time >= 91 && state.running) clearGame();
}

function fail(reason) {
  if (!state.running) return;
  state.running = false;
  state.finished = true;
  UI.resultKicker.textContent = "DUTY FAILED";
  UI.resultTitle.textContent = "GAME OVER";
  UI.resultReason.textContent = reason;
  UI.resultModal.classList.remove("hidden");
}

function clearGame() {
  state.running = false;
  state.finished = true;
  UI.resultKicker.textContent = "DUTY COMPLETE";
  UI.resultTitle.textContent = "ミッシング突破";
  UI.resultReason.textContent = "8回の塔と4回の過去／未来をすべて処理しました。";
  UI.resultModal.classList.remove("hidden");
}

function showBanner(text, duration) {
  UI.banner.textContent = text;
  UI.banner.classList.remove("hidden");
  state.bannerUntil = state.time + duration;
}

function eventDisplay() {
  const time = Math.max(0, state.time);
  let next = TIMELINE_ITEMS.find(([at]) => at > time + 0.05);
  if (!next) next = [91, "終了"];
  UI.next.textContent = `${Math.max(0, Math.ceil(next[0] - time))}s ${next[1]}`;
  UI.time.textContent = `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;

  const round = activeRound();
  UI.round.textContent = `ROUND ${round} / 8`;
  for (const item of UI.timeline.children) {
    item.classList.toggle("active", Number(item.dataset.time) <= time &&
      (item.nextElementSibling ? Number(item.nextElementSibling.dataset.time) > time : true));
  }

  if (state.time < 0) {
    UI.banner.textContent = Math.ceil(-state.time);
    UI.banner.classList.remove("hidden");
  } else if (state.time < 2) {
    UI.banner.textContent = "ミッシング";
    UI.banner.classList.remove("hidden");
  } else if (state.time > state.bannerUntil) {
    UI.banner.classList.add("hidden");
  }

  updateCastBar();
}

function updateCastBar() {
  let name = "";
  let progress = 0;
  for (const round of [2, 4, 6, 8]) {
    const base = TOWER_TIMES[round - 1];
    if (state.time >= base - 4 && state.time < base) {
      name = `${state.pastFuture[round]}の終焉`;
      progress = (state.time - (base - 4)) / 4;
    }
    if (state.time >= base + 5 && state.time < base + 10) {
      name = "消滅の脚";
      progress = (state.time - (base + 5)) / 5;
    }
  }
  UI.castBar.classList.toggle("hidden", !name);
  UI.castName.textContent = name;
  UI.castFill.style.width = `${progress * 100}%`;
}

function updateAssignment() {
  const player = getPlayer();
  if (!player) return;
  const round = nextRoundFor(player, player.lastSoaked);
  const assignment = round ? assignmentFor(player, round) : null;
  UI.roleIcon.src = player.role.icon;
  UI.roleName.textContent = player.id;
  UI.pairName.textContent = `PAIR ${pairIdFor(player.id, state.strategy)}`;
  UI.groupName.textContent = `${player.group === "A" ? "先組" : "後組"} · ${GROUP_ROUNDS[player.group].join(" / ")}`;
  UI.markBadge.textContent = MARK_LABEL[player.mark];
  UI.markBadge.className = `mark-badge ${player.mark}`;
  UI.towerAssignment.textContent = assignment ? `${round}回目 ${assignment.name}` : "完了";
  UI.stacks.textContent = String(player.stacks);
}

function drawArena() {
  ctx.clearRect(0, 0, W, W);
  const gradient = ctx.createRadialGradient(400, 380, 80, 400, 400, 355);
  gradient.addColorStop(0, "#172334");
  gradient.addColorStop(1, "#0c1420");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(ARENA.x, ARENA.y, ARENA.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#3d526e";
  ctx.lineWidth = 5;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(ARENA.x, ARENA.y, ARENA.r - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = "rgba(83,111,148,0.32)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 16; i += 1) {
    const angle = (i / 16) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(ARENA.x, ARENA.y);
    ctx.lineTo(ARENA.x + Math.cos(angle) * ARENA.r, ARENA.y + Math.sin(angle) * ARENA.r);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(BOSS.x, BOSS.y, 105, 0, Math.PI * 2);
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = "rgba(194,211,233,0.5)";
  ctx.stroke();
  ctx.setLineDash([]);
  drawMechanics();
  ctx.restore();

  drawBoss();
  drawPlayers();
}

function drawMechanics() {
  if (state.time >= 0 && state.time < 80) {
    for (const tower of TOWERS) {
      ctx.fillStyle = "rgba(53,111,218,0.15)";
      ctx.strokeStyle = "#5b91ff";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(tower.x, tower.y, tower.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#a7c7ff";
      ctx.font = "700 18px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(tower.label, tower.x, tower.y + 6);
    }
    drawTowerDrops();
  }
  drawSpellEffects();

  const round = activeRound();
  const info = towerInfo(round);
  if (!info.odd && state.time >= info.time - 1.2 && state.time < info.time + 0.65) {
    for (const target of circleTargets(round)) {
      ctx.fillStyle = "rgba(33,196,213,0.18)";
      ctx.strokeStyle = "#31d5e5";
      ctx.setLineDash([7, 6]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(target.x, target.y, PAST_FUTURE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  for (const sourceRound of [2, 4, 6, 8]) {
    const base = TOWER_TIMES[sourceRound - 1];
    if (state.time >= base + 5 && state.time < base + 10.6) {
      const alpha = 0.15 + 0.3 * Math.max(0, (state.time - (base + 5)) / 5);
      ctx.fillStyle = `rgba(192, 65, 79, ${alpha})`;
      const safePosition = sourceRound === 8
        ? finalSafePositionFor(sourceRound)
        : { x: BOSS.x, y: BOSS.y + DIRECTION_LOCK_DISTANCE };
      if (safePosition.y < BOSS.y) {
        ctx.fillRect(0, BOSS.y, W, W - BOSS.y);
      } else {
        ctx.fillRect(0, 0, W, BOSS.y);
      }
      ctx.strokeStyle = "#ff7d86";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(50, BOSS.y);
      ctx.lineTo(750, BOSS.y);
      ctx.stroke();
      drawClones(sourceRound);
    }
  }
}

function drawSpellEffects() {
  state.spellEffects = state.spellEffects.filter((effect) => effect.endsAt > state.time);
  for (const effect of state.spellEffects) {
    const life = Math.max(0, Math.min(1, (effect.endsAt - state.time) / 1.4));
    const alpha = 0.18 + life * 0.18;
    ctx.save();
    ctx.lineWidth = 3;
    if (effect.type === "share") {
      ctx.fillStyle = `rgba(239, 177, 49, ${alpha})`;
      ctx.strokeStyle = "rgba(255, 220, 125, 0.95)";
      ctx.beginPath();
      ctx.arc(effect.x, effect.y, SPELL_RADII.share, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (effect.type === "circle") {
      ctx.fillStyle = `rgba(218, 66, 168, ${alpha})`;
      ctx.strokeStyle = "rgba(255, 115, 207, 0.95)";
      ctx.beginPath();
      ctx.arc(effect.x, effect.y, SPELL_RADII.circle, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = `rgba(111, 78, 239, ${alpha})`;
      ctx.strokeStyle = "rgba(160, 132, 255, 0.95)";
      ctx.beginPath();
      ctx.moveTo(effect.x, effect.y);
      ctx.arc(
        effect.x,
        effect.y,
        FAN_LENGTH,
        effect.angle - FAN_HALF_ANGLE,
        effect.angle + FAN_HALF_ANGLE
      );
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawTowerDrops() {
  const round = activeRound();
  const hitTime = TOWER_TIMES[round - 1];
  const spawnTime = round === 1 ? 0 : TOWER_TIMES[round - 2];
  const progress = Math.min(1, Math.max(0, (state.time - spawnTime) / (hitTime - spawnTime)));
  const eased = progress * progress * (3 - 2 * progress);

  for (const tower of TOWERS) {
    const startY = tower.y - 175;
    const orbY = startY + (tower.y - startY) * eased;
    const pulse = 1 + Math.sin(state.time * 7) * 0.08;

    ctx.save();
    ctx.strokeStyle = `rgba(113, 176, 255, ${0.18 + progress * 0.42})`;
    ctx.lineWidth = 3 + progress * 3;
    ctx.beginPath();
    ctx.moveTo(tower.x, orbY + 13);
    ctx.lineTo(tower.x, tower.y);
    ctx.stroke();

    ctx.shadowColor = progress > 0.75 ? "#fff1a3" : "#72b5ff";
    ctx.shadowBlur = 18 + progress * 16;
    ctx.fillStyle = progress > 0.75 ? "#ffe783" : "#b7d9ff";
    ctx.beginPath();
    ctx.arc(tower.x, orbY, (11 + progress * 7) * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function drawClones(round) {
  const targets = circleTargets(round);
  for (const target of targets) {
    ctx.save();
    ctx.translate(target.x, target.y);
    ctx.fillStyle = "rgba(134,232,242,0.75)";
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(11, 12);
    ctx.lineTo(-11, 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawBoss() {
  ctx.save();
  ctx.translate(BOSS.x, BOSS.y);
  ctx.shadowColor = "#d7e5ff";
  ctx.shadowBlur = 15;
  ctx.fillStyle = "#d8e4f6";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, BOSS.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#1c2a3e";
  ctx.font = "900 12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("BOSS", 0, 4);
  ctx.restore();
}

function drawMark(player) {
  if (state.time < player.markUpdatedAt || state.time > player.markUpdatedAt + 3) return;
  const y = player.y - 27;
  ctx.save();
  ctx.translate(player.x, y);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  if (player.mark === "share") {
    ctx.fillStyle = "#e4ab2d";
    ctx.beginPath();
    ctx.roundRect(-8, -8, 16, 16, 3);
  } else if (player.mark === "circle") {
    ctx.fillStyle = "#d84cac";
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
  } else {
    ctx.fillStyle = "#7359ef";
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(9, 8);
    ctx.lineTo(-9, 8);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPlayers() {
  for (const player of state.players) {
    drawMark(player);
    const controlled = player.id === state.playerId;
    ctx.save();
    ctx.translate(player.x, player.y);
    if (controlled) {
      ctx.strokeStyle = "#fff4a8";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = player.role.color;
    ctx.strokeStyle = "#07101b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `${controlled ? 900 : 700} 11px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(player.id, 0, 30);
    ctx.restore();
  }
}

function loop(now) {
  const rawDt = Math.min(0.04, (now - state.lastFrame) / 1000);
  state.lastFrame = now;
  if (state.running) {
    const speed = Number(UI.speed.value);
    const dt = rawDt * speed;
    state.time += dt;
    movePlayers(dt);
    checkArena();
    resolveEvents();
    eventDisplay();
    drawArena();
    requestAnimationFrame(loop);
  } else if (!state.finished) {
    requestAnimationFrame(loop);
  }
}

function setupTimeline() {
  UI.timeline.innerHTML = "";
  for (const [time, label] of TIMELINE_ITEMS) {
    const item = document.createElement("li");
    item.dataset.time = time;
    item.innerHTML = `<time>${Math.floor(time / 60)}:${String(time % 60).padStart(2, "0")}</time><span>${label}</span>`;
    UI.timeline.appendChild(item);
  }
}

window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  keys.add(event.key.length === 1 ? event.key.toLowerCase() : event.key);
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
});
canvas.addEventListener("pointerdown", (event) => {
  if (!state.running) return;
  const rect = canvas.getBoundingClientRect();
  state.moveTarget = {
    x: ((event.clientX - rect.left) / rect.width) * W,
    y: ((event.clientY - rect.top) / rect.height) * W,
  };
});
UI.retry.addEventListener("click", () => {
  startGame(state.playerId, state.strategy, state.spread);
});

UI.strategyButtons.addEventListener("click", (event) => {
  const button = event.target.closest(".strategy-button");
  if (button) selectStrategy(button.dataset.strategy);
});
UI.spreadButtons.addEventListener("click", (event) => {
  const button = event.target.closest(".spread-button");
  if (button) selectSpread(button.dataset.spread);
});
setupRoleButtons();
setupTimeline();
resetSelection();
drawArena();
if (autoplay) startGame(
  query.get("role") || "MT",
  query.get("strategy") || "lean",
  query.get("spread") || query.get("position") || "kt"
);
