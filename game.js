// Angry Blobs — turn-based slingshot chaos for two iPads.
// Physics via Matter.js. Lobby via PeerJS. No build step.

const PEER_PREFIX = 'angryblobs-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const WORLD_W = 1600;
const WORLD_H = 900;
const GROUND_Y = 804;
const GRAVITY_Y = 0.44;
const LAUNCH_SCALE = 31;
const MAX_PULL = 270;
const SHOT_TIMEOUT_FRAMES = 8 * 60;

const SLING_A = { x: 260, y: GROUND_Y - 128 };
const SLING_B = { x: WORLD_W - 260, y: GROUND_Y - 128 };

const M = typeof Matter !== 'undefined' ? Matter : null;

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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

class JuiceAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.11;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  unlock() {
    const ctx = this.ensure();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
  }

  tone(type, freq, duration, gain, ramp = 'exp', delay = 0) {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.0001, now);
    if (ramp === 'exp') {
      g.gain.exponentialRampToValueAtTime(gain, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    } else {
      g.gain.linearRampToValueAtTime(gain, now + 0.01);
      g.gain.linearRampToValueAtTime(0.0001, now + duration);
    }
    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  noise(duration, gain, filterFreq) {
    const ctx = this.ensure();
    if (!ctx) return;
    const buffer = ctx.createBuffer(1, Math.max(1, duration * ctx.sampleRate), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  launch(power) {
    this.unlock();
    this.tone('triangle', 180 + power * 100, 0.18, 0.06);
    this.tone('square', 110 + power * 50, 0.11, 0.035, 'linear', 0.04);
  }

  impact(speed) {
    this.tone('triangle', 85 + speed * 8, 0.1, clamp(speed / 150, 0.01, 0.045), 'linear');
    this.noise(0.06, clamp(speed / 350, 0.005, 0.03), 1200);
  }

  splat() {
    this.tone('sawtooth', 220, 0.12, 0.04, 'linear');
    this.tone('triangle', 140, 0.17, 0.03, 'linear', 0.03);
  }

  explode() {
    this.noise(0.4, 0.08, 700);
    this.tone('sawtooth', 75, 0.35, 0.06, 'linear');
    this.tone('triangle', 45, 0.5, 0.05, 'linear');
  }
}

const audio = new JuiceAudio();

class Game {
  constructor(canvas, side, seed, send) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.side = side;
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.send = send;
    this.turn = 0;
    this.phase = 'aim';
    this.drag = null;
    this.bird = null;
    this.toast = null;
    this.toastUntil = 0;
    this.flyFrames = 0;
    this.settledFrames = 0;
    this.lastT = performance.now();
    this.cpu = null;
    this.pigId = 0;
    this.blockId = 0;
    this.pigs = [];
    this.blocks = [];
    this.tnts = [];
    this.pigsAlive = [0, 0];
    this.particles = [];
    this.trail = [];
    this.pendingHits = new Map();
    this.shake = 0;
    this.clouds = [];
    this.hills = [];
    this.stars = [];
    this.decor = [];

    this.engine = M.Engine.create();
    this.engine.gravity.scale = 0.0036;
    this.engine.gravity.y = GRAVITY_Y;
    this.engine.enableSleeping = false;
    this.world = this.engine.world;

    this.generateBackdrop();
    this.setupCollisions();
    this.buildWorld();
  }

  generateBackdrop() {
    const r = mulberry32(this.seed ^ 0x51f15e);
    for (let i = 0; i < 7; i++) {
      this.clouds.push({ x: r() * WORLD_W, y: 70 + r() * 210, w: 110 + r() * 120, drift: r() * 0.08 + 0.02 });
    }
    for (let i = 0; i < 5; i++) {
      this.hills.push({
        x: i * 340 - 50 + r() * 80,
        y: GROUND_Y - 80 - r() * 140,
        w: 330 + r() * 180,
        h: 140 + r() * 120,
        color: i % 2 ? '#84b94d' : '#6e9f43',
      });
    }
    for (let i = 0; i < 18; i++) {
      this.stars.push({ x: r() * WORLD_W, y: 40 + r() * 180, size: 1 + r() * 3 });
    }
    for (let i = 0; i < 12; i++) {
      this.decor.push({ x: 120 + i * 125 + r() * 30, y: GROUND_Y, size: 18 + r() * 20, flip: r() > 0.5 ? 1 : -1 });
    }
  }

  setupCollisions() {
    M.Events.on(this.engine, 'collisionStart', (event) => {
      for (const pair of event.pairs) this.onHit(pair.bodyA, pair.bodyB);
    });
  }

  addBody(body, bucket) {
    bucket.push(body);
    M.World.add(this.world, body);
    return body;
  }

  makeBlock(x, y, w, h, material, angle = 0) {
    const specs = {
      wood: { density: 0.0010, hp: 22, color: '#c98b45', stroke: '#7a4b18', dust: '#f1c179', restitution: 0.12 },
      glass: { density: 0.00065, hp: 11, color: '#b8f7ff', stroke: '#6bc9da', dust: '#d6fcff', restitution: 0.04 },
      stone: { density: 0.00175, hp: 40, color: '#b6bec8', stroke: '#6b7380', dust: '#d4dae2', restitution: 0.06 },
    };
    const spec = specs[material];
    const body = M.Bodies.rectangle(x, y, w, h, {
      angle,
      density: spec.density,
      friction: 0.45,
      frictionStatic: 0.8,
      restitution: spec.restitution,
      label: 'block',
    });
    body.material = material;
    body.blockId = this.blockId++;
    body.maxHp = spec.hp;
    body.hp = spec.hp;
    body.color = spec.color;
    body.stroke = spec.stroke;
    body.dust = spec.dust;
    body._w = w;
    body._h = h;
    return this.addBody(body, this.blocks);
  }

  makePig(ownerSide, x, y) {
    const pig = M.Bodies.circle(x, y, 22, {
      density: 0.0014,
      friction: 0.45,
      restitution: 0.22,
      label: 'pig',
    });
    pig.ownerSide = ownerSide;
    pig.pigId = this.pigId++;
    pig.maxHp = 14;
    pig.hp = 14;
    pig.dead = false;
    this.pigsAlive[ownerSide]++;
    return this.addBody(pig, this.pigs);
  }

  makeTnt(ownerSide, x, y) {
    const tnt = M.Bodies.rectangle(x, y, 52, 52, {
      density: 0.0012,
      friction: 0.6,
      restitution: 0.08,
      label: 'tnt',
    });
    tnt.ownerSide = ownerSide;
    tnt.tntId = `t${ownerSide}-${x}-${y}`;
    tnt.hp = 7;
    tnt.armed = true;
    tnt._w = 52;
    tnt._h = 52;
    return this.addBody(tnt, this.tnts);
  }

  buildWorld() {
    const ground = M.Bodies.rectangle(WORLD_W / 2, GROUND_Y + 85, WORLD_W * 2, 170, {
      isStatic: true,
      label: 'ground',
      friction: 0.9,
    });
    const leftWall = M.Bodies.rectangle(-70, WORLD_H / 2, 120, WORLD_H * 2.5, { isStatic: true, label: 'wall' });
    const rightWall = M.Bodies.rectangle(WORLD_W + 70, WORLD_H / 2, 120, WORLD_H * 2.5, { isStatic: true, label: 'wall' });
    const ceiling = M.Bodies.rectangle(WORLD_W / 2, -100, WORLD_W * 2, 150, { isStatic: true, label: 'wall' });
    M.World.add(this.world, [ground, leftWall, rightWall, ceiling]);

    const buildFort = (ownerSide, centerX, mirror) => {
      const dir = mirror ? -1 : 1;
      const base = GROUND_Y;

      this.makeBlock(centerX - dir * 66, base - 44, 26, 88, 'wood');
      this.makeBlock(centerX + dir * 66, base - 44, 26, 88, 'wood');
      this.makeBlock(centerX, base - 94, 180, 24, 'stone');

      this.makeBlock(centerX - dir * 54, base - 156, 26, 84, 'glass');
      this.makeBlock(centerX + dir * 54, base - 156, 26, 84, 'glass');
      this.makeBlock(centerX, base - 205, 150, 20, 'wood');

      this.makeBlock(centerX, base - 272, 24, 108, 'wood');
      this.makeBlock(centerX - dir * 62, base - 248, 110, 18, 'glass', dir * -0.14);
      this.makeBlock(centerX + dir * 62, base - 248, 110, 18, 'glass', dir * 0.14);
      this.makeBlock(centerX, base - 335, 134, 20, 'stone');

      this.makePig(ownerSide, centerX - dir * 8, base - 34);
      this.makePig(ownerSide, centerX + dir * 6, base - 152);
      this.makePig(ownerSide, centerX, base - 365);

      this.makeTnt(ownerSide, centerX + dir * 128, base - 26);
      this.makeBlock(centerX + dir * 128, base - 72, 70, 18, 'glass');
      this.makePig(ownerSide, centerX + dir * 128, base - 102);
    };

    buildFort(0, 310, false);
    buildFort(1, WORLD_W - 310, true);
  }

  myTurn() {
    return this.turn === this.side && this.phase === 'aim';
  }

  slingshotPos(side) {
    return side === 0 ? SLING_A : SLING_B;
  }

  setToast(text, ms = 2200) {
    this.toast = text;
    this.toastUntil = performance.now() + ms;
  }

  shakeScreen(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  burst(x, y, color, count, speedMin, speedMax, size = 5, gravity = 0.2) {
    for (let i = 0; i < count; i++) {
      const angle = this.rng() * Math.PI * 2;
      const speed = speedMin + this.rng() * (speedMax - speedMin);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - this.rng() * 2,
        life: 22 + this.rng() * 18,
        size: size * (0.6 + this.rng() * 0.8),
        color,
        gravity,
      });
    }
  }

  sparkArc(x, y, color, dir) {
    for (let i = 0; i < 10; i++) {
      const angle = dir + (this.rng() - 0.5) * 1.2;
      const speed = 3 + this.rng() * 6;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 10 + this.rng() * 10,
        size: 4 + this.rng() * 3,
        color,
        gravity: 0.08,
      });
    }
  }

  onPointerDown(wx, wy) {
    if (!this.myTurn()) return;
    audio.unlock();
    this.drag = { x: wx, y: wy, pulled: false };
  }

  onPointerMove(wx, wy) {
    if (!this.drag || !this.myTurn()) return;
    const s = this.slingshotPos(this.side);
    let dx = wx - s.x;
    let dy = wy - s.y;
    const d = Math.hypot(dx, dy);
    if (d > MAX_PULL) {
      dx *= MAX_PULL / d;
      dy *= MAX_PULL / d;
    }
    this.drag.x = s.x + dx;
    this.drag.y = s.y + dy;
    if (d > 10) this.drag.pulled = true;
  }

  onPointerUp() {
    if (!this.drag) return;
    if (this.myTurn() && this.drag.pulled) {
      const s = this.slingshotPos(this.side);
      const pullX = s.x - this.drag.x;
      const pullY = s.y - this.drag.y;
      const pull = Math.hypot(pullX, pullY);
      if (pull > 25) {
        const angle = Math.atan2(pullY, pullX);
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
    const bird = M.Bodies.circle(s.x, s.y - 12, 24, {
      density: 0.028,
      friction: 0.45,
      frictionAir: 0.00045,
      restitution: 0.18,
      label: 'bird',
    });
    bird.ownerSide = side;
    bird.maxHp = 999;
    M.Body.setVelocity(bird, { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed });
    M.World.add(this.world, bird);
    this.bird = bird;
    this.phase = 'flying';
    this.flyFrames = 0;
    this.settledFrames = 0;
    this.trail = [];
    this.shakeScreen(7 + power * 8);
    this.burst(s.x, s.y - 10, side === 0 ? '#ff6b6b' : '#52d6ff', 14, 2, 7, 5, 0.12);
    audio.launch(power);
  }

  accumulateHit(body, dmg) {
    if (!body || dmg <= 0) return;
    const prev = this.pendingHits.get(body) || 0;
    this.pendingHits.set(body, prev + dmg);
  }

  handleImpactFx(x, y, speed, color) {
    if (speed < 2.5) return;
    this.burst(x, y, color, 8 + Math.min(18, speed * 1.2), 1, 4 + speed * 0.35, 4, 0.2);
    this.shakeScreen(Math.min(14, speed * 0.35));
    audio.impact(speed);
  }

  onHit(a, b) {
    const aSpeed = Math.hypot(a.velocity.x, a.velocity.y);
    const bSpeed = Math.hypot(b.velocity.x, b.velocity.y);
    const speed = Math.max(aSpeed, bSpeed);
    const contactX = (a.position.x + b.position.x) * 0.5;
    const contactY = (a.position.y + b.position.y) * 0.5;

    const tags = [a.label, b.label];
    if (tags.includes('bird')) {
      this.handleImpactFx(contactX, contactY, speed, '#ffe47a');
      const bird = a.label === 'bird' ? a : b;
      const other = bird === a ? b : a;
      const dir = Math.atan2(bird.velocity.y, bird.velocity.x);
      this.sparkArc(contactX, contactY, bird.ownerSide === 0 ? '#ff7b70' : '#87efff', dir);
      if (other.label === 'pig') this.accumulateHit(other, speed * 3.1 + 8);
      if (other.label === 'block') this.accumulateHit(other, speed * 2.1 + 4);
      if (other.label === 'tnt') this.accumulateHit(other, speed * 2.2 + 6);
    }

    if (tags.includes('pig')) {
      const pig = a.label === 'pig' ? a : b;
      const other = pig === a ? b : a;
      if (other.label === 'block' && speed > 2.5) this.accumulateHit(pig, speed * 1.1);
      if ((other.label === 'ground' || other.label === 'wall') && aSpeed + bSpeed > 6) this.accumulateHit(pig, speed * 1.3);
      if (other.label === 'pig' && speed > 5) this.accumulateHit(pig, speed * 0.6);
    }

    if (tags.includes('block')) {
      const block = a.label === 'block' ? a : b;
      const other = block === a ? b : a;
      if (other.label === 'ground' && speed > 5) this.accumulateHit(block, speed * 0.75);
      if (other.label === 'block' && speed > 5) this.accumulateHit(block, speed * 0.45);
      if (other.label === 'pig' && speed > 4) this.accumulateHit(block, speed * 0.2);
    }

    if (tags.includes('tnt')) {
      const tnt = a.label === 'tnt' ? a : b;
      const other = tnt === a ? b : a;
      if (!tnt.armed) return;
      if (other.label === 'bird') this.accumulateHit(tnt, speed * 3 + 8);
      if ((other.label === 'block' || other.label === 'ground' || other.label === 'pig') && speed > 4.5) {
        this.accumulateHit(tnt, speed * 0.95);
      }
    }
  }

  processPendingHits() {
    if (this.pendingHits.size === 0) return;
    for (const [body, damage] of this.pendingHits.entries()) {
      if (body.label === 'pig') this.damagePig(body, damage);
      if (body.label === 'block') this.damageBlock(body, damage);
      if (body.label === 'tnt') this.damageTnt(body, damage);
    }
    this.pendingHits.clear();
  }

  damagePig(pig, damage) {
    if (!pig || pig.dead) return;
    pig.hp -= damage;
    this.burst(pig.position.x, pig.position.y, '#8de55c', 3 + Math.min(8, damage * 0.5), 0.5, 2.5, 4, 0.14);
    if (pig.hp <= 0) this.killPig(pig);
  }

  damageBlock(block, damage) {
    if (!block || !this.blocks.includes(block)) return;
    block.hp -= damage;
    if (damage > 2.5) this.burst(block.position.x, block.position.y, block.dust, 2 + Math.min(8, damage * 0.3), 0.4, 2.8, 3, 0.16);
    if (block.hp <= 0) this.breakBlock(block);
  }

  breakBlock(block) {
    if (!block || !this.blocks.includes(block)) return;
    this.blocks = this.blocks.filter((b) => b !== block);
    M.World.remove(this.world, block);
    this.burst(block.position.x, block.position.y, block.dust, 18, 1.5, 6.5, 6, 0.18);
    this.shakeScreen(block.material === 'stone' ? 7 : 5);
    if (block.material === 'glass') audio.impact(12);
  }

  damageTnt(tnt, damage) {
    if (!tnt || !tnt.armed || !this.tnts.includes(tnt)) return;
    tnt.hp -= damage;
    this.burst(tnt.position.x, tnt.position.y, '#ffb04d', 3 + Math.min(8, damage * 0.4), 0.5, 2.5, 3, 0.08);
    if (tnt.hp <= 0) this.explodeTnt(tnt);
  }

  explodeTnt(tnt) {
    if (!tnt || !tnt.armed || !this.tnts.includes(tnt)) return;
    tnt.armed = false;
    this.tnts = this.tnts.filter((x) => x !== tnt);
    M.World.remove(this.world, tnt);

    const { x, y } = tnt.position;
    this.burst(x, y, '#ffcf5b', 38, 2.5, 10, 9, 0.14);
    this.burst(x, y, '#ff7048', 28, 1.5, 7, 12, 0.08);
    this.shakeScreen(24);
    audio.explode();

    const bodies = [this.bird, ...this.blocks, ...this.pigs.filter((p) => !p.dead), ...this.tnts].filter(Boolean);
    for (const body of bodies) {
      const dx = body.position.x - x;
      const dy = body.position.y - y;
      const d = Math.max(18, Math.hypot(dx, dy));
      if (d > 220) continue;
      const force = (220 - d) / 220;
      const nx = dx / d;
      const ny = dy / d;
      M.Body.applyForce(body, body.position, { x: nx * force * 0.12, y: ny * force * 0.12 - 0.008 * force });
      if (body.label === 'pig') this.accumulateHit(body, 10 + force * 14);
      if (body.label === 'block') this.accumulateHit(body, 12 + force * 20);
      if (body.label === 'tnt') this.accumulateHit(body, 999);
    }
  }

  killPig(pig) {
    if (!pig || pig.dead) return;
    pig.dead = true;
    this.pigsAlive[pig.ownerSide] = Math.max(0, this.pigsAlive[pig.ownerSide] - 1);
    M.World.remove(this.world, pig);
    this.burst(pig.position.x, pig.position.y, '#93e357', 24, 1.5, 7, 7, 0.18);
    this.burst(pig.position.x, pig.position.y, '#ffffff', 8, 1, 4.5, 4, 0.08);
    this.shakeScreen(10);
    audio.splat();
  }

  step() {
    M.Engine.update(this.engine, 1000 / 60);
    this.processPendingHits();

    if (this.bird) {
      this.trail.push({
        x: this.bird.position.x,
        y: this.bird.position.y,
        life: 14,
        side: this.bird.ownerSide,
      });
      if (this.trail.length > 18) this.trail.shift();
    }

    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.986;
      p.vy = p.vy * 0.986 + (p.gravity || 0.16);
      p.life -= 1;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const t of this.trail) t.life -= 1;
    this.trail = this.trail.filter((t) => t.life > 0);
    this.shake *= 0.84;

    if (this.phase === 'flying') {
      this.flyFrames++;
      if (this.bird) {
        const p = this.bird.position;
        if (p.y > WORLD_H + 350 || p.x < -350 || p.x > WORLD_W + 350) {
          this.endShot();
          return;
        }
      }

      let calm = true;
      const all = [this.bird, ...this.pigs.filter((p) => !p.dead), ...this.blocks, ...this.tnts];
      for (const body of all) {
        if (!body) continue;
        if (Math.hypot(body.velocity.x, body.velocity.y) > 0.8) {
          calm = false;
          break;
        }
      }
      this.settledFrames = calm ? this.settledFrames + 1 : 0;
      if (this.settledFrames > 32 && this.flyFrames > 42) this.endShot();
      if (this.flyFrames > SHOT_TIMEOUT_FRAMES) this.endShot();
    }
  }

  endShot() {
    if (this.bird) {
      M.World.remove(this.world, this.bird);
      this.bird = null;
    }
    this.trail = [];
    const firerSide = this.turn;
    if (firerSide === this.side) {
      const deadIds = this.pigs.filter((p) => p.dead).map((p) => p.pigId);
      this.send({ type: 'endShot', deadIds, pigsAlive: this.pigsAlive.slice() });
    }
    this.advanceTurn();
  }

  advanceTurn() {
    if (this.pigsAlive[0] === 0 || this.pigsAlive[1] === 0) {
      this.phase = 'over';
      const winner = this.pigsAlive[0] > 0 ? 0 : 1;
      this.setToast(winner === this.side ? 'YOU WIN' : (this.cpu?.active ? 'CPU WINS' : 'SISTER WINS'), 999999);
      return;
    }
    this.turn = 1 - this.turn;
    this.phase = 'aim';
    this.setToast(this.myTurn() ? 'YOUR TURN' : (this.cpu?.active ? "CPU'S TURN" : "SISTER'S TURN"), 1300);
  }

  receive(msg) {
    if (msg.type === 'fire') {
      this.launchBird(msg.side, msg.power, msg.angle);
    } else if (msg.type === 'endShot') {
      for (const id of msg.deadIds || []) {
        const pig = this.pigs.find((p) => p.pigId === id);
        if (pig && !pig.dead) this.killPig(pig);
      }
      this.pigsAlive = msg.pigsAlive.slice();
    }
  }

  draw() {
    const ctx = this.ctx;
    const { width: cw, height: ch } = this.canvas;
    ctx.save();
    if (this.shake > 0.2) {
      ctx.translate((this.rng() - 0.5) * this.shake * 1.8, (this.rng() - 0.5) * this.shake * 1.8);
    }

    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#6bc7ff');
    sky.addColorStop(0.48, '#9ee7ff');
    sky.addColorStop(0.7, '#ffd77d');
    sky.addColorStop(1, '#ff9966');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);

    this.drawBackdrop();

    ctx.fillStyle = '#90cf4f';
    ctx.fillRect(0, this.w2cy(GROUND_Y), cw, ch);
    const turf = ctx.createLinearGradient(0, this.w2cy(GROUND_Y), 0, ch);
    turf.addColorStop(0, '#79bf46');
    turf.addColorStop(1, '#5f9b2e');
    ctx.fillStyle = turf;
    ctx.fillRect(0, this.w2cy(GROUND_Y), cw, this.s(38));

    this.drawSlingshot(SLING_A, 0);
    this.drawSlingshot(SLING_B, 1);

    for (const t of this.trail) this.drawTrailDot(t);
    for (const b of this.blocks) this.drawBlock(b);
    for (const t of this.tnts) this.drawTnt(t);
    for (const p of this.pigs) if (!p.dead) this.drawPig(p);
    if (this.bird) this.drawBirdAt(this.bird.position.x, this.bird.position.y, this.bird.ownerSide ?? this.turn, this.bird.angle);

    if (this.myTurn() && this.drag?.pulled) {
      this.drawSlingshotPull();
      this.drawTrajectoryPreview();
    } else if (this.myTurn()) {
      this.drawTurnPulse();
    }

    for (const p of this.particles) this.drawParticle(p);
    ctx.restore();
  }

  drawBackdrop() {
    const ctx = this.ctx;
    const time = performance.now() * 0.00003;

    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (const star of this.stars) {
      const alpha = 0.3 + 0.2 * Math.sin(time * 30 + star.x);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.beginPath();
      ctx.arc(this.w2cx(star.x), this.w2cy(star.y), this.s(star.size), 0, Math.PI * 2);
      ctx.fill();
    }

    for (const hill of this.hills) {
      ctx.fillStyle = hill.color;
      ctx.beginPath();
      ctx.ellipse(this.w2cx(hill.x), this.w2cy(hill.y), this.s(hill.w), this.s(hill.h), 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const c of this.clouds) {
      const drift = ((performance.now() * c.drift * 0.02) % (WORLD_W + c.w * 2)) - c.w;
      const x = ((c.x + drift) % (WORLD_W + c.w * 2)) - c.w;
      const y = c.y + Math.sin(time * 160 + c.x) * 6;
      const cx = this.w2cx(x);
      const cy = this.w2cy(y);
      const s = this.s(c.w * 0.24);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(cx, cy, s, 0, Math.PI * 2);
      ctx.arc(cx + s * 0.9, cy - s * 0.3, s * 0.9, 0, Math.PI * 2);
      ctx.arc(cx + s * 1.7, cy, s * 1.05, 0, Math.PI * 2);
      ctx.arc(cx - s * 0.7, cy + s * 0.1, s * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const d of this.decor) {
      const x = this.w2cx(d.x);
      const y = this.w2cy(d.y);
      const size = this.s(d.size);
      ctx.fillStyle = '#4d8e2a';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - size * 0.35 * d.flip, y - size * 0.9);
      ctx.lineTo(x + size * 0.12 * d.flip, y - size * 0.5);
      ctx.lineTo(x + size * 0.4 * d.flip, y - size * 1.1);
      ctx.lineTo(x + size * 0.15 * d.flip, y);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawSlingshot(s, side) {
    const ctx = this.ctx;
    const cx = this.w2cx(s.x);
    const top = this.w2cy(s.y);
    const base = this.w2cy(GROUND_Y);
    const fork = this.s(40);

    ctx.strokeStyle = '#6f3411';
    ctx.lineCap = 'round';
    ctx.lineWidth = this.s(16);
    ctx.beginPath();
    ctx.moveTo(cx, base);
    ctx.lineTo(cx, top + this.s(14));
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, top + this.s(14));
    ctx.lineTo(cx - fork, top - this.s(6));
    ctx.moveTo(cx, top + this.s(14));
    ctx.lineTo(cx + fork, top - this.s(6));
    ctx.stroke();

    if (!this.bird && this.turn === side && this.phase === 'aim' && !(this.myTurn() && this.drag?.pulled)) {
      this.drawBirdAt(s.x, s.y - 12, side, 0);
    }
  }

  drawSlingshotPull() {
    const ctx = this.ctx;
    const s = this.slingshotPos(this.side);
    const cx0 = this.w2cx(s.x);
    const cy0 = this.w2cy(s.y);
    const cxd = this.w2cx(this.drag.x);
    const cyd = this.w2cy(this.drag.y);

    ctx.strokeStyle = '#2f1609';
    ctx.lineWidth = this.s(8);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx0 - this.s(40), cy0 - this.s(4));
    ctx.lineTo(cxd, cyd);
    ctx.lineTo(cx0 + this.s(40), cy0 - this.s(4));
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
    let vx = (pullX / pull) * (LAUNCH_SCALE * power);
    let vy = (pullY / pull) * (LAUNCH_SCALE * power);
    let x = s.x;
    let y = s.y - 12;

    for (let i = 0; i < 130; i++) {
      vy += GRAVITY_Y;
      x += vx;
      y += vy;
      if (y > GROUND_Y || x < -80 || x > WORLD_W + 80) break;
      if (i % 4 === 0) {
        const alpha = 0.9 - i / 150;
        ctx.fillStyle = `rgba(255, 249, 163, ${alpha})`;
        ctx.beginPath();
        ctx.arc(this.w2cx(x), this.w2cy(y), this.s(6.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawTurnPulse() {
    const ctx = this.ctx;
    const s = this.slingshotPos(this.side);
    const cx = this.w2cx(s.x);
    const cy = this.w2cy(s.y - 12);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 240);
    ctx.strokeStyle = `rgba(255, 251, 120, ${0.45 + pulse * 0.35})`;
    ctx.lineWidth = this.s(4);
    ctx.beginPath();
    ctx.arc(cx, cy, this.s(32 + pulse * 14), 0, Math.PI * 2);
    ctx.stroke();
  }

  drawBlock(b) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.w2cx(b.position.x), this.w2cy(b.position.y));
    ctx.rotate(b.angle);
    const w = this.s(b._w);
    const h = this.s(b._h);

    ctx.fillStyle = b.color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = b.stroke;
    ctx.lineWidth = this.s(2.6);
    ctx.strokeRect(-w / 2, -h / 2, w, h);

    if (b.material === 'wood') {
      ctx.strokeStyle = 'rgba(111, 58, 16, 0.35)';
      ctx.lineWidth = this.s(1.2);
      ctx.beginPath();
      ctx.moveTo(-w / 2 + this.s(4), -h / 4);
      ctx.lineTo(w / 2 - this.s(4), -h / 4);
      ctx.moveTo(-w / 2 + this.s(4), h / 4);
      ctx.lineTo(w / 2 - this.s(4), h / 4);
      ctx.stroke();
    } else if (b.material === 'glass') {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = this.s(1.2);
      ctx.beginPath();
      ctx.moveTo(-w / 2 + this.s(5), -h / 2 + this.s(5));
      ctx.lineTo(w / 2 - this.s(5), h / 2 - this.s(5));
      ctx.moveTo(w / 2 - this.s(5), -h / 2 + this.s(5));
      ctx.lineTo(-w / 2 + this.s(5), h / 2 - this.s(5));
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(-w / 2 + this.s(2), -h / 2 + this.s(2), w * 0.35, h * 0.22);
    }

    if (b.hp < b.maxHp) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-w / 2, -h / 2 - this.s(8), w, this.s(4));
      ctx.fillStyle = '#ffdb6b';
      ctx.fillRect(-w / 2, -h / 2 - this.s(8), w * Math.max(0, b.hp / b.maxHp), this.s(4));
    }
    ctx.restore();
  }

  drawTnt(tnt) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.w2cx(tnt.position.x), this.w2cy(tnt.position.y));
    ctx.rotate(tnt.angle);
    const w = this.s(tnt._w);
    const h = this.s(tnt._h);
    ctx.fillStyle = '#d54637';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#7e1f18';
    ctx.lineWidth = this.s(2.6);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = '#fff3ca';
    ctx.font = `700 ${this.s(18)}px "Avenir Next Condensed", "Trebuchet MS", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TNT', 0, 0);
    const fuse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
    ctx.strokeStyle = '#2d1f10';
    ctx.lineWidth = this.s(3);
    ctx.beginPath();
    ctx.moveTo(0, -h / 2);
    ctx.quadraticCurveTo(this.s(6), -h / 2 - this.s(18), this.s(18), -h / 2 - this.s(10));
    ctx.stroke();
    ctx.fillStyle = `rgba(255, 225, 90, ${0.65 + fuse * 0.35})`;
    ctx.beginPath();
    ctx.arc(this.s(20), -h / 2 - this.s(10), this.s(5 + fuse * 3), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawPig(p) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.w2cx(p.position.x), this.w2cy(p.position.y));
    ctx.rotate(p.angle);
    const r = this.s(p.circleRadius || 22);

    ctx.fillStyle = '#8ad84b';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#467c22';
    ctx.lineWidth = this.s(2);
    ctx.stroke();

    ctx.fillStyle = '#7cc640';
    ctx.beginPath();
    ctx.arc(-r * 0.35, -r * 0.8, r * 0.22, 0, Math.PI * 2);
    ctx.arc(r * 0.35, -r * 0.8, r * 0.22, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(-r * 0.3, -r * 0.2, r * 0.26, 0, Math.PI * 2);
    ctx.arc(r * 0.3, -r * 0.2, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1d1d1d';
    ctx.beginPath();
    ctx.arc(-r * 0.28, -r * 0.18, r * 0.1, 0, Math.PI * 2);
    ctx.arc(r * 0.28, -r * 0.18, r * 0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#5d912c';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.22, r * 0.45, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2f5d15';
    ctx.beginPath();
    ctx.arc(-r * 0.13, r * 0.22, r * 0.06, 0, Math.PI * 2);
    ctx.arc(r * 0.13, r * 0.22, r * 0.06, 0, Math.PI * 2);
    ctx.fill();

    if (p.hp < p.maxHp) {
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(-r, -r - this.s(10), r * 2, this.s(4));
      ctx.fillStyle = '#ff6379';
      ctx.fillRect(-r, -r - this.s(10), r * 2 * Math.max(0, p.hp / p.maxHp), this.s(4));
    }
    ctx.restore();
  }

  drawBirdAt(wx, wy, side, rot = 0) {
    const ctx = this.ctx;
    const r = this.s(21);
    ctx.save();
    ctx.translate(this.w2cx(wx), this.w2cy(wy));
    ctx.rotate(rot);
    const body = side === 0 ? '#ff6c61' : '#59d9ff';
    const shadow = side === 0 ? '#912f2d' : '#20789b';

    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shadow;
    ctx.lineWidth = this.s(2);
    ctx.stroke();

    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(r * 0.2, -r * 0.18, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1d1d1d';
    ctx.beginPath();
    ctx.arc(r * 0.28, -r * 0.18, r * 0.11, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#2a1820';
    ctx.lineWidth = this.s(3);
    ctx.beginPath();
    ctx.moveTo(-r * 0.15, -r * 0.58);
    ctx.lineTo(r * 0.05, -r * 0.94);
    ctx.lineTo(r * 0.35, -r * 0.62);
    ctx.stroke();

    ctx.fillStyle = '#ffbf3d';
    ctx.beginPath();
    ctx.moveTo(r * 0.62, -r * 0.06);
    ctx.lineTo(r * 1.28, 0);
    ctx.lineTo(r * 0.62, r * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawTrailDot(t) {
    const ctx = this.ctx;
    const alpha = t.life / 14;
    const color = t.side === 0 ? '255,108,97' : '89,217,255';
    ctx.fillStyle = `rgba(${color}, ${alpha * 0.35})`;
    ctx.beginPath();
    ctx.arc(this.w2cx(t.x), this.w2cy(t.y), this.s((15 - t.life) * 0.65 + 5), 0, Math.PI * 2);
    ctx.fill();
  }

  drawParticle(p) {
    const ctx = this.ctx;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = Math.min(1, p.life / 18);
    ctx.beginPath();
    ctx.arc(this.w2cx(p.x), this.w2cy(p.y), this.s(p.size), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  w2cx(x) {
    return x * (this.canvas.width / WORLD_W);
  }

  w2cy(y) {
    return y * (this.canvas.height / WORLD_H);
  }

  s(v) {
    return v * (this.canvas.width / WORLD_W);
  }
}

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
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

window.addEventListener('resize', fitCanvas);
fitCanvas();

document.getElementById('host-btn').addEventListener('click', startHost);
document.getElementById('join-btn').addEventListener('click', () => show(joinForm));
document.getElementById('cpu-btn').addEventListener('click', startVsCpu);
document.getElementById('host-back').addEventListener('click', () => { teardownPeer(); show(lobby); });
document.getElementById('join-back').addEventListener('click', () => show(lobby));
document.getElementById('join-go').addEventListener('click', startJoin);

function show(el) {
  for (const overlay of [lobby, hostWait, joinForm]) overlay.classList.add('hidden');
  if (el) el.classList.remove('hidden');
}

function teardownPeer() {
  try { conn?.close(); } catch {}
  try { peer?.destroy(); } catch {}
  peer = null;
  conn = null;
}

function startHost() {
  const code = randomCode();
  document.getElementById('room-code').textContent = code;
  document.getElementById('host-status').textContent = 'Waiting for chaos partner...';
  show(hostWait);

  peer = new Peer(PEER_PREFIX + code, { debug: 1 });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      teardownPeer();
      startHost();
      return;
    }
    document.getElementById('host-status').textContent = `Network error: ${err.type}`;
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

  document.getElementById('join-status').textContent = 'Connecting...';
  peer = new Peer(undefined, { debug: 1 });
  peer.on('open', () => {
    conn = peer.connect(PEER_PREFIX + codeRaw, { reliable: true });
    wireConn();
    conn.on('open', () => {
      document.getElementById('join-status').textContent = 'Connected. Waiting for launch...';
    });
  });
  peer.on('error', (err) => {
    document.getElementById('join-status').textContent = `Could not connect: ${err.type}`;
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
  document.querySelector('#hp-p1 .name').textContent = 'PINK BLOB';
  document.querySelector('#hp-p2 .name').textContent = 'BLUE BLOB';
  game = new Game(canvas, side, seed, (payload) => conn?.send(payload));
  game.setToast(game.myTurn() ? 'YOUR TURN' : "SISTER'S TURN", 1500);
  requestAnimationFrame(loop);
}

function startVsCpu() {
  show(null);
  hud.classList.remove('hidden');
  document.querySelector('#hp-p1 .name').textContent = 'PINK BLOB';
  document.querySelector('#hp-p2 .name').textContent = 'CHAOS BOT';
  const seed = (Math.random() * 0x7fffffff) | 0;
  game = new Game(canvas, 0, seed, () => {});
  game.cpu = { active: true, planned: null };
  game.setToast('YOUR TURN', 1400);
  requestAnimationFrame(loop);
}

function cpuMaybeAct(g) {
  if (!g?.cpu?.active || g.turn !== 1 || g.phase !== 'aim') {
    if (g?.cpu) g.cpu.planned = null;
    return;
  }

  if (!g.cpu.planned) {
    const me = g.slingshotPos(1);
    const targets = g.pigs.filter((p) => !p.dead && p.ownerSide === 0);
    if (targets.length === 0) return;
    targets.sort((a, b) => dist(a.position.x, a.position.y, me.x, me.y) - dist(b.position.x, b.position.y, me.x, me.y));
    const target = targets[Math.floor(Math.random() * Math.min(3, targets.length))];
    const T = 48 + Math.random() * 16;
    const dx = target.position.x - me.x;
    const dy = target.position.y - (me.y - 12);
    const vx = dx / T;
    const vy = (dy - 0.5 * GRAVITY_Y * T * T) / T;
    const speed = Math.hypot(vx, vy);
    const power = clamp(speed / LAUNCH_SCALE, 0.38, 1);
    let angle = Math.atan2(vy, vx);
    angle += (Math.random() - 0.5) * 0.22;
    g.cpu.planned = { angle, power, atMs: performance.now() + 900 + Math.random() * 600 };
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
  if (!game) return;
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
  const otherLabel = game.cpu?.active ? "CHAOS BOT'S SHOT" : "SISTER'S SHOT";
  if (game.phase === 'over') banner.textContent = 'BATTLE OVER';
  else if (game.myTurn()) banner.textContent = 'FLING';
  else if (game.phase === 'flying') banner.textContent = 'INCOMING';
  else banner.textContent = otherLabel;

  if (game.drag?.pulled && game.myTurn()) {
    const s = game.slingshotPos(game.side);
    const pull = Math.hypot(s.x - game.drag.x, s.y - game.drag.y);
    banner.textContent = `POWER ${Math.round((pull / MAX_PULL) * 100)}%`;
  }

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

function getWorldPos(ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (WORLD_W / rect.width),
    y: (ev.clientY - rect.top) * (WORLD_H / rect.height),
  };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!game) return;
  ev.preventDefault();
  audio.unlock();
  canvas.setPointerCapture(ev.pointerId);
  const { x, y } = getWorldPos(ev);
  game.onPointerDown(x, y);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!game) return;
  const { x, y } = getWorldPos(ev);
  game.onPointerMove(x, y);
});

canvas.addEventListener('pointerup', () => {
  if (game) game.onPointerUp();
});

canvas.addEventListener('pointercancel', () => {
  if (game) game.onPointerUp();
});

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
