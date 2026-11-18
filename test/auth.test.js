'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ouvrirBase } = require('../server/db');
const { creerApplication } = require('../server/index');

async function creerContexte(t) {
  const dossierTemporaire = fs.mkdtempSync(path.join(os.tmpdir(), 'sutura-test-'));
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
    const texteReponse = await reponse.text();
    let donnees = null;
    try {
      donnees = JSON.parse(texteReponse);
    } catch {}
    return {
      status: reponse.status,
      contentType: reponse.headers.get('content-type'),
      donnees,
      setCookie: reponse.headers.get('set-cookie')
    };
  }

  return { appeler, db };
}

const motDePassePatient = 'motdepasse-test-8';
const inscriptionValide = {
  prenom: 'Awa',
  nom: 'Test',
  email: 'awa@example.test',
  telephone: null,
  date_naissance: '2000-01-15',
  mot_de_passe: motDePassePatient
};

async function inscrirePatient(appeler, champs = {}) {
  return appeler('/api/auth/inscription', {
    method: 'POST',
    body: { ...inscriptionValide, ...champs }
  });
}

async function connecter(appeler, identifiant = inscriptionValide.email, motDePasse = motDePassePatient, resterConnecte = true) {
  return appeler('/api/auth/connexion', {
    method: 'POST',
    body: { identifiant, mot_de_passe: motDePasse, rester_connecte: resterConnecte }
  });
}

function creerAdmin(db) {
  const hash = bcrypt.hashSync('motdepasse-admin-8', 4);
  db.prepare(`
    INSERT INTO utilisateurs
      (role, prenom, nom, email, telephone, date_naissance, mot_de_passe_hash, matricule, specialite, cree_le)
    VALUES ('admin', 'Admin', 'Test', 'admin@example.test', NULL, NULL, ?, NULL, NULL, ?)
  `).run(hash, new Date().toISOString());
}

async function connecterAdmin(appeler) {
  const resultat = await connecter(appeler, 'admin@example.test', 'motdepasse-admin-8');
  assert.equal(resultat.status, 200);
  return resultat.setCookie.split(';', 1)[0];
}

function donneesPersonnel(champs = {}) {
  return {
    role: 'personnel',
    prenom: 'Ibra',
    nom: 'Test',
    email: 'personnel@example.test',
    matricule: 'PER-12',
    mot_de_passe: 'motdepasse-personnel-8',
    ...champs
  };
}

async function creerPersonnel(appeler, cookie, champs = {}) {
  return appeler('/api/admin/comptes', {
    method: 'POST',
    cookie,
    body: donneesPersonnel(champs)
  });
}

test('inscription d’un patient', async (t) => {
  const { appeler } = await creerContexte(t);
  const resultat = await inscrirePatient(appeler);
  assert.equal(resultat.status, 201);
  assert.equal(resultat.donnees.utilisateur.prenom, 'Awa');
  assert.equal(resultat.donnees.utilisateur.role, 'patient');
  assert.equal('mot_de_passe_hash' in resultat.donnees.utilisateur, false);
});

test('inscription refusée sans date de naissance', async (t) => {
  const { appeler } = await creerContexte(t);
  const resultat = await inscrirePatient(appeler, { date_naissance: null });
  assert.equal(resultat.status, 400);
  assert.equal(typeof resultat.donnees.erreur, 'string');
});

test('inscription avec un courriel déjà utilisé renvoie 409 avec un message neutre', async (t) => {
  const { appeler } = await creerContexte(t);
  const premiereInscription = await inscrirePatient(appeler);
  assert.equal(premiereInscription.status, 201);

  const doublon = await inscrirePatient(appeler, {
    prenom: 'Binta',
    telephone: '77 123 45 67'
  });
  assert.equal(doublon.status, 409);
  assert.equal(
    doublon.donnees.erreur,
    'Impossible de créer ce compte avec ces informations. Essayez de vous connecter.'
  );
  assert.doesNotMatch(doublon.donnees.erreur, /déjà/i);
});

test('connexion correcte', async (t) => {
  const { appeler } = await creerContexte(t);
  const inscription = await inscrirePatient(appeler);
  assert.equal(inscription.status, 201);
  const resultat = await connecter(appeler);
  assert.equal(resultat.status, 200);
  assert.equal(resultat.donnees.utilisateur.role, 'patient');
  assert.match(resultat.setCookie, /HttpOnly/);
  assert.match(resultat.setCookie, /SameSite=Lax/);
  assert.match(resultat.setCookie, /Max-Age=2592000/);
});

test('mauvais mot de passe avec message uniforme', async (t) => {
  const { appeler } = await creerContexte(t);
  const inscription = await inscrirePatient(appeler);
  assert.equal(inscription.status, 201);
  const resultat = await connecter(appeler, inscriptionValide.email, 'motdepasse-incorrect');
  assert.equal(resultat.status, 401);
  assert.equal(resultat.donnees.erreur, 'Identifiant ou mot de passe incorrect.');
});

test('accès refusé (403) à POST /api/admin/comptes pour un patient', async (t) => {
  const { appeler } = await creerContexte(t);
  const inscription = await inscrirePatient(appeler);
  assert.equal(inscription.status, 201);
  const connexion = await connecter(appeler);
  const cookie = connexion.setCookie.split(';', 1)[0];
  const resultat = await creerPersonnel(appeler, cookie);
  assert.equal(resultat.status, 403);
});

test('déconnexion', async (t) => {
  const { appeler } = await creerContexte(t);
  const inscription = await inscrirePatient(appeler);
  assert.equal(inscription.status, 201);
  const connexion = await connecter(appeler);
  const cookie = connexion.setCookie.split(';', 1)[0];
  const resultat = await appeler('/api/auth/deconnexion', { method: 'POST', cookie });
  assert.equal(resultat.status, 200);
  assert.match(resultat.setCookie, /Max-Age=0/);
});

test('session invalide après déconnexion', async (t) => {
  const { appeler } = await creerContexte(t);
  const inscription = await inscrirePatient(appeler);
  assert.equal(inscription.status, 201);
  const connexion = await connecter(appeler);
  const cookie = connexion.setCookie.split(';', 1)[0];
  await appeler('/api/auth/deconnexion', { method: 'POST', cookie });
  const resultat = await appeler('/api/auth/moi', { cookie });
  assert.equal(resultat.status, 401);
});

test('blocage après cinq échecs sur le même identifiant', async (t) => {
  const { appeler } = await creerContexte(t);
  for (let numero = 0; numero < 5; numero += 1) {
    const echec = await connecter(appeler, 'absent@example.test', 'motdepasse-incorrect');
    assert.equal(echec.status, 401);
    assert.equal(echec.donnees.erreur, 'Identifiant ou mot de passe incorrect.');
  }
  const blocage = await connecter(appeler, 'absent@example.test', 'motdepasse-incorrect');
  assert.equal(blocage.status, 429);
});

test('inscription avec role admin crée un patient', async (t) => {
  const { appeler } = await creerContexte(t);
  const resultat = await inscrirePatient(appeler, { role: 'admin' });
  assert.equal(resultat.status, 201);
  assert.equal(resultat.donnees.utilisateur.role, 'patient');
});

test('un admin crée un membre du personnel qui se connecte par matricule', async (t) => {
  const { appeler, db } = await creerContexte(t);
  creerAdmin(db);
  const cookieAdmin = await connecterAdmin(appeler);
  const creation = await creerPersonnel(appeler, cookieAdmin);
  assert.equal(creation.status, 201);
  assert.equal(creation.donnees.utilisateur.role, 'personnel');
  const connexionPersonnel = await connecter(appeler, 'PER-12', 'motdepasse-personnel-8');
  assert.equal(connexionPersonnel.status, 200);
  assert.equal(connexionPersonnel.donnees.utilisateur.role, 'personnel');
});

test('un admin reçoit 409 si le matricule est déjà utilisé', async (t) => {
  const { appeler, db } = await creerContexte(t);
  creerAdmin(db);
  const cookieAdmin = await connecterAdmin(appeler);
  const premiereCreation = await creerPersonnel(appeler, cookieAdmin);
  assert.equal(premiereCreation.status, 201);
  const doublon = await creerPersonnel(appeler, cookieAdmin, { email: 'autre@example.test' });
  assert.equal(doublon.status, 409);
});

test('un admin ne peut pas créer un médecin sans spécialité valide', async (t) => {
  const { appeler, db } = await creerContexte(t);
  creerAdmin(db);
  const cookieAdmin = await connecterAdmin(appeler);
  const resultat = await appeler('/api/admin/comptes', {
    method: 'POST',
    cookie: cookieAdmin,
    body: {
      role: 'medecin',
      prenom: 'Moussa',
      nom: 'Test',
      email: 'medecin@example.test',
      matricule: 'MED-001',
      mot_de_passe: 'motdepasse-medecin-8'
    }
  });
  assert.equal(resultat.status, 400);
});

test('un matricule sans lettre est refusé clairement', async (t) => {
  const { appeler, db } = await creerContexte(t);
  creerAdmin(db);
  const cookieAdmin = await connecterAdmin(appeler);
  const resultat = await creerPersonnel(appeler, cookieAdmin, { matricule: '123456' });
  assert.equal(resultat.status, 400);
  assert.equal(resultat.donnees.erreur, 'Le matricule doit contenir au moins une lettre.');
});

test('rester_connecte false crée un cookie sans Max-Age', async (t) => {
  const { appeler } = await creerContexte(t);
  const inscription = await inscrirePatient(appeler);
  assert.equal(inscription.status, 201);
  const resultat = await connecter(appeler, inscriptionValide.email, motDePassePatient, false);
  assert.equal(resultat.status, 200);
  assert.doesNotMatch(resultat.setCookie, /Max-Age=/);
});

test('les trois formats d’un téléphone sénégalais identifient le même compte', async (t) => {
  const { appeler, db } = await creerContexte(t);
  const inscription = await inscrirePatient(appeler, { email: null, telephone: '77 123 45 67' });
  assert.equal(inscription.status, 201);
  assert.equal(inscription.donnees.utilisateur.telephone, '+221771234567');
  for (const identifiant of ['77 123 45 67', '771234567', '+221 77 123 45 67']) {
    const connexion = await connecter(appeler, identifiant);
    assert.equal(connexion.status, 200);
    assert.equal(connexion.donnees.utilisateur.id, inscription.donnees.utilisateur.id);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS nombre FROM utilisateurs').get().nombre, 1);
});

test('une route inconnue sous /api/ renvoie un 404 JSON', async (t) => {
  const { appeler } = await creerContexte(t);
  const resultat = await appeler('/api/route-inconnue');
  assert.equal(resultat.status, 404);
  assert.match(resultat.contentType, /application\/json/);
  assert.equal(typeof resultat.donnees.erreur, 'string');
});

test('un Content-Type non pris en charge renvoie une erreur 4xx JSON', async (t) => {
  const { appeler } = await creerContexte(t);
  const resultat = await appeler('/api/auth/inscription', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'text/plain' }
  });
  assert.equal(resultat.status, 415);
  assert.match(resultat.contentType, /application\/json/);
  assert.equal(typeof resultat.donnees.erreur, 'string');
});

test('cinq échecs sur un identifiant ne bloquent pas un autre utilisateur sur la même IP', async (t) => {
  const { appeler } = await creerContexte(t);
  const premiereInscription = await inscrirePatient(appeler);
  assert.equal(premiereInscription.status, 201);
  const secondeInscription = await inscrirePatient(appeler, {
    prenom: 'Binta',
    email: 'binta@example.test'
  });
  assert.equal(secondeInscription.status, 201);

  for (let numero = 0; numero < 5; numero += 1) {
    const echec = await connecter(appeler, inscriptionValide.email, 'motdepasse-incorrect');
    assert.equal(echec.status, 401);
  }

  const connexionAutreCompte = await connecter(appeler, 'binta@example.test');
  assert.equal(connexionAutreCompte.status, 200);
  assert.equal(connexionAutreCompte.donnees.utilisateur.prenom, 'Binta');
});
