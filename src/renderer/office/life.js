import { Navigation } from './navigation.js';
import { createAppearance } from './appearance.js';
import { DRINKS } from './drinks.js';

export const COFFEE_MENU = DRINKS;

const ACTIONS = {
  drink: { pose: 'drink', ms: 6500, text: '🥤 한 모금, 충전 완료!' },
  laptop: { pose: 'type', ms: 12000, text: '⌨ 내 노트북에서 작업 중' },
  sit: { pose: 'sit', ms: 10000, text: '☕ 여기서 잠깐 쉬어요' },
  collaborate: { pose: 'talk', ms: 8000, text: '💡 함께 아이디어 정리 중' },
  visit: { pose: 'stand', ms: 4000, text: '🚪 문을 열고 방에 들어왔어요' },
  elevator: { pose: 'stand', ms: 3000, text: '엘리베이터 문이 열렸어요' },
  brew: { pose: 'brew', ms: 2400, text: '☕ 커피가 내려오는 중…' },
  arcade: { pose: 'play', ms: 8000, text: '🎮 잠깐의 픽셀 게임!' },
  water: { pose: 'water', ms: 5500, text: '🌱 초록 친구에게 물 주는 중' },
  read: { pose: 'read', ms: 7500, text: '📖 책장을 넘기며 쉬어요' },
  stretch: { pose: 'stretch', ms: 6000, text: '🙌 쭉쭉, 어깨를 풀어요' },
};

// Local life is separate from Claude sessions and is never counted as executing agents.
export class OfficeLife {
  constructor(layout, engine, random = Math.random) {
    this.layout = layout; this.engine = engine; this.random = random;
    this.navigation = new Navigation(layout); this.time = 0; this.destination = null;
    this.menu = null; this.effects = []; this.bestScore = 0;
    this.doors = layout.interactions.filter(i => i.door).map(i => ({ id: i.id, amount: 0, heldUntil: 0 }));
    this.player = this.makeActor('player', '나', layout.playerStart, true, 5);
    this.residents = [
      this.makeActor('resident-mocha', '모카', { x: 1850, y: 842 }, false, 4),
      this.makeActor('resident-loop', '루프', { x: 1330, y: 922 }, false, 1),
      this.makeActor('resident-coco', '코코', { x: 1680, y: 1080 }, false, 2),
    ];
    this.residents.forEach((a, i) => { a.nextAt = 1800 + i * 2600; });
  }

  makeActor(id, label, p, isPlayer, colorIndex) {
    return { id, label, x: p.x, y: p.y, isPlayer, isAmbient: !isPlayer, isLead: false, colorIndex,
      appearance: createAppearance(this.random), heldItem: null,
      role: 'visitor', status: 'idle', pose: 'stand', facing: 'down', path: [], action: null,
      task: isPlayer ? '바닥을 클릭해 이동하세요' : '사무실 상주 캐릭터', until: 0, nextAt: 0, bubble: null };
  }

  moveTo(point, interaction = null, actor = this.player) {
    if (!this.navigation.isWalkable(point)) return false;
    if (actor.isAmbient && interaction?.id && this.isBusy(interaction.id, actor)) return false;
    const path = this.navigation.findPath(actor, point);
    if (!path.length) return false;
    actor.path = path; actor.action = null; actor.currentItem = null; actor.interaction = interaction; actor.until = 0;
    actor.selection = null;
    if (actor.isPlayer) this.menu = null;
    actor.status = 'walking'; actor.task = interaction ? `${interaction.label}로 이동 중` : '산책 중';
    actor.bubble = null;
    if (actor.isPlayer) this.destination = { ...point };
    return true;
  }

  interact(id) {
    const item = this.layout.interactions.find(p => p.id === id);
    const door = this.doors.find(d => d.id === id);
    if (door) door.heldUntil = this.time + 3000;
    if (item) for (const a of this.residents) {
      if (a.currentItem === id || a.interaction?.id === id) this.moveTo({ x: 1450, y: 850 }, null, a);
    }
    return !!item && this.moveTo(item.stand, item);
  }

  isBusy(id, except) {
    return [this.player, ...this.residents].some(a => a !== except && (a.currentItem === id || a.interaction?.id === id));
  }

  closeMenu() {
    if (!this.menu) return;
    this.menu = null; this.player.currentItem = null; this.player.task = '사무실을 둘러보세요';
  }

  chooseDrink(id) {
    const item = this.layout.interactions.find(i => i.id === this.menu?.itemId);
    const drink = COFFEE_MENU.find(d => d.id === id);
    if (!item || !drink || Math.hypot(this.player.x - item.stand.x, this.player.y - item.stand.y) > 40) return false;
    this.menu = null;
    this.player.interaction = { ...item, action: 'brew', selection: drink };
    return true;
  }

  update(dtMs) {
    const dt = Math.max(0, Math.min(dtMs, 250)); this.time += dt;
    this.effects = this.effects.filter(e => e.until > this.time);
    const activeSkills = [...this.engine.agents.values()].some(a => a.skill && a.status === 'working');
    for (const a of [this.player, ...this.residents]) {
      if (a.bubble && a.bubble.until <= this.time) a.bubble = null;
      if (a.heldItem && a.heldItem.until <= this.time) {
        a.heldItem = null;
        if (a.isPlayer && !a.path.length && !a.action) a.task = '사무실을 둘러보세요';
      }
      if (a.path.length) this.step(a, dt);
      else if (a.interaction) this.startAction(a);
      else if (a.action && this.time >= a.until) this.finishAction(a);
      if (!a.isPlayer && !a.path.length && !a.action && this.time >= a.nextAt) this.autonomous(a, activeSkills);
    }
    const actors = [this.player, ...this.residents, ...this.engine.agents.values()];
    for (const door of this.doors) {
      const item = this.layout.interactions.find(i => i.id === door.id);
      const centerY = item.y + (item.axis === 'y' ? item.d / 2 : 0);
      const near = actors.some(a => Math.hypot(a.x - item.x - item.w / 2, a.y - centerY) < 130);
      const open = near || door.heldUntil > this.time;
      door.amount = Math.max(0, Math.min(1, door.amount + (open ? 1 : -1) * dt / 320));
    }
  }

  step(a, dt) {
    let budget = dt * (a.isPlayer ? 240 : 170) / 1000;
    while (budget > 0 && a.path.length) {
      const p = a.path[0], dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0.01) a.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      if (d <= budget) { a.x = p.x; a.y = p.y; a.path.shift(); budget -= d; }
      else { a.x += dx / d * budget; a.y += dy / d * budget; budget = 0; }
    }
    if (!a.path.length) {
      a.facing = 'down'; a.status = 'idle'; a.pose = 'stand';
      if (a.isPlayer) this.destination = null;
    }
  }

  startAction(a) {
    const item = a.interaction;
    if (item.menu === 'coffee' && !item.selection && a.isPlayer) {
      a.interaction = null; a.currentItem = item.id;
      a.task = '마실 커피나 음료를 골라 주세요';
      this.menu = { itemId: item.id, title: item.label, choices: COFFEE_MENU };
      return;
    }
    const action = ACTIONS[item.menu === 'coffee' && !a.isPlayer ? 'brew' : item.action];
    a.interaction = null; a.action = item.action; a.pose = action.pose;
    if (item.menu === 'coffee' && !a.isPlayer) a.action = 'brew';
    a.selection = item.selection || (item.menu === 'coffee' ? COFFEE_MENU[Math.floor(this.random() * COFFEE_MENU.length)] : null);
    a.currentItem = item.id || null;
    if (item.seat) { a.x = item.seat.x; a.y = item.seat.y; }
    a.status = item.action === 'visit' ? 'idle' : ['laptop', 'collaborate'].includes(item.action) ? 'working' : 'resting';
    a.task = `${item.label} · ${action.text}`; a.until = this.time + action.ms;
    a.bubble = { text: action.text, kind: 'chat', until: this.time + 3500 };
    a.nextAt = a.until + 2000;
    if (a.action === 'drink') this.giveDrink(a, item.id === 'vending' ? DRINKS.find(d => d.id === 'soda') : COFFEE_MENU[0]);
    if (a.isPlayer) this.engine.pushFeed(`나: ${item.label} 이용 중`);
  }

  giveDrink(a, drink) { a.heldItem = { ...drink, until: this.time + 45000 }; }

  finishAction(a) {
    if (a.action === 'brew') {
      this.giveDrink(a, a.selection || COFFEE_MENU[0]);
      a.action = 'drink'; a.pose = 'drink'; a.until = this.time + 3500; a.currentItem = null;
      a.task = `☕ ${a.heldItem.label} · 들고 산책할 수 있어요`;
      a.bubble = { text: `${a.heldItem.label}, 한 모금!`, kind: 'chat', until: this.time + 3500 };
      return;
    }
    if (a.action === 'arcade') {
      const score = 100 + Math.floor(this.random() * 900);
      this.bestScore = Math.max(this.bestScore, score);
      a.bubble = { text: `🎮 ${score}점! 최고 ${this.bestScore}점`, kind: 'done', until: this.time + 4500 };
      this.effects.push({ x: a.x, y: a.y, kind: 'confetti', until: this.time + 2500 });
      if (a.isPlayer) this.engine.pushFeed(`나: 게임 ${score}점 · 최고 ${this.bestScore}점`);
    } else if (a.action === 'water') {
      a.bubble = { text: '🌱 잎이 더 반짝이는 것 같아요', kind: 'done', until: this.time + 3500 };
      this.effects.push({ x: a.x, y: a.y - 35, kind: 'sparkle', until: this.time + 3500 });
    } else if (a.action === 'stretch') a.bubble = { text: '✨ 몸도 마음도 가벼워요', kind: 'done', until: this.time + 3500 };
    a.action = null; a.currentItem = null; a.pose = 'stand'; a.status = 'idle'; a.selection = null;
    a.task = a.isPlayer ? (a.heldItem ? `☕ ${a.heldItem.label} 들고 산책 중` : '다음 산책을 기다리는 중') : '잠깐 쉬는 중';
  }

  autonomous(a, activeSkills) {
    a.nextAt = this.time + 7000;
    if (activeSkills && a.id !== 'resident-mocha') {
      const room = this.layout.rooms.skills;
      const target = { x: room.x + (a.id === 'resident-loop' ? 170 : 325), y: room.y + 308 };
      if (Math.hypot(a.x - target.x, a.y - target.y) > 15) this.moveTo(target, { label: '스킬 협업', action: 'collaborate' }, a);
      else { a.action = 'collaborate'; a.pose = 'talk'; a.status = 'working'; a.task = '스킬 스튜디오 · 협업 연출'; a.until = this.time + 7000; }
      return;
    }
    const choices = this.layout.interactions.filter(i => !i.door && i.id !== 'laptop');
    const choice = Math.floor(this.random() * (choices.length + 2));
    if (choice < choices.length) {
      for (let i = 0; i < choices.length; i++) {
        const item = choices[(choice + i) % choices.length];
        if (this.moveTo(item.stand, item, a)) break;
      }
    } else {
      const points = [{ x: 1350, y: 850 }, { x: 1850, y: 1100 }, { x: 1500, y: 576 }, { x: 980, y: 576 }];
      this.moveTo(points[Math.floor(this.random() * points.length)], null, a);
      a.bubble = { text: choice === 3 ? '🌿 잠깐 산책할까요?' : '💬 아이디어가 떠올랐어요', kind: 'chat', until: this.time + 3500 };
    }
  }

  snapshot() {
    return [this.player, ...this.residents].map(a => ({ ...a, pose: a.path.length ? 'walk' : a.pose,
      moving: a.path.length > 0, sessionLabel: a.isPlayer ? '내 캐릭터' : '상주 캐릭터 · 생활 연출',
      bubble: a.bubble ? { text: a.bubble.text, kind: a.bubble.kind } : null }));
  }
}
