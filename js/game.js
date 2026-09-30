/*
 * Consonant Class — a web port of the "Into The Box" game from Thailes.
 *
 * Thai consonants fall from the sky. Tap one to hear its voice, then drag it
 * into the matching class box (High / Middle / Low). The line you draw is the
 * path the tile follows. It speeds up as you play. Three mistakes ends the game.
 *
 * Movement, follow-speed, box layout and class rules are ported directly from
 * the original SpriteKit source (Tile.m, IntoTheBox.m, CharacterLookup.m).
 */

(() => {
  "use strict";

  // ---- Constants ported from the original ------------------------------
  const BASE_FOLLOW_SPEED = 80;   // POINTS_PER_SEC (phone) — path-follow speed
  const DROP_SECONDS = 10;       // initial drop time: a fresh tile falls the playfield in ~10s
  const SPAWN_SECONDS = 6;       // initial spawn rate: seconds between new tiles
  const SPAWN_MIN = 0.5;         // spawns never get closer together than this
  const SPEEDUP_EVERY = 10;      // every this many seconds both timings step up
  const SPEEDUP_STEP = 0.12;     // +12% faster per step (applies to drop AND spawn)
  const PAUSE_SECONDS = 1.8;     // the whole board freezes this long on a wrong drop
  const START_LIVES = 3;         // three errors ends the game
  const MAX_SCORE = 9999;        // perfect score — the game ends here
  // Cloudflare Worker base URL for the stats registry (no trailing slash).
  // Leave "" to run with no registry. e.g. "https://consonant-class-stats.<you>.workers.dev"
  // Override at runtime for testing with ?stats=<url> (e.g. ?stats=http://localhost:8787).
  const STATS_URL_DEFAULT = "https://into-the-box-stats.snowsignals.workers.dev";
  const STATS_URL =
    (new URLSearchParams(location.search).get("stats") || STATS_URL_DEFAULT).replace(/\/$/, "");
  const TILE_ASPECT = 139 / 148;    // source tile is 148x139
  let TILE_W = 148, TILE_H = 139;   // recomputed in layoutBoxes() to match the box size

  const CLASS_INFO = {
    high: { label: "High",   box: "assets/boxes/high.png", line: "#3730a3" },
    mid:  { label: "Middle", box: "assets/boxes/mid.png",  line: "#3730a3" },
    low:  { label: "Low",    box: "assets/boxes/low.png",  line: "#3730a3" },
  };

  // ---- DOM / canvas -----------------------------------------------------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const livesEl = document.getElementById("lives");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayText = document.getElementById("overlay-text");
  const startBtn = document.getElementById("start-btn");
  const hudTitle = document.getElementById("hud-title");
  const soundBtn = document.getElementById("sound-btn");
  const nameWrap = document.getElementById("name-wrap");
  const nameInput = document.getElementById("name-input");
  const greeting = document.getElementById("greeting");
  const leaderboardEl = document.getElementById("leaderboard");

  let DPR = 1, W = 0, H = 0; // logical (CSS px) size

  // ---- Asset loading ----------------------------------------------------
  const images = {};   // key -> HTMLImageElement
  const audio = {};    // key -> preloaded Audio (voices + sfx)

  function loadImage(key, src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { images[key] = img; resolve(); };
      img.onerror = () => resolve(); // keep going even if one is missing
      img.src = src;
    });
  }

  function preloadAll() {
    const jobs = [];
    for (const c of CONSONANTS) {
      jobs.push(loadImage("t" + c.cp, `assets/tiles/${c.cp}.png`));
      jobs.push(loadImage("h" + c.cp, `assets/tiles/${c.cp}_hi.png`));
    }
    jobs.push(loadImage("high", CLASS_INFO.high.box));
    jobs.push(loadImage("mid", CLASS_INFO.mid.box));
    jobs.push(loadImage("low", CLASS_INFO.low.box));
    return Promise.all(jobs);
  }

  // Sound mode: 0 = all, 1 = no effects (voices only), 2 = fully muted.
  const SOUND_MODES = ["all", "no-fx", "silent"];
  let soundMode = Math.max(0, Math.min(2, parseInt(localStorage.getItem("ccg_sound") || "0", 10) || 0));

  function playClip(key, src) {
    const a = audio[key] || (audio[key] = new Audio(src));
    try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) {}
  }

  // Voices are created lazily on first tap (after a user gesture) so mobile
  // browsers allow playback. SFX are small and preloaded.
  function sfx(name) {
    if (soundMode !== 0) return;                 // effects only in "all"
    playClip(name, `assets/audio/${name}.mp3`);
  }

  let gender = "F"; // alternates each tap, like the original genderAlternator
  function speak(cp) {
    if (soundMode === 2) return;                 // voices off only when fully muted
    gender = gender === "F" ? "M" : "F";
    playClip(gender + cp, `assets/audio/${gender}${cp}.mp3`);
  }

  // ---- Geometry: boxes --------------------------------------------------
  // Ported from PositionsManager getPositionsBoxes (fractions of screen).
  // Middle box sits centered and slightly lower; High left, Low right.
  const boxes = []; // {cls, x, y, w, h, img, sinkT}
  function layoutBoxes() {
    const bw = Math.min(W * 0.26, 150);
    const bh = bw * (778 / 948);
    const y1 = H - bh * 0.62;          // high / low baseline
    const y2 = H - bh * 0.42;          // middle sits a touch lower
    const defs = [
      { cls: "high", cx: W * 0.17, cy: y1, img: "high" },
      { cls: "mid",  cx: W * 0.50, cy: y2, img: "mid"  },
      { cls: "low",  cls2: true, cx: W * 0.83, cy: y1, img: "low" },
    ];
    boxes.length = 0;
    for (const d of defs) {
      boxes.push({ cls: d.cls, x: d.cx, y: d.cy, w: bw, h: bh, img: d.img, sinkT: 0 });
    }
    // tiles scale to the box size as displayed (keeps its own aspect ratio)
    TILE_W = bw;
    TILE_H = bw * TILE_ASPECT;
  }
  // Top of the box row — where a falling tile first meets a box.
  function boxRowTop() {
    let top = H;
    for (const b of boxes) top = Math.min(top, b.y - b.h / 2);
    return top;
  }

  // Base fall speed: cross the playable height (spawn to box row) in DROP_SECONDS.
  // The per-frame speedMul (see difficulty) then shortens the drop time on the clock.
  function fallSpeed() {
    return Math.max(30, (boxRowTop() + TILE_H) / DROP_SECONDS);
  }

  // ---- Tile -------------------------------------------------------------
  class Tile {
    constructor(data) {
      this.data = data;               // {cp, ch, cls, name}
      this.x = TILE_W / 2 + Math.random() * (W - TILE_W);
      this.y = -TILE_H;               // spawn above the top edge
      this.vx = 0;                    // falls straight; the player steers it
      this.vy = fallSpeed();          // constant descent (see fallSpeed)
      this.waypoints = [];            // path the user draws
      this.selected = false;
      this.scheduled = false;         // released onto a box -> homing in
      this.dead = false;
      this.scale = 0.2;               // pop-in
      this.spin = 0;
      this.alpha = 1;
      this.highlightT = 0;            // remaining highlight time (s)
    }

    get img() {
      const on = this.highlightT > 0 || this.selected;
      return images[(on ? "h" : "t") + this.data.cp];
    }

    addPoint(px, py) { this.waypoints.push({ x: px, y: py }); }
    clearWaypoints() { this.waypoints.length = 0; }

    select() {
      this.selected = true;
      this.highlightT = 1.0;
      speak(this.data.cp);
    }

    update(dt, speedMul) {
      // pop-in animation
      if (this.scale < 1) this.scale = Math.min(1, this.scale + dt * 4);
      if (this.highlightT > 0) this.highlightT -= dt;

      if (this.exploding) { this.runExplode(dt); return; }

      const follow = BASE_FOLLOW_SPEED * speedMul;

      if (this.waypoints.length > 0) {
        const t = this.waypoints[0];
        const ox = t.x - this.x, oy = t.y - this.y;
        const len = Math.hypot(ox, oy) || 1;
        this.vx = (ox / len) * follow;
        this.vy = (oy / len) * follow;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        // pop the waypoint once the tile covers it (as in Tile.m move:)
        if (Math.abs(t.x - this.x) < TILE_W / 2 && Math.abs(t.y - this.y) < TILE_H / 2) {
          this.waypoints.shift();
        }
      } else if (!this.selected) {
        // idle fall — steady descent so tiles cross the play area in ~5s
        this.vy = fallSpeed() * speedMul;
        this.y += this.vy * dt;
      }
    }

    explode(win) {
      this.exploding = true;
      this.win = win;
      this.explodeT = 0;
      this.waypoints.length = 0;
    }
    runExplode(dt) {
      this.explodeT += dt;
      if (this.win) { this.scale += dt * 3; this.alpha -= dt * 1.6; this.spin += dt * 6; }
      else { this.scale = Math.max(0, this.scale - dt * 2.5); this.alpha -= dt * 1.6; }
      if (this.alpha <= 0) this.dead = true;
    }

    contains(px, py) {
      return Math.abs(px - this.x) < TILE_W / 2 && Math.abs(py - this.y) < TILE_H / 2;
    }

    draw(ctx) {
      const img = this.img;
      if (!img) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, this.alpha);
      ctx.translate(this.x, this.y);
      ctx.rotate(this.spin);
      ctx.scale(this.scale, this.scale);
      if (this.selected || this.highlightT > 0) {
        ctx.shadowColor = "rgba(255, 214, 64, 0.9)";
        ctx.shadowBlur = 24;
      }
      ctx.drawImage(img, -TILE_W / 2, -TILE_H / 2, TILE_W, TILE_H);
      ctx.restore();
    }
  }

  // ---- Game state -------------------------------------------------------
  const state = {
    running: false,
    tiles: [],
    score: 0,
    lives: START_LIVES,
    spawnTimer: 0,
    elapsed: 0,    // seconds of play — drives the speed ramp
    pause: 0,      // seconds left of the wrong-drop freeze
    lastTime: 0,
    flash: 0,      // red flash on error
    errorLabel: null, // { text, cls, t } shown after a wrong drop
    order: [],     // shuffled consonant queue
    orderIdx: 0,
  };

  function difficulty() {
    // One clock, one multiplier — it shortens the drop time AND the spawn interval.
    const steps = Math.floor(state.elapsed / SPEEDUP_EVERY);
    const speedMul = 1 + SPEEDUP_STEP * steps;
    return {
      level: steps + 1,
      speedMul,                                       // drop time  = DROP_SECONDS / speedMul
      spawnEvery: Math.max(SPAWN_MIN, SPAWN_SECONDS / speedMul), // spawn time / speedMul
    };
  }

  function nextConsonant() {
    if (state.orderIdx >= state.order.length) {
      state.order = shuffle(CONSONANTS.slice());
      state.orderIdx = 0;
    }
    return state.order[state.orderIdx++];
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function spawnTile() {
    // no cap — tiles keep coming and back up on the boxes
    state.tiles.push(new Tile(nextConsonant()));
    sfx("sfx_drop");
  }

  function startGame() {
    finishing = false;
    state.running = true;
    state.tiles = [];
    state.score = 0;
    state.lives = START_LIVES;
    state.spawnTimer = 0;
    state.elapsed = 0;
    state.pause = 0;
    state.order = shuffle(CONSONANTS.slice());
    state.orderIdx = 0;
    state.flash = 0;
    state.errorLabel = null;
    updateHud();
    overlay.classList.add("hidden");
    spawnTile();
  }

  let finishing = false;
  async function finishGame(win) {
    if (finishing) return;                 // guard against double-trigger
    finishing = true;
    state.running = false;

    overlayTitle.textContent = win ? "Perfect — 9999!" : "Game Over";
    overlayText.innerHTML = `You sorted <strong>${state.score}</strong> consonant${state.score === 1 ? "" : "s"}.`;
    nameWrap.classList.add("hidden");
    greeting.classList.add("hidden");
    startBtn.textContent = "Play again";
    leaderboardEl.innerHTML = STATS_URL ? '<div class="lb-loading">Saving…</div>' : "";
    overlay.classList.remove("hidden");

    if (STATS_URL) {
      const result = await submitScore(getName(), state.score);
      renderStats(result);
    }
  }
  const gameOver = () => finishGame(false);

  function updateHud() {
    scoreEl.textContent = state.score;
    livesEl.textContent = "❤".repeat(state.lives) + "♡".repeat(START_LIVES - state.lives);
  }

  // ---- Evaluate a tile that reached a box ------------------------------
  function boxAt(px, py) {
    for (const b of boxes) {
      if (px >= b.x - b.w / 2 && px <= b.x + b.w / 2 &&
          py >= b.y - b.h / 2 && py <= b.y + b.h / 2) return b;
    }
    return null;
  }

  // A tile counts as "in" a box once their rectangles overlap.
  function boxHitting(tile) {
    for (const b of boxes) {
      if (Math.abs(tile.x - b.x) < (b.w + TILE_W) / 2 &&
          Math.abs(tile.y - b.y) < (b.h + TILE_H) / 2) return b;
    }
    return null;
  }

  // Rigid-body separation: no two tiles may overlap. A few relaxation passes
  // push overlapping pairs apart along their shallowest axis. Tiles being driven
  // (dragged or flying a drawn path into a box) shove others but don't get shoved.
  function separateTiles() {
    const list = state.tiles.filter((t) => !t.exploding);
    // process lowest tiles first so stacks settle from the bottom up
    list.sort((a, b) => b.y - a.y);
    const minX = TILE_W * 0.94, minY = TILE_H * 0.94;
    for (let iter = 0; iter < 12; iter++) {
      let moved = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const ox = minX - Math.abs(dx);
          const oy = minY - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;      // not overlapping
          const aFixed = a.scheduled || a === active;
          const bFixed = b.scheduled || b === active;
          if (aFixed && bFixed) continue;
          moved = true;
          if (ox < oy) {                          // separate horizontally
            const push = ox * (Math.sign(dx) || 1);
            if (aFixed) b.x += push;
            else if (bFixed) a.x -= push;
            else { a.x -= push / 2; b.x += push / 2; }
          } else {                                // separate vertically
            const push = oy * (Math.sign(dy) || 1);
            if (aFixed) { b.y += push; if (b.vy > 0) b.vy = 0; }
            else if (bFixed) { a.y -= push; }
            else { a.y -= push / 2; b.y += push / 2; }
          }
          // never let a shove push a tile out through a side wall
          a.x = Math.max(TILE_W / 2, Math.min(W - TILE_W / 2, a.x));
          b.x = Math.max(TILE_W / 2, Math.min(W - TILE_W / 2, b.x));
        }
      }
      if (!moved) break; // fully separated
    }
  }

  function resolveTile(tile, box) {
    if (tile.exploding) return;
    tile.scheduled = false;
    if (tile === active) active = null; // it resolved out from under the drag
    if (tile.data.cls === box.cls) {
      state.score = Math.min(MAX_SCORE, state.score + 1);
      updateHud();
      sfx("sfx_correct");
      tile.explode(true);
      if (state.score >= MAX_SCORE) finishGame(true); // perfect run ends the game
    } else {
      state.lives -= 1;
      updateHud();
      sfx("sfx_wrong");
      state.flash = 0.5;
      box.sinkT = 0.6;
      state.pause = PAUSE_SECONDS;   // freeze the whole board while the error registers
      active = null;                 // drop any in-progress drag
      // flash where the tile actually belonged, e.g. "ก = Middle Class"
      state.errorLabel = {
        text: `${tile.data.ch} = ${CLASS_INFO[tile.data.cls].label} Class`,
        cls: tile.data.cls,
        t: PAUSE_SECONDS,
      };
      tile.explode(false);
      if (state.lives <= 0) {
        // let the animation play a beat, then end
        setTimeout(gameOver, 450);
      }
    }
  }

  // ---- Pointer input (mouse + touch via Pointer Events) ----------------
  let active = null; // the tile currently being dragged

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Draw off the edge → drop the path, same as releasing over open space.
  function cancelDrag() {
    if (!active) return;
    active.selected = false;
    active.clearWaypoints();
    active.vy = Math.abs(active.vy) || fallSpeed();
    active = null;
  }

  function onDown(e) {
    if (!state.running || state.pause > 0) return; // input frozen during the wrong-drop pause
    const p = pointerPos(e);
    // topmost tile first
    for (let i = state.tiles.length - 1; i >= 0; i--) {
      const t = state.tiles[i];
      if (!t.exploding && t.contains(p.x, p.y)) {
        active = t;
        t.select();
        t.clearWaypoints();
        t.addPoint(p.x, p.y);
        canvas.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
    }
  }

  function onMove(e) {
    if (!active || state.pause > 0) return;
    const p = pointerPos(e);
    // if the path is drawn past the screen edge, invalidate it (drop the tile)
    if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
      cancelDrag();
      e.preventDefault();
      return;
    }
    active.addPoint(p.x, p.y);
    e.preventDefault();
  }

  function onUp(e) {
    if (!active) return;
    const p = pointerPos(e);
    const t = active;
    t.selected = false;
    const box = boxAt(p.x, p.y);
    if (box) {
      // schedule it: steer the tail of the path into the box center
      t.scheduled = true;
      t.addPoint(box.x, box.y);
    } else {
      // released in open space — resume drifting
      t.clearWaypoints();
      t.vy = Math.abs(t.vy) || 40;
    }
    active = null;
    e.preventDefault();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  // ---- Main loop --------------------------------------------------------
  function frame(now) {
    const dt = Math.min(0.033, (now - state.lastTime) / 1000 || 0);
    state.lastTime = now;

    if (state.running && state.pause > 0) {
      // frozen after a wrong drop: only the error feedback keeps ticking
      state.pause -= dt;
      for (const t of state.tiles) if (t.exploding) t.runExplode(dt); // let the bad tile pop
      state.tiles = state.tiles.filter((t) => !t.dead);
      if (state.flash > 0) state.flash -= dt;
      if (state.errorLabel) {
        state.errorLabel.t -= dt;
        if (state.errorLabel.t <= 0) state.errorLabel = null;
      }
      for (const b of boxes) if (b.sinkT > 0) b.sinkT -= dt;
    } else if (state.running) {
      state.elapsed += dt;
      const diff = difficulty();
      state.spawnTimer += dt;
      if (state.spawnTimer >= diff.spawnEvery) {
        state.spawnTimer = 0;
        spawnTile();
      }

      for (const t of state.tiles) t.update(dt, diff.speedMul);
      separateTiles();                        // rigid bodies — tiles don't overlap
      for (const t of state.tiles) {
        // a box invalidates the instant a tile touches its edge — right or wrong
        if (!t.exploding) {
          const box = boxHitting(t);
          if (box) resolveTile(t, box);
        }
      }
      // safety: drop anything that somehow slipped past the box row
      state.tiles = state.tiles.filter((t) => !t.dead && t.y < H + TILE_H * 2);
      if (state.flash > 0) state.flash -= dt;
      if (state.errorLabel) {
        state.errorLabel.t -= dt;
        if (state.errorLabel.t <= 0) state.errorLabel = null;
      }
      for (const b of boxes) if (b.sinkT > 0) b.sinkT -= dt;
    }

    render();
    requestAnimationFrame(frame);
  }

  function render() {
    ctx.clearRect(0, 0, W, H);

    // boxes
    const hint = state.errorLabel;
    for (const b of boxes) {
      const img = images[b.img];
      if (!img) continue;
      const shk = b.sinkT > 0 ? 1 - b.sinkT * 0.25 : 1;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.scale(shk, shk);
      // glow the box the errored tile should have gone into
      if (hint && hint.cls === b.cls) {
        ctx.shadowColor = "rgba(255, 214, 64, 0.95)";
        ctx.shadowBlur = 30 + Math.sin(hint.t * 12) * 10;
      }
      ctx.drawImage(img, -b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }

    // drawn paths (behind tiles) — blue when scheduled, red while dragging
    for (const t of state.tiles) {
      if (t.waypoints.length < 1 || t.exploding) continue;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      for (const w of t.waypoints) ctx.lineTo(w.x, w.y);
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = t.scheduled ? "#3730a3" : "#7c1030";
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // tiles
    for (const t of state.tiles) t.draw(ctx);

    // error flash
    if (state.flash > 0) {
      ctx.fillStyle = `rgba(200, 20, 40, ${state.flash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }

    // error label — names the box the tile belonged in
    if (state.errorLabel) {
      const a = Math.min(1, state.errorLabel.t / 0.4); // fade out at the end
      const cy = H * 0.32;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const fs = Math.max(26, Math.min(48, W * 0.09));
      ctx.font = `bold ${fs}px "Trebuchet MS", system-ui, sans-serif`;
      const text = state.errorLabel.text;
      const tw = ctx.measureText(text).width;
      const padX = fs * 0.7, bh = fs * 1.8, bw = tw + padX * 2;
      ctx.fillStyle = "rgba(30, 20, 20, 0.82)";
      roundRect(ctx, W / 2 - bw / 2, cy - bh / 2, bw, bh, 14);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255, 107, 107, 0.9)";
      ctx.stroke();
      ctx.fillStyle = "#ffd640";
      ctx.fillText(text, W / 2, cy);
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- Resize -----------------------------------------------------------
  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    DPR = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    layoutBoxes();
  }
  window.addEventListener("resize", resize);

  // ---- Name (stored once in localStorage) ------------------------------
  function getName() { return (localStorage.getItem("ccg_name") || "").trim(); }

  function refreshNameUI() {
    const n = getName();
    hudTitle.textContent = n || "Consonant Class"; // top label becomes the player's name
    if (n) {
      nameWrap.classList.add("hidden");
      greeting.classList.remove("hidden");
      greeting.innerHTML = `Playing as <strong>${escapeHtml(n)}</strong> · <a href="#" id="change-name">change</a>`;
      document.getElementById("change-name").onclick = (e) => {
        e.preventDefault();
        nameInput.value = n;
        nameWrap.classList.remove("hidden");
        greeting.classList.add("hidden");
        nameInput.focus();
      };
    } else {
      nameWrap.classList.remove("hidden");
      greeting.classList.add("hidden");
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- Stats registry API -----------------------------------------------
  async function submitScore(name, score) {
    if (!STATS_URL) return null;
    try {
      const res = await fetch(STATS_URL + "/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, score }),
      });
      if (!res.ok) return null;
      return await res.json(); // { ok, returning, best, totalUsers, throttled }
    } catch (e) { return null; }
  }

  function renderStats(result) {
    if (!result) {
      leaderboardEl.innerHTML = '<div class="lb-error">Score not saved (offline).</div>';
      return;
    }
    if (result.throttled) {
      leaderboardEl.innerHTML = '<div class="lb-note">Score not counted right now — too many tries. Try again later.</div>';
      return;
    }
    const n = Number(result.totalUsers || 0);
    const best = result.best != null ? result.best : state.score;
    const rankLine = result.rank
      ? `<div class="lb-note">Your rank: <strong>#${result.rank}</strong> of ${n.toLocaleString()} — best <strong>${best}</strong></div>`
      : `<div class="lb-note">Your best: <strong>${best}</strong></div>`;
    const link = STATS_URL
      ? `<div class="lb-note"><a href="${STATS_URL}/stats" target="_blank" rel="noopener">See the full leaderboard →</a></div>`
      : "";
    leaderboardEl.innerHTML =
      '<div class="lb-title">Thanks for playing</div>' +
      `<div class="lb-note">You’re one of <strong>${n.toLocaleString()}</strong> player${n === 1 ? "" : "s"} so far.</div>` +
      rankLine + link;
  }

  // ---- Sound toggle -----------------------------------------------------
  const SOUND_ICON = ["🔊", "🔉", "🔇"]; // 🔊 🔉 🔇
  const SOUND_HINT = ["Sound: on", "Sound: voices only", "Sound: muted"];
  function refreshSoundBtn() {
    soundBtn.textContent = SOUND_ICON[soundMode];
    soundBtn.title = SOUND_HINT[soundMode];
    soundBtn.setAttribute("aria-label", SOUND_HINT[soundMode]);
  }
  soundBtn.addEventListener("click", () => {
    soundMode = (soundMode + 1) % 3;
    localStorage.setItem("ccg_sound", String(soundMode));
    refreshSoundBtn();
  });

  // ---- Boot -------------------------------------------------------------
  startBtn.addEventListener("click", () => {
    // require a name the first time; afterward it's remembered
    if (!nameWrap.classList.contains("hidden")) {
      const name = (nameInput.value || "").trim().slice(0, 16);
      if (!name) {
        nameInput.classList.add("nudge");
        setTimeout(() => nameInput.classList.remove("nudge"), 350);
        nameInput.focus();
        return;
      }
      localStorage.setItem("ccg_name", name);
      hudTitle.textContent = name;   // top label becomes the player's name
    }
    leaderboardEl.innerHTML = "";
    startGame();               // one user gesture unlocks audio
  });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") startBtn.click(); });

  overlayTitle.textContent = "Consonant Class";
  overlayText.innerHTML =
    "Thai consonants fall from the sky. Tap one to hear it, then drag it into the box for its class — <strong>High</strong>, <strong>Middle</strong>, or <strong>Low</strong>. The line you draw is the path it follows. It speeds up as you go. Three mistakes ends the game.";
  startBtn.textContent = "Start";
  refreshSoundBtn();
  refreshNameUI();

  preloadAll().then(() => {
    resize();
    state.lastTime = performance.now();
    requestAnimationFrame(frame);
  });
})();
