'use strict';

const pty = require('node-pty');

class PtyManager {
  constructor({ onData, onExit }) {
    this.map = new Map();
    this.kinds = new Map(); // tabId → 'session'(AI 탭·로그인·설치) | 'shell'(코드 화면 터미널) — 종료 확인 창의 세션 수에서 셸을 빼려고
    this.onData = onData;
    this.onExit = onExit;
  }

  create({ tabId, file, args, cwd, cols = 100, rows = 30, env, kind = 'session' }) {
    // 새 프로세스를 먼저 띄운다 — 실패하면 던지고 이전 프로세스는 그대로 살아 있게 (없는 프로세스를 산 것으로 믿지 않게)
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    this.kill(tabId);
    this.map.set(tabId, p);
    this.kinds.set(tabId, kind);
    // 교체·종료한 이전 프로세스의 늦은 출력·종료는 같은 tabId 의 새 프로세스로 보내지 않는다.
    p.onData((d) => {
      if (this.map.get(tabId) !== p) return;
      this.onData(tabId, d);
    });
    p.onExit(({ exitCode }) => {
      if (this.map.get(tabId) !== p) return;
      this.map.delete(tabId);
      this.kinds.delete(tabId);
      this.onExit(tabId, exitCode);
    });
    return p.pid;
  }

  write(tabId, data) {
    const p = this.map.get(tabId);
    if (p) p.write(data);
  }

  resize(tabId, cols, rows) {
    const p = this.map.get(tabId);
    if (!p || !(cols > 0) || !(rows > 0)) return;
    try { p.resize(Math.floor(cols), Math.floor(rows)); } catch { /* 종료 직후 resize 는 무시 */ }
  }

  kill(tabId) {
    const p = this.map.get(tabId);
    if (!p) return;
    this.map.delete(tabId);
    this.kinds.delete(tabId);
    try { p.kill(); } catch { /* 이미 종료 */ }
  }

  // kind 를 주면 그 종류만, 없으면 전체.
  count(kind) {
    if (kind === undefined) return this.map.size;
    let n = 0;
    for (const k of this.kinds.values()) if (k === kind) n++;
    return n;
  }

  killAll() {
    for (const id of [...this.map.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager };
