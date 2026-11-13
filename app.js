'use strict';
/* 클라이밍 라벨링 화면. 규칙은 rules.js, 저장·동기화는 store.js. 화면 문구에는 전문 용어를 쓰지 않는다. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const COLORS = { S: '#4cc9f0', L: '#8b9cff', T: '#ffd166', M: '#ff9f1a', R: '#ff6b6b', E: '#cfd3da' };
const START_COLOR = '#3ddc84';
const TOP_COLOR = '#ff9f1a';
const KEY_CODES = { KeyS: 'S', KeyL: 'L', KeyT: 'T', KeyM: 'M', KeyR: 'R', KeyE: 'E' };
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const REPO_HINT_KEY = 'climb-labeler:repo';

const video = $('#video');
const canvas = $('#overlay');
const ctx = canvas.getContext('2d');
const timeline = $('#timeline');

const S = {
  cfg: Rules.config(), store: null, server: null, videos: [], labels: new Map(),
  src: null, fp: null, label: null, pi: 0, ai: -1, selKey: null, tab: 'moments',
  draw: null, drag: null, undo: [], unsaved: false, typingSnap: false,
  fps: 30, fpsKnown: false, speedIdx: 2, objectUrl: null,
  view: { s: 1, tx: 0, ty: 0 }, pointers: new Map(), pinch: null,
  batch: [], meta: new Map(), batchOpen: false,
};

// ---------------------------------------------------------------- 도구

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') e.value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const fmt = (ms) => Rules.fmtMs(ms);
const fmtTime = (sec) => { const m = Math.floor(sec / 60); return `${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`; };
const prob = () => S.label.problems[S.pi];
const curAttempt = () => (S.label && S.ai >= 0 && S.ai < prob().attempts.length ? prob().attempts[S.ai] : null);
const curMs = () => Math.round((video.currentTime || 0) * 1000);
const durMs = () => (video.duration && isFinite(video.duration) ? video.duration * 1000 : (S.label && S.label.video.durationMs) || 0);

function resultClass(r) {
  if (!r.complete) return 'warn';
  return { SEND: 'send', FAIL: 'fail', UNKNOWN: 'unk', NOT_ATTEMPT: 'muted' }[r.result];
}

function ago(d) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return '방금';
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(msg, actionLabel, onAction) {
  $('#toastText').textContent = msg;
  const btn = $('#toastAction');
  btn.hidden = !actionLabel;
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.onclick = () => { $('#toast').hidden = true; onAction(); };
  }
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, actionLabel ? 5000 : 1800);
}

function banner(kind, text, actionLabel, onAction) {
  $('#banners').append(h('div', { class: `banner ${kind}` }, h('span', {}, text),
    actionLabel ? h('button', { class: 'btn small', onclick: onAction }, actionLabel) : null));
}

// ---------------------------------------------------------------- 시작

function rememberRepoHint() {
  // 링크(#repo=…)로 한 번 들어오면 기억 → 홈 화면 앱(주소에 #repo 없음)에서도 저장소 칸이 채워진다
  const repo = new URLSearchParams(location.hash.slice(1)).get('repo');
  if (repo) { try { localStorage.setItem(REPO_HINT_KEY, repo); } catch (_) { /* 저장 공간 막힘 */ } }
}

function repoHint() {
  try { return localStorage.getItem(REPO_HINT_KEY) || ''; } catch (_) { return ''; }
}

/** 폰 사진 선택기는 파일 이름 대신 갤러리 번호(1000065656.mp4)를 준다 → '영상 43초 · #5656'으로 보여 준다.
 * (파일의 수정 시각은 촬영 시각이 아니라 처음 고른 시각이라 쓰지 않는다) */
function videoName(file, durationMs) {
  const m = /^(\d+)\.(mp4|mov|m4v)$/i.exec(file || '');
  if (!m) return file || '영상';
  return `영상${durationMs ? ` ${Math.round(durationMs / 1000)}초` : ''} · #${m[1].slice(-4)}`;
}

const labelName = (l) => videoName(l.video.file, l.video.durationMs);

async function init() {
  rememberRepoHint();
  bindUi();
  try {
    const settings = Store.loadSettings();
    S.store = new Store.LabelStore(await Store.openDb(), settings);
    S.store.onConflict = resolveConflict;
    S.store.subscribe(renderSync);
    S.server = await detectServer();
    if (S.server) S.videos = await (await fetch('api/videos', { cache: 'no-store' })).json();
    await afterConnect();
    await restoreBatch();
    if (!settings) showOnboarding();
    else if (S.server && S.videos.length) {
      const want = new URLSearchParams(location.hash.slice(1)).get('v');
      const v = S.videos.find((x) => x.name === want) || S.videos.find((x) => stateOf(x.meta.fingerprint) !== 'done') || S.videos[0];
      await openServerVideo(v.name);
    }
    setupUpdates();
  } catch (e) {
    banner('error', `시작하지 못했어요: ${e.message}`);
  }
  renderAll();
  setInterval(renderSync, 30000);
}

/** 앱 업데이트: 새 버전이 받아지면, 영상을 안 열었으면 바로 적용하고 열어 둔 상태면 배너로 묻는다 */
function setupUpdates() {
  const debug = new URLSearchParams(location.search).has('sw'); // 로컬 테스트용
  if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && !debug)) return;
  let applying = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applying) return;
    saveNow().finally(() => location.reload());
  });
  const offer = (w) => {
    if (!navigator.serviceWorker.controller) return; // 첫 설치
    const apply = () => { applying = true; w.postMessage('skipWaiting'); };
    if (!S.src) { apply(); return; }
    S.updateReady = apply;
    showUpdateBanner();
  };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
  }).catch(() => {});
}

function showUpdateBanner() {
  if (!S.updateReady || $('#updateBanner')) return;
  $('#banners').append(h('div', { class: 'banner info', id: 'updateBanner' },
    h('span', {}, '새 버전이 있어요. 적용하면 화면이 새로 고쳐져요 (라벨은 저장돼 있어요).'),
    h('button', { class: 'btn small', onclick: () => S.updateReady() }, '지금 적용')));
}

async function detectServer() {
  if (location.protocol === 'https:') return null;
  try {
    const r = await fetch('api/server', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (_) {
    return null;
  }
}

/** 연결(또는 체험 모드) 뒤: 설정·라벨 목록을 받아 화면을 맞춘다 */
async function afterConnect() {
  if (S.store.mode === 'github') {
    try {
      const remote = await S.store.fetchConfig();
      if (remote) S.cfg = Rules.config(remote);
    } catch (e) {
      banner('warn', `저장소 설정을 못 읽었어요: ${e.message}`);
    }
  }
  const all = await S.store.refreshAll();
  S.labels = new Map(all.filter((l) => l && l.video && l.video.fingerprint).map((l) => [l.video.fingerprint, l]));
  S.meta = new Map((await S.store.allMeta()).map((m) => [m.fp, m]));
  await S.store.refreshPending();
  renderTagOptions();
  renderList();
  if (S.label) renderLabel();
}

// ---------------------------------------------------------------- 영상 열기

async function openServerVideo(name) {
  const v = S.videos.find((x) => x.name === name);
  if (!v) return;
  await leaveVideo();
  setSource({ kind: 'server', name, meta: v.meta }, `video/${encodeURIComponent(name)}`);
  S.fps = v.meta.fps || 30;
  S.fpsKnown = !!v.meta.fps;
  if (!S.fpsKnown) startFpsProbe();
  await loadLabel(v.meta.fingerprint, name, v.meta);
  history.replaceState(null, '', `#v=${encodeURIComponent(name)}`);
  if (v.meta.startTimeMs) banner('warn', `이 영상은 시작 시각이 0이 아니에요(${v.meta.startTimeMs}ms). 앱 분석 시각과 조금 어긋날 수 있어요.`);
}

async function openFile(file, knownFp) {
  if (!file) return;
  await leaveVideo();
  toast('영상 확인 중…');
  const fp = knownFp || await Rules.fingerprintBlob(file);
  if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
  S.objectUrl = URL.createObjectURL(file);
  setSource({ kind: 'file', name: file.name, meta: {} }, S.objectUrl);
  S.fps = 30;
  S.fpsKnown = false;
  startFpsProbe();
  await loadLabel(fp, file.name, {});
  const st = S.labels.has(fp) ? Rules.labelStatus(S.labels.get(fp), S.cfg) : null;
  toast(!st ? '새 영상이에요 — 홀드부터 표시해요'
    : st.state === 'done' ? `✓ 이미 끝낸 영상이에요 (시도 ${st.attempts}개) — 고칠 게 없으면 '다음 영상'`
      : '입력 중이던 영상이에요 — 이어서 해요');
  remember(fp, file, false);
  makeThumbs([{ file, fp }]);
}

// ---------------------------------------------------------------- 고른 영상 (여러 개 고르기 · 상태 구분)

// 고른 영상은 이 폰의 앱 전용 저장 공간(OPFS)에 복사해 둔다 → 새로 고치거나 다시 켜도 목록이 남고 바로 열린다.
// (사진 선택기로 고른 파일은 새로 고치면 다시 열 수 없다.) 끝낸 영상의 복사본은 지워 공간을 아낀다. 갤러리 원본은 건드리지 않는다.
const Copies = {
  supported: !!(navigator.storage && navigator.storage.getDirectory),
  async dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle('videos', { create: true }); },
  async save(fp, file) {
    const fh = await (await this.dir()).getFileHandle(`${fp}.mp4`, { create: true });
    if ((await fh.getFile()).size === file.size) return;
    const w = await fh.createWritable();
    try { await file.stream().pipeTo(w); } catch (e) { await this.remove(fp); throw e; }
  },
  async open(fp) {
    try { return await (await (await this.dir()).getFileHandle(`${fp}.mp4`)).getFile(); } catch (_) { return null; }
  },
  async remove(fp) { try { await (await this.dir()).removeEntry(`${fp}.mp4`); } catch (_) { /* 없음 */ } },
  async list() {
    const out = new Set();
    try { for await (const name of (await this.dir()).keys()) out.add(name.replace(/\.mp4$/, '')); } catch (_) { /* 미지원 */ }
    return out;
  },
};

/** 사진 선택기에서 고른 영상들: 지문으로 상태(안 함/입력 중/끝남)를 붙여 목록으로 보여 주고, 기기에 복사해 둔다 */
async function onFilesPicked(files) {
  if (!files.length) return;
  const items = [];
  for (let i = 0; i < files.length; i++) {
    if (files.length > 1) toast(`영상 확인 중 ${i + 1}/${files.length}`);
    items.push({ file: files[i], fp: await Rules.fingerprintBlob(files[i]) });
  }
  const base = Date.now();
  items.forEach((it, i) => {
    const ex = S.batch.find((b) => b.fp === it.fp);
    if (ex) { ex.file = it.file; ex.fromCopy = false; } else S.batch.push({ fp: it.fp, file: it.file, stored: false });
    remember(it.fp, it.file, base + i);
  });
  renderList();
  if (items.length === 1) await openFile(items[0].file, items[0].fp);
  else showBatch();
  makeThumbs(items);
  makeCopies(items);
}

function remember(fp, file, pickedAt) {
  const m = S.meta.get(fp) || { fp };
  m.name = file.name;
  m.sizeBytes = file.size;
  if (pickedAt) { m.lastPicked = pickedAt; m.inList = true; } else m.lastOpened = Date.now();
  S.meta.set(fp, m);
  S.store.putMeta(m);
}

/** 앱을 켤 때: 고른 영상 목록을 되살리고, 끝낸 영상·목록에 없는 영상의 복사본은 지운다 */
async function restoreBatch() {
  const stored = Copies.supported ? await Copies.list() : new Set();
  // inList가 없는 항목은 이전 버전에서 고른 영상 → 목록에 되살린다 (복사본이 없어 '다시 골라야 열려요')
  const listed = [...S.meta.values()].filter((m) => m.inList || (m.inList === undefined && m.lastPicked))
    .sort((a, b) => (a.lastPicked || 0) - (b.lastPicked || 0));
  S.batch = listed.map((m) => ({ fp: m.fp, file: null, stored: stored.has(m.fp) }));
  for (const fp of stored) {
    const m = S.meta.get(fp);
    if (!m || !m.inList || stateOf(fp) === 'done') {
      await Copies.remove(fp);
      const b = S.batch.find((x) => x.fp === fp);
      if (b) b.stored = false;
    }
  }
  renderList();
}

/** 목록의 영상 열기: 이번에 고른 파일 → 기기 복사본 → 없으면 다시 골라 달라고 안내 */
async function openBatchItem(b) {
  if (b.fp === S.fp) return;
  let file = b.file;
  if (!file && b.stored) {
    file = await Copies.open(b.fp);
    if (file) { b.file = file; b.fromCopy = true; } else b.stored = false;
  }
  if (!file) {
    toast(`'${itemName(b.fp)}'을(를) 다시 골라 주세요 — 고르면 라벨이 이어져요`);
    openPicker();
    return;
  }
  await openFile(file, b.fp);
}

const STATE_ORDER = { todo: 0, doing: 1, done: 2 };

function itemName(fp, fallback) {
  const m = S.meta.get(fp) || {};
  const l = S.labels.get(fp);
  return videoName(m.name || (l && l.video.file) || fallback || '영상', m.durationMs || (l && l.video.durationMs));
}

function thumbEl(fp) {
  const m = S.meta.get(fp);
  return m && m.thumb ? h('img', { class: 'thumb', src: m.thumb, alt: '' }) : h('span', { class: 'thumb empty' }, '🎬');
}

function stateChip(fp) {
  const l = S.labels.get(fp);
  const st = l ? Rules.labelStatus(l, S.cfg) : null;
  const state = st ? st.state : 'todo';
  return h('span', { class: `state ${state}` }, STATE_NAMES[state] + (st && st.attempts ? ` · 시도 ${st.attempts}` : ''));
}

function sortedBatch() {
  return S.batch.map((b, i) => ({ b, i })).sort((x, y) => (STATE_ORDER[stateOf(x.b.fp)] - STATE_ORDER[stateOf(y.b.fp)]) || (x.i - y.i)).map((x) => x.b);
}

function removeFromBatch(fps) {
  for (const fp of fps) {
    S.batch = S.batch.filter((b) => b.fp !== fp);
    const m = S.meta.get(fp);
    if (m) { m.inList = false; S.store.putMeta(m); }
    if (fp !== S.fp) Copies.remove(fp);
  }
  renderList();
}

function showBatch() {
  closeDrawer();
  if (!S.batch.length) { openPicker(); return; }
  const count = { todo: 0, doing: 0, done: 0 };
  for (const b of S.batch) count[stateOf(b.fp)]++;
  const storedMb = S.batch.filter((b) => b.stored).reduce((n, b) => n + ((S.meta.get(b.fp) || {}).sizeBytes || 0), 0) / 1e6;
  const close = () => { S.batchOpen = false; closeModal(); };
  S.batchOpen = true;
  openModal(
    h('h2', {}, `고른 영상 ${S.batch.length}개`),
    h('p', { class: 'batch-summary' },
      h('span', { class: 'state todo' }, `안 함 ${count.todo}`), ' ',
      h('span', { class: 'state doing' }, `입력 중 ${count.doing}`), ' ',
      h('span', { class: 'state done' }, `끝남 ${count.done}`)),
    h('ul', { class: 'batch-list' }, sortedBatch().map((b) => h('li', {
      class: `batch-row${b.fp === S.fp ? ' active' : ''}`,
      onclick: () => { close(); openBatchItem(b); },
    }, thumbEl(b.fp),
    h('span', { class: 'v-name' }, itemName(b.fp, b.file && b.file.name),
      !b.file && !b.stored ? h('span', { class: 'hint' }, '다시 골라야 열려요') : null),
    stateChip(b.fp),
    h('button', {
      class: 'btn small ghost row-x', 'aria-label': '목록에서 빼기', title: '목록에서 빼기 (라벨은 그대로)',
      onclick: (e) => { e.stopPropagation(); removeFromBatch([b.fp]); showBatch(); },
    }, '×')))),
    h('p', { class: 'muted small' }, Copies.supported
      ? `목록의 영상은 이 폰 안(앱 전용 공간)에 복사해 둬서 새로 고쳐도 바로 열려요 · 지금 ${Math.round(storedMb)}MB · 끝낸 영상의 복사본은 자동으로 지워요`
      : '이 브라우저는 영상을 기기에 보관할 수 없어서, 새로 고친 뒤에는 다시 골라야 열려요'),
    h('div', { class: 'modal-actions' },
      count.done ? h('button', { class: 'btn ghost', onclick: () => { removeFromBatch(S.batch.filter((b) => stateOf(b.fp) === 'done').map((b) => b.fp)); showBatch(); } }, '끝난 영상 빼기') : null,
      h('button', { class: 'btn', onclick: () => { close(); openPicker(); } }, '영상 더 고르기'),
      h('button', { class: 'btn primary', onclick: close }, '닫기')));
}

/** 고른 영상을 기기(OPFS)에 하나씩 복사 — 끝난 영상은 복사하지 않는다 */
let copyQueue = Promise.resolve();
let persistAsked = false;
function makeCopies(items) {
  if (!Copies.supported) return;
  if (!persistAsked && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
  for (const it of items) {
    copyQueue = copyQueue.then(async () => {
      const b = S.batch.find((x) => x.fp === it.fp);
      if (!b || b.stored || stateOf(it.fp) === 'done') return;
      try {
        await Copies.save(it.fp, it.file);
        b.stored = true;
        renderList();
        if (S.batchOpen && !$('#modal').hidden) showBatch();
      } catch (e) {
        toast(`기기에 보관하지 못했어요 (${e.name === 'QuotaExceededError' ? '저장 공간 부족' : e.message}) — 새로 고치면 다시 골라야 해요`);
      }
    });
  }
}

/** 썸네일·길이를 하나씩 만든다 (목록에서 영상을 알아보기 쉽게, 이 기기에만 저장) */
let thumbQueue = Promise.resolve();
function makeThumbs(items) {
  for (const it of items) {
    thumbQueue = thumbQueue.then(async () => {
      const m = S.meta.get(it.fp) || { fp: it.fp };
      if ((m.thumb && m.durationMs) || !it.file) return;
      const r = await grabThumb(it.file);
      if (!r) return;
      Object.assign(m, r);
      S.meta.set(it.fp, m);
      await S.store.putMeta(m);
      renderList();
      if (S.batchOpen && !$('#modal').hidden) showBatch();
      if (it.fp === S.fp) renderLabel();
    });
  }
}

function grabThumb(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let timer = null;
    const finish = (val) => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(val); };
    timer = setTimeout(() => finish(null), 10000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(1.5, (v.duration || 3) / 3); }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const hh = 128, ww = Math.max(1, Math.round((hh * v.videoWidth) / v.videoHeight)) || 96;
        const c = document.createElement('canvas');
        c.width = ww;
        c.height = hh;
        c.getContext('2d').drawImage(v, 0, 0, ww, hh);
        finish({ thumb: c.toDataURL('image/jpeg', 0.6), durationMs: Math.round(v.duration * 1000) });
      } catch (_) { finish(null); }
    }, { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = url;
  });
}

async function leaveVideo() {
  closeDrawer();
  if (S.unsaved) await saveNow();
  if (S.store) S.store.sync();
  const b = S.fp && S.batch.find((x) => x.fp === S.fp);
  if (b && b.stored && stateOf(b.fp) === 'done') { // 끝낸 영상의 복사본은 지운다 (원본은 갤러리에)
    await Copies.remove(b.fp);
    b.stored = false;
    if (b.fromCopy) { b.file = null; b.fromCopy = false; }
  }
}

function setSource(src, url) {
  S.src = src;
  $('#banners').replaceChildren();
  showUpdateBanner();
  resetView();
  $('#zoomCtl').hidden = false;
  video.src = url;
  video.playbackRate = SPEEDS[S.speedIdx];
  $('#emptyState').hidden = true;
}

async function loadLabel(fp, name, meta) {
  S.fp = fp;
  const existing = await S.store.load(fp);
  S.label = existing || Rules.newLabel(name, fp, meta);
  if (existing) S.labels.set(fp, existing);
  S.pi = 0;
  S.ai = prob().attempts.length - 1;
  S.selKey = null;
  S.undo = [];
  S.draw = null;
  S.drag = null;
  renderAll();
  renderInfo();
  if (!prob().startRois.length) switchTab('holds');
  else switchTab('moments');
}

function fillMeta(label) {
  const v = label.video;
  if (video.duration && isFinite(video.duration)) v.durationMs = Math.round(video.duration * 1000);
  if (video.videoWidth) { v.width = video.videoWidth; v.height = video.videoHeight; }
  if (S.fpsKnown) v.fps = S.fps;
}

function startFpsProbe() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
  let last = null;
  const samples = [];
  const cb = (now, md) => {
    if (S.fpsKnown) return;
    if (last && md.presentedFrames > last.presentedFrames && video.playbackRate === 1) {
      const dt = (md.mediaTime - last.mediaTime) / (md.presentedFrames - last.presentedFrames);
      if (dt > 0.003 && dt < 0.1) samples.push(1 / dt);
      if (samples.length >= 20) {
        samples.sort((a, b) => a - b);
        const med = samples[samples.length >> 1];
        S.fps = [24, 25, 30, 48, 50, 60, 120, 240].reduce((b, c) => (Math.abs(c - med) < Math.abs(b - med) ? c : b), 30);
        S.fpsKnown = true;
        updateTime();
        return;
      }
    }
    last = md;
    video.requestVideoFrameCallback(cb);
  };
  video.requestVideoFrameCallback(cb);
}

// ---------------------------------------------------------------- 고치기·저장·되돌리기

let saveTimer = null;

function pushUndo() {
  if (!S.label) return;
  S.undo.push(JSON.stringify(S.label));
  if (S.undo.length > 100) S.undo.shift();
  $('#undoBtn').disabled = false;
}

function mutate(fn, opts = {}) {
  if (!S.label) return;
  if (opts.snapshot !== false) pushUndo();
  fn(S.label);
  scheduleSave();
  if (opts.render !== false) renderLabel();
}

function scheduleSave(ms = 250) {
  S.unsaved = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, ms);
  renderSync();
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.label || !S.unsaved) return;
  const label = S.label;
  fillMeta(label);
  try {
    const saved = await S.store.save(label);
    S.labels.set(saved.video.fingerprint, saved);
    label.updatedAt = saved.updatedAt;
    S.unsaved = false;
  } catch (e) {
    banner('error', `저장하지 못했어요: ${e.message}`);
  }
  renderSync();
  renderList();
}

function undo() {
  if (!S.undo.length) { toast('되돌릴 게 없어요'); return; }
  S.label = JSON.parse(S.undo.pop());
  S.ai = Math.min(S.ai, prob().attempts.length - 1);
  $('#undoBtn').disabled = !S.undo.length;
  scheduleSave(0);
  renderLabel();
  renderInfo();
  toast('되돌렸어요');
}

// ---------------------------------------------------------------- 순간·시도

function addAttempt() {
  const p = prob();
  const ids = new Set(p.attempts.map((a) => a.id));
  let n = p.attempts.length + 1;
  while (ids.has(`a${n}`)) n++;
  p.attempts.push({ id: `a${n}`, events: {}, override: null, ex: [], note: '' });
  S.ai = p.attempts.length - 1;
  return p.attempts[S.ai];
}

function setMoment(key) {
  if (!S.label) { toast('먼저 영상을 열어 주세요'); return; }
  const t = curMs();
  let created = false;
  mutate(() => {
    let a = curAttempt();
    // 앞 시도가 착지까지 끝났고 그 뒤에서 시작·이륙을 찍으면 새 시도
    if (!a || ((key === 'S' || key === 'L') && a.events.E != null && t > a.events.E)) {
      a = addAttempt();
      created = true;
    }
    a.events[key] = t;
  }, { render: false });
  S.selKey = key;
  renderLabel();
  toast(`${created ? `새 시도 #${S.ai + 1} · ` : ''}${S.cfg.eventShort[key]} ${fmt(t)}`);
}

function clearMoment(key) {
  const a = curAttempt();
  if (!a || a.events[key] == null) return;
  mutate(() => { delete a.events[key]; }, { render: false });
  if (S.selKey === key) S.selKey = null;
  renderLabel();
  toast(`'${S.cfg.eventShort[key]}'을(를) 지웠어요`, '되돌리기', undo);
}

function nudgeMoment(key, frames, snapshot = true) {
  const a = curAttempt();
  if (!a || a.events[key] == null) return;
  mutate(() => { a.events[key] = Math.max(0, Math.round(a.events[key] + (frames * 1000) / S.fps)); }, { snapshot });
  video.pause();
  seek(a.events[key] / 1000);
}

function selectAttempt(i) {
  const n = prob().attempts.length;
  if (!n) return;
  S.ai = clamp(i, 0, n - 1);
  S.selKey = null;
  renderLabel();
  const ts = Object.values(Rules.events(prob().attempts[S.ai]));
  if (ts.length) seek(Math.min(...ts) / 1000);
}

function deleteAttempt() {
  const a = curAttempt();
  if (!a) return;
  const n = S.ai + 1;
  mutate(() => { prob().attempts.splice(S.ai, 1); S.ai = Math.min(S.ai, prob().attempts.length - 1); S.selKey = null; });
  toast(`시도 #${n}을(를) 지웠어요`, '되돌리기', undo);
}

function markDone() {
  mutate((l) => { l.done = true; });
  saveNow().then(() => S.store.sync());
  toast('이 영상을 끝냈어요 👏', '다음 영상', nextVideo);
}

// ---------------------------------------------------------------- 그리기 (홀드 영역)

function contentRect() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const vw = video.videoWidth || (S.label && S.label.video.width) || 16;
  const vh = video.videoHeight || (S.label && S.label.video.height) || 9;
  const s = Math.min(cw / vw, ch / vh);
  return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
}

// ---- 확대·이동: 영상만 CSS로 확대하고, 홀드 상자는 같은 변환으로 캔버스에 그린다 (선이 흐려지지 않게)
const ZOOM_MAX = 8;

/** 확대·이동이 반영된 영상 내용 영역 (캔버스 좌표) */
function viewRect() {
  const r = contentRect(), v = S.view;
  return { x: r.x * v.s + v.tx, y: r.y * v.s + v.ty, w: r.w * v.s, h: r.h * v.s };
}

function applyView() {
  const v = S.view, W = canvas.clientWidth, H = canvas.clientHeight;
  v.s = clamp(v.s, 1, ZOOM_MAX);
  v.tx = clamp(v.tx, W * (1 - v.s), 0);
  v.ty = clamp(v.ty, H * (1 - v.s), 0);
  video.style.transform = v.s === 1 ? '' : `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
  $('#zoomLevel').textContent = v.s === 1 ? '1×' : `${v.s.toFixed(1)}×`;
  $('#zoomCtl').classList.toggle('zoomed', v.s > 1);
  drawOverlay();
}

/** (px, py) 지점을 고정한 채로 배율을 factor배 */
function zoomAt(px, py, factor) {
  const v = S.view, ns = clamp(v.s * factor, 1, ZOOM_MAX);
  v.tx = px - (px - v.tx) * (ns / v.s);
  v.ty = py - (py - v.ty) * (ns / v.s);
  v.s = ns;
  applyView();
}

function zoomCenter(factor) { zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor); }

function resetView() {
  S.view = { s: 1, tx: 0, ty: 0 };
  applyView();
}

function holdList(p) {
  const out = p.startRois.map((r, i) => ({ roi: r, which: `s${i}`, name: p.startRois.length > 1 ? `시작 ${i + 1}` : '시작', color: START_COLOR }));
  if (p.topRoi) out.push({ roi: p.topRoi, which: 'top', name: '탑', color: TOP_COLOR });
  return out;
}

function roiRect(roi, r) {
  return { x: r.x + (roi.cx - roi.w / 2) * r.w, y: r.y + (roi.cy - roi.h / 2) * r.h, w: roi.w * r.w, h: roi.h * r.h };
}

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  canvas.classList.toggle('editing', !!S.draw || S.tab === 'holds');
  if (!S.label) return;
  const r = viewRect();
  const t = curMs();
  const fixed = (S.label.tags.camera || 'FIXED') === 'FIXED';
  const editing = S.tab === 'holds' && !S.draw;
  ctx.font = '600 13px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
  for (const hold of holdList(prob())) {
    const near = fixed || Math.abs(t - hold.roi.tMs) <= 1500;
    const b = roiRect(hold.roi, r);
    ctx.globalAlpha = near ? 1 : 0.45;
    ctx.setLineDash(near ? [] : [6, 4]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3);
    ctx.lineWidth = 2;
    ctx.strokeStyle = hold.color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    const label = near ? hold.name : `${hold.name} (${fmt(hold.roi.tMs)} 장면)`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(b.x, b.y - 20, tw + 10, 19);
    ctx.fillStyle = hold.color;
    ctx.fillText(label, b.x + 5, b.y - 6);
    if (editing && near) {
      ctx.fillStyle = hold.color;
      for (const [hx, hy] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
        ctx.fillRect(hx - 5, hy - 5, 10, 10);
      }
    }
    ctx.globalAlpha = 1;
  }
  if (S.drag && S.drag.mode === 'draw') {
    const d = S.drag;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    ctx.setLineDash([]);
  }
}

function canvasPoint(e) {
  const b = canvas.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}

function hitTest(p) {
  const r = viewRect();
  const tol = matchMedia('(pointer: coarse)').matches ? 22 : 12;
  const holds = holdList(prob()).reverse();
  // 상자 안쪽을 잡으면 옮기기 (작은 상자는 모서리 영역이 상자 전체를 덮어 옮길 수 없던 문제)
  for (const hold of holds) {
    const b = roiRect(hold.roi, r);
    const inset = Math.min(tol, b.w / 4, b.h / 4);
    if (p.x >= b.x + inset && p.x <= b.x + b.w - inset && p.y >= b.y + inset && p.y <= b.y + b.h - inset) return { mode: 'move', hold };
  }
  for (const hold of holds) {
    const b = roiRect(hold.roi, r);
    const corners = { tl: [b.x, b.y], tr: [b.x + b.w, b.y], bl: [b.x, b.y + b.h], br: [b.x + b.w, b.y + b.h] };
    for (const [c, [cx, cy]] of Object.entries(corners)) {
      if (Math.abs(p.x - cx) <= tol && Math.abs(p.y - cy) <= tol) return { mode: 'resize', corner: c, hold };
    }
  }
  for (const hold of holds) {
    const b = roiRect(hold.roi, r);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { mode: 'move', hold };
  }
  return null;
}

function holdRef(which) {
  const p = prob();
  return which === 'top' ? p.topRoi : p.startRois[Number(which.slice(1))];
}

function startDraw(kind, idx = 0) {
  if (!S.label) { toast('먼저 영상을 열어 주세요'); return; }
  const p = prob();
  if (kind === 'start' && idx === 1 && !p.startRois[0]) idx = 0;
  video.pause();
  S.draw = { kind, idx };
  const what = kind === 'top' ? '탑 홀드' : idx ? '시작 홀드 2' : '시작 홀드';
  $('#drawText').textContent = `영상 위 ${what}를 탭하거나 드래그하세요 · 작으면 두 손가락으로 확대 · 지금 장면(${fmt(curMs())})에 표시돼요`;
  $('#drawBar').hidden = false;
  drawOverlay();
}

function cancelDraw() {
  S.draw = null;
  S.drag = null;
  $('#drawBar').hidden = true;
  drawOverlay();
}

function finishDraw(d) {
  const r = viewRect();
  const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
  let roi;
  if (x1 - x0 < 8 || y1 - y0 < 8) {
    // 탭: 화면 기준 크기의 상자 → 확대해서 탭하면 작은 홀드에 맞는 작은 상자
    const side = 0.07 * Math.min(canvas.clientWidth, canvas.clientHeight);
    roi = { cx: (d.x0 - r.x) / r.w, cy: (d.y0 - r.y) / r.h, w: side / r.w, h: side / r.h };
  } else {
    roi = { cx: ((x0 + x1) / 2 - r.x) / r.w, cy: ((y0 + y1) / 2 - r.y) / r.h, w: (x1 - x0) / r.w, h: (y1 - y0) / r.h };
  }
  const out = clampRoi(roi);
  const { kind, idx } = S.draw;
  cancelDraw();
  mutate(() => {
    const p = prob();
    if (kind === 'top') p.topRoi = out;
    else p.startRois[Math.min(idx, p.startRois.length)] = out;
  });
  toast(`${kind === 'top' ? '탑 홀드' : '시작 홀드'}를 표시했어요 · 상자를 끌어 옮기거나 모서리로 크기를 바꿀 수 있어요`);
}

function clampRoi(roi) {
  const w = clamp(roi.w, 0.01, 1), hh = clamp(roi.h, 0.01, 1);
  return { cx: round5(clamp(roi.cx, w / 2, 1 - w / 2)), cy: round5(clamp(roi.cy, hh / 2, 1 - hh / 2)), w: round5(w), h: round5(hh), tMs: curMs() };
}

function onCanvasDown(e) {
  if (!S.label) return;
  const p = canvasPoint(e);
  S.pointers.set(e.pointerId, p);
  canvas.setPointerCapture(e.pointerId);
  if (S.pointers.size === 2) { // 두 손가락: 확대·축소·이동 (그리던 상자·옮기던 상자는 취소)
    e.preventDefault();
    if (S.drag && (S.drag.mode === 'move' || S.drag.mode === 'resize')) {
      Object.assign(holdRef(S.drag.which), S.drag.orig);
      S.undo.pop();
    }
    S.drag = null;
    const [a, b] = [...S.pointers.values()];
    S.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s0: S.view.s, tx0: S.view.tx, ty0: S.view.ty };
    drawOverlay();
    return;
  }
  if (S.pointers.size > 2) return;
  if (S.draw) {
    e.preventDefault();
    S.drag = { mode: 'draw', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    drawOverlay();
    return;
  }
  if (S.tab === 'holds') {
    const hit = hitTest(p);
    if (hit) {
      e.preventDefault();
      pushUndo();
      S.drag = { mode: hit.mode, corner: hit.corner, which: hit.hold.which, start: p, orig: Object.assign({}, hit.hold.roi) };
      return;
    }
  }
  // 한 손가락: 확대 중이면 화면 이동, 아니면(터치) 페이지 스크롤 · 움직이지 않고 떼면 재생/정지
  S.drag = { mode: 'tap', start: p, tx0: S.view.tx, ty0: S.view.ty, lastY: e.clientY, moved: false, touch: e.pointerType === 'touch' };
}

function onCanvasMove(e) {
  if (!S.pointers.has(e.pointerId)) return;
  const p = canvasPoint(e);
  S.pointers.set(e.pointerId, p);
  if (S.pinch && S.pointers.size >= 2) {
    const [a, b] = [...S.pointers.values()];
    const pc = S.pinch;
    const ns = clamp((pc.s0 * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pc.d0, 1, ZOOM_MAX);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    S.view.s = ns;
    S.view.tx = mid.x - (pc.mid0.x - pc.tx0) * (ns / pc.s0);
    S.view.ty = mid.y - (pc.mid0.y - pc.ty0) * (ns / pc.s0);
    applyView();
    return;
  }
  const d = S.drag;
  if (!d) return;
  if (d.mode === 'draw') {
    d.x1 = p.x;
    d.y1 = p.y;
    drawOverlay();
  } else if (d.mode === 'move' || d.mode === 'resize') {
    const r = viewRect();
    const dx = (p.x - d.start.x) / r.w, dy = (p.y - d.start.y) / r.h;
    const o = d.orig;
    let roi;
    if (d.mode === 'move') roi = { cx: o.cx + dx, cy: o.cy + dy, w: o.w, h: o.h };
    else {
      let L = o.cx - o.w / 2, R = o.cx + o.w / 2, T = o.cy - o.h / 2, B = o.cy + o.h / 2;
      if (d.corner.includes('l')) L = Math.min(L + dx, R - 0.01);
      if (d.corner.includes('r')) R = Math.max(R + dx, L + 0.01);
      if (d.corner.includes('t')) T = Math.min(T + dy, B - 0.01);
      if (d.corner.includes('b')) B = Math.max(B + dy, T + 0.01);
      roi = { cx: (L + R) / 2, cy: (T + B) / 2, w: R - L, h: B - T };
    }
    Object.assign(holdRef(d.which), clampRoi(roi));
    drawOverlay();
  } else if (d.mode === 'tap') {
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 10) return;
    d.moved = true;
    if (S.view.s > 1) {
      S.view.tx = d.tx0 + dx;
      S.view.ty = d.ty0 + dy;
      applyView();
    } else if (d.touch) {
      window.scrollBy(0, d.lastY - e.clientY);
    }
    d.lastY = e.clientY;
  }
}

function onCanvasUp(e) {
  S.pointers.delete(e.pointerId);
  if (S.pinch) { // 두 손가락을 떼는 동안에는 탭으로 보지 않는다
    if (S.pointers.size < 2) S.pinch = null;
    S.drag = null;
    return;
  }
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  if (d.mode === 'draw') {
    if (e.type === 'pointerup') finishDraw(d); else drawOverlay();
  } else if (d.mode === 'move' || d.mode === 'resize') { scheduleSave(); renderLabel(); }
  else if (d.mode === 'tap' && e.type === 'pointerup' && !d.moved) togglePlay();
}

function onCanvasWheel(e) {
  if (!S.label) return;
  e.preventDefault();
  const p = canvasPoint(e);
  zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.002));
}

// ---------------------------------------------------------------- 꾹 누르면 계속

// 누르는 순간 한 번 움직이고, HOLD_DELAY_MS 뒤부터 손을 뗄 때까지 반복한다 (안드로이드 반복 버튼과 같은 방식).
// 앞 장면 찾기(seek)가 끝난 뒤에 다음으로 가서, 폰에서도 화면이 멈추지 않고 한 장씩 넘어간다.
const HOLD_DELAY_MS = 350;
const HOLD_FRAME_MS = 60; // 1프레임 버튼: 초당 최대 약 16프레임
const HOLD_SEC_MS = 250;  // 1초 버튼: 초당 4초
let hold = null;

// fn(first): first는 누른 순간(true)과 반복(false)을 구분한다 (되돌리기를 한 번에 묶을 때 쓴다)
function holdable(el, fn, everyMs) {
  el.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0) return;
    stopHold();
    hold = { id: e.pointerId, fn, everyMs, timer: setTimeout(holdTick, HOLD_DELAY_MS) };
    fn(true);
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.detail === 0) fn(true); // 키보드(Enter·Space)로 누른 경우만. 손가락·마우스는 pointerdown에서 이미 움직였다
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault()); // 길게 눌러도 메뉴가 뜨지 않게
  return el;
}

function holdTick() {
  if (!hold) return;
  if (video.seeking) { hold.timer = setTimeout(holdTick, 16); return; }
  hold.fn(false);
  hold.timer = setTimeout(holdTick, hold.everyMs);
}

function stopHold(e) {
  if (!hold || (e && e.pointerId != null && e.pointerId !== hold.id)) return;
  clearTimeout(hold.timer);
  hold = null;
}

// ---------------------------------------------------------------- 재생

function seek(sec) {
  const dur = durMs() / 1000;
  video.currentTime = clamp(sec, 0, dur || 0);
}

function stepFrames(n) {
  video.pause();
  const idx = Math.floor((video.currentTime || 0) * S.fps + 1e-3);
  seek((idx + n + 0.5) / S.fps); // 프레임 구간 가운데 → 그 프레임이 확실히 보인다
}

function stepSeconds(n) {
  video.pause();
  seek((video.currentTime || 0) + n);
}

function togglePlay() {
  if (!S.src) return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
}

function setSpeed(i) {
  S.speedIdx = clamp(i, 0, SPEEDS.length - 1);
  video.playbackRate = SPEEDS[S.speedIdx];
  $('#speedBtn').textContent = `${SPEEDS[S.speedIdx]}×`;
}

function updateTime() {
  const t = video.currentTime || 0;
  $('#timeText').textContent = fmtTime(t);
  $('#frameText').textContent = S.src ? `프레임 ${Math.floor(t * S.fps + 1e-3)}${S.fpsKnown ? '' : ' (추정)'}` : '';
  const d = durMs() / 1000;
  $('#playhead').style.left = d ? `${clamp(t / d, 0, 1) * 100}%` : '0';
  const z = zoomRange();
  if (z) $('#zoomPlayhead').style.left = `${clamp((t * 1000 - z[0]) / (z[1] - z[0]), 0, 1) * 100}%`;
  drawOverlay();
}

function frameLoop() {
  updateTime();
  if (!video.paused) requestAnimationFrame(frameLoop);
}

// ---------------------------------------------------------------- 타임라인

function zoomRange() {
  const a = curAttempt();
  if (!a || !S.selKey || a.events[S.selKey] == null) return null;
  const t = a.events[S.selKey];
  const d = durMs() || t + 2000;
  return [Math.max(0, t - 2000), Math.min(d, t + 2000)];
}

function makeDraggable(el, ai, key, where) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    S.ai = ai;
    const a = prob().attempts[ai];
    const rail = where === 'zoom' ? $('#zoomRail') : timeline;
    const range = where === 'zoom' ? zoomRange() || [0, durMs()] : [0, durMs()];
    const start = { x: e.clientX, t: a.events[key] };
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - start.x;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) pushUndo();
      moved = true;
      const b = rail.getBoundingClientRect();
      const t = Math.round(clamp(start.t + (dx / b.width) * (range[1] - range[0]), 0, durMs()));
      a.events[key] = t;
      el.style.left = `${clamp((t - range[0]) / (range[1] - range[0]), 0, 1) * 100}%`;
      video.pause();
      seek(t / 1000);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      S.selKey = key;
      if (moved) scheduleSave(); else seek(a.events[key] / 1000);
      renderLabel();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

function placeMarks(container, marks, toPct) {
  // 이름표가 겹치면 두 줄로 나누고, 그래도 겹치면 점만 남긴다 (선택한 표시는 항상 이름표)
  const width = container.getBoundingClientRect().width || 300;
  const est = (k) => 16 + 12 * S.cfg.eventShort[k].length;
  const placed = [];
  for (const m of marks.slice().sort((x, y) => (y.selected - x.selected) || (x.t - y.t))) {
    const x = (toPct(m.t) / 100) * width;
    const w = est(m.k);
    const row = [0, 1].find((r) => placed.every((p) => p.compact || p.row !== r || Math.abs(p.x - x) >= (p.w + w) / 2 + 3));
    placed.push(Object.assign({}, m, { x, w, row: row === undefined ? 0 : row, compact: row === undefined }));
  }
  for (const m of placed) {
    const el = h('div', {
      class: `tl-mark row-${m.row}${m.compact ? ' compact' : ''}${m.selected ? ' selected' : ''}${m.dim ? ' dim' : ''}`,
      style: `left:${toPct(m.t)}%;--c:${COLORS[m.k]}`,
      title: `시도 ${m.ai + 1} · ${S.cfg.eventShort[m.k]} ${fmt(m.t)} — 끌어서 옮기기`,
    }, h('span', {}, S.cfg.eventShort[m.k]));
    makeDraggable(el, m.ai, m.k, container === timeline ? 'main' : 'zoom');
    container.append(el);
  }
}

function renderTimeline() {
  timeline.querySelectorAll('.tl-bar,.tl-mark,.tl-hold').forEach((e) => e.remove());
  const d = durMs();
  if (S.label && d) {
    const pct = (ms) => clamp(ms / d, 0, 1) * 100;
    const p = prob();
    const marks = [];
    p.attempts.forEach((a, i) => {
      const ev = Rules.events(a);
      const ts = Object.values(ev);
      if (!ts.length) return;
      const r = Rules.evaluateAttempt(a, S.cfg);
      const t0 = Math.min(...ts), t1 = Math.max(...ts);
      timeline.append(h('div', {
        class: `tl-bar ${resultClass(r)}${i === S.ai ? ' current' : ''}`,
        style: `left:${pct(t0)}%;width:max(3px, ${pct(t1) - pct(t0)}%)`,
        onclick: (e) => { e.stopPropagation(); selectAttempt(i); },
      }));
      for (const [k, t] of Object.entries(ev)) marks.push({ k, t, ai: i, selected: i === S.ai && S.selKey === k, dim: i !== S.ai });
    });
    placeMarks(timeline, marks, pct);
    for (const hold of holdList(p)) timeline.append(h('div', { class: 'tl-hold', style: `left:${pct(hold.roi.tMs)}%;--c:${hold.color}`, title: `${hold.name} 홀드 표시 장면` }));
  }
  renderZoom();
  updateTime();
}

function renderZoom() {
  const z = $('#zoom');
  const range = zoomRange();
  if (!range) { z.hidden = true; return; }
  z.hidden = false;
  const [lo, hi] = range;
  const rail = $('#zoomRail');
  rail.querySelectorAll('.tl-mark').forEach((e) => e.remove());
  const frames = Math.max(1, ((hi - lo) * S.fps) / 1000);
  $('#zoomTicks').style.backgroundSize = `${100 / frames}% 100%`;
  const a = curAttempt();
  const ev = Rules.events(a);
  const marks = Object.entries(ev).filter(([, t]) => t >= lo && t <= hi).map(([k, t]) => ({ k, t, ai: S.ai, selected: k === S.selKey }));
  placeMarks(rail, marks, (t) => ((t - lo) / (hi - lo)) * 100);
  $('#zoomTitle').textContent = `${S.cfg.eventShort[S.selKey]} ${fmt(ev[S.selKey])}`;
}

function scrubFrom(rail, rangeFn) {
  let down = false;
  const go = (e) => {
    const b = rail.getBoundingClientRect();
    const [lo, hi] = rangeFn();
    video.pause();
    seek((lo + clamp((e.clientX - b.left) / b.width, 0, 1) * (hi - lo)) / 1000);
  };
  rail.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tl-mark, .tl-bar') || !S.src) return;
    down = true;
    rail.setPointerCapture(e.pointerId);
    go(e);
  });
  rail.addEventListener('pointermove', (e) => { if (down) go(e); });
  rail.addEventListener('pointerup', () => { down = false; });
  rail.addEventListener('pointercancel', () => { down = false; });
}

// ---------------------------------------------------------------- 렌더링

function renderAll() {
  renderList();
  renderLabel();
  renderSync();
  setSpeed(S.speedIdx);
  $('#emptyState').hidden = !!S.src;
}

function renderLabel() {
  $('#videoTitle').textContent = S.label
    ? videoName(S.label.video.file, S.label.video.durationMs || (video.duration ? video.duration * 1000 : (S.meta.get(S.fp) || {}).durationMs))
    : (S.src ? S.src.name : '');
  $('#undoBtn').disabled = !S.undo.length;
  renderAttemptBar();
  renderVerdict();
  renderMoments();
  renderEditRow();
  renderAttemptExtra();
  renderDoneRow();
  renderHolds();
  renderTimeline();
  renderGuide();
}

function renderAttemptBar() {
  const bar = $('#attemptBar');
  bar.replaceChildren();
  if (!S.label) return;
  prob().attempts.forEach((a, i) => {
    const r = Rules.evaluateAttempt(a, S.cfg);
    bar.append(h('button', { class: `att-chip ${resultClass(r)}${i === S.ai ? ' current' : ''}`, onclick: () => selectAttempt(i) },
      `시도 ${i + 1} · ${r.complete ? S.cfg.resultNames[r.result] : '입력 중'}`));
  });
  bar.append(h('button', {
    class: 'att-chip add', title: '단축키 N',
    onclick: () => { mutate(() => addAttempt()); toast(`새 시도 #${S.ai + 1} — 순간을 찍어 주세요`); },
  }, '+ 새 시도'));
}

function friendlyIssues(a) {
  const ev = Rules.events(a);
  const n = S.cfg.eventShort;
  const out = [];
  const seq = ['L', 'T', 'M', 'R', 'E'].filter((k) => k in ev);
  for (let i = 0; i + 1 < seq.length; i++) {
    const x = seq[i], y = seq[i + 1];
    if (ev[x] > ev[y]) out.push(`'${n[x]}'(${fmt(ev[x])})이 '${n[y]}'(${fmt(ev[y])})보다 늦어요 — 시각을 확인해 주세요`);
  }
  if ('S' in ev) for (const k of ['T', 'M', 'R', 'E']) if (k in ev && ev[k] < ev.S) out.push(`'${n.S}'이 '${n[k]}'보다 늦어요`);
  const r = Rules.evaluateAttempt(a, S.cfg);
  if (r.complete && (r.result === 'SEND' || r.result === 'FAIL') && !('E' in ev)) out.push(`'${n.E}'도 찍어 주세요 — 발이 매트에 닿는 순간`);
  if ('R' in ev && !('M' in ev)) out.push(`'${n.R}'은 '${n.M}'을 찍은 뒤에 써요`);
  return out;
}

function renderVerdict() {
  const el = $('#verdict');
  const a = curAttempt();
  if (!S.label) { el.replaceChildren(); el.className = 'verdict'; return; }
  if (!a) {
    el.className = 'verdict muted';
    el.replaceChildren('아래 버튼을 누르면 시도가 만들어져요. 양손이 시작 홀드에 모인 장면에서 첫 버튼부터 눌러 보세요.');
    return;
  }
  const r = Rules.evaluateAttempt(a, S.cfg);
  el.className = `verdict ${resultClass(r)}`;
  el.replaceChildren(h('div', { class: 'verdict-main' }, Rules.verdictText(a, S.cfg)),
    ...friendlyIssues(a).map((t) => h('div', { class: 'issue' }, `⚠ ${t}`)));
}

function renderMoments() {
  const grid = $('#momentGrid');
  grid.replaceChildren();
  const a = curAttempt();
  const ev = a ? Rules.events(a) : {};
  const next = S.label ? (a ? Rules.nextEvent(a) : { key: 'S', alt: 'L' }) : null;
  for (const k of Rules.KEYS) {
    const set = k in ev;
    const isNext = next && next.key === k;
    const cls = ['moment', set && 'set', isNext && 'next', next && next.alt === k && 'alt', set && S.selKey === k && 'selected'].filter(Boolean).join(' ');
    const btn = h('button', { class: cls, style: `--c:${COLORS[k]}`, title: `${S.cfg.eventHelp[k]} (단축키 ${k})`, onclick: () => setMoment(k) },
      h('span', { class: 'm-name' }, S.cfg.eventNames[k]),
      h('span', { class: 'm-time' }, set ? fmt(ev[k]) : isNext ? '다음 · 눌러서 찍기' : '눌러서 찍기'),
      h('span', { class: 'm-key' }, k));
    if (set) {
      btn.append(h('span', {
        class: 'm-x', role: 'button', 'aria-label': `${S.cfg.eventShort[k]} 지우기`,
        onclick: (e) => { e.stopPropagation(); clearMoment(k); },
      }, '×'));
    }
    grid.append(btn);
  }
}

function renderEditRow() {
  const row = $('#editRow');
  const a = curAttempt();
  if (!a || !S.selKey || a.events[S.selKey] == null) { row.hidden = true; delete row.dataset.key; return; }
  const k = S.selKey;
  const name = `${S.cfg.eventShort[k]} ${fmt(a.events[k])} 고치기`;
  row.hidden = false;
  // 같은 순간을 고치는 중이면 글자만 바꾼다. 꾹 누르는 중에 버튼을 새로 만들면 손을 뗀 걸 놓칠 수 있다
  if (row.dataset.key === k) { row.querySelector('.edit-name').textContent = name; return; }
  row.dataset.key = k;
  // 버튼은 다시 그리지 않으니, 누를 때마다 지금 시도를 새로 찾는다
  const ev = () => { const at = curAttempt(); return at ? at.events[k] : null; };
  row.replaceChildren(
    h('span', { class: 'edit-name', style: `--c:${COLORS[k]}` }, name),
    h('div', { class: 'edit-btns' },
      holdable(h('button', { class: 'btn hold', title: '꾹 누르면 계속' }, '◀ 1프레임'), (first) => nudgeMoment(k, -1, first), HOLD_FRAME_MS),
      holdable(h('button', { class: 'btn hold', title: '꾹 누르면 계속' }, '1프레임 ▶'), (first) => nudgeMoment(k, 1, first), HOLD_FRAME_MS),
      h('button', { class: 'btn', onclick: () => { const t = ev(); if (t == null) return; video.pause(); seek(t / 1000); } }, '이 장면 보기'),
      h('button', { class: 'btn', onclick: () => { if (ev() != null) mutate(() => { curAttempt().events[k] = curMs(); }); } }, '지금 시각으로'),
      h('button', { class: 'btn danger', onclick: () => clearMoment(k) }, '지우기')));
}

function renderAttemptExtra() {
  const box = $('#attemptExtra');
  box.replaceChildren();
  const a = curAttempt();
  if (!a) return;
  const r = Rules.evaluateAttempt(a, S.cfg);
  const note = h('input', {
    class: 'input note', placeholder: '메모 (선택)', value: a.note || '',
    onfocus: () => { S.typingSnap = false; },
    oninput: (e) => {
      if (!S.typingSnap) { pushUndo(); S.typingSnap = true; }
      a.note = e.target.value;
      scheduleSave(600);
    },
  });
  box.append(
    h('div', { class: 'extra-btns' },
      h('button', { class: `btn${r.overridden ? ' active' : ''}`, onclick: openOverride }, r.overridden ? `직접 고름: ${S.cfg.resultNames[r.result]}` : '판정이 달라요'),
      h('button', { class: `btn${a.ex.length ? ' active' : ''}`, onclick: openSpecial }, a.ex.length ? `특이 상황 ${a.ex.length}개` : '특이 상황'),
      h('button', { class: 'btn ghost danger', onclick: deleteAttempt }, '이 시도 삭제')),
    note);
  // append(null)은 "null" 글자를 붙이므로 있을 때만 넣는다
  if (a.ex.length) box.append(h('div', { class: 'tag-list' }, a.ex.map((c) => h('span', { class: 'tag' }, S.cfg.exCodes[c] || '특이 상황'))));
}

function renderDoneRow() {
  const row = $('#doneRow');
  row.replaceChildren();
  if (!S.label) return;
  const st = Rules.labelStatus(S.label, S.cfg);
  if (S.label.done) {
    row.append(h('span', { class: 'done-note' }, '✓ 이 영상은 끝냈어요'),
      h('button', { class: 'btn ghost', onclick: () => mutate((l) => { l.done = false; }) }, '다시 열기'),
      h('button', { class: 'btn primary', onclick: nextVideo }, '다음 영상'));
    return;
  }
  const why = st.incomplete ? '입력 중인 시도를 마저 찍으면 누를 수 있어요' : !st.roisReady ? '시작·탑 홀드를 표시하면 누를 수 있어요' : '시도를 다 찍었으면 눌러 주세요 (시도가 없는 영상도 괜찮아요)';
  row.append(h('button', { class: 'btn ok wide', disabled: !!st.incomplete || !st.roisReady, onclick: markDone }, '이 영상 끝냄'),
    h('span', { class: 'muted small' }, why));
}

function renderHolds() {
  const rows = $('#holdRows');
  rows.replaceChildren();
  if (!S.label) { rows.append(h('p', { class: 'muted' }, '영상을 열면 홀드를 표시할 수 있어요.')); return; }
  const p = prob();
  const row = (title, color, roi, onDraw, onClear, key) => h('div', { class: 'hold-row' },
    h('span', { class: 'swatch', style: `background:${color}` }),
    h('div', { class: 'hold-text' }, h('b', {}, title), h('span', { class: 'muted small' }, roi ? `${fmt(roi.tMs)} 장면에 표시함` : '아직 표시 안 함')),
    roi ? h('button', { class: 'btn small', onclick: () => { video.pause(); seek(roi.tMs / 1000); } }, '장면 보기') : null,
    h('button', { class: `btn small${roi ? '' : ' primary'}`, onclick: onDraw, title: `단축키 ${key}` }, roi ? '다시 표시' : '표시하기'),
    roi ? h('button', { class: 'btn small ghost', onclick: onClear }, '지우기') : null);
  rows.append(row('시작 홀드', START_COLOR, p.startRois[0], () => startDraw('start', 0), () => mutate(() => { p.startRois.splice(0, 1); }), '1'));
  if (p.startRois[0]) rows.append(row('시작 홀드 2 (두 개일 때만)', START_COLOR, p.startRois[1], () => startDraw('start', 1), () => mutate(() => { p.startRois.splice(1, 1); }), '2'));
  rows.append(row('탑 홀드', TOP_COLOR, p.topRoi, () => startDraw('top'), () => mutate(() => { p.topRoi = null; }), '3'));
  const nameInput = $('#problemName');
  if (document.activeElement !== nameInput) nameInput.value = p.name || '';
  const tabs = $('#problemTabs');
  tabs.replaceChildren();
  if (S.label.problems.length > 1) {
    S.label.problems.forEach((q, i) => tabs.append(h('button', {
      class: `chip${i === S.pi ? ' active' : ''}`,
      onclick: () => { S.pi = i; S.ai = prob().attempts.length - 1; S.selKey = null; renderLabel(); },
    }, q.name || `문제 ${i + 1}`)));
  }
  tabs.append(h('button', {
    class: 'chip add', title: '같은 영상에 다른 문제 등반도 있을 때',
    onclick: () => { mutate((l) => { l.problems.push({ id: `p${Date.now().toString(36)}`, name: '', startRois: [], topRoi: null, attempts: [] }); S.pi = l.problems.length - 1; S.ai = -1; }); toast('새 문제 — 이 문제의 홀드를 표시해 주세요'); },
  }, '+ 같은 영상의 다른 문제'));
}

function renderTagOptions() {
  const fill = (sel, map) => {
    const cur = sel.value;
    sel.replaceChildren(h('option', { value: '' }, '모름'), ...Object.entries(map).map(([k, v]) => h('option', { value: k }, v)));
    sel.value = cur;
  };
  fill($('[data-tag=angle]'), S.cfg.angles);
  fill($('[data-tag=camera]'), S.cfg.cameras);
  fill($('[data-tag=people]'), S.cfg.people);
  $('#standardHint').textContent = S.cfg.standardHelp || '거치대 고정, 시작·탑 홀드가 화면 안, 전신이 보임, 가림 거의 없음';
  const dl = $('#gymList');
  const gyms = new Set();
  for (const l of S.labels.values()) if (l.tags && l.tags.gym) gyms.add(l.tags.gym);
  dl.replaceChildren(...[...gyms].sort().map((g) => h('option', { value: g })));
}

function renderInfo() {
  if (!S.label) return;
  const tags = S.label.tags;
  for (const el of $$('#infoForm [data-tag]')) {
    const k = el.dataset.tag;
    el.value = k === 'standard' ? (tags.standard === true ? 'Y' : tags.standard === false ? 'N' : '') : (tags[k] || '');
  }
}

function renderGuide() {
  const g = guide();
  $$('#guide .steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.className = n < g.step ? 'done' : n === g.step ? 'now' : '';
  });
  $('#guideText').textContent = g.text;
  const btn = $('#guideAction');
  btn.hidden = !g.action;
  if (g.action) { btn.textContent = g.actionLabel; btn.onclick = g.action; }
}

function guide() {
  if (!S.label && S.batch.length) {
    const left = S.batch.filter((b) => stateOf(b.fp) !== 'done').length;
    return { step: 1, text: `① 고른 영상 ${S.batch.length}개 중 ${left}개가 남았어요. 목록에서 골라 이어서 해요.`, actionLabel: '고른 영상 목록', action: showBatch };
  }
  if (!S.label) return { step: 1, text: '① 라벨링할 영상을 열어 주세요. 여러 개를 한꺼번에 골라도 돼요.', actionLabel: '영상 열기', action: openPicker };
  const p = prob();
  if (!p.startRois.length) return { step: 2, text: '② 시작 홀드가 보이는 장면으로 옮긴 뒤, 영상 위 시작 홀드를 표시해요.', actionLabel: '시작 홀드 표시하기', action: () => { switchTab('holds'); startDraw('start', 0); } };
  if (!p.topRoi) return { step: 2, text: '② 탑 홀드가 보이는 장면에서 탑 홀드를 표시해요.', actionLabel: '탑 홀드 표시하기', action: () => { switchTab('holds'); startDraw('top'); } };
  const a = curAttempt();
  if (!p.attempts.length) return { step: 3, text: `③ 재생하다 등반이 시작되면 멈추고, 양손이 시작 홀드에 모인 장면에서 '${S.cfg.eventNames.S}'를 눌러요.`, actionLabel: '순간 찍기로', action: () => switchTab('moments') };
  if (a) {
    const n = Rules.nextEvent(a);
    if (n) {
      return { step: 3, text: `③ 다음: '${S.cfg.eventNames[n.key]}' — ${S.cfg.eventHelp[n.key]}${Rules.altHint(n, S.cfg)}` };
    }
  }
  if (p.attempts.some((x) => !Rules.evaluateAttempt(x, S.cfg).complete)) return { step: 3, text: '③ 입력 중인 시도가 있어요. 위의 노란 시도를 눌러 마저 찍어 주세요.' };
  if (!S.label.done) return { step: 4, text: "④ 이 영상에 다른 시도가 더 있으면 '+ 새 시도', 없으면 '이 영상 끝냄'을 눌러요.", actionLabel: '이 영상 끝냄', action: markDone };
  return { step: 5, text: '✓ 이 영상은 끝났어요. 다음 영상으로 넘어가요.', actionLabel: '다음 영상', action: nextVideo };
}

function renderSync() {
  const chip = $('#syncChip');
  if (!S.store) return;
  const st = S.store.status;
  let text, cls;
  if (S.store.mode !== 'github') { text = '이 기기에만 저장'; cls = 'local'; }
  else if (st.syncing) { text = '올리는 중…'; cls = 'busy'; }
  else if (st.error) { text = '올리기 실패 · 다시'; cls = 'error'; }
  else if (st.offline && (st.pending || S.unsaved)) { text = '오프라인 · 연결되면 올라가요'; cls = 'warn'; }
  else if (st.pending || S.unsaved) { text = '저장됨 · 곧 올라가요'; cls = 'pending'; }
  else { text = st.lastSync ? `올림 · ${ago(st.lastSync)}` : '저장됨'; cls = 'ok'; }
  chip.textContent = text;
  chip.className = `sync-chip ${cls}`;
  chip.title = st.error || (S.store.mode === 'github' ? '누르면 지금 올려요' : '누르면 GitHub 연결 설정');
}

function stateOf(fp) {
  const l = S.labels.get(fp);
  return l ? Rules.labelStatus(l, S.cfg).state : 'todo';
}

const STATE_NAMES = { todo: '안 함', doing: '입력 중', done: '끝남' };

function renderList() {
  let items, progress;
  if (S.server) {
    const done = S.videos.filter((v) => stateOf(v.meta.fingerprint) === 'done').length;
    progress = `${S.videos.length}개 중 ${done}개 끝남`;
    items = S.videos.map((v) => {
      const st = stateOf(v.meta.fingerprint);
      return h('li', { class: `video-item${S.src && S.src.name === v.name ? ' active' : ''}`, onclick: () => openServerVideo(v.name) },
        h('span', { class: 'v-name' }, v.name),
        h('span', { class: `state ${st}` }, STATE_NAMES[st]));
    });
  } else {
    items = [];
    const inBatch = new Set(S.batch.map((b) => b.fp));
    if (S.batch.length) {
      const done = S.batch.filter((b) => stateOf(b.fp) === 'done').length;
      progress = `고른 영상 ${S.batch.length}개 중 ${done}개 끝남`;
      for (const b of sortedBatch()) {
        items.push(h('li', { class: `video-item${S.fp === b.fp ? ' active' : ''}`, onclick: () => openBatchItem(b) },
          thumbEl(b.fp), h('span', { class: 'v-name' }, itemName(b.fp, b.file && b.file.name)), stateChip(b.fp)));
      }
    }
    const older = [...S.labels.values()].filter((l) => !inBatch.has(l.video.fingerprint))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    if (!S.batch.length) {
      const done = older.filter((l) => Rules.labelStatus(l, S.cfg).state === 'done').length;
      progress = older.length ? `라벨 ${older.length}개 · ${done}개 끝남 — 영상 열기에서 여러 개를 한꺼번에 고르면 안 한 것을 골라 줘요` : '영상 열기에서 여러 개를 한꺼번에 골라도 돼요';
    }
    if (older.length) {
      items.push(h('li', { class: 'list-head' }, '전에 라벨한 영상 — 다시 고르면 이어져요'));
      for (const l of older) {
        const fp = l.video.fingerprint;
        items.push(h('li', {
          class: `video-item${S.fp === fp ? ' active' : ''}`,
          title: '이어서 하려면 같은 영상을 다시 골라 주세요',
          onclick: () => { if (S.fp !== fp) { toast(`'${itemName(fp, l.video.file)}'을(를) 다시 골라 주세요 — 고르면 라벨이 이어져요`); openPicker(); } },
        }, thumbEl(fp), h('span', { class: 'v-name' }, itemName(fp, l.video.file)), stateChip(fp)));
      }
    }
  }
  const eb = $('#emptyBatchBtn');
  eb.hidden = !S.batch.length;
  eb.textContent = `고른 영상 목록 (${S.batch.length}개)`;
  for (const slot of $$('[data-slot=progress]')) slot.textContent = progress;
  for (const slot of $$('[data-slot=videos]')) slot.replaceChildren(...items.map((li) => li.cloneNode(true)));
  // cloneNode는 이벤트를 복사하지 않으므로 다시 연결
  $$('[data-slot=videos]').forEach((slot) => {
    Array.from(slot.children).forEach((li, i) => { li.onclick = () => items[i].click(); });
  });
}

// ---------------------------------------------------------------- 탭·메뉴·이동

function switchTab(name) {
  S.tab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== name; });
  if (name !== 'holds' && S.draw) cancelDraw();
  drawOverlay();
}

function openPicker() { closeDrawer(); $('#filePicker').click(); }
function openDrawer() { $('#drawer').hidden = false; }
function closeDrawer() { $('#drawer').hidden = true; }

function nextVideo() {
  closeDrawer();
  if (!S.server) {
    const idx = S.batch.findIndex((b) => b.fp === S.fp);
    const order = S.batch.slice(idx + 1).concat(S.batch.slice(0, Math.max(0, idx)));
    const next = order.find((b) => b.fp !== S.fp && stateOf(b.fp) !== 'done');
    if (next) openBatchItem(next);
    else if (S.batch.length) { toast('고른 영상을 다 끝냈어요 🎉 — 더 하려면 영상 열기'); showBatch(); }
    else openPicker();
    return;
  }
  const idx = S.videos.findIndex((v) => S.src && v.name === S.src.name);
  const order = S.videos.slice(idx + 1).concat(S.videos.slice(0, Math.max(0, idx)));
  const next = order.find((v) => stateOf(v.meta.fingerprint) !== 'done');
  if (next) openServerVideo(next.name);
  else toast('모든 영상을 끝냈어요 🎉');
}

// ---------------------------------------------------------------- 대화상자

function openModal(...content) {
  $('#modalCard').replaceChildren(...content);
  $('#modal').hidden = false;
}

function closeModal() {
  if ($('#modal').dataset.locked === '1') return;
  $('#modal').hidden = true;
}

function openOverride() {
  const a = curAttempt();
  if (!a) return;
  const r = Rules.evaluateAttempt(a, S.cfg);
  let choice = a.override ? a.override.result : '';
  const reason = h('input', { class: 'input', placeholder: '이유 (예: 양손 0.8초지만 확실히 버텼음)', value: (a.override && a.override.reason) || '' });
  const opts = [['', `자동 판정 그대로 (${S.cfg.resultNames[r.derived]})`], ...S.cfg.results.map((c) => [c, S.cfg.resultNames[c]])];
  openModal(
    h('h2', {}, '판정이 달라요'),
    h('p', { class: 'muted' }, '찍은 순간으로 계산한 판정과 내가 본 결과가 다를 때 골라요. 탑이 안 보여서 알 수 없으면 "판단 불가".'),
    h('div', { class: 'choice-list' }, opts.map(([code, name]) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'ov', value: code, checked: choice === code, onchange: () => { choice = code; } }), ' ', name))),
    reason,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: closeModal }, '취소'),
      h('button', {
        class: 'btn primary',
        onclick: () => { mutate(() => { a.override = choice ? { result: choice, reason: reason.value.trim() } : null; }); closeModal(); },
      }, '적용')));
}

function openSpecial() {
  const a = curAttempt();
  if (!a) return;
  const codes = Object.entries(S.cfg.exCodes);
  const picked = new Set(a.ex);
  openModal(
    h('h2', {}, '특이 상황'),
    h('p', { class: 'muted' }, '이 시도에 해당하는 게 있으면 골라요. 어려운 상황을 따로 모아 확인할 때 써요.'),
    codes.length
      ? h('div', { class: 'choice-list grid' }, codes.map(([c, name]) => h('label', { class: 'choice' },
        h('input', { type: 'checkbox', checked: picked.has(c), onchange: (e) => { if (e.target.checked) picked.add(c); else picked.delete(c); } }), ' ', name)))
      : h('p', {}, 'GitHub 저장소에 연결하면 목록이 보여요.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: closeModal }, '취소'),
      h('button', { class: 'btn primary', onclick: () => { mutate(() => { a.ex = [...picked].sort(); }); closeModal(); } }, '적용')));
}

function showHelp() {
  closeDrawer();
  openModal(
    h('h2', {}, '사용법'),
    h('ol', { class: 'howto' },
      h('li', {}, h('b', {}, '영상 고르기'), ' — 폰 갤러리나 컴퓨터의 영상을 열어요. 영상은 올라가지 않고, 라벨(시각 숫자)만 저장돼요.'),
      h('li', {}, h('b', {}, '홀드 표시'), " — '홀드 영역' 탭에서 시작 홀드와 탑 홀드를 영상 위에 표시해요."),
      h('li', {}, h('b', {}, '순간 찍기'), ' — 재생하다 멈추고, 그 장면에 맞는 버튼을 눌러요. 판정은 자동으로 계산돼요.')),
    h('table', { class: 'tbl' }, Rules.KEYS.map((k) => h('tr', {},
      h('td', {}, h('span', { class: 'dot', style: `background:${COLORS[k]}` })),
      h('td', {}, h('b', {}, S.cfg.eventNames[k])),
      h('td', { class: 'muted' }, S.cfg.eventHelp[k])))),
    h('p', {}, `탑을 양손으로 ${(S.cfg.sendHoldMs / 1000).toFixed(1)}초 넘게 잡으면 완등이에요. 이륙 없이 홀드만 만지면 '시도 아님'. 내가 본 결과와 다르면 '판정이 달라요'를 눌러요.`),
    h('p', {}, '잘못 찍었으면 다시 누르면 지금 시각으로 바뀌고, 타임라인의 표시를 끌어 옮기거나 ◀ 1프레임 ▶로 미세 조정할 수 있어요. 1프레임·1초 버튼은 꾹 누르고 있으면 계속 움직여요. ↶ 버튼으로 되돌려요.'),
    h('details', {}, h('summary', {}, '키보드 단축키 (컴퓨터)'),
      h('p', { class: 'muted' }, 'Space 재생 · ←/→ 1프레임 · Shift+←/→ 1초 · ⌥+←/→ 5초 · S L T M R E 순간 찍기 · N 새 시도 · ↑/↓ 시도 선택 · 1·2 시작 홀드 · 3 탑 홀드 · [ ] 속도 · ⌘Z 되돌리기')),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: closeModal }, '닫기')));
}

function showCoverage() {
  closeDrawer();
  const labels = [...S.labels.values()];
  const c = Rules.coverage(labels, S.cfg);
  const sug = S.cfg.targets ? Rules.suggestions(c, S.cfg) : [];
  const t = c.targets;
  const row = (name, v, target) => h('tr', {}, h('td', {}, name), h('td', { class: 'num' }, target ? `${v} / ${target}` : String(v)),
    target ? h('td', {}, h('span', { class: 'meter' }, h('span', { style: `width:${Math.min(100, (v / target) * 100)}%` }))) : h('td'));
  const named = (map, names) => Object.entries(map).map(([k, v]) => `${names[k] || '모름'} ${v}`).join(' · ') || '—';
  openModal(
    h('h2', {}, '모은 데이터 현황'),
    h('table', { class: 'tbl' },
      row('라벨한 영상', c.videos), row('시도', c.attempts, t.attempts), row('완등', c.sends, t.sends), row('실패', c.fails),
      row('판단 불가', c.unknown), row('입력 중', c.incomplete), row('암장', c.gyms, t.gyms), row('찍은 각도', c.angles, t.angles)),
    h('p', {}, h('b', {}, '각도 '), named(c.byAngle, S.cfg.angles)),
    h('p', {}, h('b', {}, '찍은 방법 '), named(c.byCamera, S.cfg.cameras)),
    h('h3', {}, '다음에 찍거나 올리면 좋은 영상'),
    sug.length ? h('ul', {}, sug.map((s) => h('li', {}, s))) : h('p', { class: 'muted' }, S.cfg.targets ? '목표를 다 채웠어요 🎉' : 'GitHub 저장소에 연결하면 목표와 함께 보여요.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: closeModal }, '닫기')));
}

function connectForm(onDone) {
  const params = new URLSearchParams(location.hash.slice(1));
  const repo = h('input', { class: 'input', placeholder: '계정/저장소 이름', value: params.get('repo') || repoHint() || (S.server && S.server.labelsRepo) || (S.store.settings && S.store.settings.repo) || '' });
  const token = h('input', { class: 'input', type: 'password', placeholder: '토큰 붙여 넣기 (github_pat_…)', autocomplete: 'off' });
  const msg = h('p', { class: 'form-msg' });
  const go = h('button', { class: 'btn primary wide' }, '연결하기');
  go.onclick = async () => {
    const repoName = repo.value.replace(/\s+/g, '');
    const tok = token.value.replace(/\s+/g, ''); // 폰에서 복사하면 줄바꿈·공백이 섞이기도 한다
    const fail = (text) => { msg.textContent = text; msg.className = 'form-msg error'; };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoName)) { fail("저장소는 '계정/저장소' 형식으로 써 주세요 (예: name/labels)"); return; }
    if (!tok) { fail('토큰을 붙여 넣어 주세요'); return; }
    if (/[^\x21-\x7e]/.test(tok)) { fail('토큰에 다른 글자가 섞였어요. GitHub에서 토큰을 다시 복사해 붙여 넣어 주세요.'); return; }
    go.disabled = true;
    msg.textContent = '확인 중…';
    msg.className = 'form-msg';
    const res = await Store.checkConnection(repoName, tok);
    go.disabled = false;
    if (!res.ok) { msg.textContent = res.message; msg.className = 'form-msg error'; return; }
    Store.saveSettings(res.settings);
    S.store.settings = res.settings;
    renderSync();
    const pending = (await S.store.entries()).filter((e) => e.dirty).length;
    if (pending && !confirm(`이 기기에서 만든 라벨 ${pending}개를 저장소에 올릴까요?\n취소하면 지워져요.`)) await S.store.discardPending();
    onDone();
    await afterConnect();
    S.store.sync();
    toast('연결했어요 — 라벨이 저장소에 올라가요');
  };
  return h('div', { class: 'connect' },
    h('label', { class: 'field' }, '라벨 저장소', repo),
    h('label', { class: 'field' }, 'GitHub 토큰', token),
    h('details', { class: 'token-help' }, h('summary', {}, '토큰 만드는 법 (처음 한 번, 2분)'),
      h('ol', {},
        h('li', {}, h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener' }, 'GitHub 토큰 만들기 페이지 열기'), ' (GitHub 로그인)'),
        h('li', {}, 'Token name: 아무 이름 (예: 라벨링-폰) · Expiration: 원하는 기간'),
        h('li', {}, 'Repository access → Only select repositories → 위 라벨 저장소 고르기'),
        h('li', {}, 'Permissions → Repository permissions → Contents → Read and write'),
        h('li', {}, 'Generate token → 나온 토큰을 복사해서 위 칸에 붙여 넣기')),
      h('p', { class: 'muted small' }, '토큰은 이 기기 브라우저에만 저장돼요. 폰을 잃어버리면 GitHub에서 토큰을 지우면 돼요.')),
    go, msg);
}

function showOnboarding() {
  $('#modal').dataset.locked = '1';
  openModal(
    h('h2', {}, '클라이밍 영상 라벨링'),
    h('p', {}, '영상을 보면서 순간 6가지만 찍으면 완등·실패는 자동으로 계산돼요.'),
    h('ol', { class: 'howto big' },
      h('li', {}, h('b', {}, '영상 고르기'), h('span', { class: 'muted' }, ' — 갤러리 영상을 그대로 열어요 (올라가지 않아요)')),
      h('li', {}, h('b', {}, '홀드 표시'), h('span', { class: 'muted' }, ' — 시작 홀드와 탑 홀드를 영상 위에 표시')),
      h('li', {}, h('b', {}, '순간 찍기'), h('span', { class: 'muted' }, ' — 재생하다 멈추고 버튼을 눌러요'))),
    h('h3', {}, 'GitHub에 연결하면 폰·노트북 어디서든 이어서 해요'),
    connectForm(() => { delete $('#modal').dataset.locked; closeModal(); }),
    h('div', { class: 'or' }, '또는'),
    h('button', {
      class: 'btn wide',
      onclick: () => {
        const s = { mode: 'local' };
        Store.saveSettings(s);
        S.store.settings = s;
        delete $('#modal').dataset.locked;
        closeModal();
        renderSync();
        toast('체험 모드 — 라벨은 이 기기에만 저장돼요');
      },
    }, '체험 모드로 둘러보기 (이 기기에만 저장)'));
}

function showSettings() {
  closeDrawer();
  const s = S.store.settings;
  const body = [h('h2', {}, '연결 설정')];
  if (S.store.mode === 'github') {
    body.push(h('p', {}, `라벨 저장소: `, h('b', {}, s.repo)),
      h('button', {
        class: 'btn danger',
        onclick: () => {
          if (!confirm('이 기기에서 연결을 끊을까요? 올리지 않은 라벨은 기기에 남아 있다가 다시 연결하면 올라가요.')) return;
          const local = { mode: 'local' };
          Store.saveSettings(local);
          S.store.settings = local;
          closeModal();
          renderSync();
        },
      }, '연결 끊기'),
      h('h3', {}, '다른 토큰으로 바꾸기'));
  } else {
    body.push(h('p', { class: 'muted' }, '지금은 체험 모드예요. 연결하면 이 기기의 라벨도 함께 올릴 수 있어요.'));
  }
  body.push(connectForm(closeModal), h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: closeModal }, '닫기')));
  openModal(...body);
}

function resolveConflict(mine, theirs) {
  return new Promise((resolve) => {
    $('#modal').dataset.locked = '1';
    const done = (v) => { delete $('#modal').dataset.locked; closeModal(); resolve(v); };
    const when = (l) => (l.updatedAt ? new Date(l.updatedAt).toLocaleString('ko-KR') : '알 수 없음');
    openModal(
      h('h2', {}, '다른 기기에서도 이 영상 라벨을 고쳤어요'),
      h('p', {}, `영상: ${labelName(mine)}`),
      h('p', { class: 'muted' }, `이 기기: ${when(mine)} · 다른 기기: ${when(theirs)}`),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => done('theirs') }, '다른 기기 것 받기'),
        h('button', { class: 'btn primary', onclick: () => done('mine') }, '이 기기 것으로 덮어쓰기')));
  });
}

function exportLabels() {
  closeDrawer();
  const data = JSON.stringify([...S.labels.values()], null, 1);
  const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: `labels-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  toast(`라벨 ${S.labels.size}개를 파일로 내보냈어요`);
}

async function importLabels(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = (Array.isArray(data) ? data : [data]).filter((l) => l && l.schema === 'climb-label/1' && l.video && l.video.fingerprint);
    for (const l of list) {
      const saved = await S.store.save(l);
      S.labels.set(saved.video.fingerprint, saved);
    }
    S.store.sync();
    renderList();
    toast(`라벨 ${list.length}개를 가져왔어요`);
  } catch (e) {
    toast(`가져오지 못했어요: ${e.message}`);
  }
}

// ---------------------------------------------------------------- 입력 연결

function bindUi() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const n = Number(el.dataset.n || 0);
    if (act === 'open-file') openPicker();
    else if (act === 'next-video') nextVideo();
    else if (act === 'batch') showBatch();
    else if (act === 'close-drawer') closeDrawer();
    else if (act === 'sync') { closeDrawer(); if (S.store.mode === 'github') S.store.sync(); else showSettings(); }
    else if (act === 'coverage') showCoverage();
    else if (act === 'help') showHelp();
    else if (act === 'export') exportLabels();
    else if (act === 'import') { closeDrawer(); $('#importPicker').click(); }
    else if (act === 'settings') showSettings();
    else if (act === 'zoom-in') zoomCenter(1.6);
    else if (act === 'zoom-out') zoomCenter(1 / 1.6);
    else if (act === 'zoom-reset') resetView();
  });
  $$('[data-hold]').forEach((b) => {
    const n = Number(b.dataset.n);
    const frame = b.dataset.hold === 'frame';
    holdable(b, frame ? () => stepFrames(n) : () => stepSeconds(n), frame ? HOLD_FRAME_MS : HOLD_SEC_MS);
  });
  window.addEventListener('pointerup', stopHold, true);
  window.addEventListener('pointercancel', stopHold, true);
  window.addEventListener('blur', () => stopHold());
  document.addEventListener('visibilitychange', () => stopHold());
  $('#menuBtn').addEventListener('click', openDrawer);
  $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#undoBtn').addEventListener('click', undo);
  $('#syncChip').addEventListener('click', () => { if (S.store.mode === 'github') S.store.sync(); else showSettings(); });
  $('#playBtn').addEventListener('click', togglePlay);
  $('#speedBtn').addEventListener('click', () => setSpeed((S.speedIdx + 1) % SPEEDS.length));
  $('#drawCancel').addEventListener('click', cancelDraw);
  $('#filePicker').addEventListener('change', (e) => { onFilesPicked(Array.from(e.target.files)); e.target.value = ''; });
  $('#importPicker').addEventListener('change', (e) => { importLabels(e.target.files[0]); e.target.value = ''; });
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#problemName').addEventListener('focus', () => { S.typingSnap = false; });
  $('#problemName').addEventListener('input', (e) => {
    if (!S.label) return;
    if (!S.typingSnap) { pushUndo(); S.typingSnap = true; }
    prob().name = e.target.value;
    scheduleSave(600);
  });
  for (const el of $$('#infoForm [data-tag]')) {
    el.addEventListener('focus', () => { S.typingSnap = false; });
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (!S.label) return;
      if (el.tagName === 'SELECT' || !S.typingSnap) { pushUndo(); S.typingSnap = true; }
      const k = el.dataset.tag;
      if (k === 'standard') S.label.tags.standard = el.value === 'Y' ? true : el.value === 'N' ? false : null;
      else S.label.tags[k] = el.value || (k === 'gym' || k === 'note' ? '' : null);
      scheduleSave(600);
      if (k === 'camera') drawOverlay();
    });
  }

  video.addEventListener('loadedmetadata', () => { renderLabel(); drawOverlay(); });
  video.addEventListener('play', () => { $('#playBtn').textContent = '❚❚'; requestAnimationFrame(frameLoop); });
  video.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; updateTime(); });
  video.addEventListener('seeked', updateTime);
  video.addEventListener('timeupdate', () => { if (video.paused) updateTime(); });
  video.addEventListener('error', () => {
    if (!S.src) return;
    banner('error', '이 브라우저에서 영상을 재생할 수 없어요. 크롬이나 사파리에서 열어 주세요. (HEVC 영상은 파이어폭스에서 재생되지 않아요)');
  });

  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointermove', onCanvasMove);
  canvas.addEventListener('pointerup', onCanvasUp);
  canvas.addEventListener('pointercancel', onCanvasUp);
  canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
  scrubFrom(timeline, () => [0, durMs()]);
  scrubFrom($('#zoomRail'), () => zoomRange() || [0, durMs()]);

  window.addEventListener('resize', () => { applyView(); renderTimeline(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveNow(); if (S.store) S.store.sync(); }
  });
  window.addEventListener('beforeunload', () => { saveNow(); });
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if (e.key === 'Escape') {
    if (S.draw) cancelDraw();
    closeModal();
    closeDrawer();
    if (typing) e.target.blur();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ' && !typing) { e.preventDefault(); undo(); return; }
  if (typing || e.isComposing || e.metaKey || e.ctrlKey || !$('#modal').hidden) return;
  const c = e.code;
  if (c === 'Slash') { showHelp(); return; }
  if (!S.label) return;
  if (c === 'Space') { e.preventDefault(); togglePlay(); }
  else if (c === 'ArrowLeft' || c === 'ArrowRight') {
    e.preventDefault();
    if (e.repeat && video.seeking) return; // 꾹 누를 때 앞 장면이 나오기 전에 또 옮기면 화면이 멈춘 것처럼 보인다
    const dir = c === 'ArrowLeft' ? -1 : 1;
    if (e.shiftKey) stepSeconds(dir); else if (e.altKey) stepSeconds(5 * dir); else stepFrames(dir);
  } else if (c === 'ArrowUp' || c === 'ArrowDown') { e.preventDefault(); selectAttempt(S.ai + (c === 'ArrowUp' ? -1 : 1)); }
  else if (c === 'BracketLeft') setSpeed(S.speedIdx - 1);
  else if (c === 'BracketRight') setSpeed(S.speedIdx + 1);
  else if (KEY_CODES[c] && !e.altKey) { e.preventDefault(); setMoment(KEY_CODES[c]); }
  else if (c === 'KeyN') { mutate(() => addAttempt()); toast(`새 시도 #${S.ai + 1}`); }
  else if (c === 'Digit1') { switchTab('holds'); startDraw('start', 0); }
  else if (c === 'Digit2') { switchTab('holds'); startDraw('start', 1); }
  else if (c === 'Digit3') { switchTab('holds'); startDraw('top'); }
  else if (c === 'Equal' || c === 'NumpadAdd') zoomCenter(1.6);
  else if (c === 'Minus' || c === 'NumpadSubtract') zoomCenter(1 / 1.6);
  else if (c === 'Digit0') resetView();
}

init();
