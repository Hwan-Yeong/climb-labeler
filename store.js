/* 라벨 저장 — 이 기기(IndexedDB)에 바로 저장하고, GitHub 비공개 저장소(labels/<지문>.json)로 올린다. 전역 Store로 노출.
 * 모드: 'github'(토큰 연결) | 'local'(체험 모드: 이 기기에만). 오프라인이면 기기에 두었다가 연결되면 올린다. */
(function (root) {
  'use strict';

  const DB_NAME = 'climb-labeler';
  const SETTINGS_KEY = 'climb-labeler:gh';
  const API = 'https://api.github.com';
  const SYNC_DELAY_MS = 20000;

  // ---------------------------------------------------------------- IndexedDB

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('labels')) db.createObjectStore('labels', { keyPath: 'fp' });
        // 영상 정보(썸네일·길이·고른 시각) — 이 기기에서만 쓰고 GitHub에는 올리지 않는다
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'fp' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idb(db, mode, fn, store = 'labels') {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  // ---------------------------------------------------------------- 설정

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      return s && (s.mode === 'local' || (s.mode === 'github' && s.repo && s.token)) ? s : null;
    } catch (_) {
      return null;
    }
  }

  function saveSettings(s) {
    try {
      if (s) localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
      else localStorage.removeItem(SETTINGS_KEY);
    } catch (_) { /* 저장 공간 막힘: 이번 세션만 */ }
  }

  // ---------------------------------------------------------------- GitHub

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function gh(settings, method, path, body) {
    let res;
    // 주의: 주소 끝에 '/'가 붙으면 GitHub가 CORS 사전 요청에 404를 돌려줘 브라우저가 요청을 막는다
    const url = `${API}/repos/${settings.repo}${path ? `/${path}` : ''}`;
    try {
      res = await fetch(url, {
        method,
        cache: 'no-store',
        headers: Object.assign(
          { Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          body ? { 'Content-Type': 'application/json' } : {},
        ),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // 요청이 아예 실패: 오프라인이거나, 브라우저가 막음(네트워크·보안 정책)
      const offline = !navigator.onLine;
      const err = new Error(offline ? '인터넷에 연결되지 않았어요' : `GitHub에 연결하지 못했어요 (${e.message}). 잠시 뒤 다시 시도해 주세요.`);
      err.offline = offline;
      throw err;
    }
    if (res.status === 404) return null;
    let data = null;
    try { data = await res.json(); } catch (_) { /* 본문 없음 */ }
    if (!res.ok) {
      const err = new Error(explain(res.status, data && data.message));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function explain(status, message) {
    if (status === 401) return '토큰이 맞지 않거나 만료됐어요. 메뉴 → 연결 설정에서 새 토큰을 넣어 주세요.';
    if (status === 403) return '이 토큰으로는 저장소에 쓸 수 없어요. 토큰 권한에서 Contents를 Read and write로 해 주세요.';
    return message ? `GitHub 오류: ${message}` : `GitHub 오류 (${status})`;
  }

  function deviceName() {
    return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? '폰' : '노트북';
  }

  const strip = (label) => JSON.stringify(Object.assign({}, label, { updatedAt: null }));

  // ---------------------------------------------------------------- 저장소

  class LabelStore {
    constructor(db, settings) {
      this.db = db;
      this.settings = settings;
      this.listeners = new Set();
      this.timer = null;
      this.status = { syncing: false, error: null, offline: !navigator.onLine, lastSync: null, pending: 0 };
      this.onConflict = async () => 'mine';
      root.addEventListener('online', () => { this.status.offline = false; this.emit(); this.sync(); });
      root.addEventListener('offline', () => { this.status.offline = true; this.emit(); });
    }

    get mode() { return this.settings && this.settings.mode === 'github' ? 'github' : 'local'; }

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    emit() { for (const fn of this.listeners) fn(this.status); }

    async entry(fp) { return (await idb(this.db, 'readonly', (s) => s.get(fp))) || null; }

    async entries() { return (await idb(this.db, 'readonly', (s) => s.getAll())) || []; }

    async put(e) { await idb(this.db, 'readwrite', (s) => s.put(e)); }

    async remove(fp) { await idb(this.db, 'readwrite', (s) => s.delete(fp)); }

    async meta(fp) { return (await idb(this.db, 'readonly', (s) => s.get(fp), 'meta')) || null; }

    async putMeta(m) { await idb(this.db, 'readwrite', (s) => s.put(m), 'meta'); }

    async allMeta() { return (await idb(this.db, 'readonly', (s) => s.getAll(), 'meta')) || []; }

    async refreshPending() {
      this.status.pending = (await this.entries()).filter((e) => e.dirty).length;
      this.emit();
    }

    /** 라벨 읽기: 기기 → (연결돼 있으면) 원격이 더 새것인지 확인 */
    async load(fp) {
      let e = await this.entry(fp);
      if (this.mode === 'github' && navigator.onLine) {
        try {
          const remote = await gh(this.settings, 'GET', `contents/labels/${fp}.json?ref=main`);
          if (remote && (!e || (!e.dirty && e.sha !== remote.sha))) {
            e = { fp, label: JSON.parse(b64decode(remote.content)), sha: remote.sha, dirty: false };
            await this.put(e);
          }
          this.status.error = null;
        } catch (err) {
          if (err.offline) this.status.offline = true; else this.status.error = err.message;
          this.emit();
        }
      }
      return e ? e.label : null;
    }

    /** 저장: 기기에 바로, GitHub에는 잠시 뒤 모아서 */
    async save(label) {
      const fp = label.video && label.video.fingerprint;
      if (!fp) throw new Error('영상 지문이 없어요');
      const clean = root.Rules.normalizeLabel(label);
      clean.updatedAt = new Date().toISOString();
      const prev = await this.entry(fp);
      await this.put({ fp, label: clean, sha: prev ? prev.sha : null, dirty: true });
      await this.refreshPending();
      this.schedule();
      return clean;
    }

    schedule(ms = SYNC_DELAY_MS) {
      if (this.mode !== 'github') return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.sync(), ms);
    }

    /** 바뀐 라벨을 GitHub에 올린다 (파일마다 커밋 1개). 다른 기기에서 바뀌었으면 onConflict로 묻는다. */
    async sync() {
      if (this.mode !== 'github' || this.status.syncing) return;
      clearTimeout(this.timer);
      const dirty = (await this.entries()).filter((e) => e.dirty);
      if (!dirty.length) { await this.refreshPending(); return; }
      this.status.syncing = true;
      this.status.error = null;
      this.emit();
      try {
        for (const e of dirty) await this.upload(e);
        this.status.lastSync = new Date();
        this.status.offline = false;
      } catch (err) {
        if (err.offline) this.status.offline = true; else this.status.error = err.message;
      } finally {
        this.status.syncing = false;
        await this.refreshPending();
      }
    }

    async upload(e) {
      const path = `contents/labels/${e.fp}.json`;
      const body = (sha) => ({
        message: `라벨: ${(e.label.video && e.label.video.file) || e.fp} (${deviceName()})`,
        content: b64encode(JSON.stringify(e.label, null, 2) + '\n'),
        branch: 'main',
        ...(sha ? { sha } : {}),
      });
      try {
        const res = await gh(this.settings, 'PUT', path, body(e.sha));
        await this.put({ fp: e.fp, label: e.label, sha: res.content.sha, dirty: false });
      } catch (err) {
        if (err.status !== 409 && err.status !== 422) throw err;
        const remote = await gh(this.settings, 'GET', `${path}?ref=main`);
        if (!remote) { // 원격에서 지워짐 → 새로 올린다
          const res = await gh(this.settings, 'PUT', path, body(null));
          await this.put({ fp: e.fp, label: e.label, sha: res.content.sha, dirty: false });
          return;
        }
        const theirs = JSON.parse(b64decode(remote.content));
        if (strip(theirs) === strip(e.label)) {
          await this.put({ fp: e.fp, label: e.label, sha: remote.sha, dirty: false });
          return;
        }
        const choice = await this.onConflict(e.label, theirs);
        if (choice === 'theirs') {
          await this.put({ fp: e.fp, label: theirs, sha: remote.sha, dirty: false });
        } else {
          const res = await gh(this.settings, 'PUT', path, body(remote.sha));
          await this.put({ fp: e.fp, label: e.label, sha: res.content.sha, dirty: false });
        }
      }
    }

    /** 저장소의 모든 라벨을 받아 기기 캐시를 맞춘다 (바뀐 파일만) → 라벨 목록 */
    async refreshAll() {
      if (this.mode === 'github' && navigator.onLine) {
        try {
          const list = (await gh(this.settings, 'GET', 'contents/labels?ref=main')) || [];
          const local = new Map((await this.entries()).map((e) => [e.fp, e]));
          for (const f of list) {
            if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
            const fp = f.name.slice(0, -5);
            const e = local.get(fp);
            if (e && (e.dirty || e.sha === f.sha)) continue;
            const remote = await gh(this.settings, 'GET', `contents/labels/${fp}.json?ref=main`);
            if (remote) await this.put({ fp, label: JSON.parse(b64decode(remote.content)), sha: remote.sha, dirty: false });
          }
          this.status.error = null;
        } catch (err) {
          if (err.offline) this.status.offline = true; else this.status.error = err.message;
        }
        this.emit();
      }
      return (await this.entries()).map((e) => e.label);
    }

    async fetchConfig() {
      if (this.mode !== 'github') return null;
      const f = await gh(this.settings, 'GET', 'contents/config.json?ref=main');
      return f ? JSON.parse(b64decode(f.content)) : null;
    }

    async discardPending() {
      for (const e of await this.entries()) if (e.dirty && !e.sha) await this.remove(e.fp);
      await this.refreshPending();
    }
  }

  /** 토큰·저장소 확인 → {ok, message} */
  async function checkConnection(repo, token) {
    const settings = { mode: 'github', repo, token };
    try {
      const info = await gh(settings, 'GET', '');
      if (!info) return { ok: false, message: `저장소 '${repo}'를 찾을 수 없어요. 이름을 확인하거나, 토큰에 이 저장소를 골랐는지 확인해 주세요.` };
      if (info.permissions && info.permissions.push === false) return { ok: false, message: '읽기만 되는 토큰이에요. Contents 권한을 Read and write로 바꿔 주세요.' };
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  root.Store = { openDb, LabelStore, loadSettings, saveSettings, checkConnection, b64encode, b64decode };
})(typeof window !== 'undefined' ? window : globalThis);
