/* 라벨 규칙 — 맥북 쪽 labels.py와 같은 계산이다 (test.html로 두 쪽 결과를 대조한다). 전역 Rules로 노출.
 * 순간: S 양손이 시작 홀드에 · L 이륙 · T 탑 처음 터치 · M 탑 양손 · R 양손이 떨어짐 · E 착지
 * 완등 = R − M ≥ sendHoldMs. S만 있고 L이 없으면 '시도 아님'. 사람이 직접 고른 결과(override)가 우선. */
(function (root) {
  'use strict';

  const KEYS = ['S', 'L', 'T', 'M', 'R', 'E'];
  const DEFAULTS = {
    sendHoldMs: 1000,
    eventKeys: KEYS,
    eventNames: { S: '양손이 시작 홀드에', L: '이륙 (발이 바닥에서)', T: '탑 처음 터치', M: '탑 양손', R: '양손이 떨어짐', E: '착지' },
    eventShort: { S: '시작', L: '이륙', T: '터치', M: '양손', R: '떨어짐', E: '착지' },
    eventHelp: {
      S: '양손이 시작 홀드에 함께 들어온 순간',
      L: '마지막 발이 매트(바닥)에서 떨어진 순간',
      T: '한 손이 탑 홀드에 처음 닿은 순간',
      M: '양손이 탑 홀드를 함께 잡은 순간',
      R: '한 손이라도 탑 홀드에서 떨어진 순간',
      E: '발이 매트로 돌아온 순간 (추락·뛰어내림 착지)',
    },
    results: ['SEND', 'FAIL', 'UNKNOWN', 'NOT_ATTEMPT'],
    resultNames: { SEND: '완등', FAIL: '실패', UNKNOWN: '판단 불가', NOT_ATTEMPT: '시도 아님', INCOMPLETE: '입력 중' },
    angles: { FRONT: '정면', SIDE: '측면', LOW: '아래에서', HIGH: '위에서', FAR: '멀리서' },
    cameras: { FIXED: '거치 고정', HANDHELD: '손으로 듦', PAN: '따라가며 촬영' },
    people: { ONE: '1명', FEW: '2~3명', MANY: '4명 이상' },
    exCodes: {},
    standardHelp: '',
    targets: null,
    rareEx: [],
  };

  function config(remote) {
    return Object.assign({}, DEFAULTS, remote || {});
  }

  /** m:ss.cc — labels.py fmt_ms와 같은 정수 계산 */
  function fmtMs(ms) {
    if (ms == null) return '—';
    const cs = Math.floor((Math.trunc(ms) + 5) / 10);
    const m = Math.floor(cs / 6000);
    const r = cs % 6000;
    return `${m}:${String(Math.floor(r / 100)).padStart(2, '0')}.${String(r % 100).padStart(2, '0')}`;
  }

  function events(a) {
    const ev = (a && a.events) || {};
    const out = {};
    for (const k of KEYS) if (ev[k] != null) out[k] = Math.trunc(ev[k]);
    return out;
  }

  function orderIssues(ev) {
    const out = [];
    const seq = ['L', 'T', 'M', 'R', 'E'].filter((k) => k in ev);
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i], b = seq[i + 1];
      if (ev[a] > ev[b]) out.push(`순서가 이상해요: ${a} ${fmtMs(ev[a])} > ${b} ${fmtMs(ev[b])}`);
    }
    if ('S' in ev) {
      const early = ['T', 'M', 'R', 'E'].filter((k) => k in ev && ev[k] < ev.S);
      if (early.length) out.push(`S가 ${early.join(', ')}보다 늦어요`);
    }
    return out;
  }

  /** 찍은 순간으로 계산한 결과 (직접 고른 결과는 보지 않음) → [결과, 문제 목록] */
  function derive(a, cfg) {
    const ev = events(a);
    const issues = orderIssues(ev);
    const has = (k) => k in ev;
    if (!Object.keys(ev).length) return ['INCOMPLETE', issues.concat(['찍은 순간이 없어요'])];
    if (!has('L')) {
      if (has('S') && !has('T') && !has('M') && !has('R')) return ['NOT_ATTEMPT', issues];
      return ['INCOMPLETE', issues.concat(['L(이륙)이 필요해요'])];
    }
    let result;
    if (has('M')) {
      if (!has('R')) return ['INCOMPLETE', issues.concat(['R(합손 풀림)이 필요해요'])];
      result = ev.R - ev.M >= cfg.sendHoldMs ? 'SEND' : 'FAIL';
    } else {
      if (has('R')) issues.push('R은 M(합손)이 있을 때만 찍어요');
      result = 'FAIL';
    }
    if (!has('E')) issues.push('E(착지)가 필요해요');
    return [result, issues];
  }

  function interval(a, result) {
    const ev = events(a);
    const starts = ['S', 'L'].filter((k) => k in ev).map((k) => ev[k]);
    const start = starts.length ? Math.min(...starts) : null;
    let end = null;
    if (result === 'SEND') end = 'M' in ev ? ev.M : ('E' in ev ? ev.E : null);
    else if (result === 'FAIL') end = 'E' in ev ? ev.E : null;
    else if (result === 'UNKNOWN') { for (const k of ['E', 'R', 'M', 'T']) if (k in ev) { end = ev[k]; break; } }
    else return null;
    if (start == null || end == null || end <= start) return null;
    return [start, end];
  }

  function evaluateAttempt(a, cfg) {
    const [derived, issues0] = derive(a, cfg);
    let issues = issues0;
    const ov = a.override && cfg.results.includes(a.override.result) ? a.override.result : null;
    const result = ov || derived;
    const ev = events(a);
    const evaluable = result === 'SEND' || result === 'FAIL' || result === 'UNKNOWN';
    const iv = evaluable ? interval(a, result) : null;
    if (evaluable && !iv && !issues.length) issues = issues.concat(['시도 구간을 정할 수 없어요 (시작 S/L과 끝 M/E를 확인해 주세요)']);
    return {
      result, derived, issues,
      overridden: result !== derived,
      interval: iv,
      complete: result === 'NOT_ATTEMPT' || iv !== null,
      holdMs: 'M' in ev && 'R' in ev ? ev.R - ev.M : null,
    };
  }

  /** 다음에 찍을 순간 → {key, alt} (alt: 탑에 못 갔으면 착지) 또는 null */
  function nextEvent(a) {
    const ev = events(a);
    const has = (k) => k in ev;
    if (!has('S') && !has('L')) return { key: 'S', alt: 'L' };
    if (!has('L')) return { key: 'L', alt: null };
    if (has('M') && !has('R')) return { key: 'R', alt: null };
    if (has('E')) return null;
    if (!has('T') && !has('M')) return { key: 'T', alt: 'E' };
    if (has('T') && !has('M')) return { key: 'M', alt: 'E' };
    return { key: 'E', alt: null };
  }

  /** 쉬운 말 판정 문장 */
  function verdictText(a, cfg) {
    const r = evaluateAttempt(a, cfg);
    const ev = events(a);
    const sec = (ms) => `${(ms / 1000).toFixed(1)}초`;
    if (r.overridden) {
      const reason = a.override && a.override.reason ? ` · ${a.override.reason}` : '';
      return `${cfg.resultNames[r.result]} — 직접 고름${reason}`;
    }
    switch (r.result) {
      case 'SEND': return `완등 — 탑 양손 ${sec(r.holdMs)} 유지`;
      case 'FAIL':
        if ('M' in ev) return `실패 — 탑 양손 ${sec(r.holdMs)} (${sec(cfg.sendHoldMs)} 미만)`;
        if ('T' in ev) return '실패 — 탑을 양손으로 못 잡음';
        return '실패 — 탑에 닿지 못함';
      case 'NOT_ATTEMPT': return `시도 아님 (이륙 없음) — 이륙했다면 '${cfg.eventNames.L}'을(를) 찍어 주세요`;
      case 'UNKNOWN': return '판단 불가';
      default: {
        const n = nextEvent(a);
        return n ? `입력 중 — '${cfg.eventNames[n.key]}'을(를) 찍어 주세요` : '입력 중';
      }
    }
  }

  function labelStatus(label, cfg) {
    const results = {};
    let n = 0, incomplete = 0;
    const problems = label.problems || [];
    for (const p of problems) for (const a of p.attempts || []) {
      n++;
      const r = evaluateAttempt(a, cfg);
      if (r.complete) results[r.result] = (results[r.result] || 0) + 1; else incomplete++;
    }
    const tags = label.tags || {};
    return {
      attempts: n,
      results,
      incomplete,
      roisReady: problems.length > 0 && problems.every((p) => (p.startRois || []).length > 0 && !!p.topRoi),
      tagsReady: !!(tags.angle && tags.camera),
      done: !!label.done,
      state: label.done && !incomplete ? 'done' : 'doing',
    };
  }

  function sortedObj(counter) {
    const o = {};
    for (const k of Object.keys(counter).sort()) o[k] = counter[k];
    return o;
  }

  function coverage(labels, cfg) {
    const res = { SEND: 0, FAIL: 0, UNKNOWN: 0, NOT_ATTEMPT: 0 };
    const byAngle = {}, byCamera = {}, byPeople = {}, ex = {};
    const gyms = {};
    let stdAttempts = 0, stdSends = 0, incomplete = 0, videos = 0;
    const inc = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };
    for (const lab of labels) {
      const tags = lab.tags || {};
      let nVideo = 0;
      for (const p of lab.problems || []) for (const a of p.attempts || []) {
        const r = evaluateAttempt(a, cfg);
        if (!r.complete) { incomplete++; continue; }
        res[r.result]++;
        if (r.result === 'NOT_ATTEMPT') continue;
        nVideo++;
        for (const c of a.ex || []) inc(ex, c);
        if (tags.standard === true) { stdAttempts++; if (r.result === 'SEND') stdSends++; }
      }
      if (nVideo) {
        videos++;
        const gym = (tags.gym || '').trim();
        if (gym) { const key = gym.toLowerCase().replace(/ /g, ''); if (!(key in gyms)) gyms[key] = gym; }
        inc(byAngle, tags.angle || '?', nVideo);
        inc(byCamera, tags.camera || '?', nVideo);
        inc(byPeople, tags.people || '?', nVideo);
      }
    }
    return {
      videos,
      attempts: res.SEND + res.FAIL + res.UNKNOWN,
      sends: res.SEND,
      fails: res.FAIL,
      unknown: res.UNKNOWN,
      notAttempt: res.NOT_ATTEMPT,
      incomplete,
      gyms: Object.keys(gyms).length,
      gymNames: Object.values(gyms).sort(),
      angles: Object.keys(byAngle).filter((a) => a !== '?').length,
      byAngle: sortedObj(byAngle),
      byCamera: sortedObj(byCamera),
      byPeople: sortedObj(byPeople),
      standard: { attempts: stdAttempts, sends: stdSends },
      ex: sortedObj(ex),
      targets: Object.assign({}, cfg.targets || { attempts: 0, sends: 0, gyms: 0, angles: 0 }),
    };
  }

  function suggestions(cov, cfg) {
    const out = [];
    const t = cov.targets;
    if (cov.attempts < t.attempts) out.push(`시도 ${t.attempts - cov.attempts}건 더 필요해요 (지금 ${cov.attempts}/${t.attempts})`);
    if (cov.sends < t.sends) out.push(`완등 시도 ${t.sends - cov.sends}건 더 (지금 ${cov.sends}/${t.sends})`);
    if (cov.attempts && cov.fails < Math.max(10, Math.floor(cov.attempts * 0.3 + 0.5))) {
      out.push(`실패 시도도 필요해요 — 완등만 있으면 오검출을 못 잡아요 (지금 ${cov.fails}건)`);
    }
    if (cov.gyms < t.gyms) out.push(`다른 암장 영상 (지금 ${cov.gyms}/${t.gyms}곳)`);
    const missing = Object.keys(cfg.angles).filter((a) => !cov.byAngle[a]).map((a) => cfg.angles[a]);
    if (cov.angles < t.angles && missing.length) out.push(`다른 각도 (지금 ${cov.angles}/${t.angles}종) — 아직 없는 각도: ${missing.join(', ')}`);
    if (!cov.byCamera.HANDHELD && !cov.byCamera.PAN) out.push('손으로 들거나 따라가며 찍은 영상 (움직이는 카메라 검증용)');
    if (cov.attempts && cov.standard.attempts < cov.attempts * 0.5) out.push(`표준 촬영 조건 영상 — ${cfg.standardHelp}`);
    const rare = (cfg.rareEx || []).filter((c) => !cov.ex[c]);
    if (cov.attempts >= 10 && rare.length) out.push(`특이 상황 영상: ${rare.map((c) => cfg.exCodes[c]).join(', ')}`);
    if (cov.incomplete) out.push(`입력이 덜 끝난 시도 ${cov.incomplete}건 — 목록의 ⚠ 표시를 확인해 주세요`);
    return out;
  }

  /** 영상 지문 — labels.py fingerprint와 같은 값: SHA-1(크기 문자열 + 앞 1MB + (2MB 넘으면) 뒤 1MB) 앞 16자 */
  async function fingerprintBlob(blob) {
    const MB = 1 << 20;
    const size = blob.size;
    const parts = [new TextEncoder().encode(String(size)), new Uint8Array(await blob.slice(0, Math.min(size, MB)).arrayBuffer())];
    if (size > 2 * MB) parts.push(new Uint8Array(await blob.slice(size - MB, size).arrayBuffer()));
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  function newLabel(file, fingerprint, meta) {
    const video = { file, fingerprint };
    for (const k of ['durationMs', 'width', 'height', 'fps']) if (meta && meta[k] != null) video[k] = meta[k];
    return {
      schema: 'climb-label/1',
      video,
      tags: { gym: '', angle: null, camera: null, people: null, standard: null, note: '' },
      problems: [{ id: 'p1', name: '', startRois: [], topRoi: null, attempts: [] }],
      done: false,
      updatedAt: null,
    };
  }

  /** 저장 전 정리 (정수 시각, 빈 값 정리) — labels.py validate를 통과하는 모양 */
  function normalizeLabel(label) {
    const out = JSON.parse(JSON.stringify(label));
    out.schema = 'climb-label/1';
    const t = out.tags || {};
    out.tags = {
      gym: (t.gym || '').trim(),
      angle: t.angle || null,
      camera: t.camera || null,
      people: t.people || null,
      standard: t.standard === true || t.standard === false ? t.standard : null,
      note: (t.note || '').trim(),
    };
    out.done = !!out.done;
    (out.problems || []).forEach((p, pi) => {
      p.id = p.id || `p${pi + 1}`;
      p.name = (p.name || '').trim();
      p.startRois = (p.startRois || []).slice(0, 2);
      p.topRoi = p.topRoi || null;
      const seen = new Set();
      (p.attempts || []).forEach((a, ai) => {
        let id = a.id;
        if (!id || seen.has(id)) { let n = ai + 1; while (seen.has(`a${n}`)) n++; id = `a${n}`; }
        seen.add(id);
        a.id = id;
        const ev = {};
        for (const k of KEYS) if (a.events && a.events[k] != null) ev[k] = Math.max(0, Math.round(a.events[k]));
        a.events = ev;
        a.override = a.override && DEFAULTS.results.includes(a.override.result)
          ? { result: a.override.result, reason: (a.override.reason || '').trim() } : null;
        a.ex = Array.from(new Set(a.ex || [])).sort();
        a.note = (a.note || '').trim();
      });
      p.attempts = p.attempts || [];
    });
    return out;
  }

  root.Rules = {
    KEYS, DEFAULTS, config, fmtMs, events, orderIssues, derive, interval, evaluateAttempt, nextEvent, verdictText,
    labelStatus, coverage, suggestions, fingerprintBlob, newLabel, normalizeLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
