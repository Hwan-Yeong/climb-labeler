/* 화면 파일을 캐시해 인터넷이 약한 곳(암장)에서도 열리게 한다. 영상(blob:)·GitHub 요청은 건드리지 않는다.
 * 네트워크 먼저(새 버전 반영), 안 되면 캐시. 네트워크 요청은 HTTP 캐시를 다시 확인(no-cache)해서
 * 배포 직후에도 옛 파일(GitHub Pages max-age 10분)이 나오지 않게 한다. */
const CACHE = 'climb-labeler-v6';
const FILES = ['./', 'index.html', 'style.css', 'rules.js', 'store.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

// 새 버전은 설치만 해 두고, 화면이 '적용'을 보내면 바꾼다 (라벨링 중에 영상이 닫히지 않게)
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
