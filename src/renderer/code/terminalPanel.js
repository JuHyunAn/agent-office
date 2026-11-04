// 코드 화면 하단 터미널: 작업 폴더마다 셸 하나 (PowerShell · Git Bash). 화면(xterm)만 다루고, 셸을 띄우는 일은 메인(pty:create 의 mode:'shell')이 한다.
// 터미널 ID(code-term-N)는 앱 탭(state.tabs)·세션·사무실 캐릭터와 무관하다 — 바깥(app.js)은 onPtyData·onPtyExit 가 true 를 돌려준 ID 를 탭으로 취급하지 않는다.
// xterm 은 보일 때만 열고 맞춘다 (숨겨진 채로 열면 크기가 0 이다). 폴더를 바꿔도 터미널은 버리지 않아 출력(scrollback)이 남는다.

function node(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
  return n;
}

// 폴더 비교 키 (panel.js 와 같은 규칙).
const keyOf = (dir) => String(dir).replace(/[\\/]+$/, '').toLowerCase();
// IPC 거부 메시지의 「Error invoking remote method '…': Error: 」 머리말은 떼고 보여 준다.
const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

const SHELLS = ['powershell', 'bash'];
const SHELL_NAME = { powershell: 'PowerShell', bash: 'Git Bash' };
const SHELL_KEY = 'ao.termShell';
const GRAY = (s) => `\x1b[90m${s}\x1b[0m`;

// 마지막으로 고른 셸: 새 폴더의 기본값으로만 쓴다 (폴더마다 자기 셸은 entry.shell).
function storedShell() {
  try {
    const v = localStorage.getItem(SHELL_KEY);
    if (SHELLS.includes(v)) return v;
  } catch { /* 저장소 없음 */ }
  return 'powershell';
}

function saveShell(kind) {
  try { localStorage.setItem(SHELL_KEY, kind); } catch { /* 저장소 없음 */ }
}

// onShellChange: 띄우기에 실패해 셸 종류가 되돌아가는 따위, 나중에 정해지는 변화를 화면(select)에 알린다.
export function createTerminalPanel({ api, newTerminal, onShellChange = () => {} }) {
  // keyOf(폴더) → { root, el, id, term, fit, opened, starting(그리기 대기·띄우는 중), exited, live(셸이 살아 있다), shell, ranShell(마지막으로 띄운 셸), run }
  const entries = new Map();
  const byId = new Map(); // 터미널 ID → entry
  let seq = 0;
  let current = null;
  let active = false; // 코드 화면이 보이고 터미널 탭을 보고 있다

  const noteEl = node('p', { class: 'ct-note' }, '작업 폴더를 고르면 터미널을 열 수 있습니다');
  const el = node('div', { class: 'code-terminal', 'aria-label': '터미널' }, noteEl);

  // 보이는 터미널만 크기를 맞추고 셸에 알린다 (종료한 셸·숨겨진 터미널은 건드리지 않는다).
  function fitNow(entry) {
    if (!active || current !== entry || !entry.opened) return;
    try {
      entry.fit.fit();
      if (!entry.exited) api.resizePty(entry.id, entry.term.cols, entry.term.rows);
    } catch { /* 숨김 상태에서는 크기 계산 불가 */ }
  }

  // 셸을 (다시) 띄운다. 성공해야 살아 있는 상태가 된다 — 메인은 검사에 걸리면 옛 셸을 건드리지 않으므로,
  // 살아 있던 셸을 다시 시작하다 실패하면 그 셸을 그대로 두고(입력도 계속 전달) 셸 종류·저장값을 옛 값으로 되돌린다.
  async function launch(entry) {
    const run = ++entry.run;
    const wasLive = entry.live;
    const shell = entry.shell;
    entry.starting = true;
    try {
      await api.createPty({ tabId: entry.id, cwd: entry.root, mode: 'shell', shell, cols: entry.term.cols, rows: entry.term.rows });
      if (run !== entry.run) return;
      entry.exited = false;
      entry.live = true;
      entry.ranShell = shell;
    } catch (e) {
      if (run !== entry.run) return; // 더 새로 띄운 셸이 있으면 이 실패는 버린다
      const msg = `\x1b[31m⚠ ${errText(e)}\x1b[0m\r\n`;
      if (wasLive) {
        entry.shell = entry.ranShell;
        saveShell(entry.shell);
        entry.term.write(`${msg}${GRAY(`계속 ${SHELL_NAME[entry.shell]} 을 씁니다`)}\r\n`);
        onShellChange();
      } else {
        entry.exited = true;
        entry.live = false;
        entry.term.write(`${msg}${GRAY('Enter 또는 「다시 시작」으로 다시 엽니다')}\r\n`);
      }
    } finally {
      if (run === entry.run) entry.starting = false;
    }
  }

  function open(entry) {
    const { term, fit } = newTerminal();
    entry.id = `code-term-${++seq}`;
    entry.shell = entry.shell || storedShell();
    Object.assign(entry, { term, fit, opened: true });
    byId.set(entry.id, entry);
    term.open(entry.el);
    term.onData((d) => {
      if (!entry.exited) { api.writePty(entry.id, d); return; }
      if (d === '\r') restartEntry(entry); // 끝난 셸에서는 Enter 가 다시 시작
    });
    try { fit.fit(); } catch { /* 크기 계산 불가 — 기본 크기로 띄운다 */ }
    launch(entry);
  }

  function restartEntry(entry) {
    if (entry.starting) return; // 띄우는 중이면 한 번 더 누른 것은 무시
    entry.term.write(`\r\n${GRAY('[셸을 다시 시작합니다]')}\r\n`);
    launch(entry);
    entry.term.focus();
  }

  // 보이는 순간에 처음 연다: hidden 이 풀린 뒤의 다음 프레임에서 xterm 을 열고 맞춘 다음 셸을 띄운다.
  function begin(entry, focus) {
    if (entry.starting) return;
    entry.starting = true;
    requestAnimationFrame(() => {
      entry.starting = false;
      if (!active || current !== entry) return; // 그 사이 숨겨졌거나 다른 폴더로 바뀜 — 다시 보일 때 시작
      if (entry.opened) fitNow(entry);
      else open(entry);
      if (focus) entry.term.focus();
    });
  }

  new ResizeObserver(() => { if (current) fitNow(current); }).observe(el);

  return {
    el,
    // 작업 폴더가 바뀌었다: 그 폴더의 터미널 칸으로 바꾼다 (이전 폴더의 셸·출력은 그대로 둔다).
    setRoot(root) {
      if (!root) { current = null; el.replaceChildren(noteEl); return; }
      const k = keyOf(root);
      let entry = entries.get(k);
      if (!entry) {
        entry = { root, el: node('div', { class: 'ct-host' }), id: null, term: null, fit: null, opened: false, starting: false, exited: false, live: false, shell: null, ranShell: null, run: 0 };
        entries.set(k, entry);
      }
      current = entry;
      el.replaceChildren(entry.el);
      if (active) begin(entry, false);
    },
    // 코드 화면의 터미널 탭이 보인다 / 가려진다.
    activate() {
      if (active) return;
      active = true;
      if (current) begin(current, true);
    },
    deactivate() { active = false; },
    // 터미널 ID 의 출력·종료면 처리하고 true (바깥은 이 ID 를 탭으로 찾지 않는다).
    onPtyData(id, data) {
      const entry = byId.get(id);
      if (!entry) return false;
      entry.term.write(data);
      return true;
    },
    onPtyExit(id, exitCode) {
      const entry = byId.get(id);
      if (!entry) return false;
      entry.exited = true;
      entry.live = false;
      entry.term.write(`\r\n${GRAY(`[셸 종료 · 코드 ${exitCode}] Enter 또는 「다시 시작」으로 다시 엽니다`)}\r\n`);
      return true;
    },
    // 지금 폴더의 셸을 새로 띄운다 (아직 열기 전이면 보이는 대로 처음 연다). 사용자의 명시적 동작이라 확인하지 않는다.
    restart() {
      if (!current) return;
      if (current.opened) restartEntry(current);
      else if (active) begin(current, true);
    },
    // 지금 폴더의 셸 종류 (폴더마다 따로). 아직 정하지 않은 폴더는 마지막 저장값.
    getShell: () => (current && current.shell) || storedShell(),
    // 지금 폴더의 셸 종류를 바꾼다. 마지막 선택은 새 폴더의 기본값으로 기억한다.
    // 셸이 살아 있으면 끊지 않고 값만 바꿔 안내한다 (실행 중인 명령을 잃지 않게) — 「다시 시작」이 새 값으로 띄운다. 끝났거나 아직 안 열렸으면 그대로 시작.
    setShell(kind) {
      if (!SHELLS.includes(kind)) return;
      saveShell(kind);
      if (!current) return;
      current.shell = kind;
      if (!current.opened) { this.restart(); return; }
      if (current.exited) { restartEntry(current); return; }
      current.term.write(`\r\n${GRAY(`[다음 시작부터 ${SHELL_NAME[kind]} 을 씁니다 — 「다시 시작」을 누르세요]`)}\r\n`);
    },
  };
}
