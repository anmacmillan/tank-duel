// Angry Manon · Angry Margot — turn-based slingshot duel for two iPads.
// Physics via Matter.js. Lobby via PeerJS (free public broker). One module, no build.

const PEER_PREFIX = 'angrymm-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ----------------------------- deterministic RNG ---------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
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

// ----------------------------- world constants -----------------------------
const WORLD_W = 1600;
const WORLD_H = 900;
const GROUND_Y = 800;
const GRAVITY_Y = 0.4;             // gentle pull = long, lazy arcs across the world
const LAUNCH_SCALE = 30;           // bird speed = LAUNCH_SCALE * power (Matter units/step)
const MAX_PULL = 260;              // px from slingshot anchor

const SLING_A = { x: 320, y: GROUND_Y - 110 };
const SLING_B = { x: WORLD_W - 320, y: GROUND_Y - 110 };

const M = (typeof Matter !== 'undefined') ? Matter : null;

class Game {
  constructor(canvas, side, seed, send) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.side = side;
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.send = send;
    this.turn = 0;
    this.phase = 'aim';            // 'aim' | 'flying' | 'over'
    this.drag = null;
    this.bird = null;
    this.toast = null;
    this.toastUntil = 0;
    this.flyFrames = 0;
    this.settledFrames = 0;
    this.lastT = performance.now();
    this.cpu = null;

    this.engine = M.Engine.create();
    // gravity.scale = 1/deltaTime² so engine.gravity.y becomes the per-step velocity delta directly.
    this.engine.gravity.scale = 0.0036;
    this.engine.gravity.y = GRAVITY_Y;
    this.engine.enableSleeping = false;       // never let pigs/blocks sleep — every hit wakes them
    this.world = this.engine.world;
    this.pigs = [];
    this.blocks = [];
    this.pigsAlive = [0, 0];

    this.setupCollisions();
    this.buildWorld();
  }

  // ----------------------------- world build -------------------------------
  buildWorld() {
    const ground = M.Bodies.rectangle(WORLD_W / 2, GROUND_Y + 70, WORLD_W * 2, 140, { isStatic: true, label: 'ground', friction: 0.8 });
    M.World.add(this.world, ground);
    // Off-screen walls + ceiling
    M.World.add(this.world, [
      M.Bodies.rectangle(-60, WORLD_H / 2, 100, WORLD_H * 3, { isStatic: true, label: 'wall' }),
      M.Bodies.rectangle(WORLD_W + 60, WORLD_H / 2, 100, WORLD_H * 3, { isStatic: true, label: 'wall' }),
    ]);

    let pigId = 0;
    const buildFort = (ownerSide, centerX) => {
      const baseY = GROUND_Y;
      const blockW = 34, blockH = 70;
      const gap = 110;

      // Two pillars, two blocks each
      for (const off of [-gap / 2, gap / 2]) {
        for (let r = 0; r < 2; r++) {
          const b = M.Bodies.rectangle(
            centerX + off,
            baseY - blockH / 2 - r * (blockH + 1),
            blockW, blockH,
            { density: 0.0008, friction: 0.15, frictionStatic: 0.2, restitution: 0.2, label: 'block' }
          );
          b._w = blockW; b._h = blockH;
          this.blocks.push(b);
          M.World.add(this.world, b);
        }
      }
      // Top horizontal beam
      const beamW = gap + blockW * 1.3, beamH = 22;
      const beam = M.Bodies.rectangle(centerX, baseY - blockH * 2 - beamH / 2 - 2, beamW, beamH,
        { density: 0.0007, friction: 0.15, frictionStatic: 0.2, restitution: 0.2, label: 'block' });
      beam._w = beamW; beam._h = beamH;
      this.blocks.push(beam);
      M.World.add(this.world, beam);

      // Pigs: one on top of beam, one on ground inside, one offset on the ground outside
      const mkPig = (x, y) => {
        const p = M.Bodies.circle(x, y, 22, {
          density: 0.0014, friction: 0.4, restitution: 0.25, label: 'pig'
        });
        p.ownerSide = ownerSide;
        p.pigId = pigId++;
        p.hp = 10;
        p.dead = false;
        this.pigs.push(p);
        M.World.add(this.world, p);
        this.pigsAlive[ownerSide]++;
      };
      mkPig(centerX, baseY - blockH * 2 - beamH - 26);            // crown pig
      mkPig(centerX, baseY - 24);                                  // bunkered pig
    };

    buildFort(0, 170);
    buildFort(1, WORLD_W - 170);
  }

  setupCollisions() {
    M.Events.on(this.engine, 'collisionStart', (event) => {
      for (const pair of event.pairs) this.onHit(pair.bodyA, pair.bodyB);
    });
  }

  onHit(a, b) {
    const pig = a.label === 'pig' ? a : b.label === 'pig' ? b : null;
    if (!pig || pig.dead) return;
    const other = pig === a ? b : a;
    const pigSpeed = Math.hypot(pig.velocity.x, pig.velocity.y);
    const otherSpeed = Math.hypot(other.velocity.x, other.velocity.y);
    let dmg = 0;
    if (other.label === 'bird') {
      dmg = otherSpeed * 2.5 + pigSpeed * 1.0 + 6;   // any bird touch is a real hit
    } else if (other.label === 'block') {
      if (otherSpeed > 1.5) dmg = otherSpeed * 1.4;
    } else if (other.label === 'ground' || other.label === 'wall') {
      if (pigSpeed > 5) dmg = pigSpeed * 0.9;
    }
    if (dmg > 1) {
      pig.hp -= dmg;
      if (pig.hp <= 0) this.killPig(pig);
    }
  }

  killPig(pig) {
    if (pig.dead) return;
    pig.dead = true;
    this.pigsAlive[pig.ownerSide] = Math.max(0, this.pigsAlive[pig.ownerSide] - 1);
    M.World.remove(this.world, pig);
  }

  // ----------------------------- turn / state ------------------------------
  myTurn() { return this.turn === this.side && this.phase === 'aim'; }
  slingshotPos(side) { return side === 0 ? SLING_A : SLING_B; }

  setToast(text, ms = 2200) {
    this.toast = text;
    this.toastUntil = performance.now() + ms;
  }

  // ----------------------------- input -------------------------------------
  onPointerDown(wx, wy) {
    if (!this.myTurn()) return;
    this.drag = { x: wx, y: wy, pulled: false };
  }
  onPointerMove(wx, wy) {
    if (!this.drag || !this.myTurn()) return;
    const s = this.slingshotPos(this.side);
    let dx = wx - s.x;
    let dy = wy - s.y;
    const d = Math.hypot(dx, dy);
    if (d > MAX_PULL) { dx *= MAX_PULL / d; dy *= MAX_PULL / d; }
    this.drag.x = s.x + dx;
    this.drag.y = s.y + dy;
    if (d > 10) this.drag.pulled = true;
  }
  onPointerUp() {
    if (!this.drag) { return; }
    if (this.myTurn() && this.drag.pulled) {
      const s = this.slingshotPos(this.side);
      const pullX = s.x - this.drag.x;
      const pullY = s.y - this.drag.y;
      const pull = Math.hypot(pullX, pullY);
      if (pull > 25) {
        let angle = Math.atan2(pullY, pullX);
        const power = Math.min(1, pull / MAX_PULL);
        this.fire(power, angle);
      }
    }
    this.drag = null;
  }

  fire(power, angle) {
    this.send({ type: 'fire', side: this.side, power, angle });
    this.launchBird(this.side, power, angle);
  }

  launchBird(side, power, angle) {
    const s = this.slingshotPos(side);
    const speed = LAUNCH_SCALE * power;
    const bird = M.Bodies.circle(s.x, s.y - 14, 24, {
      density: 0.025,          // wrecking ball — ~30× the block mass per unit area
      friction: 0.5,
      frictionAir: 0.0005,     // virtually no drag — flies far
      restitution: 0.15,
      label: 'bird'
    });
    bird.ownerSide = side;
    M.Body.setVelocity(bird, { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed });
    M.World.add(this.world, bird);
    this.bird = bird;
    this.phase = 'flying';
    this.flyFrames = 0;
    this.settledFrames = 0;
  }

  // ----------------------------- update loop -------------------------------
  step() {
    M.Engine.update(this.engine, 1000 / 60);

    if (this.phase === 'flying') {
      this.flyFrames++;
      if (this.bird) {
        const p = this.bird.position;
        if (p.y > WORLD_H + 300 || p.x < -300 || p.x > WORLD_W + 300) {
          this.endShot();
          return;
        }
      }
      // Settled detection
      let calm = true;
      const all = [this.bird, ...this.pigs.filter(p => !p.dead), ...this.blocks];
      for (const b of all) {
        if (!b) continue;
        if (Math.hypot(b.velocity.x, b.velocity.y) > 0.6) { calm = false; break; }
      }
      if (calm) this.settledFrames++; else this.settledFrames = 0;
      if (this.settledFrames > 24 && this.flyFrames > 36) this.endShot();
      if (this.flyFrames > 8 * 60) this.endShot();
    }
  }

  endShot() {
    if (this.bird) {
      M.World.remove(this.world, this.bird);
      this.bird = null;
    }
    // Authoritative pig deaths from the firer
    const firerSide = this.turn;
    if (firerSide === this.side) {
      const deadIds = this.pigs.filter(p => p.dead).map(p => p.pigId);
      this.send({ type: 'endShot', deadIds, pigsAlive: this.pigsAlive.slice() });
    }
    this.advanceTurn();
  }

  advanceTurn() {
    if (this.pigsAlive[0] === 0 || this.pigsAlive[1] === 0) {
      this.phase = 'over';
      const winner = this.pigsAlive[0] > 0 ? 0 : 1;
      this.setToast(winner === this.side ? 'YOU WIN ♥' : (this.cpu?.active ? 'CPU WINS' : 'SISTER WINS'), 999999);
      return;
    }
    this.turn = 1 - this.turn;
    this.phase = 'aim';
    this.setToast(this.myTurn() ? 'YOUR TURN' : (this.cpu?.active ? "CPU'S TURN" : "SISTER'S TURN"), 1300);
  }

  // Remote messages
  receive(msg) {
    if (msg.type === 'fire') {
      this.launchBird(msg.side, msg.power, msg.angle);
    } else if (msg.type === 'endShot') {
      for (const id of msg.deadIds || []) {
        const pig = this.pigs.find(p => p.pigId === id);
        if (pig && !pig.dead) this.killPig(pig);
      }
      this.pigsAlive = msg.pigsAlive.slice();
    }
  }

  // ----------------------------- render ------------------------------------
  draw() {
    const ctx = this.ctx;
    const { width: cw, height: ch } = this.canvas;

    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#7ed1ff');
    sky.addColorStop(0.6, '#ffd6a0');
    sky.addColorStop(1, '#ffaca0');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);

    // Clouds (seeded)
    if (!this._clouds) {
      this._clouds = [];
      const r = mulberry32(this.seed ^ 0xc10ad);
      for (let i = 0; i < 6; i++) {
        this._clouds.push({ x: r() * WORLD_W, y: 50 + r() * 250, s: 38 + r() * 26 });
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    for (const c of this._clouds) {
      const cx = this.w2cx(c.x), cy = this.w2cy(c.y), s = this.s(c.s);
      ctx.beginPath();
      ctx.arc(cx, cy, s, 0, Math.PI * 2);
      ctx.arc(cx + s * 0.7, cy - s * 0.25, s * 0.85, 0, Math.PI * 2);
      ctx.arc(cx + s * 1.4, cy, s * 0.9, 0, Math.PI * 2);
      ctx.arc(cx - s * 0.6, cy + s * 0.1, s * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ground
    ctx.fillStyle = '#88c850';
    ctx.fillRect(0, this.w2cy(GROUND_Y), cw, ch);
    ctx.fillStyle = '#5c9c34';
    ctx.fillRect(0, this.w2cy(GROUND_Y), cw, this.s(7));

    // Slingshots (draw both — only the active turn's gets a loaded bird)
    this.drawSlingshot(SLING_A, 0);
    this.drawSlingshot(SLING_B, 1);

    // Blocks
    for (const b of this.blocks) this.drawBlock(b);

    // Pigs
    for (const p of this.pigs) if (!p.dead) this.drawPig(p);

    // Bird in flight
    if (this.bird) this.drawBirdAt(this.bird.position.x, this.bird.position.y, this.bird.ownerSide ?? this.turn, this.bird.angle);

    // Slingshot pull + trajectory while aiming
    if (this.myTurn() && this.drag?.pulled) {
      this.drawSlingshotPull();
      this.drawTrajectoryPreview();
    } else if (this.myTurn()) {
      this.drawTurnPulse();
    }
  }

  drawSlingshot(s, side) {
    const ctx = this.ctx;
    const cx = this.w2cx(s.x);
    const top = this.w2cy(s.y);
    const base = this.w2cy(GROUND_Y);
    const fork = this.s(36);

    ctx.strokeStyle = '#6b3a1f';
    ctx.lineCap = 'round';
    ctx.lineWidth = this.s(14);
    ctx.beginPath();
    ctx.moveTo(cx, base);
    ctx.lineTo(cx, top + this.s(10));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, top + this.s(10));
    ctx.lineTo(cx - fork, top - this.s(4));
    ctx.moveTo(cx, top + this.s(10));
    ctx.lineTo(cx + fork, top - this.s(4));
    ctx.stroke();

    // Idle "loaded" bird on the active slingshot when waiting for input
    if (!this.bird && this.turn === side && this.phase === 'aim' && !(this.myTurn() && this.drag?.pulled)) {
      this.drawBirdAt(s.x, s.y - 14, side, 0);
    }
  }

  drawSlingshotPull() {
    const ctx = this.ctx;
    const s = this.slingshotPos(this.side);
    const cx0 = this.w2cx(s.x);
    const cy0 = this.w2cy(s.y);
    const cxd = this.w2cx(this.drag.x);
    const cyd = this.w2cy(this.drag.y);

    ctx.strokeStyle = '#3a1a08';
    ctx.lineWidth = this.s(7);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx0 - this.s(36), cy0 - this.s(4));
    ctx.lineTo(cxd, cyd);
    ctx.lineTo(cx0 + this.s(36), cy0 - this.s(4));
    ctx.stroke();

    this.drawBirdAt(this.drag.x, this.drag.y, this.side, 0);
  }

  drawTrajectoryPreview() {
    const ctx = this.ctx;
    const s = this.slingshotPos(this.side);
    const pullX = s.x - this.drag.x;
    const pullY = s.y - this.drag.y;
    const pull = Math.hypot(pullX, pullY);
    if (pull < 12) return;
    const power = Math.min(1, pull / MAX_PULL);
    const speed = LAUNCH_SCALE * power;
    let vx = (pullX / pull) * speed;
    let vy = (pullY / pull) * speed;
    let x = s.x;
    let y = s.y - 14;
    for (let i = 0; i < 120; i++) {
      vy += GRAVITY_Y;
      x += vx;
      y += vy;
      if (y > GROUND_Y || x < -50 || x > WORLD_W + 50) break;
      if (i % 4 === 0) {
        const alpha = 0.85 - i / 160;
        ctx.fillStyle = `rgba(255, 245, 100, ${alpha})`;
        ctx.beginPath();
        ctx.arc(this.w2cx(x), this.w2cy(y), this.s(7), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.lineWidth = this.s(1.5);
        ctx.stroke();
      }
    }
  }

  drawTurnPulse() {
    const ctx = this.ctx;
    const s = this.slingshotPos(this.side);
    const cx = this.w2cx(s.x);
    const cy = this.w2cy(s.y - 14);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 280);
    ctx.strokeStyle = `rgba(255, 240, 100, ${0.5 + 0.4 * pulse})`;
    ctx.lineWidth = this.s(3);
    ctx.beginPath();
    ctx.arc(cx, cy, this.s(30 + pulse * 10), 0, Math.PI * 2);
    ctx.stroke();
  }

  drawBlock(b) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.w2cx(b.position.x), this.w2cy(b.position.y));
    ctx.rotate(b.angle);
    const w = this.s(b._w);
    const h = this.s(b._h);
    ctx.fillStyle = '#b78049';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#5c3a1a';
    ctx.lineWidth = this.s(2.5);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(90, 58, 28, 0.4)';
    ctx.lineWidth = this.s(1);
    ctx.beginPath();
    ctx.moveTo(-w / 2 + this.s(4), -h / 4); ctx.lineTo(w / 2 - this.s(4), -h / 4);
    ctx.moveTo(-w / 2 + this.s(4), h / 4); ctx.lineTo(w / 2 - this.s(4), h / 4);
    ctx.stroke();
    ctx.restore();
  }

  drawPig(p) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.w2cx(p.position.x), this.w2cy(p.position.y));
    ctx.rotate(p.angle);
    const r = this.s(p.circleRadius || 22);
    ctx.fillStyle = '#7ec850';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#4a7e2d';
    ctx.lineWidth = this.s(2);
    ctx.stroke();
    // Eyes
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(-r * 0.32, -r * 0.22, r * 0.24, 0, Math.PI * 2);
    ctx.arc(r * 0.32, -r * 0.22, r * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(-r * 0.32, -r * 0.22, r * 0.1, 0, Math.PI * 2);
    ctx.arc(r * 0.32, -r * 0.22, r * 0.1, 0, Math.PI * 2);
    ctx.fill();
    // Snout
    ctx.fillStyle = '#4a7e2d';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.25, r * 0.42, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2c5618';
    ctx.beginPath();
    ctx.arc(-r * 0.12, r * 0.25, r * 0.05, 0, Math.PI * 2);
    ctx.arc(r * 0.12, r * 0.25, r * 0.05, 0, Math.PI * 2);
    ctx.fill();
    // HP bar if damaged
    if (p.hp < 24) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(-r, -r - this.s(10), r * 2, this.s(4));
      ctx.fillStyle = '#ff6080';
      ctx.fillRect(-r, -r - this.s(10), r * 2 * Math.max(0, p.hp / 24), this.s(4));
    }
    ctx.restore();
  }

  drawBirdAt(wx, wy, side, rot = 0) {
    const ctx = this.ctx;
    const r = this.s(20);
    ctx.save();
    ctx.translate(this.w2cx(wx), this.w2cy(wy));
    ctx.rotate(rot);
    const color = side === 0 ? '#ff5bdc' : '#5be5ff';
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1a1430';
    ctx.lineWidth = this.s(2);
    ctx.stroke();
    // Eye
    ctx.fillStyle = 'white';
    ctx.beginPath(); ctx.arc(r * 0.25, -r * 0.2, r * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(r * 0.32, -r * 0.2, r * 0.12, 0, Math.PI * 2); ctx.fill();
    // Beak
    ctx.fillStyle = '#f1a826';
    ctx.beginPath();
    ctx.moveTo(r * 0.7, -r * 0.05);
    ctx.lineTo(r * 1.3, 0);
    ctx.lineTo(r * 0.7, r * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#7a4a10';
    ctx.lineWidth = this.s(1.5);
    ctx.stroke();
    // Brow tuft
    ctx.strokeStyle = '#1a1430';
    ctx.lineWidth = this.s(2.5);
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, -r * 0.7);
    ctx.lineTo(0, -r * 1.05);
    ctx.lineTo(r * 0.25, -r * 0.75);
    ctx.stroke();
    ctx.restore();
  }

  // ----------------------------- viewport ----------------------------------
  w2cx(x) { return x * (this.canvas.width / WORLD_W); }
  w2cy(y) { return y * (this.canvas.height / WORLD_H); }
  s(v) { return v * (this.canvas.width / WORLD_W); }
}

// ----------------------------- bootstrap -----------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const toastEl = document.getElementById('toast');

const lobby = document.getElementById('lobby');
const hostWait = document.getElementById('host-wait');
const joinForm = document.getElementById('join-form');

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

// Lobby
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
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') { teardownPeer(); startHost(); return; }
    document.getElementById('host-status').textContent = 'Network error: ' + err.type;
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
    document.getElementById('join-status').textContent = 'Could not connect: ' + err.type;
  });
}

function wireConn() {
  conn.on('data', onMessage);
  conn.on('close', () => showToast('Connection lost.', 4000));
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init' && !game) {
    startGame(1, msg.seed);
  } else if (game) {
    game.receive(msg);
  }
}

function startGame(side, seed) {
  show(null);
  hud.classList.remove('hidden');
  game = new Game(canvas, side, seed, (payload) => conn?.send(payload));
  game.setToast(game.myTurn() ? 'YOUR TURN' : "SISTER'S TURN", 1500);
  requestAnimationFrame(loop);
}

function startVsCpu() {
  show(null);
  hud.classList.remove('hidden');
  document.querySelector('#hp-p2 .name').textContent = 'CPU';
  const seed = (Math.random() * 0x7fffffff) | 0;
  game = new Game(canvas, 0, seed, () => {});
  game.cpu = { active: true, planned: null };
  game.setToast('YOUR TURN', 1400);
  requestAnimationFrame(loop);
}

// CPU AI: aim at the closer of the two opposing pigs with a ballistic approximation + jitter.
function cpuMaybeAct(g) {
  if (!g.cpu?.active || g.turn !== 1 || g.phase !== 'aim') {
    if (g.cpu) g.cpu.planned = null;
    return;
  }
  if (!g.cpu.planned) {
    const me = g.slingshotPos(1);
    // Pick a random surviving target pig
    const targets = g.pigs.filter(p => !p.dead && p.ownerSide === 0);
    if (targets.length === 0) return;
    const target = targets[(Math.random() * targets.length) | 0];
    const tx = target.position.x;
    const ty = target.position.y;
    // Solve approximate velocity to reach (tx, ty) in T Matter steps
    const T = 55 + Math.random() * 15;
    const dx = tx - me.x;
    const dy = ty - (me.y - 14);
    const vx = dx / T;
    const vy = (dy - 0.5 * GRAVITY_Y * T * T) / T;
    const speed = Math.hypot(vx, vy);
    const power = Math.max(0.35, Math.min(1, speed / LAUNCH_SCALE));
    let angle = Math.atan2(vy, vx);
    // Forbid below-horizontal launches
    if (Math.sin(angle) > 0) angle = Math.cos(angle) >= 0 ? 0 : Math.PI;
    const jitter = (Math.random() - 0.5) * 0.18;
    angle += jitter;
    g.cpu.planned = { angle, power, atMs: performance.now() + 1100 + Math.random() * 700 };
  }
  if (performance.now() >= g.cpu.planned.atMs) {
    const savedSide = g.side;
    g.side = 1;
    g.fire(g.cpu.planned.power, g.cpu.planned.angle);
    g.side = savedSide;
    g.cpu.planned = null;
  }
}

function loop(now) {
  game.lastT = now;
  game.step();
  cpuMaybeAct(game);
  game.draw();
  updateHUD();
  requestAnimationFrame(loop);
}

function updateHUD() {
  document.getElementById('pigs-p1').textContent = '🐷'.repeat(game.pigsAlive[0]) || '—';
  document.getElementById('pigs-p2').textContent = '🐷'.repeat(game.pigsAlive[1]) || '—';
  document.getElementById('hp-p1').classList.toggle('turn', game.turn === 0);
  document.getElementById('hp-p2').classList.toggle('turn', game.turn === 1);

  const banner = document.getElementById('turn-banner');
  const otherLabel = game.cpu?.active ? "CPU'S SHOT" : "SISTER'S SHOT";
  if (game.phase === 'over') banner.textContent = 'GAME OVER';
  else if (game.myTurn()) banner.textContent = 'YOUR SHOT';
  else if (game.phase === 'flying') banner.textContent = 'INCOMING';
  else banner.textContent = otherLabel;

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

// Canvas pointer input
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
canvas.addEventListener('pointerup', () => { if (game) game.onPointerUp(); });
canvas.addEventListener('pointercancel', () => { if (game) game.onPointerUp(); });

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
