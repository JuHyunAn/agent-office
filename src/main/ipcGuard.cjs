'use strict';

// 메인 창 전용 IPC 채널의 보낸 쪽 검사 (electron 에 기대지 않아 테스트할 수 있다).
// getWin: 지금의 메인 창을 돌려주는 함수. 보낸 쪽이 그 창의 webContents 일 때만 처리한다.
function createMainGuard(ipcMain, getWin) {
  const fromMain = (e) => { const w = getWin(); return !!w && !w.isDestroyed() && !!e && e.sender === w.webContents; };
  // invoke 채널: 다른 보낸 쪽이면 던진다
  const handleMain = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
    if (!fromMain(e)) throw new Error('허용되지 않는 요청입니다');
    return fn(...args);
  });
  // send 채널: 다른 보낸 쪽이면 무시한다
  const onMain = (channel, fn) => ipcMain.on(channel, (e, ...args) => { if (fromMain(e)) fn(...args); });
  return { fromMain, handleMain, onMain };
}

module.exports = { createMainGuard };
