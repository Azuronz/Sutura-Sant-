'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ouvrirBase } = require('../server/db');
const { creerApplication } = require('../server/index');

async function avecServeur(t) {
  const dossierTemporaire = fs.mkdtempSync(path.join(os.tmpdir(), 'satura-informations-test-'));
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

test('GET /api/informations renvoie une liste sans les détails des fiches', async (t) => {
  const base = await avecServeur(t);
  const reponse = await fetch(`${base}/api/informations`);
  const contenu = await reponse.json();

  assert.equal(reponse.status, 200);
  assert.ok(Array.isArray(contenu.informations));
  assert.ok(contenu.informations.length >= 5);
  for (const fiche of contenu.informations) {
    assert.deepEqual(Object.keys(fiche).sort(), [
      'categorie', 'resume', 'slug', 'statut_validation', 'titre'
    ]);
    assert.equal('signes_alerte' in fiche, false);
    assert.equal('quoi_faire' in fiche, false);
    assert.equal('quand_consulter' in fiche, false);
  }
});

test('GET /api/informations/:slug inconnu renvoie un 404 JSON', async (t) => {
  const base = await avecServeur(t);
  const reponse = await fetch(`${base}/api/informations/fiche-inconnue`);
  const contenu = await reponse.json();

  assert.equal(reponse.status, 404);
  assert.deepEqual(contenu, { erreur: 'Fiche d’information introuvable.' });
});
