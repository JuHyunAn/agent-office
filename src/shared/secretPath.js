// 비밀 파일 이름 판별 — 메인(require)·화면(import)이 함께 쓴다.
// 규칙: 순수 함수만 둔다. import 금지, DOM·Node API 금지, 최상위 await·import.meta 금지 (메인이 require(esm) 로 읽는다).

// 비밀이 담기기 쉬운 경로 (DENY_SETTINGS 의 Read 거부와 같은 범위): .env, .env.*, *.pem, *.key, id_rsa*, .git/ 아래.
// 어느 깊이에서든 대소문자 무시. 이 경로의 내용은 프롬프트에 싣지 않는다.
const SECRET_FILE = /^(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*)$/i;

export function isSecretPath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const pieces = rel.replace(/\\/g, '/').split('/');
  if (pieces.some((d) => d.toLowerCase() === '.git')) return true;
  return SECRET_FILE.test(pieces[pieces.length - 1]);
}
