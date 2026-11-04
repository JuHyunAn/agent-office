// 코드 화면의 순수 로직: 경로 판정·건드린 파일 목록·트리 만들기·갱신 타이머.
// 화면(DOM)·모나코·IPC 와 무관해서 화면 없이 테스트할 수 있다.
import { patchFile } from '../office/phrases.js';

// 경로 조각 정리: \ → /, 연속 /·끝 / 제거, . 는 버리고 .. 는 윗 단계로 (루트 위로는 올라가지 않음).
// 렌더러라 node:path 가 없어서 Windows 경로 규칙(대소문자 무시는 비교할 때)을 문자열로 직접 처리한다.
function squash(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  const out = [];
  for (const seg of parts.slice(1)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  // 첫 조각은 드라이브(c:) 또는 빈 값(/ 로 시작)이라 그대로 두고, 나머지만 정리한다.
  return [parts[0], ...out].join('/');
}

const isAbs = (p) => /^[a-z]:\//i.test(p) || p.startsWith('/');

// file 이 root 안이면 root 기준 「/」 구분 상대 경로, 밖(또는 root 자신)이면 null.
// file 이 상대 경로면 cwd(없으면 root) 기준으로 푼다. 대소문자는 비교할 때만 무시하고 결과는 file 표기를 그대로 둔다.
export function relInside(root, file, cwd) {
  if (typeof root !== 'string' || typeof file !== 'string' || !root || !file) return null;
  const base = squash(root.replace(/\\/g, '/'));
  if (!isAbs(base)) return null;
  const f = file.replace(/\\/g, '/');
  let abs = f;
  if (!isAbs(f)) {
    const from = typeof cwd === 'string' && cwd ? squash(cwd.replace(/\\/g, '/')) : base;
    if (!isAbs(from)) return null;
    abs = `${from}/${f}`;
  }
  abs = squash(abs);
  if (!isAbs(abs)) return null;
  // 접두어 + 「/」 경계까지 확인해야 C:\Repo2 가 C:\Repo 안으로 잡히지 않는다.
  if (abs.length <= base.length + 1) return null;
  if (abs.slice(0, base.length).toLowerCase() !== base.toLowerCase() || abs[base.length] !== '/') return null;
  return abs.slice(base.length + 1);
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);

// 도구 호출 이벤트 → 「건드린 파일」 한 건. PreToolUse 의 편집·읽기만 대상이고 root 밖이면 null.
export function touchedFrom(ev, root) {
  if (!ev || ev.hook_event_name !== 'PreToolUse') return null;
  const name = ev.tool_name;
  const kind = EDIT_TOOLS.has(name) ? 'edit' : name === 'Read' ? 'read' : null;
  if (!kind) return null;
  const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const file = name === 'apply_patch' ? patchFile(input) : input.file_path || input.notebook_path;
  const rel = relInside(root, file, ev.cwd);
  if (!rel || rel.split('/').some((piece) => piece.toLowerCase() === '.git')) return null; // 깃 내부 파일은 코드 화면에서 열 수 없다
  return { rel, kind, cli: ev._cli === 'codex' ? 'codex' : 'claude', at: ev._at ?? Date.now() };
}

const TOUCHED_MAX = 50;

// 폴더 하나에서 에이전트가 건드린 파일 목록(최근 것이 앞). 같은 파일(대소문자만 다른 경로 포함)은 하나로 합치고 표기는 최신 항목 것을 쓴다.
export class TouchedList {
  #list = [];

  // 목록이 눈에 띄게 바뀌었으면(새 파일·순서·표기·종류·에이전트·시각의 분) true. 같은 분 안의 시각 차이는 false (다시 그릴 필요 없음).
  add(item) {
    const key = item.rel.toLowerCase();
    const i = this.#list.findIndex((x) => x.rel.toLowerCase() === key);
    const prev = i >= 0 ? this.#list[i] : null;
    // 한 번이라도 edit 이면 edit 유지 (읽기가 나중에 와도 「수정함」 표시를 낮추지 않는다).
    // editAt = 마지막 수정 시각 (읽기가 나중에 와도 유지) — Git 패널의 「방금 수정」 판정에 쓴다.
    const editAt = item.kind === 'edit' ? item.at : prev?.editAt;
    const merged = { ...item, kind: prev?.kind === 'edit' || item.kind === 'edit' ? 'edit' : 'read', ...(editAt !== undefined ? { editAt } : {}) };
    if (prev) this.#list.splice(i, 1);
    this.#list.unshift(merged);
    if (this.#list.length > TOUCHED_MAX) this.#list.length = TOUCHED_MAX;
    return !prev || i !== 0 || prev.rel !== merged.rel || prev.kind !== merged.kind || prev.cli !== merged.cli
      || Math.floor(prev.at / 60000) !== Math.floor(merged.at / 60000);
  }

  items() { return [...this.#list]; }

  clear() { this.#list = []; }
}

// 파일 경로(/ 구분) 목록 → 폴더 트리. 폴더가 먼저, 같은 종류끼리는 이름순.
// Node = { name, path, dir, children? } — 최상위(이름 '')는 목록의 뿌리 자리표시다.
export function buildTree(paths) {
  const root = { name: '', path: '', dir: true, children: [] };
  const byPath = new Map([['', root]]);
  for (const p of paths) {
    const parts = String(p).split('/').filter(Boolean);
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let node = byPath.get(path);
      if (!node) {
        const dir = i < parts.length - 1;
        node = dir ? { name: parts[i], path, dir, children: [] } : { name: parts[i], path, dir };
        byPath.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }
  const sort = (n) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    for (const c of n.children) if (c.dir) sort(c);
  };
  sort(root);
  return root;
}

// 일정 주기로 run 을 부르는 갱신기. 실행은 절대 겹치지 않고, run 이 실패해도 다음 주기는 이어진다.
//  - start: 이미 켜져 있으면 무시. 켜고 즉시 1회 실행, 끝나면(성공·실패 모두) 켜져 있을 때만 intervalMs 뒤 예약.
//  - bump(ms = bumpMs): 꺼져 있으면 무시. 실행 중이면 끝난 뒤 예약을 ms 로, 대기 중이면 남은 시간이 ms 보다 길 때만 ms 로 당김 (0 이면 곧바로).
//  - stop: 예약 취소. 실행 중이던 것이 끝나도 다시 예약하지 않음.
//  - running: 켜져 있는 동안 true (start 이후 stop 전).
// timers 의 setTimeout·clearTimeout 은 부를 때마다 꺼내 쓴다 (테스트의 mock 타이머가 적용되도록).
export function createRefresher({ run, intervalMs = 10000, bumpMs = 3000, timers = globalThis, onError = () => {} }) {
  let on = false;
  let busy = false;
  let again = false; // 실행 중에 stop 뒤 다시 start 됨 → 끝나는 즉시 한 번 더 (겹치지 않게)
  let timer = null;
  let dueAt = 0;
  let nextMs = intervalMs; // 실행이 끝난 뒤 예약할 간격 (실행 중 bump 가 줄인다)

  const cancel = () => {
    if (timer == null) return;
    timers.clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms) => {
    cancel();
    dueAt = Date.now() + ms;
    timer = timers.setTimeout(fire, ms);
  };
  async function fire() {
    timer = null;
    if (!on || busy) return;
    busy = true;
    nextMs = intervalMs;
    try {
      await run();
    } catch (e) {
      try { onError(e); } catch { /* 오류 보고가 실패해도 주기는 이어간다 */ }
    }
    busy = false;
    if (!on) { again = false; return; }
    if (again) { again = false; fire(); return; }
    schedule(nextMs);
  }

  return {
    get running() { return on; },
    start() {
      if (on) return;
      on = true;
      if (busy) { again = true; return; }
      fire();
    },
    stop() {
      on = false;
      again = false;
      cancel();
    },
    bump(ms = bumpMs) {
      if (!on) return;
      if (busy) { nextMs = Math.min(nextMs, ms); return; }
      if (timer != null && dueAt - Date.now() > ms) schedule(ms);
    },
  };
}
