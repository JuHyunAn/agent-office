import { OfficeLife } from '../../office/life.js';

// 새 테마의 생활 동작만 가변 배치도에 맞춘다.
export class CustomLife extends OfficeLife {
  constructor(layout, engine, random) {
    super(layout, engine, random);
    const locations = layout.interactions.filter(i => !i.door).map(i => i.stand);
    this.residents.forEach((a, n) => Object.assign(a, locations[n] || layout.playerStart));
  }
  autonomous(actor, activeSkills) {
    actor.nextAt = this.time + 6000;
    const options = this.layout.interactions.filter(i => !i.door && !this.isBusy(i.id, actor));
    if (activeSkills) {
      const seat = this.layout.rooms.skills.seats[0];
      if (seat && this.moveTo(seat, { label: '스킬 협업', action: 'collaborate' }, actor)) return;
    }
    if (options.length) {
      const offset = Math.floor(this.random() * options.length);
      for (let n = 0; n < options.length; n++) if (this.moveTo(options[(n + offset) % options.length].stand, options[(n + offset) % options.length], actor)) return;
    }
  }
}
