import { t } from '../../shared/i18n.js';

// 모나코 편집기(VS Code 편집기) 지연 로드.
// 번들러가 없어서 ESM 빌드(CSS import 124개)는 쓰지 않고 AMD 빌드(min/vs)를 쓴다. 지원 중단 예고가 있으니 package.json 에서 버전을 고정해 둔다.
// loader.js 는 index.html 에 넣지 않고 처음 필요할 때 주입한다 — xterm UMD 가 전역 define.amd 를 보고 AMD 로 등록되어 깨지는 것을 막기 위해
// (xterm 은 이미 로드된 뒤다). 워커를 쓰므로 CSP 에 worker-src 'self' blob: 가 있어야 한다.

// index.html 기준 상대 경로 (app://office/src/renderer/index.html → app://office/node_modules/...)
const VS = '../../node_modules/monaco-editor/min/vs';

// 자바스크립트·타입스크립트 언어 서비스는 끈다 — 파일 하나만 덩그러니 열린 모델에는 가짜 빨간 줄이 생기고 TS 워커가 계속 떠 있게 된다.
const SERVICES_OFF = {
  completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false,
  rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false,
  codeActions: false, inlayHints: false,
};

function quiet(monaco) {
  // 최상위 monaco.typescript 가 실제 API 다 (monaco.languages.typescript 는 지원 중단 자리표시). 없으면 건너뛴다.
  for (const defaults of [monaco.typescript?.typescriptDefaults, monaco.typescript?.javascriptDefaults]) {
    defaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
    defaults?.setModeConfiguration(SERVICES_OFF);
  }
}

let loading = null;

// 한 번만 불러오고 같은 Promise 를 돌려준다. 실패하면 거부 (다음 호출도 같은 거부를 받는다 — 앱을 다시 켜면 재시도).
export function loadMonaco() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${VS}/loader.js`;
    script.onerror = () => reject(new Error(t('code.monaco.loaderFailed')));
    script.onload = () => {
      try {
        window.require.config({ paths: { vs: VS } });
        window.require(['vs/editor/editor.main'], () => {
          try { quiet(window.monaco); resolve(window.monaco); } catch (e) { reject(e); }
        }, reject);
      } catch (e) { reject(e); }
    };
    document.head.append(script);
  });
  return loading;
}
