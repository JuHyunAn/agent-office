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
  const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
  const { pathToFileURL } = require('node:url');
  const assert = require('node:assert/strict');
  const OUT = path.join(ROOT, 'output', 'design');
  const errors = [];
  let win, tabId;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const event = (name, extra = {}) => win.webContents.send('hook:event', {
    session_id: 'preview-main', cwd: ROOT, hook_event_name: name, _tab: tabId, ...extra,
  });
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ao-render-')));
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const watchdog = setTimeout(() => { console.error('Renderer check timed out'); app.exit(1); }, 60000);

  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    protocol.handle('app', req => {
      const target = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname)));
      if (!target.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });
    ipcMain.handle('app:status', () => ({ claude: { version: '디자인 검증' }, auth: { loggedIn: true }, hook: { global: { installed: false } } }));
    ipcMain.handle('weather:current', () => ({ available: true, stale: false, location: '서울',
      observedAt: Date.parse('2026-10-26T12:00:00+09:00'), temperature: 16, cloudCover: 10, condition: 'clear' }));
    ipcMain.handle('dialog:pickFolder', () => ROOT);
    ipcMain.handle('pty:create', (_e, options) => { tabId = options.tabId; return { sessionId: 'preview-main' }; });
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
        const start=performance.now();while(v.theme.id!==${JSON.stringify(id)}){
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
      for(const condition of ['rain','snow']){
        const env={night:true,condition};let backdrop=exterior.drawBackground(c,0,env);
        c.clearRect(0,0,1600,1000);a.drawWindows(c,0,env,backdrop);const before=c.getImageData(0,0,3200,2000).data;
        backdrop=exterior.drawBackground(c,360,env);
        c.clearRect(0,0,1600,1000);a.drawWindows(c,360,env,backdrop);const after=c.getImageData(0,0,3200,2000).data;
        let changed=0,escaped=0;
        for(let i=0;i<before.length;i+=4)if(before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2]){
          changed++;const x=(i/4%3200)/2,y=Math.floor(i/4/3200)/2;
          if(!WINDOWS.some(pane=>{const p=projectPoint(pane.x,pane.y,pane.top),u=(x-p.x)*(pane.axis==='y'?-1:1),v=y-p.y-u*0.5;return u>=-2&&u<=pane.w*0.36+2&&v>=-2&&v<=pane.top-pane.bottom+2;}))escaped++;
        }
        c.setTransform(1,0,0,1,0,0);
        const interiorPoints=[...Object.values(theme.layout.rooms).map(r=>theme.project(r.x+r.w/2,r.y+r.h/2)),theme.project(1000,576)];
        const samples=()=>interiorPoints.map(p=>c.getImageData(p.x-8,p.y-8,16,16).data);
        theme.drawScene(c,[],0,{environment:env});
        const indoorBefore=samples(),outdoorBefore=c.getImageData(0,0,400,300).data;
        theme.drawScene(c,[],360,{environment:env});
        const indoorAfter=samples(),outdoorAfter=c.getImageData(0,0,400,300).data;
        const indoorChanged=indoorBefore.reduce((total,pixels,index)=>total+Number(pixels.some((v,j)=>v!==indoorAfter[index][j])),0);
        const outdoorChanged=outdoorBefore.some((v,j)=>v!==outdoorAfter[j]);
        precipitation.push({condition,changed,escaped,indoorChanged,outdoorChanged});
        c.setTransform(2,0,0,2,0,0);
      }
      return {day,night,windows:WINDOWS.length,deskLights:DESK_LIGHTS.length,precipitation};
    })()`);
    assert.equal(lightingCheck.windows,7);
    assert.equal(lightingCheck.deskLights,18);
    assert.ok(lightingCheck.night.floor < lightingCheck.day.floor * 0.6,JSON.stringify(lightingCheck));
    assert.ok(lightingCheck.night.desk / lightingCheck.day.desk > lightingCheck.night.floor / lightingCheck.day.floor + 0.1,JSON.stringify(lightingCheck));
    assert.ok(lightingCheck.precipitation.every(p=>p.changed>100&&p.escaped===0),JSON.stringify(lightingCheck));
    assert.ok(lightingCheck.precipitation.every(p=>p.indoorChanged===0&&p.outdoorChanged),JSON.stringify(lightingCheck));

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
    assert.ok(neonCheck.changed>500000&&neonCheck.purple>100000,JSON.stringify(neonCheck));
    assert.ok(neonCheck.rainIdentical&&neonCheck.restored,JSON.stringify(neonCheck));

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
    win.webContents.sendInputEvent({type:'mouseWheel',x:listPoint.x,y:listPoint.y,deltaY:-350,deltaX:0});await pause(150);
    const listScroll=await win.webContents.executeJavaScript(`({top:document.querySelector('.drink-choices').scrollTop,zoom:window.__view.camera.zoom})`);
    assert.ok(listScroll.top>0);assert.equal(listScroll.zoom,listPoint.zoom);
    fs.writeFileSync(path.join(OUT,'office-drinks-scroll.png'),(await win.webContents.capturePage()).toPNG());
    const choicePoint=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[data-drink="soda"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    await click(choicePoint);
    await win.webContents.executeJavaScript(`for(let i=0;i<55;i++)window.__view.life.update(50);window.__view.focusPlayer();`);
    const selectedCoffee=await win.webContents.executeJavaScript(`({hidden:document.querySelector('#interaction-menu').hidden,id:window.__view.life.player.heldItem?.id,image:window.__view.life.player.heldItem?.image,action:window.__view.life.player.action})`);
    assert.equal(selectedCoffee.hidden,true);assert.equal(selectedCoffee.id,'soda');assert.equal(selectedCoffee.action,'drink');assert.match(selectedCoffee.image,/\/soda\.png$/);
    await pause(100);fs.writeFileSync(path.join(OUT,'office-coffee-carry.png'),(await win.webContents.capturePage()).toPNG());
    await selectTheme('pixel-office-plain');await selectTheme('pixel-office');
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
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({status,small,spriteChanges:spriteCheck.changes,artCheck,lightingCheck,neonCheck,themeSwitch,plainCheck,interactionCheck,consoleErrors:errors,output:OUT}, null, 2));
    clearTimeout(watchdog);
    app.exit(0);
  }).catch(e => { console.error(e.stack || e); console.error(JSON.stringify({ consoleErrors: errors })); clearTimeout(watchdog); app.exit(1); });
}
