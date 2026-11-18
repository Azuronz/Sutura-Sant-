'use strict';

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { journaliserAcces } = require('./db');
const { requireRole } = require('./roles');

const DUREE_SESSION_COURTE_MS = 12 * 60 * 60 * 1000;
const DUREE_SESSION_LONGUE_MS = 30 * 24 * 60 * 60 * 1000;
const FENETRE_TENTATIVES_MS = 15 * 60 * 1000;
const MAX_TENTATIVES_PAR_IDENTIFIANT = 5;
const MAX_TENTATIVES_PAR_IP = 50;
const COUT_BCRYPT = 12;
const HASH_INCONNU = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), COUT_BCRYPT);
const ROLES_CREABLES = new Set(['medecin', 'personnel']);
const SPECIALITES = new Set(['médecin généraliste', 'psychologue']);

function maintenantIso() {
  return new Date().toISOString();
}

function texte(valeur, nom, { obligatoire = true, max = 120 } = {}) {
  if (valeur == null && !obligatoire) return null;
  if (typeof valeur !== 'string') throw new ErreurRequete(`${nom} est requis.`);
  const resultat = valeur.trim();
  if ((!resultat && obligatoire) || resultat.length > max) {
    throw new ErreurRequete(`${nom} est invalide.`);
  }
  return resultat || null;
}

function normaliserEmail(valeur) {
  if (valeur == null || valeur === '') return null;
  const email = texte(valeur, 'L’adresse courriel', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ErreurRequete('L’adresse courriel est invalide.');
  }
  return email;
}

function normaliserTelephone(valeur) {
  if (valeur == null || valeur === '') return null;
  const telephoneOriginal = texte(valeur, 'Le téléphone', { max: 30 });
  if (!/^\+?[0-9\s().-]+$/.test(telephoneOriginal)) {
    throw new ErreurRequete('Le numéro de téléphone est invalide.');
  }
  let telephone = telephoneOriginal.replace(/[\s().-]/g, '');
  if (/^[37][0-9]{8}$/.test(telephone)) telephone = `+221${telephone}`;
  if (!/^\+?[0-9]{7,15}$/.test(telephone)) {
    throw new ErreurRequete('Le numéro de téléphone est invalide.');
  }
  return telephone;
}

function normaliserIdentifiant(valeur) {
  if (typeof valeur !== 'string') throw new ErreurRequete('L’identifiant est requis.');
  const brut = valeur.trim();
  if (!brut || brut.length > 254) throw new ErreurRequete('L’identifiant est invalide.');
  if (brut.includes('@')) return { type: 'email', valeur: brut.toLowerCase() };
  try {
    return { type: 'telephone', valeur: normaliserTelephone(brut) };
  } catch (erreur) {
    if (!(erreur instanceof ErreurRequete)) throw erreur;
  }
  if (!/^[\p{L}\p{N}._/-]{1,50}$/u.test(brut) || !/\p{L}/u.test(brut)) {
    throw new ErreurRequete('L’identifiant est invalide.');
  }
  return { type: 'matricule', valeur: brut.toUpperCase() };
}

function validerDateNaissance(valeur, { obligatoire = true } = {}) {
  if ((valeur == null || valeur === '') && !obligatoire) return null;
  if (typeof valeur !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valeur)) {
    throw new ErreurRequete('La date de naissance doit être au format AAAA-MM-JJ.');
  }
  const date = new Date(`${valeur}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== valeur) {
    throw new ErreurRequete('La date de naissance est invalide.');
  }
  const aujourdHui = new Date().toISOString().slice(0, 10);
  if (valeur > aujourdHui) throw new ErreurRequete('La date de naissance ne peut pas être dans le futur.');
  return valeur;
}

function validerMotDePasse(valeur) {
  if (typeof valeur !== 'string' || valeur.length < 8) {
    throw new ErreurRequete('Le mot de passe doit contenir au moins 8 caractères.');
  }
  if (Buffer.byteLength(valeur, 'utf8') > 72) {
    throw new ErreurRequete('Le mot de passe ne peut pas dépasser 72 octets.');
  }
  return valeur;
}

function hasherIdentifiantRateLimit(valeur) {
  return crypto.createHash('sha256').update(valeur).digest('hex');
}

function cleCookie() {
  const nom = process.env.SESSION_COOKIE_NAME || 'sutura_session';
  return /^[A-Za-z0-9_-]{1,50}$/.test(nom) ? nom : 'sutura_session';
}

function lireCookie(req, nom) {
  const entete = req.headers.cookie;
  if (typeof entete !== 'string') return null;
  for (const partie of entete.split(';')) {
    const index = partie.indexOf('=');
    if (index < 0) continue;
    if (partie.slice(0, index).trim() === nom) return partie.slice(index + 1).trim();
  }
  return null;
}

function optionSecure() {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

function ecrireCookie(res, nom, jeton, maxAgeSecondes = null) {
  const age = maxAgeSecondes == null ? '' : `; Max-Age=${maxAgeSecondes}`;
  res.setHeader('Set-Cookie', `${nom}=${jeton}; Path=/; HttpOnly; SameSite=Lax${age}${optionSecure()}`);
}

function effacerCookie(res, nom) {
  res.setHeader('Set-Cookie', `${nom}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${optionSecure()}`);
}

function jetonEnBase(jeton) {
  return crypto.createHash('sha256').update(jeton).digest('hex');
}

function utilisateurPublic(ligne) {
  if (!ligne) return null;
  return {
    id: ligne.id,
    role: ligne.role,
    prenom: ligne.prenom,
    nom: ligne.nom,
    email: ligne.email,
    telephone: ligne.telephone,
    date_naissance: ligne.date_naissance,
    matricule: ligne.matricule,
    specialite: ligne.specialite,
    cree_le: ligne.cree_le
  };
}

function nettoyerSessionsExpirees(db) {
  db.prepare('DELETE FROM sessions WHERE expire_le <= ?').run(maintenantIso());
}

function chargerSession(db, req) {
  const nomCookie = cleCookie();
  const jeton = lireCookie(req, nomCookie);
  if (!jeton || !/^[a-f0-9]{64}$/.test(jeton)) return null;
  const idSession = jetonEnBase(jeton);
  const session = db.prepare(`
    SELECT u.id, u.role, u.prenom, u.nom, u.email, u.telephone,
           u.date_naissance, u.matricule, u.specialite, u.cree_le,
           s.id AS session_id, s.expire_le
    FROM sessions s JOIN utilisateurs u ON u.id = s.utilisateur_id
    WHERE s.id = ?
  `).get(idSession);
  if (!session) return null;
  if (session.expire_le <= maintenantIso()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(idSession);
    return null;
  }
  req.sessionId = idSession;
  return utilisateurPublic(session);
}

function authentifier(db) {
  return function middlewareSession(req, _res, next) {
    try {
      req.user = chargerSession(db, req);
      return next();
    } catch (erreur) {
      return next(erreur);
    }
  };
}

class ErreurRequete extends Error {
  constructor(message, statut = 400) {
    super(message);
    this.statut = statut;
  }
}

function gestionnaireAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function estConflitUnique(erreur) {
  return typeof erreur?.message === 'string' && erreur.message.includes('UNIQUE constraint failed');
}

function creerRouteAuth(db) {
  const routeur = express.Router();
  const tentatives = new Map();
  const nomCookie = cleCookie();
  let dernierNettoyage = 0;
  const cleIP = (ip) => `ip:${hasherIdentifiantRateLimit(ip || 'inconnu')}`;
  const cleIdentifiant = (identifiant) => `id:${hasherIdentifiantRateLimit(identifiant)}`;

  function estLimite(ip, identifiant, maintenant = Date.now()) {
    if (maintenant - dernierNettoyage >= 60 * 1000) {
      for (const [cle, tentative] of tentatives) {
        if (tentative.expireLe <= maintenant) tentatives.delete(cle);
      }
      dernierNettoyage = maintenant;
    }
    const cles = [cleIP(ip), cleIdentifiant(identifiant)];
    for (const cle of cles) {
      const tentative = tentatives.get(cle);
      if (tentative && tentative.expireLe <= maintenant) tentatives.delete(cle);
    }
    return (tentatives.get(cles[0])?.nombre || 0) >= MAX_TENTATIVES_PAR_IP
      || (tentatives.get(cles[1])?.nombre || 0) >= MAX_TENTATIVES_PAR_IDENTIFIANT;
  }

  function noterEchec(ip, identifiant, maintenant = Date.now()) {
    for (const cle of [cleIP(ip), cleIdentifiant(identifiant)]) {
      const precedente = tentatives.get(cle);
      if (!precedente || precedente.expireLe <= maintenant) {
        tentatives.set(cle, { nombre: 1, expireLe: maintenant + FENETRE_TENTATIVES_MS });
      } else {
        precedente.nombre += 1;
      }
    }
  }

  routeur.post('/inscription', gestionnaireAsync(async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new ErreurRequete('Les informations envoyées sont invalides.');
      }
      const prenom = texte(req.body.prenom, 'Le prénom', { max: 100 });
      const nom = texte(req.body.nom, 'Le nom', { max: 100 });
      const email = normaliserEmail(req.body.email);
      const telephone = normaliserTelephone(req.body.telephone);
      if (!email && !telephone) throw new ErreurRequete('Indiquez une adresse courriel ou un téléphone.');
      const dateNaissance = validerDateNaissance(req.body.date_naissance);
      const motDePasse = validerMotDePasse(req.body.mot_de_passe);
      const hash = await bcrypt.hash(motDePasse, COUT_BCRYPT);
      const creeLe = maintenantIso();
      const insertion = db.prepare(`
        INSERT INTO utilisateurs
          (role, prenom, nom, email, telephone, date_naissance, mot_de_passe_hash, matricule, specialite, cree_le)
        VALUES ('patient', ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(prenom, nom, email, telephone, dateNaissance, hash, creeLe);
      const utilisateur = db.prepare(`
        SELECT id, role, prenom, nom, email, telephone, date_naissance, matricule, specialite, cree_le
        FROM utilisateurs WHERE id = ?
      `).get(Number(insertion.lastInsertRowid));
      journaliserAcces(db, { quiId: utilisateur.id, quoi: 'creation_compte_patient' });
      return res.status(201).json({ utilisateur: utilisateurPublic(utilisateur) });
    } catch (erreur) {
      if (erreur instanceof ErreurRequete) return res.status(erreur.statut).json({ erreur: erreur.message });
      if (estConflitUnique(erreur)) {
        return res.status(409).json({ erreur: 'Impossible de créer ce compte avec ces informations. Essayez de vous connecter.' });
      }
      throw erreur;
    }
  }));

  routeur.post('/connexion', gestionnaireAsync(async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new ErreurRequete('Les informations envoyées sont invalides.');
      }
      const identifiantBrut = texte(req.body.identifiant, 'L’identifiant', { max: 254 });
      const candidat = normaliserIdentifiant(identifiantBrut);
      const identifiantRateLimit = `${candidat.type}:${candidat.valeur}`;
      const motDePasse = validerMotDePasse(req.body.mot_de_passe);
      if (req.body.rester_connecte != null && typeof req.body.rester_connecte !== 'boolean') {
        throw new ErreurRequete('La préférence de connexion est invalide.');
      }

      if (estLimite(req.ip, identifiantRateLimit)) {
        return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      }

      let utilisateur;
      if (candidat.type === 'email') {
        utilisateur = db.prepare(`
          SELECT id, role, prenom, nom, email, telephone, date_naissance,
                 mot_de_passe_hash, matricule, specialite, cree_le
          FROM utilisateurs WHERE email = ?
        `).get(candidat.valeur);
      } else if (candidat.type === 'telephone') {
        utilisateur = db.prepare(`
          SELECT id, role, prenom, nom, email, telephone, date_naissance,
                 mot_de_passe_hash, matricule, specialite, cree_le
          FROM utilisateurs WHERE telephone = ?
        `).get(candidat.valeur);
      } else {
        utilisateur = db.prepare(`
          SELECT id, role, prenom, nom, email, telephone, date_naissance,
                 mot_de_passe_hash, matricule, specialite, cree_le
          FROM utilisateurs
          WHERE matricule = ? AND role IN ('medecin', 'personnel')
        `).get(candidat.valeur);
      }
      // Un hash de même coût évite de révéler l’existence d’un compte par le temps de réponse.
      const hashDeComparaison = utilisateur?.mot_de_passe_hash || HASH_INCONNU;
      const motDePasseValide = await bcrypt.compare(motDePasse, hashDeComparaison);
      if (!utilisateur || !motDePasseValide) {
        noterEchec(req.ip, identifiantRateLimit);
        return res.status(401).json({ erreur: 'Identifiant ou mot de passe incorrect.' });
      }

      tentatives.delete(cleIdentifiant(identifiantRateLimit));
      nettoyerSessionsExpirees(db);
      const resterConnecte = req.body.rester_connecte === true;
      const dureeMs = resterConnecte ? DUREE_SESSION_LONGUE_MS : DUREE_SESSION_COURTE_MS;
      const jeton = crypto.randomBytes(32).toString('hex');
      const creeLe = maintenantIso();
      const expireLe = new Date(Date.now() + dureeMs).toISOString();
      db.prepare('INSERT INTO sessions (id, utilisateur_id, expire_le, cree_le) VALUES (?, ?, ?, ?)')
        .run(jetonEnBase(jeton), utilisateur.id, expireLe, creeLe);
      ecrireCookie(res, nomCookie, jeton, resterConnecte ? 30 * 24 * 60 * 60 : null);
      return res.json({ utilisateur: utilisateurPublic(utilisateur) });
    } catch (erreur) {
      if (erreur instanceof ErreurRequete) return res.status(erreur.statut).json({ erreur: erreur.message });
      throw erreur;
    }
  }));

  routeur.post('/deconnexion', (req, res, next) => {
    try {
      const jeton = lireCookie(req, nomCookie);
      if (jeton && /^[a-f0-9]{64}$/.test(jeton)) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(jetonEnBase(jeton));
      }
      effacerCookie(res, nomCookie);
      return res.json({ message: 'Vous êtes déconnecté.' });
    } catch (erreur) {
      return next(erreur);
    }
  });

  routeur.get('/moi', (req, res, next) => {
    try {
      const utilisateur = chargerSession(db, req);
      if (!utilisateur) return res.status(401).json({ erreur: 'Vous devez vous connecter.' });
      return res.json({ utilisateur });
    } catch (erreur) {
      return next(erreur);
    }
  });

  return routeur;
}

function creerRouteAdmin(db) {
  const routeur = express.Router();
  routeur.use(authentifier(db));
  routeur.post('/comptes', requireRole('admin'), gestionnaireAsync(async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new ErreurRequete('Les informations envoyées sont invalides.');
      }
      const role = req.body.role;
      if (!ROLES_CREABLES.has(role)) throw new ErreurRequete('Le rôle doit être médecin ou personnel.');
      const prenom = texte(req.body.prenom, 'Le prénom', { max: 100 });
      const nom = texte(req.body.nom, 'Le nom', { max: 100 });
      const email = normaliserEmail(req.body.email);
      const telephone = normaliserTelephone(req.body.telephone);
      const matriculeBrut = texte(req.body.matricule, 'Le matricule', { max: 50 });
      const matricule = matriculeBrut.toUpperCase();
      if (!/^[\p{L}\p{N}._/-]{1,50}$/u.test(matricule)) {
        throw new ErreurRequete('Le matricule est invalide.');
      }
      if (!/\p{L}/u.test(matricule)) {
        throw new ErreurRequete('Le matricule doit contenir au moins une lettre.');
      }
      const dateNaissance = validerDateNaissance(req.body.date_naissance, { obligatoire: false });
      let specialite = null;
      if (role === 'medecin') {
        if (typeof req.body.specialite !== 'string' || !SPECIALITES.has(req.body.specialite)) {
          throw new ErreurRequete('La spécialité du médecin est invalide.');
        }
        specialite = req.body.specialite;
      } else if (req.body.specialite != null && req.body.specialite !== '') {
        throw new ErreurRequete('Le personnel n’a pas de spécialité médicale.');
      }
      const motDePasse = validerMotDePasse(req.body.mot_de_passe);
      const hash = await bcrypt.hash(motDePasse, COUT_BCRYPT);
      const insertion = db.prepare(`
        INSERT INTO utilisateurs
          (role, prenom, nom, email, telephone, date_naissance, mot_de_passe_hash, matricule, specialite, cree_le)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(role, prenom, nom, email, telephone, dateNaissance, hash, matricule, specialite, maintenantIso());
      const utilisateur = db.prepare(`
        SELECT id, role, prenom, nom, email, telephone, date_naissance, matricule, specialite, cree_le
        FROM utilisateurs WHERE id = ?
      `).get(Number(insertion.lastInsertRowid));
      journaliserAcces(db, {
        quiId: req.user.id,
        quoi: role === 'medecin' ? 'creation_compte_medecin' : 'creation_compte_personnel',
        cibleId: utilisateur.id
      });
      return res.status(201).json({ utilisateur: utilisateurPublic(utilisateur) });
    } catch (erreur) {
      if (erreur instanceof ErreurRequete) return res.status(erreur.statut).json({ erreur: erreur.message });
      if (estConflitUnique(erreur)) return res.status(409).json({ erreur: 'Un compte utilise déjà cette adresse, ce numéro ou ce matricule.' });
      throw erreur;
    }
  }));
  return routeur;
}

module.exports = { creerRouteAuth, creerRouteAdmin, authentifier };
