'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ouvrirBase } = require('../server/db');
const { creerApplication } = require('../server/index');

async function creerContexte(t) {
  const dossierTemporaire = fs.mkdtempSync(path.join(os.tmpdir(), 'sutura-rdv-test-'));
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

  const adresse = serveur.address();
  const base = `http://127.0.0.1:${adresse.port}`;
  async function appeler(route, { method = 'GET', body, cookie, headers = {} } = {}) {
    const reponse = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    });
    const texte = await reponse.text();
    let donnees = null;
    try {
      donnees = JSON.parse(texte);
    } catch {}
    return { status: reponse.status, donnees, setCookie: reponse.headers.get('set-cookie') };
  }
  return { appeler, db };
}

function creerAdmin(db) {
  db.prepare(`
    INSERT INTO utilisateurs
      (role, prenom, nom, email, telephone, date_naissance, mot_de_passe_hash, matricule, specialite, cree_le)
    VALUES ('admin', 'Admin', 'Test', 'admin@example.test', NULL, NULL, ?, NULL, NULL, ?)
  `).run(bcrypt.hashSync('motdepasse-admin-8', 4), new Date().toISOString());
}

async function ouvrirSession(appeler, identifiant, motDePasse) {
  const connexion = await appeler('/api/auth/connexion', {
    method: 'POST',
    body: { identifiant, mot_de_passe: motDePasse, rester_connecte: true }
  });
  assert.equal(connexion.status, 200);
  return connexion.setCookie.split(';', 1)[0];
}

async function preparerAdmin(contexte) {
  creerAdmin(contexte.db);
  return ouvrirSession(contexte.appeler, 'admin@example.test', 'motdepasse-admin-8');
}

async function creerMedecin(appeler, cookieAdmin, {
  prenom = 'Moussa',
  nom = 'Fall',
  email = 'medecin@example.test',
  matricule = 'MED-001',
  specialite = 'médecin généraliste'
} = {}) {
  return appeler('/api/admin/comptes', {
    method: 'POST',
    cookie: cookieAdmin,
    body: {
      role: 'medecin', prenom, nom, email, matricule, specialite,
      mot_de_passe: 'motdepasse-medecin-8'
    }
  });
}

async function creerPersonnel(appeler, cookieAdmin) {
  return appeler('/api/admin/comptes', {
    method: 'POST',
    cookie: cookieAdmin,
    body: {
      role: 'personnel', prenom: 'Ibra', nom: 'Sow', email: 'personnel@example.test',
      matricule: 'PER-001', mot_de_passe: 'motdepasse-personnel-8'
    }
  });
}

async function inscrirePatient(appeler, {
  prenom = 'Awa',
  nom = 'Test',
  email = 'awa@example.test',
  telephone = null
} = {}) {
  return appeler('/api/auth/inscription', {
    method: 'POST',
    body: {
      prenom, nom, email, telephone, date_naissance: '2000-01-15',
      mot_de_passe: 'motdepasse-patient-8'
    }
  });
}

function prochainLundi() {
  const aujourdHui = new Date();
  const aujourdHuiUtc = new Date(Date.UTC(aujourdHui.getUTCFullYear(), aujourdHui.getUTCMonth(), aujourdHui.getUTCDate()));
  const jours = ((8 - aujourdHuiUtc.getUTCDay()) % 7) || 7;
  return new Date(aujourdHuiUtc.getTime() + jours * 86400000).toISOString().slice(0, 10);
}

function jourSemaine(lundi, decalage = 0) {
  return new Date(Date.parse(`${lundi}T00:00:00.000Z`) + decalage * 86400000).toISOString().slice(0, 10);
}

async function definirSemaine(appeler, cookieMedecin, lundi, plages = null) {
  const disponibilites = plages || [{
    date: lundi, heure_debut: '09:00', heure_fin: '11:00', duree_creneau: 30
  }];
  return appeler(`/api/medecin/disponibilites/${lundi}`, {
    method: 'PUT', cookie: cookieMedecin, body: disponibilites
  });
}

async function preparerMedecin(contexte, cookieAdmin, options = {}) {
  const creation = await creerMedecin(contexte.appeler, cookieAdmin, options);
  assert.equal(creation.status, 201);
  const cookie = await ouvrirSession(
    contexte.appeler,
    options.matricule || 'MED-001',
    'motdepasse-medecin-8'
  );
  return { id: creation.donnees.utilisateur.id, cookie, utilisateur: creation.donnees.utilisateur };
}

async function preparerPatient(appeler, options = {}) {
  const inscription = await inscrirePatient(appeler, options);
  assert.equal(inscription.status, 201);
  const cookie = await ouvrirSession(appeler, options.email || 'awa@example.test', 'motdepasse-patient-8');
  return { id: inscription.donnees.utilisateur.id, cookie, utilisateur: inscription.donnees.utilisateur };
}

async function prendreRendezVous(appeler, cookie, { medecinId, patientId, date, heure }) {
  return appeler('/api/rendez-vous', {
    method: 'POST', cookie,
    body: { ...(patientId ? { patient_id: patientId } : {}), medecin_id: medecinId, date, heure }
  });
}

test('le médecin définit sa semaine et le patient voit des créneaux libres sans identité', async (t) => {
  const contexte = await creerContexte(t);
  const cookieAdmin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, cookieAdmin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  const disponibilites = await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  assert.equal(disponibilites.status, 200);

  const listeMedecins = await contexte.appeler('/api/medecins', { cookie: patient.cookie });
  assert.equal(listeMedecins.status, 200);
  assert.deepEqual(Object.keys(listeMedecins.donnees.medecins[0]).sort(), ['id', 'nom', 'prenom', 'specialite']);

  const resultat = await contexte.appeler(
    `/api/medecins/${medecin.id}/creneaux?du=${lundi}&au=${jourSemaine(lundi, 6)}`,
    { cookie: patient.cookie }
  );
  assert.equal(resultat.status, 200);
  assert.equal(resultat.donnees.creneaux.length, 4);
  assert.ok(resultat.donnees.creneaux.every((creneau) => creneau.statut === 'libre'));
  assert.deepEqual(Object.keys(resultat.donnees.creneaux[0]).sort(), ['date', 'duree_creneau', 'heure', 'statut']);
  assert.equal(JSON.stringify(resultat.donnees).includes(patient.utilisateur.prenom), false);
});

test('un patient prend un créneau libre (201)', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  assert.equal((await definirSemaine(contexte.appeler, medecin.cookie, lundi)).status, 200);

  const resultat = await prendreRendezVous(contexte.appeler, patient.cookie, {
    medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  assert.equal(resultat.status, 201);
  assert.equal(resultat.donnees.rendez_vous.statut, 'confirme');
  assert.equal(resultat.donnees.rendez_vous.medecin.id, medecin.id);
  assert.equal('mot_de_passe_hash' in resultat.donnees.rendez_vous, false);
});

test('deux patients visant le même créneau obtiennent un succès et un conflit 409', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const awa = await preparerPatient(contexte.appeler);
  const binta = await preparerPatient(contexte.appeler, { prenom: 'Binta', email: 'binta@example.test' });
  const lundi = prochainLundi();
  assert.equal((await definirSemaine(contexte.appeler, medecin.cookie, lundi)).status, 200);

  const resultats = await Promise.all([
    prendreRendezVous(contexte.appeler, awa.cookie, { medecinId: medecin.id, date: lundi, heure: '09:00' }),
    prendreRendezVous(contexte.appeler, binta.cookie, { medecinId: medecin.id, date: lundi, heure: '09:00' })
  ]);
  assert.deepEqual(resultats.map((r) => r.status).sort(), [201, 409]);
  const conflit = resultats.find((r) => r.status === 409);
  assert.equal(conflit.donnees.erreur, "Ce créneau vient d'être réservé.");
});

test('un rendez-vous dans le passé est refusé (400)', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const hier = jourSemaine(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const resultat = await prendreRendezVous(contexte.appeler, patient.cookie, {
    medecinId: medecin.id, date: hier, heure: '09:00'
  });
  assert.equal(resultat.status, 400);
  assert.match(resultat.donnees.erreur, /passé/);
});

test('un patient ne peut pas annuler le rendez-vous d’un autre patient (404)', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const awa = await preparerPatient(contexte.appeler);
  const binta = await preparerPatient(contexte.appeler, { prenom: 'Binta', email: 'binta@example.test' });
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, awa.cookie, {
    medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  const annulation = await contexte.appeler(`/api/rendez-vous/${creation.donnees.rendez_vous.id}/annulation`, {
    method: 'POST', cookie: binta.cookie, body: {}
  });
  assert.equal(annulation.status, 404);
});

test('un patient annule son rendez-vous et le créneau redevient libre', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, patient.cookie, {
    medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  const annulation = await contexte.appeler(`/api/rendez-vous/${creation.donnees.rendez_vous.id}/annulation`, {
    method: 'POST', cookie: patient.cookie, body: {}
  });
  assert.equal(annulation.status, 200);
  assert.equal(annulation.donnees.rendez_vous.statut, 'annule');
  const creneaux = await contexte.appeler(`/api/medecins/${medecin.id}/creneaux?du=${lundi}&au=${lundi}`, {
    cookie: patient.cookie
  });
  assert.equal(creneaux.donnees.creneaux[0].statut, 'libre');
});

test('un médecin ne peut pas retirer une plage occupée par un rendez-vous confirmé (409 avec liste)', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, patient.cookie, {
    medecinId: medecin.id, date: lundi, heure: '09:00'
  });

  const modification = await definirSemaine(contexte.appeler, medecin.cookie, lundi, []);
  assert.equal(modification.status, 409);
  assert.equal(modification.donnees.rendez_vous.length, 1);
  assert.equal(modification.donnees.rendez_vous[0].id, creation.donnees.rendez_vous.id);
  const compte = contexte.db.prepare('SELECT COUNT(*) AS nombre FROM disponibilites WHERE medecin_id = ? AND date = ?').get(medecin.id, lundi);
  assert.equal(compte.nombre, 1);
});

test('un médecin ne voit que ses propres rendez-vous', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecinA = await preparerMedecin(contexte, admin);
  const medecinB = await preparerMedecin(contexte, admin, {
    prenom: 'Fatou', nom: 'Ndiaye', email: 'medecin2@example.test', matricule: 'MED-002'
  });
  const awa = await preparerPatient(contexte.appeler);
  const binta = await preparerPatient(contexte.appeler, { prenom: 'Binta', email: 'binta@example.test' });
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecinA.cookie, lundi);
  await definirSemaine(contexte.appeler, medecinB.cookie, lundi, [{
    date: lundi, heure_debut: '11:00', heure_fin: '12:00', duree_creneau: 30
  }]);
  await prendreRendezVous(contexte.appeler, awa.cookie, { medecinId: medecinA.id, date: lundi, heure: '09:00' });
  await prendreRendezVous(contexte.appeler, binta.cookie, { medecinId: medecinB.id, date: lundi, heure: '11:00' });

  const liste = await contexte.appeler(`/api/medecin/rendez-vous?du=${lundi}&au=${lundi}`, { cookie: medecinA.cookie });
  assert.equal(liste.status, 200);
  assert.equal(liste.donnees.rendez_vous.length, 1);
  assert.equal(liste.donnees.rendez_vous[0].patient.prenom, 'Awa');
  assert.equal('email' in liste.donnees.rendez_vous[0].patient, false);
});

test('le personnel crée un rendez-vous, le déplace et libère l’ancien créneau', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const creationPersonnel = await creerPersonnel(contexte.appeler, admin);
  assert.equal(creationPersonnel.status, 201);
  const cookiePersonnel = await ouvrirSession(contexte.appeler, 'PER-001', 'motdepasse-personnel-8');
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);

  const creation = await prendreRendezVous(contexte.appeler, cookiePersonnel, {
    patientId: patient.id, medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  assert.equal(creation.status, 201);
  const deplacement = await contexte.appeler(`/api/rendez-vous/${creation.donnees.rendez_vous.id}`, {
    method: 'PATCH', cookie: cookiePersonnel, body: { heure: '09:30' }
  });
  assert.equal(deplacement.status, 200);
  assert.equal(deplacement.donnees.rendez_vous.heure, '09:30');
  const creneaux = await contexte.appeler(`/api/medecins/${medecin.id}/creneaux?du=${lundi}&au=${lundi}`, {
    cookie: patient.cookie
  });
  assert.equal(creneaux.donnees.creneaux.find((c) => c.heure === '09:00').statut, 'libre');
  assert.equal(creneaux.donnees.creneaux.find((c) => c.heure === '09:30').statut, 'pris');
  const journal = contexte.db.prepare("SELECT quoi FROM journal_acces WHERE quoi IN ('creation_rendez_vous', 'deplacement_rendez_vous') ORDER BY id").all();
  assert.deepEqual(journal.map((ligne) => ligne.quoi), ['creation_rendez_vous', 'deplacement_rendez_vous']);
});

test('le personnel consulte une fiche patient et une ligne est ajoutée au journal', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const creationPersonnel = await creerPersonnel(contexte.appeler, admin);
  assert.equal(creationPersonnel.status, 201);
  const cookiePersonnel = await ouvrirSession(contexte.appeler, 'PER-001', 'motdepasse-personnel-8');
  const patient = await preparerPatient(contexte.appeler);
  const avant = contexte.db.prepare("SELECT COUNT(*) AS nombre FROM journal_acces WHERE quoi = 'consultation_fiche_patient'").get().nombre;

  const fiche = await contexte.appeler(`/api/personnel/patients/${patient.id}`, { cookie: cookiePersonnel });
  assert.equal(fiche.status, 200);
  assert.equal(fiche.donnees.patient.email, 'awa@example.test');
  const lignes = contexte.db.prepare("SELECT qui_id, quoi, cible_id FROM journal_acces WHERE quoi = 'consultation_fiche_patient'").all();
  assert.equal(lignes.length, avant + 1);
  assert.equal(lignes.at(-1).qui_id, creationPersonnel.donnees.utilisateur.id);
  assert.equal(lignes.at(-1).cible_id, patient.id);
});

test('un patient ne peut pas appeler les routes du personnel (403)', async (t) => {
  const contexte = await creerContexte(t);
  const patient = await preparerPatient(contexte.appeler);
  const liste = await contexte.appeler('/api/personnel/patients', { cookie: patient.cookie });
  const fiche = await contexte.appeler(`/api/personnel/patients/${patient.id}`, { cookie: patient.cookie });
  assert.equal(liste.status, 403);
  assert.equal(fiche.status, 403);
});

test('un patient ne peut pas modifier les disponibilités d’un médecin (403)', async (t) => {
  const contexte = await creerContexte(t);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  const resultat = await contexte.appeler(`/api/medecin/disponibilites/${lundi}`, {
    method: 'PUT', cookie: patient.cookie, body: []
  });
  assert.equal(resultat.status, 403);
});

function figerHorloge(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-17T08:00:00.000Z').getTime() });
}

function aujourdHui() {
  return new Date().toISOString().slice(0, 10);
}

function lundiSemaineCourante() {
  const date = aujourdHui();
  const jour = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return jourSemaine(date, -((jour + 6) % 7));
}

function ajouterDisponibilite(db, medecinId, date, heureDebut = '09:00', heureFin = '10:00', duree = 30) {
  return db.prepare(`
    INSERT INTO disponibilites (medecin_id, date, heure_debut, heure_fin, duree_creneau, cree_le)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(medecinId, date, heureDebut, heureFin, duree, new Date().toISOString());
}

function ajouterRendezVousConfirme(db, { medecinId, patientId, date, heure = '09:00', creeParId = patientId }) {
  const resultat = db.prepare(`
    INSERT INTO rendez_vous
      (medecin_id, patient_id, date, heure, duree_creneau, statut, cree_par_id, cree_le)
    VALUES (?, ?, ?, ?, 30, 'confirme', ?, ?)
  `).run(medecinId, patientId, date, heure, creeParId, new Date().toISOString());
  return Number(resultat.lastInsertRowid);
}

test('prolonger une plage qui contient un rendez-vous confirmé réussit', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, patient.cookie, {
    medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  assert.equal(creation.status, 201);

  const modification = await definirSemaine(contexte.appeler, medecin.cookie, lundi, [{
    date: lundi, heure_debut: '09:00', heure_fin: '12:00', duree_creneau: 30
  }]);
  assert.equal(modification.status, 200);
  assert.ok(contexte.db.prepare('SELECT id FROM rendez_vous WHERE id = ? AND statut = ?').get(creation.donnees.rendez_vous.id, 'confirme'));
});

test('modifier les jours à venir préserve les disponibilités et rendez-vous passés de la semaine', async (t) => {
  figerHorloge(t);
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = lundiSemaineCourante();
  const datePasse = jourSemaine(lundi, 1);
  const dateFuture = jourSemaine(lundi, 3);
  ajouterDisponibilite(contexte.db, medecin.id, datePasse);
  const rendezVousId = ajouterRendezVousConfirme(contexte.db, {
    medecinId: medecin.id, patientId: patient.id, date: datePasse
  });

  const modification = await definirSemaine(contexte.appeler, medecin.cookie, lundi, [{
    date: dateFuture, heure_debut: '10:00', heure_fin: '11:00', duree_creneau: 30
  }]);
  assert.equal(modification.status, 200);
  assert.ok(contexte.db.prepare('SELECT id FROM rendez_vous WHERE id = ? AND statut = ?').get(rendezVousId, 'confirme'));
  assert.equal(contexte.db.prepare('SELECT COUNT(*) AS nombre FROM disponibilites WHERE medecin_id = ? AND date = ?').get(medecin.id, datePasse).nombre, 1);
  assert.equal(contexte.db.prepare('SELECT COUNT(*) AS nombre FROM disponibilites WHERE medecin_id = ? AND date = ?').get(medecin.id, dateFuture).nombre, 1);
});

test('une disponibilité dont la date est passée est refusée avec un message clair', async (t) => {
  figerHorloge(t);
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const lundi = lundiSemaineCourante();
  const datePasse = jourSemaine(lundi, 1);
  const resultat = await definirSemaine(contexte.appeler, medecin.cookie, lundi, [{
    date: datePasse, heure_debut: '10:00', heure_fin: '11:00', duree_creneau: 30
  }]);
  assert.equal(resultat.status, 400);
  assert.equal(resultat.donnees.erreur, 'Une disponibilité ne peut pas être créée dans le passé.');
});

test('la liste de créneaux masque les heures déjà passées', async (t) => {
  figerHorloge(t);
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const hier = jourSemaine(aujourdHui(), -1);
  const demain = jourSemaine(aujourdHui(), 1);
  ajouterDisponibilite(contexte.db, medecin.id, hier);
  ajouterDisponibilite(contexte.db, medecin.id, demain, '10:00', '11:00');

  const resultat = await contexte.appeler(`/api/medecins/${medecin.id}/creneaux?du=${hier}&au=${demain}`, {
    cookie: patient.cookie
  });
  assert.equal(resultat.status, 200);
  assert.deepEqual(resultat.donnees.creneaux.map((creneau) => creneau.date), [demain, demain]);
});

test('un patient ne peut pas annuler un rendez-vous passé (409)', async (t) => {
  figerHorloge(t);
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, patient.cookie, {
    medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  const hier = jourSemaine(aujourdHui(), -1);
  contexte.db.prepare('UPDATE rendez_vous SET date = ?, heure = ? WHERE id = ?')
    .run(hier, '09:00', creation.donnees.rendez_vous.id);

  const annulation = await contexte.appeler(`/api/rendez-vous/${creation.donnees.rendez_vous.id}/annulation`, {
    method: 'POST', cookie: patient.cookie, body: {}
  });
  assert.equal(annulation.status, 409);
  assert.equal(annulation.donnees.erreur, 'Ce rendez-vous est passé et ne peut plus être modifié.');
});

test('le personnel ne peut pas déplacer un rendez-vous passé (409)', async (t) => {
  figerHorloge(t);
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const personnel = await creerPersonnel(contexte.appeler, admin);
  assert.equal(personnel.status, 201);
  const cookiePersonnel = await ouvrirSession(contexte.appeler, 'PER-001', 'motdepasse-personnel-8');
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, cookiePersonnel, {
    patientId: patient.id, medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  const hier = jourSemaine(aujourdHui(), -1);
  contexte.db.prepare('UPDATE rendez_vous SET date = ?, heure = ? WHERE id = ?')
    .run(hier, '09:00', creation.donnees.rendez_vous.id);

  const deplacement = await contexte.appeler(`/api/rendez-vous/${creation.donnees.rendez_vous.id}`, {
    method: 'PATCH', cookie: cookiePersonnel, body: { heure: '09:30' }
  });
  assert.equal(deplacement.status, 409);
  assert.equal(deplacement.donnees.erreur, 'Ce rendez-vous est passé et ne peut plus être modifié.');
});

test('le journal du déplacement cible le patient et garde le rendez-vous comme ressource', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const personnel = await creerPersonnel(contexte.appeler, admin);
  assert.equal(personnel.status, 201);
  const cookiePersonnel = await ouvrirSession(contexte.appeler, 'PER-001', 'motdepasse-personnel-8');
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, cookiePersonnel, {
    patientId: patient.id, medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  const rendezVousId = creation.donnees.rendez_vous.id;
  const deplacement = await contexte.appeler(`/api/rendez-vous/${rendezVousId}`, {
    method: 'PATCH', cookie: cookiePersonnel, body: { heure: '09:30' }
  });
  assert.equal(deplacement.status, 200);

  const ligne = contexte.db.prepare(`
    SELECT qui_id, cible_id, ressource_id FROM journal_acces
    WHERE quoi = 'deplacement_rendez_vous' ORDER BY id DESC LIMIT 1
  `).get();
  assert.equal(ligne.qui_id, personnel.donnees.utilisateur.id);
  assert.equal(ligne.cible_id, patient.id);
  assert.equal(ligne.ressource_id, rendezVousId);
});

test('la réservation et l’annulation par un patient ne sont pas inscrites au journal', async (t) => {
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const lundi = prochainLundi();
  await definirSemaine(contexte.appeler, medecin.cookie, lundi);
  const creation = await prendreRendezVous(contexte.appeler, patient.cookie, {
    medecinId: medecin.id, date: lundi, heure: '09:00'
  });
  assert.equal(creation.status, 201);
  assert.equal(contexte.db.prepare("SELECT COUNT(*) AS nombre FROM journal_acces WHERE quoi = 'creation_rendez_vous'").get().nombre, 0);

  const annulation = await contexte.appeler(`/api/rendez-vous/${creation.donnees.rendez_vous.id}/annulation`, {
    method: 'POST', cookie: patient.cookie, body: {}
  });
  assert.equal(annulation.status, 200);
  assert.equal(contexte.db.prepare("SELECT COUNT(*) AS nombre FROM journal_acces WHERE quoi = 'annulation_rendez_vous'").get().nombre, 0);
});

test('une base existante ajoute ressource_id sans perdre le journal', (t) => {
  const dossierTemporaire = fs.mkdtempSync(path.join(os.tmpdir(), 'sutura-rdv-migration-test-'));
  const chemin = path.join(dossierTemporaire, 'legacy.sqlite');
  const ancienneBase = new DatabaseSync(chemin);
  ancienneBase.exec(`
    CREATE TABLE journal_acces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qui_id INTEGER,
      quoi TEXT NOT NULL,
      cible_id INTEGER,
      quand TEXT NOT NULL
    );
    INSERT INTO journal_acces (qui_id, quoi, cible_id, quand)
    VALUES (7, 'consultation_fiche_patient', 11, '2026-06-17T08:00:00.000Z');
  `);
  ancienneBase.close();

  const db = ouvrirBase(chemin);
  t.after(() => {
    db.close();
    fs.rmSync(dossierTemporaire, { recursive: true, force: true });
  });
  const colonnes = db.prepare('PRAGMA table_info(journal_acces)').all();
  assert.ok(colonnes.some((colonne) => colonne.name === 'ressource_id' && colonne.notnull === 0));
  const ligne = db.prepare('SELECT qui_id, quoi, cible_id, ressource_id FROM journal_acces WHERE id = 1').get();
  assert.deepEqual({ ...ligne }, {
    qui_id: 7, quoi: 'consultation_fiche_patient', cible_id: 11, ressource_id: null
  });
});

test('un rendez-vous passé aujourd’hui ne bloque pas la réduction de la plage du jour', async (t) => {
  figerHorloge(t);
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const aujourdHuiDate = aujourdHui();
  const lundi = lundiSemaineCourante();
  ajouterDisponibilite(contexte.db, medecin.id, aujourdHuiDate, '00:00', '02:00');
  const rendezVousId = ajouterRendezVousConfirme(contexte.db, {
    medecinId: medecin.id, patientId: patient.id, date: aujourdHuiDate, heure: '00:00'
  });

  const modification = await definirSemaine(contexte.appeler, medecin.cookie, lundi, [{
    date: aujourdHuiDate, heure_debut: '00:30', heure_fin: '02:00', duree_creneau: 30
  }]);
  assert.equal(modification.status, 200);
  assert.ok(contexte.db.prepare('SELECT id FROM rendez_vous WHERE id = ? AND statut = ?').get(rendezVousId, 'confirme'));
});

test('un rendez-vous à venir aujourd’hui empêche de retirer sa plage avec la liste en conflit', async (t) => {
  figerHorloge(t);
  const contexte = await creerContexte(t);
  const admin = await preparerAdmin(contexte);
  const medecin = await preparerMedecin(contexte, admin);
  const patient = await preparerPatient(contexte.appeler);
  const aujourdHuiDate = aujourdHui();
  const lundi = lundiSemaineCourante();
  ajouterDisponibilite(contexte.db, medecin.id, aujourdHuiDate, '09:00', '23:59');
  const rendezVousId = ajouterRendezVousConfirme(contexte.db, {
    medecinId: medecin.id, patientId: patient.id, date: aujourdHuiDate, heure: '23:59'
  });

  const modification = await definirSemaine(contexte.appeler, medecin.cookie, lundi, [{
    date: aujourdHuiDate, heure_debut: '09:00', heure_fin: '10:00', duree_creneau: 30
  }]);
  assert.equal(modification.status, 409);
  assert.equal(modification.donnees.rendez_vous.length, 1);
  assert.equal(modification.donnees.rendez_vous[0].id, rendezVousId);
});
