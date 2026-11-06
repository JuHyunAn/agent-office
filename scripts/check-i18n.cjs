// 번역 누락 찾기 — src 의 주석이 아닌 문자열 리터럴 중 한글이 남은 것을 파일별로 보여 준다.
// 사전(src/shared/i18n/**)과 일부러 한국어로 두는 파일(AI 에게 보내는 프롬프트 등)은 뺀다.
// npm test 에 넣지 않는다(다른 세션이 문구를 더할 때 테스트가 깨지지 않게). 실행: npm run check:i18n [-- --all]
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HANGUL = /[가-힣]/;
// 통째로 한국어로 두는 파일 — AI 에게 보내는 규칙·프롬프트.
const SKIP_FILES = new Set(['src/main/collabRules.cjs']);
const showAll = process.argv.includes('--all');

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['i18n', 'assets'].includes(e.name)) files(p, out); }
    else if (/\.(c?js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 주석을 건너뛰며 문자열 리터럴(따옴표·백틱)과 그 줄 번호를 모은다. 정규식 리터럴은 대충 건너뛴다.
function literals(src) {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  let prevSignificant = '';
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prevSignificant)) { // 정규식 리터럴
      i++; let cls = false;
      while (i < n && src[i] !== '\n') { if (src[i] === '\\') { i += 2; continue; } if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; else if (src[i] === '/' && !cls) break; i++; }
      i++; prevSignificant = ')'; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = line; let j = i + 1, s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
        if (src[j] === '\n') { if (c !== '`') break; line++; }
        s += src[j]; j++;
      }
      out.push({ line: start, text: s });
      i = j + 1; prevSignificant = ')'; continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

// HTML: 주석을 빼고 태그 밖 글자·속성 값의 한글. data-i18n* 가 붙은 요소는 화면에서 덮어쓰므로 뺀다.
function htmlHits(src) {
  const out = [];
  const clean = src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
  const lines = clean.split('\n');
  lines.forEach((l, k) => {
    if (!HANGUL.test(l)) return;
    if (/data-i18n/.test(l)) {
      // 같은 줄에 키 없는 한글 요소가 섞였는지 대충 본다: 키 붙은 요소를 지우고 남은 한글
      const rest = l.replace(/<([a-z]+)[^>]*data-i18n[^>]*>[^<]*<\/\1>/g, '').replace(/<[^>]*data-i18n[^>]*>/g, '');
      if (!HANGUL.test(rest)) return;
    }
    out.push({ line: k + 1, text: l.trim().slice(0, 140) });
  });
  return out;
}

let total = 0;
const report = [];
for (const f of files(path.join(ROOT, 'src'))) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (SKIP_FILES.has(rel)) continue;
  const src = fs.readFileSync(f, 'utf8');
  const hits = f.endsWith('.html') ? htmlHits(src) : literals(src).filter(x => HANGUL.test(x.text));
  if (!hits.length) continue;
  total += hits.length;
  report.push([rel, hits]);
}
report.sort((a, b) => b[1].length - a[1].length);
for (const [rel, hits] of report) {
  console.log(`${String(hits.length).padStart(4)}  ${rel}`);
  if (showAll) for (const h of hits) console.log(`        ${h.line}: ${h.text.replace(/\n/g, '\\n').slice(0, 120)}`);
}
console.log(`합계 ${total}곳 (프롬프트·판별 정규식처럼 일부러 남긴 것 포함 — --all 로 줄별 보기)`);
