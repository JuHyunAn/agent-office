'use strict';

const pty = require('node-pty');

class PtyManager {
  constructor({ onData, onExit }) {
    this.map = new Map();
    this.onData = onData;
    this.onExit = onExit;
  }

  create({ tabId, file, args, cwd, cols = 100, rows = 30, env }) {
    this.kill(tabId);
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    this.map.set(tabId, p);
    p.onData((d) => this.onData(tabId, d));
    p.onExit(({ exitCode }) => {
      if (this.map.get(tabId) === p) this.map.delete(tabId);
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
    try { p.kill(); } catch { /* 이미 종료 */ }
  }

  count() {
    return this.map.size;
  }

  killAll() {
    for (const id of [...this.map.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager };
