'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ouvrirBase } = require('../server/db');
const { creerApplication } = require('../server/index');

async function avecServeur(t) {
  const dossierTemporaire = fs.mkdtempSync(path.join(os.tmpdir(), 'sutura-pwa-test-'));
  const db = ouvrirBase(path.join(dossierTemporaire, 'test.sqlite'));
  const serveur = creerApplication({ db }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    serveur.once('listening', resolve);
    serveur.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve) => serveur.close(resolve));
    db.close();
    fs.rmSync(dossierTemporaire, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${serveur.address().port}`;
}

test('GET /manifest.json renvoie le manifeste Sutura Santé', async (t) => {
  const base = await avecServeur(t);
  const reponse = await fetch(`${base}/manifest.json`);
  const manifeste = await reponse.json();

  assert.equal(reponse.status, 200);
  assert.match(reponse.headers.get('content-type') || '', /application\/json/i);
  assert.equal(manifeste.name, 'Sutura Santé');
});

test('GET /sw.js renvoie le service worker en JavaScript', async (t) => {
  const base = await avecServeur(t);
  const reponse = await fetch(`${base}/sw.js`);

  assert.equal(reponse.status, 200);
  assert.match(reponse.headers.get('content-type') || '', /javascript/i);
  assert.match(await reponse.text(), /sutura-shell-v1/);
});

test('le service worker exclut /api du cache et laisse ces requêtes au réseau', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const listeCache = source.match(/const COQUILLE = \[([\s\S]*?)\];/);

  assert.ok(listeCache, 'La liste de la coquille doit être déclarée.');
  assert.doesNotMatch(listeCache[1], /['"]\/api(?:\/|['"])/);
  const contournementApi = source.indexOf('if (estApi) return;');
  const premierInterception = source.indexOf('event.respondWith');
  assert.ok(contournementApi >= 0 && contournementApi < premierInterception);
});
