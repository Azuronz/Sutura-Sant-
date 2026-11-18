'use strict';

const CACHE_VERSION = 'sutura-shell-v3';
const COQUILLE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];
const FICHIERS_COQUILLE = new Set(COQUILLE.filter((url) => url !== '/' && url !== '/index.html'));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(COQUILLE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((versions) => Promise.all(
        versions
          .filter((version) => version !== CACHE_VERSION)
          .map((version) => caches.delete(version))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requete = event.request;
  if (requete.method !== 'GET') return;

  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) return;

  const estApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (estApi) return;

  const estPageHtml = requete.mode === 'navigate'
    || requete.destination === 'document'
    || url.pathname === '/'
    || url.pathname.endsWith('.html');

  if (estPageHtml) {
    event.respondWith(
      fetch(requete).catch(async () => (
        await caches.match(requete)
        || await caches.match('/index.html')
        || Response.error()
      ))
    );
    return;
  }

  if (!FICHIERS_COQUILLE.has(url.pathname)) return;

  event.respondWith(
    caches.match(requete).then((enCache) => enCache || fetch(requete))
  );
});
