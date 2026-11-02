import { OfficeLife } from '../../office/life.js';

// 새 테마의 생활 동작만 가변 배치도에 맞춘다.
export class CustomLife extends OfficeLife {
  constructor(layout, engine, random) {
    super(layout, engine, random);
    const locations = layout.interactions.filter(i => !i.door).map(i => i.stand);
    // 시설이 적은 사용자 배치에서도 새 상주 캐릭터들이 입구 한 칸에 겹치지 않게 한다.
    for (let y = 24; y < layout.height; y += 48) for (let x = 24; x < layout.width; x += 48)
      if (this.navigation.isWalkable({ x, y })) locations.push({ x, y });
    const occupied = [this.player];
    for (const actor of this.residents) {
      const spot = locations.find(p => this.navigation.isWalkable(p) && occupied.every(a => Math.hypot(a.x - p.x, a.y - p.y) >= 100))
        || locations.find(p => occupied.every(a => Math.hypot(a.x - p.x, a.y - p.y) >= 24)) || layout.playerStart;
      Object.assign(actor, spot); occupied.push(actor);
    }
  }
  autonomous(actor, activeSkills) {
    actor.nextAt = this.time + 6000;
    const options = this.layout.interactions.filter(i => !i.door && !this.isBusy(i.id, actor));
    if (activeSkills) {
      const others = [...this.residents.filter(a => a !== actor), this.player, ...this.engine.agents.values()];
      const seat = this.layout.rooms.skills.seats.find(p => others.every(a => {
        const end = a.path?.at(-1) || a.seat || a;
        return Math.hypot(end.x - p.x, end.y - p.y) >= 80;
      }));
      if (seat && this.moveTo(seat, { label: '스킬 협업', action: 'collaborate' }, actor)) return;
    }
    if (options.length) {
      const offset = Math.floor(this.random() * options.length);
      for (let n = 0; n < options.length; n++) if (this.moveTo(options[(n + offset) % options.length].stand, options[(n + offset) % options.length], actor)) return;
    }
  }
}
