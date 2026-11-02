'use strict';

// 협업 대화의 모델 목록 캐시를 AI 별로 관리한다: 받은 목록은 앱 실행 중 재사용하고, 실패한 AI 만 다음 호출에서 다시 조회한다
// (한 AI 의 실패 때문에 오래 걸리는 다른 AI 조회를 되풀이하지 않게).
// fetchers: { id: async () => ({ list, error, final }) } — list 가 비면 실패, final: true 면 실패여도 다시 시도하지 않는다 (예: 설치되지 않은 AI).
// 결과 모양: { <id>: 목록 | null, ..., errors: { <id>: 문구 } } — fetchers 의 키 순서대로.
// models.reset(id): 그 AI 의 확정·진행 중 조회를 버려 다음 호출에서 다시 조회한다 (예: 「미설치」로 굳은 AI 를 앱 안에서 설치한 직후).
function createModelCatalog(fetchers, { onFail = () => {} } = {}) {
  const done = new Map(); // id → 확정된 결과 { list, error }
  const flying = new Map(); // id → 진행 중인 조회 (동시에 부르면 한 번만 조회)
  const ids = Object.keys(fetchers);

  const lookup = (id) => {
    if (done.has(id)) return Promise.resolve(done.get(id));
    if (!flying.has(id)) {
      const job = (async () => {
        let r;
        try { r = await Promise.resolve().then(() => fetchers[id]()); } catch (e) { r = { error: e.message }; }
        const res = { list: r?.list?.length ? r.list : null, error: String(r?.error || '') };
        if (flying.get(id) !== job) return res; // 조회 중에 reset 됐다 — 옛 결과는 저장하지 않는다
        if (res.list || r?.final) done.set(id, res);
        else onFail(id, res.error);
        flying.delete(id);
        return res;
      })();
      flying.set(id, job);
    }
    return flying.get(id);
  };

  async function models() {
    const results = await Promise.all(ids.map(lookup));
    const out = {}; const errors = {};
    ids.forEach((id, i) => {
      out[id] = results[i].list;
      if (!results[i].list && results[i].error) errors[id] = results[i].error;
    });
    return { ...out, errors };
  }
  models.reset = (id) => { done.delete(id); flying.delete(id); };
  return models;
}

module.exports = { createModelCatalog };
