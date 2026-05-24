// Tank Duel — two iPads, turn-based artillery over PeerJS.
// One module, no build step. Deterministic physics so both screens agree.

const PEER_PREFIX = 'tankduel-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — easier for kids to read

// ----------------------------- deterministic RNG ---------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return s;
}

// ----------------------------- game model ----------------------------------
const WORLD_W = 1600;
const WORLD_H = 900;
const GRAVITY = 380;            // px/s^2
const TANK_W = 56;
const TANK_H = 28;
const MAX_HP = 100;
const MAX_POWER = 1.0;          // 0..1, scaled to speed
const SHOT_SPEED = 760;         // px/s at full power
const TERRAIN_RES = 4;          // px per heightmap sample

class Game {
  constructor(canvas, side, seed, send) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.side = side;              // 0 = host/pink (left), 1 = joiner/cyan (right)
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.send = send;
    this.turn = 0;                 // whose turn it is
    this.phase = 'aim';            // 'aim' | 'flying' | 'settle' | 'over'
    this.aim = { angle: -Math.PI / 4, power: 0.55 };
    this.projectile = null;
    this.wind = 0;
    this.toast = null;
    this.toastUntil = 0;
    this.buildTerrain();
    this.spawnTanks();
    this.rollWind();
    this.lastT = performance.now();

    // Aim preview drag state
    this.drag = null;
  }

  buildTerrain() {
    const cols = Math.ceil(WORLD_W / TERRAIN_RES) + 1;
    this.terrain = new Float32Array(cols);
    // Mix of sines, all seeded so both clients agree.
    const offs = [
      this.rng() * Math.PI * 2,
      this.rng() * Math.PI * 2,
      this.rng() * Math.PI * 2,
    ];
    for (let i = 0; i < cols; i++) {
      const x = i * TERRAIN_RES;
      const baseline = WORLD_H * 0.72;
      const a = 70 * Math.sin(x * 0.005 + offs[0]);
      const b = 35 * Math.sin(x * 0.013 + offs[1]);
      const c = 18 * Math.sin(x * 0.029 + offs[2]);
      this.terrain[i] = baseline + a + b + c;
    }
  }

  groundY(x) {
    const i = Math.max(0, Math.min(this.terrain.length - 1, Math.floor(x / TERRAIN_RES)));
    return this.terrain[i];
  }

  spawnTanks() {
    const leftX  = WORLD_W * 0.12;
    const rightX = WORLD_W * 0.88;
    this.tanks = [
      { x: leftX,  y: this.groundY(leftX),  hp: MAX_HP, dir: 1 },
      { x: rightX, y: this.groundY(rightX), hp: MAX_HP, dir: -1 },
    ];
    // Default aim points at opponent
    this.aim.angle = this.side === 0 ? -Math.PI / 4 : Math.PI + Math.PI / 4;
  }

  rollWind() {
    this.wind = (this.rng() * 2 - 1) * 160; // px/s^2 horizontal accel
  }

  setToast(text, ms = 2200) {
    this.toast = text;
    this.toastUntil = performance.now() + ms;
  }

  myTurn() { return this.turn === this.side && this.phase === 'aim'; }

  fire() {
    if (!this.myTurn()) return;
    const tank = this.tanks[this.side];
    const speed = SHOT_SPEED * Math.max(0.15, Math.min(1, this.aim.power));
    const vx = Math.cos(this.aim.angle) * speed;
    const vy = Math.sin(this.aim.angle) * speed;
    const payload = { type: 'fire', side: this.side, x: tank.x, y: tank.y - TANK_H + 4, vx, vy, wind: this.wind };
    this.send(payload);
    this.startProjectile(payload);
  }

  startProjectile(p) {
    this.projectile = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, wind: p.wind, trail: [] };
    this.phase = 'flying';
  }

  step(dt) {
    if (this.phase === 'flying' && this.projectile) {
      const p = this.projectile;
      const sub = 4;
      const ddt = dt / sub;
      for (let i = 0; i < sub; i++) {
        p.vx += p.wind * ddt;
        p.vy += GRAVITY * ddt;
        p.x += p.vx * ddt;
        p.y += p.vy * ddt;
        if (p.trail.length === 0 || Math.hypot(p.x - p.trail[p.trail.length - 1].x, p.y - p.trail[p.trail.length - 1].y) > 6) {
          p.trail.push({ x: p.x, y: p.y });
          if (p.trail.length > 80) p.trail.shift();
        }
        if (p.x < -200 || p.x > WORLD_W + 200 || p.y > WORLD_H + 200) {
          this.endShot(null);
          return;
        }
        if (p.y >= this.groundY(p.x)) {
          this.explode(p.x, this.groundY(p.x));
          return;
        }
        for (const t of this.tanks) {
          if (Math.hypot(p.x - t.x, p.y - (t.y - TANK_H * 0.5)) < TANK_W * 0.55) {
            this.explode(p.x, p.y);
            return;
          }
        }
      }
    } else if (this.phase === 'settle') {
      // Let tanks fall onto new terrain
      let stillFalling = false;
      for (const t of this.tanks) {
        const gy = this.groundY(t.x);
        if (t.y < gy) {
          t.y = Math.min(gy, t.y + 320 * dt);
          stillFalling = true;
        }
      }
      if (!stillFalling) {
        // Game over?
        const dead = this.tanks.findIndex(t => t.hp <= 0);
        if (dead !== -1) {
          this.phase = 'over';
          const winner = 1 - dead;
          this.setToast(winner === this.side ? 'YOU WIN ♥' : 'YOU LOSE', 99999);
        } else {
          this.turn = 1 - this.turn;
          this.rollWind();
          this.phase = 'aim';
          this.setToast(this.myTurn() ? 'YOUR TURN' : (this.cpu?.active ? "CPU'S TURN" : "SISTER'S TURN"), 1400);
        }
      }
    }
  }

  explode(cx, cy) {
    const radius = 56;
    // Scoop terrain
    const i0 = Math.max(0, Math.floor((cx - radius) / TERRAIN_RES));
    const i1 = Math.min(this.terrain.length - 1, Math.ceil((cx + radius) / TERRAIN_RES));
    for (let i = i0; i <= i1; i++) {
      const x = i * TERRAIN_RES;
      const dx = x - cx;
      const dy = Math.sqrt(Math.max(0, radius * radius - dx * dx));
      const newTop = cy + dy;
      if (newTop > this.terrain[i]) this.terrain[i] = newTop;
    }
    // Damage tanks
    for (const t of this.tanks) {
      const d = Math.hypot(t.x - cx, (t.y - TANK_H * 0.5) - cy);
      if (d < radius * 1.4) {
        const dmg = Math.round(Math.max(0, (1 - d / (radius * 1.4)) * 65) + 5);
        t.hp = Math.max(0, t.hp - dmg);
      }
    }
    this.endShot({ cx, cy });
  }

  endShot(_hit) {
    this.projectile = null;
    this.phase = 'settle';
  }

  // ----------------------------- input -------------------------------------
  onPointerDown(wx, wy) {
    if (!this.myTurn()) return;
    this.drag = { x: wx, y: wy };
  }
  onPointerMove(wx, wy) {
    if (!this.drag || !this.myTurn()) return;
    const tank = this.tanks[this.side];
    const dx = wx - tank.x;
    const dy = wy - (tank.y - TANK_H + 4);
    const angle = Math.atan2(dy, dx);
    // Power from drag distance — clamped
    const dragDist = Math.hypot(wx - this.drag.x, wy - this.drag.y);
    const power = Math.max(0.15, Math.min(1, dragDist / 280));
    this.aim.angle = angle;
    this.aim.power = power;
  }
  onPointerUp() {
    this.drag = null;
  }

  // ----------------------------- render ------------------------------------
  draw() {
    const ctx = this.ctx;
    const { width: cw, height: ch } = this.canvas;

    // Sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#2a1a4a');
    sky.addColorStop(0.65, '#7a2e8a');
    sky.addColorStop(1, '#ff8fb1');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);

    // Moon
    ctx.fillStyle = 'rgba(255, 240, 220, 0.9)';
    ctx.beginPath();
    ctx.arc(this.worldToCanvasX(WORLD_W * 0.78), this.worldToCanvasY(WORLD_H * 0.12), 38, 0, Math.PI * 2);
    ctx.fill();

    // Stars (seeded, fixed)
    if (!this._stars) {
      this._stars = [];
      const r = mulberry32(this.seed ^ 0x5a5a);
      for (let i = 0; i < 80; i++) {
        this._stars.push({ x: r() * WORLD_W, y: r() * WORLD_H * 0.55, s: r() * 1.4 + 0.4 });
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const s of this._stars) {
      ctx.fillRect(this.worldToCanvasX(s.x), this.worldToCanvasY(s.y), s.s, s.s);
    }

    // Terrain
    ctx.fillStyle = '#4d2a5a';
    ctx.beginPath();
    ctx.moveTo(0, ch);
    for (let i = 0; i < this.terrain.length; i++) {
      ctx.lineTo(this.worldToCanvasX(i * TERRAIN_RES), this.worldToCanvasY(this.terrain[i]));
    }
    ctx.lineTo(cw, ch);
    ctx.closePath();
    ctx.fill();

    // Grass strip on top of terrain
    ctx.strokeStyle = '#b65fb6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < this.terrain.length; i++) {
      const x = this.worldToCanvasX(i * TERRAIN_RES);
      const y = this.worldToCanvasY(this.terrain[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Tanks
    this.tanks.forEach((t, i) => this.drawTank(t, i));

    // Aim preview
    if (this.myTurn()) this.drawAimPreview();

    // Projectile + trail
    if (this.projectile) {
      const p = this.projectile;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < p.trail.length; i++) {
        const tp = p.trail[i];
        const cx = this.worldToCanvasX(tp.x);
        const cy = this.worldToCanvasY(tp.y);
        if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      ctx.fillStyle = '#ffd45b';
      ctx.beginPath();
      ctx.arc(this.worldToCanvasX(p.x), this.worldToCanvasY(p.y), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawTank(t, idx) {
    const ctx = this.ctx;
    const cx = this.worldToCanvasX(t.x);
    const cy = this.worldToCanvasY(t.y);
    const w = this.scale(TANK_W);
    const h = this.scale(TANK_H);
    const color = idx === 0 ? '#ff5bdc' : '#5be5ff';

    // Treads
    ctx.fillStyle = '#222';
    ctx.fillRect(cx - w / 2, cy - h * 0.35, w, h * 0.35);
    // Body
    ctx.fillStyle = color;
    ctx.fillRect(cx - w * 0.42, cy - h, w * 0.84, h * 0.7);
    // Turret
    ctx.beginPath();
    ctx.arc(cx, cy - h, w * 0.22, Math.PI, 0);
    ctx.fill();
    // Barrel — for active tank draw at aim angle; otherwise default toward center
    let barrelAngle;
    if (idx === this.turn && this.phase === 'aim') {
      barrelAngle = this.side === idx ? this.aim.angle : (idx === 0 ? -Math.PI / 4 : Math.PI + Math.PI / 4);
    } else {
      barrelAngle = idx === 0 ? -Math.PI / 4 : Math.PI + Math.PI / 4;
    }
    const bx = cx;
    const by = cy - h;
    const len = w * 0.55;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(barrelAngle) * len, by + Math.sin(barrelAngle) * len);
    ctx.stroke();
  }

  drawAimPreview() {
    const ctx = this.ctx;
    const t = this.tanks[this.side];
    const speed = SHOT_SPEED * this.aim.power;
    let vx = Math.cos(this.aim.angle) * speed;
    let vy = Math.sin(this.aim.angle) * speed;
    let x = t.x;
    let y = t.y - TANK_H + 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.worldToCanvasX(x), this.worldToCanvasY(y));
    const dt = 1 / 30;
    for (let i = 0; i < 28; i++) {
      vx += this.wind * dt;
      vy += GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      ctx.lineTo(this.worldToCanvasX(x), this.worldToCanvasY(y));
      if (y > this.groundY(x)) break;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ----------------------------- viewport ----------------------------------
  worldToCanvasX(x) { return x * (this.canvas.width / WORLD_W); }
  worldToCanvasY(y) { return y * (this.canvas.height / WORLD_H); }
  canvasToWorldX(x) { return x * (WORLD_W / this.canvas.width); }
  canvasToWorldY(y) { return y * (WORLD_H / this.canvas.height); }
  scale(v) { return v * (this.canvas.width / WORLD_W); }
}

// ----------------------------- bootstrap -----------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const fireBtn = document.getElementById('fire-btn');
const powerMeter = document.getElementById('power-meter');
const windEl = document.getElementById('wind');
const toastEl = document.getElementById('toast');

const lobby = document.getElementById('lobby');
const hostWait = document.getElementById('host-wait');
const joinForm = document.getElementById('join-form');
const lobbyStatus = document.getElementById('lobby-status');

let peer = null;
let conn = null;
let game = null;

function fitCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// ------------- Lobby buttons ----------------------------------------------
document.getElementById('host-btn').addEventListener('click', startHost);
document.getElementById('join-btn').addEventListener('click', () => show(joinForm));
document.getElementById('cpu-btn').addEventListener('click', startVsCpu);
document.getElementById('host-back').addEventListener('click', () => { teardownPeer(); show(lobby); });
document.getElementById('join-back').addEventListener('click', () => show(lobby));
document.getElementById('join-go').addEventListener('click', startJoin);

function show(el) {
  for (const o of [lobby, hostWait, joinForm]) o.classList.add('hidden');
  if (el) el.classList.remove('hidden');
}

function teardownPeer() {
  try { conn?.close(); } catch {}
  try { peer?.destroy(); } catch {}
  peer = null; conn = null;
}

function startHost() {
  const code = randomCode();
  document.getElementById('room-code').textContent = code;
  document.getElementById('host-status').textContent = 'Waiting for her to join…';
  show(hostWait);

  peer = new Peer(PEER_PREFIX + code, { debug: 1 });
  peer.on('open', () => { /* ready */ });
  peer.on('error', (err) => {
    console.warn('peer error', err);
    if (err.type === 'unavailable-id') {
      // try a different code
      teardownPeer();
      startHost();
    } else {
      document.getElementById('host-status').textContent = 'Network error: ' + err.type + '. Tap Back and try again.';
    }
  });
  peer.on('connection', (c) => {
    conn = c;
    wireConn();
    c.on('open', () => {
      const seed = (Math.random() * 0x7fffffff) | 0;
      conn.send({ type: 'init', seed });
      startGame(0, seed);
    });
  });
}

function startJoin() {
  const codeRaw = document.getElementById('join-code').value.trim().toUpperCase();
  if (codeRaw.length !== 4) {
    document.getElementById('join-status').textContent = 'Need a 4-letter code.';
    return;
  }
  document.getElementById('join-status').textContent = 'Connecting…';
  peer = new Peer(undefined, { debug: 1 });
  peer.on('open', () => {
    conn = peer.connect(PEER_PREFIX + codeRaw, { reliable: true });
    wireConn();
    conn.on('open', () => {
      document.getElementById('join-status').textContent = 'Connected. Waiting for game start…';
    });
  });
  peer.on('error', (err) => {
    console.warn('peer error', err);
    document.getElementById('join-status').textContent = 'Could not connect: ' + err.type;
  });
}

function wireConn() {
  conn.on('data', onMessage);
  conn.on('close', () => {
    showToast('Connection lost.');
  });
  conn.on('error', (e) => console.warn('conn err', e));
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    startGame(1, msg.seed);
  } else if (msg.type === 'fire' && game) {
    game.startProjectile(msg);
  }
}

function startGame(side, seed) {
  show(null);
  hud.classList.remove('hidden');
  windEl.classList.remove('hidden');
  powerMeter.classList.remove('hidden');
  fireBtn.classList.remove('hidden');
  game = new Game(canvas, side, seed, (payload) => conn?.send(payload));
  game.setToast(game.myTurn() ? 'YOUR TURN' : (game.cpu?.active ? "CPU'S TURN" : "SISTER'S TURN"), 1600);
  requestAnimationFrame(loop);
}

function startVsCpu() {
  show(null);
  hud.classList.remove('hidden');
  windEl.classList.remove('hidden');
  powerMeter.classList.remove('hidden');
  fireBtn.classList.remove('hidden');
  document.querySelector('#hp-p2 .name').textContent = 'CPU';
  const seed = (Math.random() * 0x7fffffff) | 0;
  game = new Game(canvas, 0, seed, () => {});      // no network
  game.cpu = { active: true, planned: null };       // CPU plays side 1
  game.setToast('YOUR TURN', 1400);
  requestAnimationFrame(loop);
}

// Simple CPU: pick a shot toward the player with some jitter, account for wind roughly.
function cpuMaybeAct(g) {
  if (!g.cpu?.active || g.turn !== 1 || g.phase !== 'aim') {
    if (g.cpu) g.cpu.planned = null;
    return;
  }
  if (!g.cpu.planned) {
    const me = g.tanks[1];
    const foe = g.tanks[0];
    const dx = foe.x - me.x;          // negative (foe is to the left)
    const dy = foe.y - me.y;
    // Solve approximate ballistic angle. Pick a fixed flight time and back out velocity.
    const t = 2.2 + Math.random() * 0.8;
    const vx = (dx - 0.5 * g.wind * t * t) / t;
    const vy = (dy - 0.5 * GRAVITY * t * t) / t;
    const speed = Math.hypot(vx, vy);
    const power = Math.max(0.25, Math.min(1, speed / SHOT_SPEED));
    let angle = Math.atan2(vy, vx);
    // jitter so the CPU isn't perfect — gets a bit better as it loses HP
    const handicap = me.hp / MAX_HP;                  // 1 → 0
    const jitter = (Math.random() - 0.5) * 0.18 * (0.5 + handicap);
    angle += jitter;
    g.cpu.planned = { angle, power, atMs: performance.now() + 900 + Math.random() * 600 };
    g.aim.angle = angle;
    g.aim.power = power;
  }
  if (performance.now() >= g.cpu.planned.atMs) {
    // Briefly hand control to CPU side to fire
    const savedSide = g.side;
    g.side = 1;
    g.fire();
    g.side = savedSide;
    g.cpu.planned = null;
  }
}

function loop(now) {
  const dt = Math.min(0.04, (now - game.lastT) / 1000);
  game.lastT = now;
  game.step(dt);
  cpuMaybeAct(game);
  game.draw();
  updateHUD();
  requestAnimationFrame(loop);
}

function updateHUD() {
  document.querySelector('#hp-p1 .bar > div').style.width = (game.tanks[0].hp / MAX_HP * 100) + '%';
  document.querySelector('#hp-p2 .bar > div').style.width = (game.tanks[1].hp / MAX_HP * 100) + '%';
  document.getElementById('hp-p1').classList.toggle('turn', game.turn === 0);
  document.getElementById('hp-p2').classList.toggle('turn', game.turn === 1);

  const banner = document.getElementById('turn-banner');
  const otherLabel = game.cpu?.active ? "CPU'S SHOT" : "SISTER'S SHOT";
  if (game.phase === 'over') {
    banner.textContent = 'GAME OVER';
  } else if (game.myTurn()) {
    banner.textContent = "YOUR SHOT";
  } else if (game.phase === 'flying') {
    banner.textContent = 'INCOMING';
  } else {
    banner.textContent = otherLabel;
  }

  const w = game.wind;
  const dir = w > 6 ? '→' : w < -6 ? '←' : '·';
  windEl.textContent = `WIND ${dir} ${Math.abs(w).toFixed(0)}`;

  powerMeter.querySelector('div').style.height = (game.aim.power * 100) + '%';

  fireBtn.disabled = !game.myTurn();

  if (game.toast && performance.now() < game.toastUntil) {
    toastEl.textContent = game.toast;
    toastEl.classList.add('show');
  } else {
    toastEl.classList.remove('show');
  }
}

function showToast(text, ms = 2200) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ------------- Canvas input -----------------------------------------------
function getWorldPos(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (WORLD_W / rect.width);
  const y = (ev.clientY - rect.top) * (WORLD_H / rect.height);
  return { x, y };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!game) return;
  ev.preventDefault();
  canvas.setPointerCapture(ev.pointerId);
  const { x, y } = getWorldPos(ev);
  game.onPointerDown(x, y);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!game) return;
  const { x, y } = getWorldPos(ev);
  game.onPointerMove(x, y);
});
canvas.addEventListener('pointerup', (ev) => {
  if (!game) return;
  game.onPointerUp();
});
canvas.addEventListener('pointercancel', (ev) => {
  if (!game) return;
  game.onPointerUp();
});

fireBtn.addEventListener('click', (ev) => {
  ev.preventDefault();
  game?.fire();
});

// Disable iOS rubber-band / accidental zoom
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
