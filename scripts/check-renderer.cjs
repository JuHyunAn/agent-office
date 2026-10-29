'use strict';

// Render the real UI with synthetic IPC events, without starting Claude or editing its settings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { cleanEnv } = require('../src/main/env.cjs');
  const child = spawn(require('electron'), [__filename], { env: cleanEnv(), stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, protocol, net, ipcMain, nativeImage } = require('electron');
  const { pathToFileURL } = require('node:url');
  const assert = require('node:assert/strict');
  const OUT = path.join(ROOT, 'output', 'design');
  const errors = [];
  let win, tabId, lastPetState = null;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const event = (name, extra = {}) => win.webContents.send('hook:event', {
    session_id: 'preview-main', cwd: ROOT, hook_event_name: name, _tab: tabId, ...extra,
  });
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ao-render-')));
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const watchdog = setTimeout(() => { console.error('Renderer check timed out'); app.exit(1); }, 90000); // 정상 실행이 50~60초라 60초 제한은 경계에 걸렸다

  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    protocol.handle('app', req => {
      const target = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname)));
      if (!target.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });
    ipcMain.handle('app:status', () => ({ claude: { version: '디자인 검증' }, codex: { version: '디자인 검증' }, auth: { loggedIn: true }, hook: { global: { installed: false } } }));
    ipcMain.handle('weather:current', () => ({ available: true, stale: false, location: '서울',
      observedAt: Date.parse('2026-10-26T12:00:00+09:00'), temperature: 16, cloudCover: 10, condition: 'clear' }));
    ipcMain.handle('dialog:pickFolder', () => ROOT);
    ipcMain.handle('pty:create', (_e, options) => { tabId = options.tabId; return { sessionId: options.cli === 'codex' ? null : 'preview-main' }; });
    ipcMain.handle('pet:mode:set', (_e, { mode } = {}) => ({ mode }));
    ipcMain.on('pet:state', (_e, payload) => { lastPetState = payload; }); // 펫에 보낸 마지막 상태 (권한 카드 점검용)
    // 펫 그림 선택 대화상자 점검용 스텁: 목록·미리보기(단색 1536x1872 PNG)·선택·삭제·가져오기
    const petsData = {
      pets: [
        { key: 'builtin:office-claude', source: 'builtin', id: 'office-claude', displayName: '기본 클로드' },
        { key: 'user:mine', source: 'user', id: 'mine', displayName: '<b>내 펫</b>' },
      ],
      selected: { claude: null, codex: 'user:mine' },
      resolved: { claude: 'builtin:office-claude', codex: 'user:mine' },
    };
    const petCalls = { select: [], remove: [], import: [], preview: [] };
    const previewBgra = Buffer.alloc(1536 * 1872 * 4);
    for (let i = 0; i < previewBgra.length; i += 4) { previewBgra[i] = 200; previewBgra[i + 1] = 90; previewBgra[i + 2] = 40; previewBgra[i + 3] = 255; }
    const previewPng = nativeImage.createFromBitmap(previewBgra, { width: 1536, height: 1872 }).toPNG();
    ipcMain.handle('pets:list', () => petsData);
    ipcMain.handle('pets:preview', (_e, key) => { petCalls.preview.push(key); return { type: 'image/png', bytes: previewPng }; });
    ipcMain.handle('pets:select', (_e, p) => { petCalls.select.push(p); petsData.selected[p.kind] = p.value; return { ok: true }; });
    ipcMain.handle('pets:remove', (_e, key) => { petCalls.remove.push(key); return { ok: true }; });
    ipcMain.handle('pets:import', (_e, kind) => { petCalls.import.push(kind); return { error: '올바른 zip 파일이 아닙니다' }; });
    ipcMain.handle('pty:kill', () => {});
    ipcMain.on('pty:write', () => {});
    ipcMain.on('pty:resize', () => {});
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, offscreen: true,
    } });
    win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
    win.webContents.on('did-fail-load', (_e, code, detail) => errors.push(`${code}: ${detail}`));
    await win.loadURL('app://office/src/renderer/index.html');
    await pause(200);
    await win.webContents.executeJavaScript(`document.querySelector('#gate-body button').click()`);
    await pause(200);
    await win.webContents.executeJavaScript(`document.querySelector('#pick-folder').click()`);
    await pause(200);
    win.webContents.send('pty:data', { tabId, data: '\x1b[38;2;217;119;87m  AGENT OFFICE\x1b[0m\r\n  렌더링 검증 · 합성 이벤트\r\n\r\n\x1b[90m  실제 Claude 명령은 실행하지 않습니다.\x1b[0m\r\n\r\n  \x1b[32m●\x1b[0m Explore      분석실에서 자료 확인\r\n  \x1b[32m●\x1b[0m executor     개발실에서 코드 작성\r\n  \x1b[32m●\x1b[0m verifier     검토실에서 결과 검토\r\n\r\n  \x1b[90m세션의 활동이 왼쪽 사무실에 반영됩니다.\x1b[0m\r\n' });
    await win.webContents.executeJavaScript(`(async () => {
      const { OfficeEngine } = await import('./office/engine.js');
      const { OfficeView } = await import('./office/view.js');
      const draw = OfficeView.prototype.draw;
      OfficeView.prototype.draw = function(t) { window.__view = this; return draw.call(this,t); };
      window.__originalUpdate = OfficeEngine.prototype.update;
      OfficeEngine.prototype.update = function (dt) { window.__engine = this; return window.__originalUpdate.call(this, dt); };
      const snapshot = OfficeEngine.prototype.snapshot;
      OfficeEngine.prototype.snapshot = function () { const s = snapshot.call(this); window.__snapshot = s; return s; };
    })()`);
    event('SessionStart');
    const agents = [['explore1', 'Explore'], ['plan1', 'planner'], ['dev1', 'executor'], ['dev2', 'executor'], ['review1', 'verifier'], ['rest1', 'researcher']];
    const assignments = { explore1: '프로젝트 구조 검토', plan1: '문서 구조 정리', dev1: '사무실 화면 개선', dev2: '테스트로 동작 검증', review1: '검증 결과 정리', rest1: '참고 자료 조사' };
    for (const [id, type] of agents) {
      event('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: type, description: assignments[id] } });
      event('SubagentStart', { agent_id: id, agent_type: type });
    }
    await pause(200);
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(window.__engine&&window.__view){clearInterval(timer);resolve();}else if(Date.now()-start>10000){clearInterval(timer);reject(new Error('Office scene did not become ready'));}},50);})`);
    await win.webContents.executeJavaScript(`window.__engine.random = () => 0.5; for (let i=0;i<400;i++) {window.__engine.update(50);window.__view.life.update(50);}`);
    event('SubagentStop', { agent_id: 'rest1', agent_type: 'researcher' });
    await pause(100);
    await win.webContents.executeJavaScript(`for (let i=0;i<800;i++) window.__engine.update(50)`);
    await win.webContents.executeJavaScript(`(async () => { const { OfficeEngine } = await import('./office/engine.js'); OfficeEngine.prototype.update = window.__originalUpdate; })()`);
    for (const [id, tool, input] of [
      ['explore1', 'Read', { file_path: 'design.md' }], ['plan1', 'Read', { file_path: 'plan.md' }],
      ['dev1', 'Edit', { file_path: 'theme.js' }], ['dev2', 'Bash', { command: 'npm test' }],
      ['review1', 'Read', { file_path: 'review.md' }],
    ]) event('PreToolUse', { agent_id: id, tool_name: tool, tool_input: input });
    event('PreToolUse', { agent_id: 'plan1', tool_name: 'Skill', tool_input: { skill: 'documents:documents' } });
    event('PreToolUse', { agent_id: 'review1', tool_name: 'Skill', tool_input: { skill: 'spreadsheets:Spreadsheets' } });
    await win.webContents.executeJavaScript(`document.hasFocus=()=>false;0`); // 「확인 필요」 점검: 사용자가 이 탭을 보고 있지 않은 상황으로 고정
    event('PermissionRequest', { tool_name: 'Bash' });
    await pause(100);
    await win.webContents.executeJavaScript(`window.__view.environment.now=()=>Date.parse('2026-10-26T12:00:00+09:00'); window.__view.environment.cachedMinute=null;
      for (let i=0;i<1000;i++) {window.__engine.update(50);window.__view.life.update(50);} window.__view.fit();`);
    await pause(350);
    const status = await win.webContents.executeJavaScript(`({
      theme: document.querySelector('#theme-select').value,
      agents: window.__snapshot.map(a => ({id:a.id,status:a.status,pose:a.pose})),
      gateHidden: document.querySelector('#gate').hidden,
      overflow: document.documentElement.scrollWidth > innerWidth,
      canvas: {width:document.querySelector('#office').width,height:document.querySelector('#office').height}
    })`);
    assert.equal(status.theme, 'pixel-office');
    assert.equal(status.gateHidden, true);
    assert.equal(status.overflow, false);
    assert.equal(status.agents.length, 7);
    const selectTheme = async id => {
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const v=window.__view,life=v.life,camera=v.camera,held=life.player.heldItem;
        const sel=document.querySelector('#theme-select');sel.value=${JSON.stringify(id)};sel.dispatchEvent(new Event('change'));
        const start=performance.now();while(v.theme.id!==${JSON.stringify(id)}||JSON.parse(localStorage.getItem('ao.theme'))!==${JSON.stringify(id)}){
          if(performance.now()-start>3000)throw new Error('테마 전환 시간 초과');
          await new Promise(r=>setTimeout(r,20));
        }
        return {id:v.theme.id,saved:JSON.parse(localStorage.getItem('ao.theme')),sameLife:v.life===life,sameCamera:v.camera===camera,sameHeld:v.life.player.heldItem===held};
      })()`);
      assert.equal(result.id,id);assert.equal(result.saved,id);
      assert.ok(result.sameLife&&result.sameCamera&&result.sameHeld,JSON.stringify(result));
      return result;
    };
    assert.ok(status.agents.some(a => a.status === 'resting'));
    assert.ok(status.agents.some(a => a.pose === 'type'));
    const workSummaries = await win.webContents.executeJavaScript(`window.__snapshot.filter(a=>a.status==='working').map(a=>a.bubble)`);
    assert.ok(workSummaries.every(b => b?.kind === 'alert' || (b?.summary && b.text.includes('\n'))),JSON.stringify(workSummaries));
    assert.equal(workSummaries.filter(b=>b?.summary).length,5);
    await fs.promises.writeFile(path.join(OUT, 'office-isometric.png'), (await win.webContents.capturePage()).toPNG());
    // 「확인 필요」: 보고 있지 않은 탭의 권한 요청은 탭 점·말풍선에 표시되고, 탭 영역을 누르면 꺼진다.
    // 외부 세션(탭 없음)의 권한 요청은 켜지고, 그 세션의 턴이 끝나면(Stop) 꺼진다.
    const lead = id => `window.__snapshot.find(a=>a.id==='${id}:lead')?.bubble`;
    const attention = await win.webContents.executeJavaScript(`(async()=>{
      const dot=()=>document.querySelector('.tab .dot').className;
      const before={dot:dot(),bubble:${lead('preview-main')}};
      document.querySelector('.pane:not([hidden])').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      await new Promise(r=>setTimeout(r,200));
      return {before,after:{dot:dot(),bubble:${lead('preview-main')}}};
    })()`);
    assert.match(attention.before.dot, /alert/, JSON.stringify(attention));
    assert.equal(attention.before.bubble?.attention, true, JSON.stringify(attention));
    assert.doesNotMatch(attention.after.dot, /alert/, JSON.stringify(attention));
    assert.ok(!attention.after.bubble?.attention, JSON.stringify(attention));
    const outside = (name, extra = {}) => win.webContents.send('hook:event', { session_id: 'preview-outside', cwd: ROOT, hook_event_name: name, _tab: null, ...extra });
    outside('SessionStart'); outside('PermissionRequest', { tool_name: 'Edit' });
    await pause(200);
    attention.outside = { asked: await win.webContents.executeJavaScript(lead('preview-outside')) };
    outside('Stop');
    await pause(200);
    attention.outside.stopped = await win.webContents.executeJavaScript(lead('preview-outside'));
    assert.equal(attention.outside.asked?.attention, true, JSON.stringify(attention));
    assert.ok(!attention.outside.stopped?.attention, JSON.stringify(attention));

    // 펫 권한 카드: 메인이 붙잡은 요청(_permId)이 있는 PermissionRequest 는 펫 상태에 canAnswer 로 실리고,
    // 메인이 풀었다고 알리면(perm:closed) 표시는 남되 카드는 안내로 바뀌며, 탭 영역을 누르면 항목이 사라진다.
    // 시간이 걸리는 점검이라 사무실 장면 점검이 끝난 뒤(맨 끝)에 부른다 — 중간에 두면 외부 세션 캐릭터가 퇴근해 버린다.
    const mainTabId = tabId; // 뒤에서 Codex 탭이 열리면 tabId 가 바뀐다 — Claude 탭의 ID 를 붙잡아 둔다
    const permCardCheck = async () => {
    const PERM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const permItems = () => (lastPetState?.kinds?.claude?.attention || []).filter(x => x.reason === 'permission');
    const permCase = async (extra, closed) => {
      event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' }, _tab: mainTabId, ...extra });
      await pause(200);
      if (closed) { win.webContents.send('perm:closed', closed); await pause(200); }
      return permItems();
    };
    const asked = await permCase({ _permId: PERM });
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.deepEqual({ permId: asked[0].permId, canAnswer: asked[0].canAnswer, tool: asked[0].tool, preview: asked[0].preview }, { permId: PERM, canAnswer: true, tool: 'Bash', preview: 'npm test' });
    // 전역 hook 사본과 겹친 두 번째 사본(_dupHold)은 카드 정보만 갱신한다
    const PERM_DUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const dup = await permCase({ _permId: PERM_DUP, _dupHold: true });
    assert.deepEqual([dup.length, dup[0].permId, dup[0].canAnswer], [1, PERM_DUP, true]);
    // 카드로 허용하면 안 되는 요청: 잘린 명령 · 사용자 답이 필요한 도구 · 보여 줄 내용 없음 · permId 없음(붙잡지 않은 요청)
    const longCmd = 'x'.repeat(300) + '…';
    assert.equal((await permCase({ _permId: PERM, tool_input: { command: longCmd } }))[0].canAnswer, false, '잘린 명령');
    assert.equal((await permCase({ _permId: PERM, tool_name: 'AskUserQuestion' }))[0].canAnswer, false, 'AskUserQuestion');
    assert.equal((await permCase({ _permId: PERM, tool_name: 'ExitPlanMode' }))[0].canAnswer, false, 'ExitPlanMode');
    assert.equal((await permCase({ _permId: PERM, tool_input: undefined }))[0].canAnswer, false, '미리보기 없음');
    assert.equal((await permCase({ _permId: PERM, tool_input: { command: '   ' } }))[0].canAnswer, false, '빈 미리보기');
    const noId = await permCase({});
    assert.deepEqual([noId[0].permId, noId[0].canAnswer], [null, false]);
    const mcpOnly = await permCase({ _permId: PERM, tool_name: 'mcp__x__y', tool_input: { foo: 'bar' } });
    assert.equal(mcpOnly[0].canAnswer, false, '알려진 필드가 없는 도구 입력');
    assert.equal((await permCase({ _permId: PERM, tool_input: { command: 'x'.repeat(161) } }))[0].canAnswer, false, '161자 명령은 안내만');
    assert.equal((await permCase({ _permId: PERM, tool_input: { command: 'x'.repeat(160) } }))[0].canAnswer, true, '160자 명령은 카드로 답할 수 있다');
    assert.equal((await permCase({ _permId: PERM, tool_name: 'Write', tool_input: { file_path: 'a.txt' } }))[0].canAnswer, false, '허용 목록 밖 도구');
    assert.equal((await permCase({ _permId: PERM, tool_input: { command: 'a‮b' } }))[0].canAnswer, false, '양방향 제어 문자');
    // 메인이 시간 초과 등으로 풀었다: 항목은 남고 카드는 안내로
    const timedOut = await permCase({ _permId: PERM }, { permId: PERM, how: 'timeout' });
    assert.equal(timedOut.length, 1, JSON.stringify(timedOut));
    assert.deepEqual([timedOut[0].permId, timedOut[0].canAnswer], [null, false]);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.tab .dot').className`), /alert/, '표시(탭 점)는 남아 있어야 함');
    // 다른 permId 의 closed 는 무관하다
    const other = await permCase({ _permId: PERM }, { permId: PERM_DUP, how: 'released' });
    assert.deepEqual([other[0].permId, other[0].canAnswer], [PERM, true]);
    // 카드로 결정해 풀렸으면(decided) 항목이 사라진다
    assert.equal((await (async () => { win.webContents.send('perm:closed', { permId: PERM, how: 'decided' }); await pause(200); return permItems(); })()).length, 0);
    // 풀린 뒤 탭 영역을 눌러 끄는 경로: 안내로 남은 항목은 탭을 누르면 사라진다
    await permCase({ _permId: PERM }, { permId: PERM, how: 'close' });
    assert.equal(permItems().length, 1);
    await win.webContents.executeJavaScript(`document.querySelector('#panes .pane').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); // 첫 탭 = Claude 탭
    await pause(200);
    assert.equal(permItems().length, 0, '탭 영역을 누르면 항목이 사라진다');
    // 같은 세션의 진행 신호가 오면 펫 상태에서 그 permId 가 사라진다 (메인의 대조가 풀 수 있게): Stop → 항목이 done, UserPromptSubmit·같은 agent 의 PreToolUse → 항목이 꺼진다
    const allItems = () => lastPetState?.kinds?.claude?.attention || [];
    const PERM3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const asked3 = await permCase({ _permId: PERM3 });
    assert.deepEqual([asked3[0].permId, asked3[0].canAnswer], [PERM3, true]);
    event('Stop', { _tab: mainTabId });
    await pause(200);
    assert.ok(!allItems().some(x => x.permId === PERM3 || x.canAnswer), `Stop 뒤에도 permId 가 남음: ${JSON.stringify(allItems())}`);
    const doneItem = allItems().find(x => x.tabId === mainTabId);
    assert.deepEqual([doneItem?.reason, doneItem?.kind], ['done', 'done'], JSON.stringify(allItems()));
    await win.webContents.executeJavaScript(`document.querySelector('#panes .pane').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await pause(200);
    for (const [name, extra] of [['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }], ['UserPromptSubmit', { prompt: '계속' }]]) {
      assert.equal((await permCase({ _permId: PERM3 })).length, 1, name);
      event(name, { _tab: mainTabId, ...extra });
      await pause(200);
      assert.ok(!allItems().some(x => x.permId === PERM3), `${name} 뒤에도 permId 가 남음: ${JSON.stringify(allItems())}`);
      assert.equal(allItems().length, 0, `${name} 뒤에는 항목이 꺼진다`);
    }
    attention.permCard = { asked: asked[0], timedOut: timedOut[0] };
    };

    const spriteCheck = await win.webContents.executeJavaScript(`(async () => {
      const {drawCharacter} = await import('./themes/pixel-office/sprites.js');
      const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=192;
      const c=canvas.getContext('2d'); c.fillStyle='#f3eddf'; c.fillRect(0,0,640,192);
      const cases=[['walk','working'],['type','working'],['read','working'],['run','working'],['talk','working'],['alert','idle'],['stand','sharing'],['sit','resting']];
      const changes=[];
      for(let i=0;i<cases.length;i++) {
        const [pose,status]=cases[i]; const a={pose,status,facing:'down',colorIndex:i%8,role:'dev'};
        const frame=document.createElement('canvas'); frame.width=64; frame.height=48;
        const f=frame.getContext('2d'); drawCharacter(f,a,0,30,38);
        const before=Array.from(f.getImageData(0,0,64,48).data);
        c.drawImage(frame,0,0,64,48,i*80,20,64,48);
        f.clearRect(0,0,64,48); drawCharacter(f,a,130,30,38);
        const after=f.getImageData(0,0,64,48).data;
        changes.push({pose,changed:before.some((v,j)=>v!==after[j])});
        c.drawImage(frame,0,0,64,48,i*80,102,64,48);
        c.font='10px monospace';c.fillStyle='#665d4e';c.fillText(pose,i*80+8,87);
      }
      return {changes,png:canvas.toDataURL('image/png').split(',')[1]};
    })()`);
    assert.ok(spriteCheck.changes.every(a => a.changed));
    fs.writeFileSync(path.join(OUT, 'character-actions.png'), Buffer.from(spriteCheck.png, 'base64'));
    const looks = await win.webContents.executeJavaScript(`(async()=>{
      const {drawCharacter}=await import('./themes/pixel-office/sprites.js');
      const {HAIR_STYLES,ACCESSORIES}=await import('./office/appearance.js');
      const canvas=document.createElement('canvas');canvas.width=1050;canvas.height=230;const c=canvas.getContext('2d');
      c.fillStyle='#f4eddf';c.fillRect(0,0,canvas.width,canvas.height);c.fillStyle='#625b51';c.font='bold 17px monospace';c.fillText('OFFICE FRIENDS / MIX & MATCH',26,30);
      const frames=[];
      for(let i=0;i<ACCESSORIES.length;i++){
        const frame=document.createElement('canvas');frame.width=64;frame.height=64;const f=frame.getContext('2d');
        const appearance={hair:HAIR_STYLES[i%HAIR_STYLES.length],accessory:ACCESSORIES[i],hairColor:['#493d3b','#795744','#c49965','#645c82','#a25e50','#657c72'][i%6]};
        drawCharacter(f,{pose:'stand',facing:'down',status:'idle',colorIndex:i,appearance},0,32,48);frames.push(frame.toDataURL());
        c.imageSmoothingEnabled=false;c.drawImage(frame,0,0,64,64,i*150,28,150,150);
        c.fillStyle='#8a7c69';c.font='12px monospace';c.fillText(ACCESSORIES[i],i*150+14,190);c.fillText(appearance.hair,i*150+14,208);
      }
      return {png:canvas.toDataURL('image/png').split(',')[1],unique:new Set(frames).size};
    })()`);
    assert.equal(looks.unique,7);fs.writeFileSync(path.join(OUT,'character-looks.png'),Buffer.from(looks.png,'base64'));
    const drinkVisualCheck=await win.webContents.executeJavaScript(`(async()=>{
      const {drawCharacter}=await import('./themes/pixel-office/sprites.js');
      const {DRINKS}=await import('./office/drinks.js');
      const {drawDrinkImage}=await import('./themes/pixel-office/drink-images.js');
      const canvas=document.createElement('canvas');canvas.width=900;canvas.height=240;const c=canvas.getContext('2d');
      c.fillStyle='#f3eddf';c.fillRect(0,0,900,240);c.fillStyle='#6e6354';c.font='bold 16px monospace';c.fillText('CAFE / CHOOSE & CARRY THE SAME DRINK',22,28);
      const sources=[],checks=[],draw=c.drawImage.bind(c);let used;
      c.drawImage=(source,...args)=>{used=source;draw(source,...args);};
      for(let i=0;i<DRINKS.length;i++){
        const drink=DRINKS[i];drawDrinkImage(c,drink.id,i*150+48,43,48,55);const expected=used;sources.push(expected);used=null;
        c.save();c.translate(i*150+60,191);c.scale(3,3);
        drawCharacter(c,{pose:'walk',status:'walking',colorIndex:i,facing:'down',heldItem:drink},500,0,0);c.restore();
        checks.push({id:drink.id,sameImage:!!expected&&used===expected});
        c.font='12px "Malgun Gothic"';c.fillStyle='#83765f';c.fillText(drink.label,i*150+24,225);
      }
      return {checks,unique:new Set(sources).size,png:canvas.toDataURL('image/png').split(',')[1]};
    })()`);
    assert.ok(drinkVisualCheck.checks.every(d=>d.sameImage));assert.equal(drinkVisualCheck.unique,6);
    fs.writeFileSync(path.join(OUT,'drink-items.png'),Buffer.from(drinkVisualCheck.png,'base64'));
    const artCheck = await win.webContents.executeJavaScript(`(async () => {
      const {default:theme} = await import('./themes/pixel-office/theme.js');
      const canvas=document.createElement('canvas');canvas.width=theme.viewport.width;canvas.height=theme.viewport.height;
      const c=canvas.getContext('2d');const agents=window.__snapshot.map(a=>({...a,bubble:null}));
      let rasterSize;const originalDraw=c.drawImage.bind(c);c.drawImage=(source,...args)=>{rasterSize={width:source.width,height:source.height};return originalDraw(source,...args);};
      theme.drawScene(c,agents,0);
      const visible=agents.map(a=>{
        const p=theme.project(a.x,a.y);let orangePixels=0;
        const pixels=c.getImageData(p.x-70,p.y-140,140,140).data;
        for(let i=0;i<pixels.length;i+=4) if(pixels[i]===215 && pixels[i+1]===123 && pixels[i+2]===87) orangePixels++;
        return {id:a.id,orangePixels};
      });
      const start=performance.now();for(let i=0;i<20;i++) theme.drawScene(c,agents,i*130);
      return {visible,rasterSize,meanDrawMs:Math.round((performance.now()-start)/20*100)/100};
    })()`);
    assert.ok(artCheck.visible.every(a => a.orangePixels > 30), JSON.stringify(artCheck.visible));
    assert.deepEqual(artCheck.rasterSize,{width:3200,height:2000});

    const lightingCheck = await win.webContents.executeJavaScript(`(async()=>{
      const {default:theme,projectPoint}=await import('./themes/pixel-office/theme.js');
      const {default:plainTheme}=await import('./themes/pixel-office/plain.js');
      const {createAtmosphere,WINDOWS,DESK_LIGHTS}=await import('./themes/pixel-office/atmosphere.js');
      const {createExterior}=await import('./themes/pixel-office/exterior.js');
      const canvas=document.createElement('canvas');canvas.width=3200;canvas.height=2000;
      const c=canvas.getContext('2d',{willReadFrequently:true});
      const sample=(x,y,z=0)=>{const p=theme.project(x,y);p.y-=z*2;const data=c.getImageData(p.x-5,p.y-5,10,10).data;
        let sum=0;for(let i=0;i<data.length;i+=4)sum+=data[i]*0.2126+data[i+1]*0.7152+data[i+2]*0.0722;return sum/100;};
      const lamp=DESK_LIGHTS[0];
      theme.drawScene(c,[],0,{environment:{night:false,condition:'clear'}});
      const day={floor:sample(1000,576),desk:sample(lamp.x+38,lamp.y+8,23)};
      theme.drawScene(c,[],0,{environment:{night:true,condition:'clear'}});
      const night={floor:sample(1000,576),desk:sample(lamp.x+38,lamp.y+8,23)};
      const a=createAtmosphere({width:1600,height:1000,detail:2,project:projectPoint});
      const exterior=createExterior({width:1600,height:1000,project:projectPoint});
      const precipitation=[];c.setTransform(2,0,0,2,0,0);
      for(const style of [undefined,'simple']) for(const condition of ['rain','snow']){
        const env={night:true,condition};let backdrop=exterior.drawBackground(c,0,env);
        c.clearRect(0,0,1600,1000);a.drawWindows(c,0,env,backdrop,style);const before=c.getImageData(0,0,3200,2000).data;
        backdrop=exterior.drawBackground(c,360,env);
        c.clearRect(0,0,1600,1000);a.drawWindows(c,360,env,backdrop,style);const after=c.getImageData(0,0,3200,2000).data;
        let changed=0,escaped=0;
        for(let i=0;i<before.length;i+=4)if(before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2]){
          changed++;const x=(i/4%3200)/2,y=Math.floor(i/4/3200)/2;
          if(!WINDOWS.some(pane=>{const p=projectPoint(pane.x,pane.y,pane.top),u=(x-p.x)*(pane.axis==='y'?-1:1),v=y-p.y-u*0.5;return u>=-2&&u<=pane.w*0.36+2&&v>=-2&&v<=pane.top-pane.bottom+2;}))escaped++;
        }
        c.setTransform(1,0,0,1,0,0);
        const interiorPoints=[...Object.values(theme.layout.rooms).map(r=>theme.project(r.x+r.w/2,r.y+r.h/2)),theme.project(1000,576)];
        const samples=()=>interiorPoints.map(p=>c.getImageData(p.x-8,p.y-8,16,16).data);
        const activeTheme=style==='simple'?plainTheme:theme;
        activeTheme.drawScene(c,[],0,{environment:env});
        const indoorBefore=samples(),outdoorBefore=c.getImageData(0,0,400,300).data;
        activeTheme.drawScene(c,[],360,{environment:env});
        const indoorAfter=samples(),outdoorAfter=c.getImageData(0,0,400,300).data;
        const indoorChanged=indoorBefore.reduce((total,pixels,index)=>total+Number(pixels.some((v,j)=>v!==indoorAfter[index][j])),0);
        const outdoorChanged=outdoorBefore.some((v,j)=>v!==outdoorAfter[j]);
        precipitation.push({style:style||'city',condition,changed,escaped,indoorChanged,outdoorChanged});
        c.setTransform(2,0,0,2,0,0);
      }
      return {day,night,windows:WINDOWS.length,deskLights:DESK_LIGHTS.length,precipitation};
    })()`);
    assert.equal(lightingCheck.windows,4);
    assert.equal(lightingCheck.deskLights,18);
    assert.ok(lightingCheck.night.floor < lightingCheck.day.floor * 0.6,JSON.stringify(lightingCheck));
    assert.ok(lightingCheck.night.desk / lightingCheck.day.desk > lightingCheck.night.floor / lightingCheck.day.floor + 0.1,JSON.stringify(lightingCheck));
    assert.ok(lightingCheck.precipitation.every(p=>p.changed>100&&p.escaped===0),JSON.stringify(lightingCheck));
    assert.ok(lightingCheck.precipitation.every(p=>p.indoorChanged===0&&p.outdoorChanged===(p.style==='city')),JSON.stringify(lightingCheck));

    const neonCheck = await win.webContents.executeJavaScript(`(async()=>{
      const {default:theme}=await import('./themes/pixel-office/theme.js');
      const {OfficeEnvironment}=await import('./office/environment.js');
      const canvas=document.createElement('canvas');canvas.width=3200;canvas.height=2000;
      const c=canvas.getContext('2d',{willReadFrequently:true});
      const render=(clock,condition)=>{
        const time=Date.parse('2026-10-26T'+clock+':00+09:00'),env=new OfficeEnvironment({now:()=>time});
        env.setWeather({available:true,observedAt:time,condition,temperature:14});
        theme.drawScene(c,[],500,{environment:env.snapshot()});
        return c.getImageData(0,0,3200,2000).data;
      };
      const regular=render('21:59','clear'),neon=render('22:00','clear');
      let changed=0,purple=0;
      for(let i=0;i<regular.length;i+=4){
        if(regular[i]!==neon[i]||regular[i+1]!==neon[i+1]||regular[i+2]!==neon[i+2])changed++;
        if(neon[i]>neon[i+1]*1.15&&neon[i+2]>neon[i+1]*1.25)purple++;
      }
      const rainBefore=render('21:59','rain'),rainAfter=render('22:00','rain');
      const rainIdentical=rainBefore.every((v,i)=>v===rainAfter[i]);
      const restored=render('22:00','clear');
      return {changed,purple,rainIdentical,restored:neon.every((v,i)=>v===restored[i])};
    })()`);
    assert.equal(neonCheck.changed,0,JSON.stringify(neonCheck));
    assert.ok(neonCheck.rainIdentical&&neonCheck.restored,JSON.stringify(neonCheck));

    const sunsetCheck = await win.webContents.executeJavaScript(`(async()=>{
      const {getTheme}=await import('./themes/index.js'),{OfficeEnvironment}=await import('./office/environment.js');
      const c=document.createElement('canvas');c.width=3200;c.height=2000;const x=c.getContext('2d',{willReadFrequently:true});
      const checks=[];
      for(const id of ['pixel-office','pixel-office-plain']){
        const theme=getTheme(id),p=theme.project(1000,576);
        const render=(clock)=>{const time=Date.parse('2026-10-27T'+clock+':00+09:00'),env=new OfficeEnvironment({now:()=>time});env.setWeather({available:true,observedAt:time,condition:'clear',temperature:16});theme.drawScene(x,[],500,{environment:env.snapshot()});const pixels=x.getImageData(0,0,3200,2000).data,patch=x.getImageData(p.x-8,p.y-8,16,16).data;let warmth=0;for(let n=0;n<patch.length;n+=4)warmth+=patch[n]-patch[n+2];return {pixels,warmth:warmth/256};};
        const day=render('14:59'),sunset=render('15:00'),late=render('17:59'),night=render('18:00'),lateNight=render('22:00');
        checks.push({id,dayDifferent:day.pixels.some((v,n)=>v!==sunset.pixels[n]),sunsetStable:sunset.pixels.every((v,n)=>v===late.pixels[n]),nightDifferent:night.pixels.some((v,n)=>v!==sunset.pixels[n]),nightStable:night.pixels.every((v,n)=>v===lateNight.pixels[n]),dayWarmth:day.warmth,sunsetWarmth:sunset.warmth});
      }
      return checks;
    })()`);
    assert.ok(sunsetCheck.every(c=>c.dayDifferent&&c.sunsetStable&&c.nightDifferent&&c.nightStable&&c.sunsetWarmth>c.dayWarmth+5),JSON.stringify(sunsetCheck));
    for(const [id,name] of [['pixel-office','office-sunset'],['pixel-office-plain','office-plain-sunset']]){
      await selectTheme(id);
      await win.webContents.executeJavaScript(`(()=>{const v=window.__view,time=Date.parse('2026-10-27T16:30:00+09:00');v.environment.now=()=>time;v.environment.setWeather({available:true,observedAt:time,temperature:16,condition:'clear'});v.fit();v.draw(performance.now());})()`);
      await pause(100);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await selectTheme('pixel-office');

    for(const [name,night,condition,late] of [['office-day',false,'clear'],['office-night',true,'clear'],['office-night-rain',true,'rain'],['office-night-snow',true,'snow'],['office-neon',true,'clear',true],['office-late-rain',true,'rain',true]]){
      await win.webContents.executeJavaScript(`(()=>{const v=window.__view,time=Date.parse('${late?'2026-10-26T22:30:00':night?'2026-10-26T20:00:00':'2026-10-26T12:00:00'}+09:00');
        v.environment.now=()=>time;v.environment.setWeather({available:true,stale:false,observedAt:time,temperature:${condition==='snow'?-2:16},cloudCover:${condition==='clear'?10:95},condition:'${condition}'});v.fit();v.draw(performance.now());})()`);
      await pause(100);
      fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    const themeSwitch = await selectTheme('pixel-office-plain');
    for(const [name,night] of [['office-plain-day',false],['office-plain-night',true]]){
      await win.webContents.executeJavaScript(`(()=>{const v=window.__view,time=Date.parse('${night?'2026-10-26T20:00:00':'2026-10-26T12:00:00'}+09:00');
        v.environment.now=()=>time;v.environment.setWeather({available:true,observedAt:time,temperature:16,condition:'clear'});v.fit();v.draw(performance.now());})()`);
      await pause(100);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    const plainCheck=await win.webContents.executeJavaScript(`(async()=>{
      const {getTheme}=await import('./themes/index.js'),v=window.__view;
      const canvas=document.createElement('canvas');canvas.width=3200;canvas.height=2000;const c=canvas.getContext('2d');
      const state={environment:{night:false,condition:'clear'}};
      getTheme('pixel-office-plain').drawScene(c,[],0,state);const plain=c.getImageData(0,0,80,80).data;
      const uniform=plain.every((value,i)=>value===[237,242,235,255][i%4]);
      const p=v.theme.project(1000,576),inside=c.getImageData(p.x-5,p.y-5,10,10).data;
      getTheme('pixel-office').drawScene(c,[],0,state);const city=c.getImageData(0,0,80,80).data,cityInside=c.getImageData(p.x-5,p.y-5,10,10).data;
      return {uniform,cityDifferent:city.some((value,i)=>value!==plain[i]),interiorIdentical:inside.every((value,i)=>value===cityInside[i])};
    })()`);
    assert.ok(plainCheck.uniform&&plainCheck.cityDifferent&&plainCheck.interiorIdentical,JSON.stringify(plainCheck));
    await selectTheme('pixel-office-citypop');
    const citypopCheck=await win.webContents.executeJavaScript(`(async()=>{
      const {getTheme}=await import('./themes/index.js'),theme=getTheme('pixel-office-citypop');
      const {drawCityscape}=await import('./themes/pixel-office/cityscape.js');
      const background=document.createElement('canvas');background.width=3200;background.height=2000;
      const bc=background.getContext('2d');bc.scale(2,2);drawCityscape(bc,{width:1600,height:1000});
      window.__citypopBackground=background.toDataURL('image/png').split(',')[1];
      const order=[...document.querySelector('#theme-select').options].map(o=>o.value);
      const canvas=document.createElement('canvas');canvas.width=3200;canvas.height=2000;const c=canvas.getContext('2d');
      const render=(night,condition,t=0)=>{theme.drawScene(c,[],t,{environment:{night,sunset:!night,neon:night,condition}});return c.getImageData(0,0,3200,2000).data;};
      const day=render(false,'clear'),night=render(true,'clear');
      const fixedDawn=day.every((value,i)=>value===night[i]);
      getTheme('pixel-office').drawScene(c,[],0,{environment:{night:true,neon:true,condition:'clear'}});
      const normal=c.getImageData(0,0,3200,2000).data;let changed=0;
      for(let i=0;i<normal.length;i+=4)if(day[i]!==normal[i]||day[i+1]!==normal[i+1]||day[i+2]!==normal[i+2])changed++;
      const weather=[];
      for(const condition of ['rain','snow']){
        render(false,condition,0);const outside=c.getImageData(0,0,400,250).data,p=theme.project(1000,576),inside=c.getImageData(p.x-5,p.y-5,10,10).data;
        render(false,condition,360);const nextOutside=c.getImageData(0,0,400,250).data,nextInside=c.getImageData(p.x-5,p.y-5,10,10).data;
        weather.push({condition,moving:outside.some((value,i)=>value!==nextOutside[i]),indoorStable:inside.every((value,i)=>value===nextInside[i])});
      }
      window.__view.fit();window.__view.draw(performance.now());
      return {order,fixedDawn,changed,weather};
    })()`);
    assert.equal(citypopCheck.order[2],'pixel-office-citypop');
    assert.ok(citypopCheck.fixedDawn&&citypopCheck.changed>500000,JSON.stringify(citypopCheck));
    assert.ok(citypopCheck.weather.every(w=>w.moving&&w.indoorStable),JSON.stringify(citypopCheck));
    await pause(100);fs.writeFileSync(path.join(OUT,'office-citypop.png'),(await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(OUT,'citypop-background.png'),Buffer.from(await win.webContents.executeJavaScript('window.__citypopBackground'),'base64'));
    await selectTheme('pixel-office');
    const weatherVideo = await win.webContents.executeJavaScript(`(async()=>{
      const v=window.__view,originalClock=v.environment.now;
      const stream=v.canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise(r=>{recorder.onstop=r;});
      recorder.start();
      for(const [night,condition] of [[false,'clear'],[true,'clear'],[true,'rain'],[true,'snow']]){
        const time=Date.parse((night?'2026-10-26T20:00:00':'2026-10-26T12:00:00')+'+09:00');
        v.environment.now=()=>time;v.environment.setWeather({available:true,stale:false,observedAt:time,condition,temperature:condition==='snow'?-2:16,cloudCover:10});
        v.fit();
        await new Promise(r=>setTimeout(r,1400));
      }
      recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());v.environment.now=originalClock;
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
    })()`);
    fs.writeFileSync(path.join(OUT,'office-weather.webm'),Buffer.from(weatherVideo,'base64'));
    await pause(100);
    fs.writeFileSync(path.join(OUT,'office-window-snow.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`window.__view.environment.now=()=>Date.parse('2026-10-26T12:00:00+09:00');window.__view.environment.setWeather({available:true,stale:false,observedAt:Date.parse('2026-10-26T12:00:00+09:00'),temperature:16,cloudCover:10,condition:'clear'});`);
    await win.webContents.executeJavaScript(`window.__view.fit();`);

    const inspect = () => win.webContents.executeJavaScript(`({zoom:window.__view.camera.zoom,ox:window.__view.camera.ox,oy:window.__view.camera.oy,
      player:{x:window.__view.life.player.x,y:window.__view.life.player.y,action:window.__view.life.player.action,interaction:window.__view.life.player.interaction?.id},
      bounds:(()=>{const r=document.querySelector('#office').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()})`);
    const beforeDrag = await inspect();
    const dragX = Math.round(beforeDrag.bounds.width / 2), dragY = Math.round(beforeDrag.bounds.y + beforeDrag.bounds.height / 2);
    win.webContents.sendInputEvent({type:'mouseMove',x:dragX,y:dragY});
    win.webContents.sendInputEvent({type:'mouseDown',x:dragX,y:dragY,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseMove',x:dragX+110,y:dragY+45});
    win.webContents.sendInputEvent({type:'mouseUp',x:dragX+110,y:dragY+45,button:'left',clickCount:1});
    await pause(100);
    const afterDrag = await inspect();
    assert.equal(beforeDrag.ox,afterDrag.ox,'full office must stay fixed');
    assert.equal(beforeDrag.oy,afterDrag.oy,'full office must stay fixed');
    assert.equal(afterDrag.player.x,beforeDrag.player.x,'drag must not move player');
    win.webContents.sendInputEvent({type:'mouseWheel',x:dragX,y:dragY,deltaY:300,deltaX:0});
    await pause(150); const afterZoom = await inspect(); assert.ok(afterZoom.zoom>afterDrag.zoom,JSON.stringify({before:afterDrag.zoom,after:afterZoom.zoom}));
    win.webContents.sendInputEvent({type:'mouseMove',x:dragX,y:dragY});
    win.webContents.sendInputEvent({type:'mouseDown',x:dragX,y:dragY,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseMove',x:dragX+80,y:dragY+30});
    win.webContents.sendInputEvent({type:'mouseUp',x:dragX+80,y:dragY+30,button:'left',clickCount:1});
    await pause(100); const zoomedDrag=await inspect(); assert.notEqual(afterZoom.ox,zoomedDrag.ox,'zoomed view should pan');

    const inputPoint = async (kind, id) => win.webContents.executeJavaScript(`(async()=>{
      const {default:theme}=await import('./themes/pixel-office/theme.js');const v=window.__view;
      let point;
      if(${JSON.stringify(kind)}==='floor')point=theme.project(1450,576);
      else if(${JSON.stringify(kind)}==='skills')point=theme.project(theme.layout.rooms.skills.x+440,theme.layout.rooms.skills.y+410);
      else {const item=theme.layout.interactions.find(i=>i.id===${JSON.stringify(id)});point=theme.project(item.x+item.w/2,item.y+item.d/2);point.y-=item.height;}
      v.camera.centerOn(point);v.syncCamera();const r=v.canvas.getBoundingClientRect();
      return {x:Math.round(r.x+v.view.ox+point.x*v.view.scale),y:Math.round(r.y+v.view.oy+point.y*v.view.scale)};
    })()`);
    const click = async p => {win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1});await pause(100);};
    await click(await inputPoint('floor'));
    await win.webContents.executeJavaScript(`for(let i=0;i<1000;i++)window.__view.life.update(50)`);
    const afterMove=await inspect(); assert.ok(Math.hypot(afterMove.player.x-1450,afterMove.player.y-576)<4);
    await click(await inputPoint('item','vending'));
    const approach=await inspect(); assert.equal(approach.player.action,null);assert.equal(approach.player.interaction,'vending');
    await win.webContents.executeJavaScript(`for(let i=0;i<1200&&!window.__view.life.player.action;i++)window.__view.life.update(50);window.__view.zoomBy(2/window.__view.camera.zoom);`);
    const afterDrink=await inspect(); assert.equal(afterDrink.player.action,'drink');
    await inputPoint('item','vending'); await pause(100);
    await fs.promises.writeFile(path.join(OUT,'office-interaction.png'),(await win.webContents.capturePage()).toPNG());
    const skillPoint=await inputPoint('skills');win.webContents.sendInputEvent({type:'mouseMove',...skillPoint});await pause(150);
    const skillTip=await win.webContents.executeJavaScript(`({hidden:document.querySelector('#tooltip').hidden,text:document.querySelector('#tooltip').textContent})`);
    assert.equal(skillTip.hidden,false);assert.match(skillTip.text,/documents:documents/);assert.match(skillTip.text,/spreadsheets:Spreadsheets/);
    await fs.promises.writeFile(path.join(OUT,'office-skills.png'),(await win.webContents.capturePage()).toPNG());
    const annexes=[];
    await click(await inputPoint('item','elevator'));
    const elevatorCheck=await win.webContents.executeJavaScript(`(()=>{const v=window.__view;
      for(let i=0;i<2000&&!v.life.player.action;i++)v.life.update(50);
      return {action:v.life.player.action,amount:v.life.doors.find(d=>d.id==='elevator').amount};})()`);
    assert.equal(elevatorCheck.action,'elevator');assert.equal(elevatorCheck.amount,1);
    await pause(100);
    fs.writeFileSync(path.join(OUT,'office-elevator-open.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(()=>{const v=window.__view;v.life.moveTo({x:500,y:576});for(let i=0;i<160;i++)v.life.update(50);})()`);
    assert.equal(await win.webContents.executeJavaScript(`window.__view.life.doors.find(d=>d.id==='elevator').amount`),0);
    await pause(100);
    fs.writeFileSync(path.join(OUT,'office-elevator-closed.png'),(await win.webContents.capturePage()).toPNG());
    for (const id of ['restroom-door','ceo-door']) {
      await click(await inputPoint('item',id));
      const entered=await win.webContents.executeJavaScript(`(()=>{const v=window.__view;
        for(let i=0;i<2000&&!v.life.player.action;i++)v.life.update(50);
        const p=v.life.player;return {room:v.engine.roomAt(p.x,p.y),action:p.action,door:v.life.doors.find(d=>d.id===${JSON.stringify(id)}).amount};})()`);
      assert.equal(entered.room,id==='ceo-door'?'ceo':'restroom');assert.equal(entered.action,'visit');assert.equal(entered.door,1);
      annexes.push(entered);
      await win.webContents.executeJavaScript(`(()=>{const v=window.__view,r=v.theme.layout.rooms[${JSON.stringify(entered.room)}];v.camera.centerOn(v.theme.project(r.x+r.w/2,r.y+r.h/2));v.syncCamera();})()`);
      await pause(120);
      await fs.promises.writeFile(path.join(OUT,`office-${entered.room}.png`),(await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript(`document.querySelector('#focus-player').click()`);
    const focus=await inspect();assert.equal(focus.zoom,1.8);
    await win.webContents.executeJavaScript(`document.querySelector('#zoom-fit').click()`);
    const interactionCheck={fitDrag:afterDrag.ox-beforeDrag.ox,zoomedDrag:zoomedDrag.ox-afterZoom.ox,wheelZoom:afterZoom.zoom,movedTo:afterMove.player,drinkAction:afterDrink.player.action,skillTip:skillTip.text,annexes};

    await click(await inputPoint('item','lounge-coffee'));
    await win.webContents.executeJavaScript(`for(let i=0;i<1600&&!window.__view.life.menu;i++)window.__view.life.update(50);window.__view.notify();`);
    await pause(150);
    const coffeeMenu=await win.webContents.executeJavaScript(`(()=>{const panel=document.querySelector('#interaction-menu'),list=panel.querySelector('.drink-choices'),r=panel.getBoundingClientRect();return {hidden:panel.hidden,count:panel.querySelectorAll('[data-drink]').length,width:r.width,height:r.height,scrollable:list.scrollHeight>list.clientHeight,images:[...list.querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth>40),held:window.__view.life.player.heldItem?.id||null};})()`);
    assert.equal(coffeeMenu.hidden,false);assert.equal(coffeeMenu.count,6);assert.equal(coffeeMenu.scrollable,true);assert.equal(coffeeMenu.images,true);
    assert.ok(coffeeMenu.width<=235&&coffeeMenu.height<=260,JSON.stringify(coffeeMenu));
    fs.writeFileSync(path.join(OUT,'office-coffee-menu.png'),(await win.webContents.capturePage()).toPNG());
    const listPoint=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.drink-choices').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),zoom:window.__view.camera.zoom};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:listPoint.x,y:listPoint.y});
    win.webContents.sendInputEvent({type:'mouseWheel',x:listPoint.x,y:listPoint.y,deltaY:-350,deltaX:0});
    // 휠 스크롤은 컴포지터에서 150~400ms 동안 단계적으로 움직이고 중간에 멈추기도 한다. 고정 대기 대신 끝까지 내려갈 때까지 기다린다.
    const listScroll=await win.webContents.executeJavaScript(`new Promise(resolve=>{const list=document.querySelector('.drink-choices'),start=performance.now();(function poll(){const done=list.scrollTop>=list.scrollHeight-list.clientHeight-1;if(done||performance.now()-start>3000)resolve({top:list.scrollTop,zoom:window.__view.camera.zoom});else setTimeout(poll,16);})();})`);
    assert.ok(listScroll.top>0);assert.equal(listScroll.zoom,listPoint.zoom);
    fs.writeFileSync(path.join(OUT,'office-drinks-scroll.png'),(await win.webContents.capturePage()).toPNG());
    const choicePoint=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[data-drink="soda"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    await click(choicePoint);
    await win.webContents.executeJavaScript(`for(let i=0;i<55;i++)window.__view.life.update(50);window.__view.focusPlayer();`);
    const selectedCoffee=await win.webContents.executeJavaScript(`({hidden:document.querySelector('#interaction-menu').hidden,id:window.__view.life.player.heldItem?.id,image:window.__view.life.player.heldItem?.image,action:window.__view.life.player.action})`);
    assert.equal(selectedCoffee.hidden,true);assert.equal(selectedCoffee.id,'soda');assert.equal(selectedCoffee.action,'drink');assert.match(selectedCoffee.image,/\/soda\.png$/);
    await pause(100);fs.writeFileSync(path.join(OUT,'office-coffee-carry.png'),(await win.webContents.capturePage()).toPNG());
    await selectTheme('pixel-office-plain');await selectTheme('pixel-office-citypop');await selectTheme('pixel-office');
    assert.equal(await win.webContents.executeJavaScript(`window.__view.life.player.heldItem?.id`),'soda');
    await click(await inputPoint('floor'));
    assert.equal(await win.webContents.executeJavaScript(`window.__view.life.player.heldItem?.id`),'soda');
    await win.webContents.executeJavaScript(`for(let i=0;i<920;i++)window.__view.life.update(50);`);
    assert.equal(await win.webContents.executeJavaScript(`window.__view.life.player.heldItem`),null);
    const activities=[];
    for(const id of ['arcade','plant','reading','stretch']){
      await click(await inputPoint('item',id));
      const action=await win.webContents.executeJavaScript(`(()=>{const l=window.__view.life;for(let i=0;i<1600&&!l.player.action;i++)l.update(50);return l.player.action;})()`);
      activities.push({id,action});assert.equal(action,id==='plant'?'water':id==='reading'?'read':id);
      await win.webContents.executeJavaScript(`for(let i=0;i<180;i++)window.__view.life.update(50);`);
    }
    const lifeVideo=await win.webContents.executeJavaScript(`(async()=>{
      const v=window.__view,l=v.life,item=v.theme.layout.interactions.find(i=>i.id==='lounge-coffee');
      Object.assign(l.player,{x:item.stand.x,y:item.stand.y,path:[],action:null,interaction:null,currentItem:null,heldItem:null});
      l.interact(item.id);for(let i=0;i<5;i++)l.update(50);l.chooseDrink('latte');v.focusPlayer();
      const stream=v.canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise(r=>{recorder.onstop=r;});recorder.start();
      await new Promise(r=>setTimeout(r,3300));l.moveTo({x:1440,y:1000});await new Promise(r=>setTimeout(r,1800));
      l.interact('stretch');await new Promise(r=>setTimeout(r,2400));recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
    })()`);
    fs.writeFileSync(path.join(OUT,'office-life.webm'),Buffer.from(lifeVideo,'base64'));
    interactionCheck.coffee={choices:coffeeMenu.count,size:[coffeeMenu.width,coffeeMenu.height],scrolled:listScroll.top,selected:selectedCoffee.id,expired:true};interactionCheck.activities=activities;

    const annexVideo=await win.webContents.executeJavaScript(`(async()=>{
      const v=window.__view,p=v.life.player;Object.assign(p,{x:280,y:1240,path:[],action:null,interaction:null,currentItem:null,pose:'stand',status:'idle'});
      v.life.doors.forEach(d=>{d.amount=0;d.heldUntil=0;});
      v.zoomBy(2.4/v.camera.zoom);v.camera.centerOn(v.theme.project(300,1430));v.syncCamera();
      const stream=v.canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise(r=>{recorder.onstop=r;});
      recorder.start();v.life.interact('ceo-door');await new Promise(r=>setTimeout(r,1800));
      v.life.moveTo({x:300,y:1600});await new Promise(r=>setTimeout(r,2200));recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());v.fit();
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
    })()`);
    fs.writeFileSync(path.join(OUT,'office-annex.webm'),Buffer.from(annexVideo,'base64'));

    const tour = await win.webContents.executeJavaScript(`(async()=>{
      const {default:theme}=await import('./themes/pixel-office/theme.js');const v=window.__view;
      const stream=v.canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      const stopped=new Promise(r=>{recorder.onstop=r;});
      v.focusPlayer();v.life.interact('laptop');recorder.start();
      await new Promise(r=>setTimeout(r,2400));
      const room=theme.layout.rooms.skills;v.camera.centerOn(theme.project(room.x+230,room.y+300));v.syncCamera();
      await new Promise(r=>setTimeout(r,2200));recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
      v.fit();const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
    })()`);
    fs.writeFileSync(path.join(OUT,'office-tour.webm'),Buffer.from(tour,'base64'));

    const video = await win.webContents.executeJavaScript(`(async () => {
      const {drawCharacter} = await import('./themes/pixel-office/sprites.js');
      const canvas=document.createElement('canvas');canvas.width=960;canvas.height=240;
      const c=canvas.getContext('2d');
      const cases=[['walk','working','WALK'],['type','working','TYPE'],['read','working','READ'],['run','working','RUN'],['talk','working','TALK'],['alert','idle','ALERT'],['stand','sharing','SHARE'],['sit','resting','REST']];
      const draw=()=>{
        c.fillStyle='#f3eddf';c.fillRect(0,0,960,240);
        c.fillStyle='#5a5144';c.font='bold 18px monospace';c.fillText('AGENT OFFICE / CHARACTER ACTIONS',24,32);
        for(let i=0;i<cases.length;i++){
          const [pose,status,label]=cases[i];c.save();c.translate(i*120+60,150);c.scale(3,3);
          drawCharacter(c,{pose,status,facing:'down',colorIndex:i%8,role:'dev'},performance.now(),0,0);c.restore();
          c.fillStyle='#857966';c.font='12px monospace';c.fillText(label,i*120+36,193);
        }
      };
      draw();const stream=canvas.captureStream(12);const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});const chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      const stopped=new Promise(resolve=>{recorder.onstop=resolve;});
      const timer=setInterval(draw,80);recorder.start();await new Promise(r=>setTimeout(r,3200));recorder.stop();await stopped;
      clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      return btoa(binary);
    })()`);
    fs.writeFileSync(path.join(OUT, 'character-actions.webm'), Buffer.from(video, 'base64'));
    win.setSize(1100, 680);
    await pause(350);
    const small = await win.webContents.executeJavaScript(`({overflow:document.documentElement.scrollWidth>innerWidth,canvasWidth:document.querySelector('#office').width})`);
    assert.equal(small.overflow, false);
    assert.ok(small.canvasWidth > 0);
    await fs.promises.writeFile(path.join(OUT, 'office-1100.png'), (await win.webContents.capturePage()).toPNG());
    const codexSprites = await win.webContents.executeJavaScript(`(async()=>{
      const {drawCharacter}=await import('./themes/pixel-office/sprites.js');
      const {ACCESSORIES}=await import('./office/appearance.js');
      const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=440;const c=canvas.getContext('2d');
      c.fillStyle='#f4eddf';c.fillRect(0,0,1000,440);c.fillStyle='#414e65';c.font='20px "Malgun Gothic"';c.fillText('적용된 코덱스 근무자 · 85% 크기',25,32);
      const frame=(a,t)=>{const c=document.createElement('canvas');c.width=c.height=96;drawCharacter(c.getContext('2d'),{pose:'stand',status:'working',facing:'down',colorIndex:1,...a},t,40,60);return c;};
      const data=c=>Array.from(c.getContext('2d').getImageData(0,0,96,96).data);
      const cases=[['걷기','walk','working'],['작업','type','working'],['독서','read','working'],['실행','run','working'],['대화','talk','working'],['확인 요청','alert','idle'],['결과 공유','stand','sharing'],['휴식','sit','resting']];
      const changes=cases.map(([title,pose,status],i)=>{
        const a={cli:'codex',pose,status},first=frame(a,0),second=frame(a,130),before=data(first),after=data(second);
        c.imageSmoothingEnabled=false;c.drawImage(first,18,15,45,50,i*124+8,50,112,125);
        c.fillStyle='#635d54';c.font='13px "Malgun Gothic"';c.fillText(title,i*124+34,194);
        return {pose,status,changed:before.some((v,j)=>v!==after[j])};
      });
      const looks=ACCESSORIES.map((accessory,i)=>{
        const f=frame({cli:'codex',appearance:{accessory}},0);
        c.drawImage(f,18,15,45,50,i*140+10,215,126,140);
        c.font='12px "Malgun Gothic"';c.fillStyle='#635d54';c.fillText(['기본','안경','둥근 안경','모자','비니','리본','헤드셋'][i],i*140+48,376);
        return f.toDataURL();
      });
      const base=frame({cli:'codex'},0),pixels=data(base);let minX=96,maxX=0,minY=96,maxY=0,blue=0,orange=0;
      for(let y=0;y<96;y++)for(let x=0;x<96;x++){const n=(y*96+x)*4;if(!pixels[n+3])continue;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);if(pixels[n]===88&&pixels[n+1]===135&&pixels[n+2]===216)blue++;if(pixels[n]===215&&pixels[n+1]===123&&pixels[n+2]===87)orange++;}
      const claudeUnchanged=frame({},0).toDataURL()===frame({cli:'claude'},0).toDataURL();
      const facePixels=(a)=>{
        const pixels=data(frame({cli:'codex',...a},0)),offset=['sit','type','read','run'].includes(a.pose)?12:0;let cyan=0;
        for(let y=60-offset+Math.round(-24*.85);y<60-offset+Math.round(-11*.85);y++)for(let x=28;x<52;x++){
          const n=(y*96+x)*4;if(pixels[n]===180&&pixels[n+1]===238&&pixels[n+2]===233)cyan++;
        }
        return cyan;
      };
      const faces=ACCESSORIES.flatMap(accessory=>['up','down','left','right'].flatMap(facing=>['stand','type'].map(pose=>({accessory,facing,pose,cyan:facePixels({pose,facing,appearance:{accessory}})}))));
      const walkingBack=facePixels({pose:'walk',facing:'up'});
      c.font='13px "Malgun Gothic"';c.fillStyle='#635d54';c.fillText('실제 렌더러로 검증 · 클로드 외형 유지 · 코덱스 팀장과 하위 에이전트 공통 적용',25,417);
      return {changes,looks:new Set(looks).size,bounds:[maxX-minX+1,maxY-minY+1],blue,orange,claudeUnchanged,faceCases:faces.length,minimumFacePixels:Math.min(...faces.map(f=>f.cyan)),walkingBack,png:canvas.toDataURL().split(',')[1]};
    })()`);
    assert.deepEqual(codexSprites.bounds,[24,27]);assert.ok(codexSprites.blue>0&&codexSprites.orange===0&&codexSprites.claudeUnchanged);
    assert.equal(codexSprites.looks,7);assert.ok(codexSprites.changes.every(c=>c.changed),JSON.stringify(codexSprites.changes));
    assert.ok(codexSprites.minimumFacePixels>=20,JSON.stringify(codexSprites));assert.equal(codexSprites.walkingBack,0);
    fs.writeFileSync(path.join(OUT,'codex-character-applied.png'),Buffer.from(codexSprites.png,'base64'));delete codexSprites.png;
    win.setSize(1600,1000);await pause(200);
    await win.webContents.executeJavaScript(`document.querySelector('#new-tab').click();document.querySelector('input[name="tab-kind"][value="codex"]').click();document.querySelector('#pick-folder').click();`);
    await pause(200);
    event('SessionStart',{session_id:'preview-codex',_cli:'codex'});
    event('UserPromptSubmit',{session_id:'preview-codex',_cli:'codex',prompt:'사무실 캐릭터 적용 검토'});
    event('SubagentStart',{session_id:'preview-codex',_cli:'codex',agent_id:'codex-worker',agent_type:'executor'});
    event('PreToolUse',{session_id:'preview-codex',_cli:'codex',agent_id:'codex-worker',tool_name:'apply_patch',tool_input:{file_path:'codex-sprite.js'}});
    win.webContents.send('pty:data',{tabId,data:'코덱스 캐릭터 화면 검증\r\n합성 이벤트를 사용하며 실제 AI는 호출하지 않습니다.\r\n'});
    await pause(150);
    const codexScene=await win.webContents.executeJavaScript(`(async()=>{
      const v=window.__view,e=window.__engine;const {getTheme}=await import('./themes/index.js');
      await v.setTheme(getTheme('pixel-office-plain'));document.querySelector('#theme-select').value='pixel-office-plain';
      for(let i=0;i<500;i++)e.update(50);v.fit();v.draw(0);
      const pixels=v.canvas.getContext('2d').getImageData(0,0,v.canvas.width,v.canvas.height).data;
      return e.snapshot().filter(a=>a.id.startsWith('preview-codex:')).map(a=>{
        const p=v.theme.project(a.x,a.y),s=v.camera.scale*v.view.dpr,ox=v.camera.ox*v.view.dpr,oy=v.camera.oy*v.view.dpr;
        const lift=['sit','type','read','run'].includes(a.pose)?12:0;let facePixels=0;
        const left=Math.floor(ox+(p.x-30)*s),right=Math.ceil(ox+(p.x+30)*s),top=Math.floor(oy+(p.y+(Math.round(-24*.85)-lift)*3)*s),bottom=Math.ceil(oy+(p.y+(Math.round(-11*.85)-lift)*3)*s);
        for(let y=Math.max(0,top);y<Math.min(v.canvas.height,bottom);y++)for(let x=Math.max(0,left);x<Math.min(v.canvas.width,right);x++){
          const n=(y*v.canvas.width+x)*4;if(pixels[n]===180&&pixels[n+1]===238&&pixels[n+2]===233)facePixels++;
        }
        return {id:a.id,cli:a.cli,pose:a.pose,facing:a.facing,facePixels};
      });
    })()`);
    assert.equal(codexScene.length,2);assert.ok(codexScene.every(a=>a.cli==='codex'));
    assert.ok(codexScene.find(a=>a.id==='preview-codex:codex-worker').facePixels>=12,JSON.stringify(codexScene));
    // 실제로 검사한 애니메이션 프레임을 캡처한다 (커서가 꺼진 순간을 피한다).
    await win.webContents.executeJavaScript(`(()=>{const v=window.__view,draw=v.draw;v.draw=function(){return draw.call(this,0);};v.draw();})()`);
    await pause(100);fs.writeFileSync(path.join(OUT,'office-codex-applied.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(()=>{const v=window.__view,a=window.__engine.snapshot().find(a=>a.id==='preview-codex:codex-worker');v.zoomBy(2.4/v.camera.zoom);v.camera.centerOn(v.theme.project(a.x,a.y));v.syncCamera();v.draw(0);})()`);
    await pause(100);fs.writeFileSync(path.join(OUT,'office-codex-face-closeup.png'),(await win.webContents.capturePage({x:0,y:105,width:1119,height:753})).toPNG());
    const petMode = await win.webContents.executeJavaScript("document.querySelector('#pet-mode').value");
    assert.equal(petMode, 'always');

    // 「펫 그림」 버튼 → 선택 대화상자: 목록 렌더 · 미리보기 · 선택 · 가져오기 오류 한 줄 · 삭제 확인 · 닫으면 비운다
    const petpickRead = () => win.webContents.executeJavaScript(`(() => {
      const radios = k => [...document.querySelectorAll('input[name="petpick-' + k + '"]')].map(r => ({ value: r.value, checked: r.checked }));
      const names = k => [...document.querySelectorAll('#petpick-' + k + ' .petcard-name')].map(n => n.textContent);
      return { open: document.querySelector('#petpick').open, claude: radios('claude'), codex: radios('codex'), names: names('claude'), codexNames: names('codex'),
        injected: document.querySelectorAll('#petpick b').length, deletes: [...document.querySelectorAll('#petpick .petcard .btn')].map(b => b.textContent),
        canvases: document.querySelectorAll('#petpick canvas').length, msg: document.querySelector('#petpick-msg').textContent,
        painted: [...document.querySelectorAll('#petpick canvas')].map(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i]; return s > 0; }) };
    })()`);
    await win.webContents.executeJavaScript(`document.querySelector('#pet-art').click()`);
    await pause(700);
    const pick = await petpickRead();
    assert.equal(pick.open, true, '펫 그림 버튼으로 대화상자가 열린다');
    assert.deepEqual(pick.claude, [{ value: '', checked: true }, { value: 'none', checked: false }, { value: 'builtin:office-claude', checked: false }, { value: 'user:mine', checked: false }]);
    assert.deepEqual(pick.codex.map(r => [r.value, r.checked]), [['', false], ['none', false], ['builtin:office-claude', false], ['user:mine', true]], '설정 원값대로 선택 표시');
    assert.deepEqual(pick.names, ['기본', '아이콘만', '기본 클로드', '<b>내 펫</b>'], '이름은 textContent 로만');
    assert.equal(pick.injected, 0, 'HTML 이 해석되지 않는다');
    assert.deepEqual(pick.deletes, ['삭제', '삭제'], '가져온 펫(두 구역)에만 삭제 버튼');
    assert.equal(pick.canvases, 4, '펫 카드마다 미리보기 캔버스 (두 구역 × 두 펫)');
    assert.ok(pick.painted.every(Boolean), `미리보기가 그려짐: ${pick.painted}`);
    assert.deepEqual(petCalls.preview.slice().sort(), ['builtin:office-claude', 'user:mine'], '미리보기는 펫마다 한 번씩만 받는다');
    // 라디오를 바꾸면 선택을 보낸다 (기본 = null)
    await win.webContents.executeJavaScript(`document.querySelector('input[name="petpick-claude"][value="none"]').click()`);
    await pause(150);
    await win.webContents.executeJavaScript(`document.querySelector('input[name="petpick-codex"][value=""]').click()`);
    await pause(150);
    assert.deepEqual(petCalls.select, [{ kind: 'claude', value: 'none' }, { kind: 'codex', value: null }]);
    // 가져오기 오류는 한 줄로 (정해진 문구)
    await win.webContents.executeJavaScript(`document.querySelector('#petpick-zip').click()`);
    await pause(200);
    assert.deepEqual(petCalls.import, ['zip']);
    assert.equal((await petpickRead()).msg, '올바른 zip 파일이 아닙니다');
    await win.webContents.executeJavaScript(`document.querySelector('#petpick-folder').click()`);
    await pause(200);
    assert.deepEqual(petCalls.import, ['zip', 'folder']);
    // 삭제는 확인을 거친다
    await win.webContents.executeJavaScript(`window.confirm = () => false; document.querySelector('#petpick .petcard .btn').click()`);
    await pause(150);
    assert.deepEqual(petCalls.remove, [], '확인에서 취소하면 삭제하지 않는다');
    await win.webContents.executeJavaScript(`window.confirm = () => true; document.querySelector('#petpick .petcard .btn').click()`);
    await pause(200);
    assert.deepEqual(petCalls.remove, ['user:mine']);
    // 닫으면 목록과 미리보기 캔버스를 비운다
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('#petpick .petpick-actions button')].at(-1).click()`);
    await pause(150);
    const closedPick = await petpickRead();
    assert.deepEqual([closedPick.open, closedPick.canvases, closedPick.claude.length], [false, 0, 0]);
    // 다시 열면 처음부터 다시 그린다
    await win.webContents.executeJavaScript(`document.querySelector('#pet-art').click()`);
    await pause(400);
    assert.equal((await petpickRead()).claude.length, 4);
    await win.webContents.executeJavaScript(`document.querySelector('#petpick').close()`);
    await pause(100);
    assert.equal((await petpickRead()).open, false);

    assert.deepEqual(errors, []);
    await permCardCheck();
    console.log(JSON.stringify({petMode,status,small,attention,spriteChanges:spriteCheck.changes,codexSprites,codexScene,artCheck,lightingCheck,neonCheck,sunsetCheck,themeSwitch,plainCheck,citypopCheck,interactionCheck,consoleErrors:errors,output:OUT}, null, 2));
    clearTimeout(watchdog);
    app.exit(0);
  }).catch(e => { console.error(e.stack || e); console.error(JSON.stringify({ consoleErrors: errors })); clearTimeout(watchdog); app.exit(1); });
}
