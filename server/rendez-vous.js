'use strict';

const express = require('express');
const { journaliserAcces } = require('./db');
const { authentifier } = require('./auth');
const { requireRole } = require('./roles');

const ROLES_CONNECTES = ['patient', 'medecin', 'personnel', 'admin'];
const DUREES_AUTORISEES = new Set([15, 20, 30, 45, 60]);
const SPECIALITES_AUTORISEES = new Set(['médecin généraliste', 'psychologue']);
const JOUR_MS = 24 * 60 * 60 * 1000;

class ErreurApi extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function gerer(fn) {
  return (req, res, next) => {
    try {
      return fn(req, res, next);
    } catch (erreur) {
      if (erreur instanceof ErreurApi) {
        return res.status(erreur.status).json({ erreur: erreur.message, ...(erreur.extra || {}) });
      }
      if (erreur?.message?.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ erreur: "Ce créneau vient d'être réservé." });
      }
      return next(erreur);
    }
  };
}

function dansTransaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultat = action();
    db.exec('COMMIT');
    return resultat;
  } catch (erreur) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw erreur;
  }
}

function objet(valeur) {
  return valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur);
}

function dateIso(valeur, nom = 'La date') {
  if (typeof valeur !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valeur)) {
    throw new ErreurApi(`${nom} doit être au format AAAA-MM-JJ.`);
  }
  const date = new Date(`${valeur}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== valeur) {
    throw new ErreurApi(`${nom} est invalide.`);
  }
  return valeur;
}

function heureIso(valeur, nom = 'L’heure') {
  if (typeof valeur !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(valeur)) {
    throw new ErreurApi(`${nom} doit être au format HH:MM.`);
  }
  return valeur;
}

function minutes(heure) {
  const [h, m] = heure.split(':').map(Number);
  return h * 60 + m;
}

function heureDepuisMinutes(valeur) {
  return `${String(Math.floor(valeur / 60)).padStart(2, '0')}:${String(valeur % 60).padStart(2, '0')}`;
}

function dateDansJours(date, nombre) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + nombre * JOUR_MS).toISOString().slice(0, 10);
}

function lundiDe(date) {
  const jour = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return dateDansJours(date, -((jour + 6) % 7));
}

function dateEtHeureDakar() {
  // Dakar est à UTC+0 sans heure d’été.
  const maintenant = new Date();
  return { date: maintenant.toISOString().slice(0, 10), heure: maintenant.toISOString().slice(11, 16) };
}

function rendezVousEstPasse(rendezVous) {
  const maintenant = dateEtHeureDakar();
  return rendezVous.date < maintenant.date
    || (rendezVous.date === maintenant.date && rendezVous.heure <= maintenant.heure);
}

function validerFutur(date, heure) {
  if (rendezVousEstPasse({ date, heure })) {
    throw new ErreurApi('Un rendez-vous ne peut pas être fixé dans le passé.');
  }
}

function identifiant(valeur, nom = 'L’identifiant') {
  const texte = String(valeur ?? '');
  if (!/^[1-9]\d*$/.test(texte) || !Number.isSafeInteger(Number(texte))) {
    throw new ErreurApi(`${nom} est invalide.`);
  }
  return Number(texte);
}

function lirePeriode(query, { obligatoire = true } = {}) {
  const aDu = query.du != null && query.du !== '';
  const aAu = query.au != null && query.au !== '';
  if (!aDu && !aAu && !obligatoire) return null;
  if (!aDu || !aAu) throw new ErreurApi('Indiquez les deux dates du et au.');
  const du = dateIso(query.du, 'La date du');
  const au = dateIso(query.au, 'La date au');
  const ecart = (Date.parse(`${au}T00:00:00.000Z`) - Date.parse(`${du}T00:00:00.000Z`)) / JOUR_MS;
  if (ecart < 0) throw new ErreurApi('La date de fin doit être égale ou postérieure à la date de début.');
  if (ecart > 30) throw new ErreurApi('La période ne peut pas dépasser 31 jours.');
  return { du, au };
}

function chargerMedecin(db, medecinId) {
  return db.prepare(`
    SELECT id, prenom, nom, specialite, email, telephone
    FROM utilisateurs WHERE id = ? AND role = 'medecin'
  `).get(medecinId) || null;
}

function chargerPatient(db, patientId) {
  return db.prepare(`
    SELECT id, prenom, nom, email, telephone, date_naissance
    FROM utilisateurs WHERE id = ? AND role = 'patient'
  `).get(patientId) || null;
}

function lignesDisponibilites(db, medecinId, du, au) {
  return db.prepare(`
    SELECT id, medecin_id, date, heure_debut, heure_fin, duree_creneau, cree_le
    FROM disponibilites
    WHERE medecin_id = ? AND date >= ? AND date <= ?
    ORDER BY date, heure_debut
  `).all(medecinId, du, au);
}

function genererCreneaux(disponibilites, rendezVous = []) {
  const pris = new Set(rendezVous.filter((r) => r.statut === 'confirme').map((r) => `${r.date}|${r.heure}`));
  const creneaux = [];
  for (const disponibilite of disponibilites) {
    const debut = minutes(disponibilite.heure_debut);
    const fin = minutes(disponibilite.heure_fin);
    for (let heure = debut; heure + disponibilite.duree_creneau <= fin; heure += disponibilite.duree_creneau) {
      const heureTexte = heureDepuisMinutes(heure);
      creneaux.push({
        date: disponibilite.date,
        heure: heureTexte,
        duree_creneau: disponibilite.duree_creneau,
        statut: pris.has(`${disponibilite.date}|${heureTexte}`) ? 'pris' : 'libre'
      });
    }
  }
  return creneaux.sort((a, b) => a.date.localeCompare(b.date) || a.heure.localeCompare(b.heure));
}

function rendezVousAvecPatient(row) {
  return {
    id: row.id,
    date: row.date,
    heure: row.heure,
    duree_creneau: row.duree_creneau,
    statut: row.statut,
    cree_le: row.cree_le,
    annule_le: row.annule_le,
    patient: { id: row.patient_id, prenom: row.patient_prenom, nom: row.patient_nom }
  };
}

function rendezVousPatient(row) {
  return {
    id: row.id,
    date: row.date,
    heure: row.heure,
    duree_creneau: row.duree_creneau,
    statut: row.statut,
    cree_le: row.cree_le,
    annule_le: row.annule_le,
    medecin: {
      id: row.medecin_id,
      prenom: row.medecin_prenom,
      nom: row.medecin_nom,
      specialite: row.medecin_specialite
    }
  };
}

function rendezVousPersonnel(row) {
  return {
    id: row.id,
    date: row.date,
    heure: row.heure,
    duree_creneau: row.duree_creneau,
    statut: row.statut,
    cree_par_id: row.cree_par_id,
    cree_le: row.cree_le,
    annule_par_id: row.annule_par_id,
    annule_le: row.annule_le,
    patient: {
      id: row.patient_id,
      prenom: row.patient_prenom,
      nom: row.patient_nom,
      email: row.patient_email,
      telephone: row.patient_telephone,
      date_naissance: row.patient_date_naissance
    },
    medecin: {
      id: row.medecin_id,
      prenom: row.medecin_prenom,
      nom: row.medecin_nom,
      specialite: row.medecin_specialite,
      email: row.medecin_email,
      telephone: row.medecin_telephone
    }
  };
}

const SELECT_RENDEZ_VOUS = `
  SELECT r.id, r.medecin_id, r.patient_id, r.date, r.heure, r.duree_creneau,
         r.statut, r.cree_par_id, r.cree_le, r.annule_par_id, r.annule_le,
         p.prenom AS patient_prenom, p.nom AS patient_nom,
         p.email AS patient_email, p.telephone AS patient_telephone,
         p.date_naissance AS patient_date_naissance,
         m.prenom AS medecin_prenom, m.nom AS medecin_nom,
         m.specialite AS medecin_specialite, m.email AS medecin_email,
         m.telephone AS medecin_telephone
  FROM rendez_vous r
  JOIN utilisateurs p ON p.id = r.patient_id
  JOIN utilisateurs m ON m.id = r.medecin_id
`;

function chargerRendezVous(db, rendezVousId) {
  return db.prepare(`${SELECT_RENDEZ_VOUS} WHERE r.id = ?`).get(rendezVousId) || null;
}

function verifierCreneauLibre(db, medecinId, date, heure, rendezVousExclu = null) {
  const debut = minutes(heure);
  const plages = db.prepare(`
    SELECT heure_debut, heure_fin, duree_creneau FROM disponibilites
    WHERE medecin_id = ? AND date = ? ORDER BY heure_debut
  `).all(medecinId, date);
  const plage = plages.find((ligne) => {
    const ouverture = minutes(ligne.heure_debut);
    const fermeture = minutes(ligne.heure_fin);
    return debut >= ouverture
      && debut + ligne.duree_creneau <= fermeture
      && (debut - ouverture) % ligne.duree_creneau === 0;
  });
  if (!plage) throw new ErreurApi('Ce créneau ne fait pas partie des disponibilités du médecin.');
  const existant = db.prepare(`
    SELECT id FROM rendez_vous
    WHERE medecin_id = ? AND date = ? AND heure = ? AND statut = 'confirme'
      AND (? IS NULL OR id <> ?)
  `).get(medecinId, date, heure, rendezVousExclu, rendezVousExclu);
  if (existant) throw new ErreurApi("Ce créneau vient d'être réservé.", 409);
  return plage.duree_creneau;
}

function plageContientRendezVous(plage, rendezVous) {
  const debut = minutes(rendezVous.heure);
  if (plage.date !== rendezVous.date || plage.duree_creneau !== rendezVous.duree_creneau) return false;
  const ouverture = minutes(plage.heure_debut);
  const fermeture = minutes(plage.heure_fin);
  return debut >= ouverture
    && debut + rendezVous.duree_creneau <= fermeture
    && (debut - ouverture) % plage.duree_creneau === 0;
}

function journaliserPatientsListe(db, auteurId, patients) {
  const ids = [...new Set(patients.map((patient) => patient.id ?? patient.patient_id).filter(Number.isInteger))];
  if (ids.length === 0) {
    journaliserAcces(db, { quiId: auteurId, quoi: 'consultation_liste_patients' });
    return;
  }
  for (const cibleId of ids) {
    journaliserAcces(db, { quiId: auteurId, quoi: 'consultation_liste_patients', cibleId });
  }
}

function creerRouteRendezVous(db) {
  const routeur = express.Router();
  const session = authentifier(db);
  const tousConnectes = requireRole(...ROLES_CONNECTES);

  routeur.get('/medecins', session, tousConnectes, gerer((req, res) => {
    let specialite = null;
    if (req.query.specialite != null && req.query.specialite !== '') {
      specialite = String(req.query.specialite);
      if (!SPECIALITES_AUTORISEES.has(specialite)) throw new ErreurApi('La spécialité demandée est invalide.');
    }
    const medecins = specialite
      ? db.prepare(`SELECT id, prenom, nom, specialite FROM utilisateurs WHERE role = 'medecin' AND specialite = ? ORDER BY nom, prenom`).all(specialite)
      : db.prepare(`SELECT id, prenom, nom, specialite FROM utilisateurs WHERE role = 'medecin' ORDER BY nom, prenom`).all();
    return res.json({ medecins });
  }));

  routeur.get('/medecins/:id/creneaux', session, tousConnectes, gerer((req, res) => {
    const medecinId = identifiant(req.params.id, 'L’identifiant du médecin');
    if (!chargerMedecin(db, medecinId)) throw new ErreurApi('Médecin introuvable.', 404);
    const periode = lirePeriode(req.query);
    const disponibilites = lignesDisponibilites(db, medecinId, periode.du, periode.au);
    const rendezVous = db.prepare(`
      SELECT date, heure, statut FROM rendez_vous
      WHERE medecin_id = ? AND date >= ? AND date <= ? AND statut = 'confirme'
    `).all(medecinId, periode.du, periode.au);
    const creneaux = genererCreneaux(disponibilites, rendezVous)
      .filter((creneau) => !rendezVousEstPasse(creneau));
    return res.json({ creneaux });
  }));

  routeur.get('/rendez-vous', session, requireRole('patient', 'personnel'), gerer((req, res) => {
    if (req.user.role === 'patient') {
      const periode = lirePeriode(req.query, { obligatoire: false });
      const conditions = ['r.patient_id = ?'];
      const valeurs = [req.user.id];
      if (periode) {
        conditions.push('r.date >= ?', 'r.date <= ?');
        valeurs.push(periode.du, periode.au);
      }
      const lignes = db.prepare(`${SELECT_RENDEZ_VOUS} WHERE ${conditions.join(' AND ')} ORDER BY r.date, r.heure, r.id`).all(...valeurs);
      return res.json({ rendez_vous: lignes.map(rendezVousPatient) });
    }

    if (req.user.role !== 'personnel') {
      throw new ErreurApi('Vous n’avez pas les droits nécessaires.', 403);
    }

    const conditions = [];
    const valeurs = [];
    if (req.query.patient_id != null && req.query.patient_id !== '') {
      conditions.push('r.patient_id = ?');
      valeurs.push(identifiant(req.query.patient_id, 'L’identifiant du patient'));
    }
    if (req.query.medecin_id != null && req.query.medecin_id !== '') {
      conditions.push('r.medecin_id = ?');
      valeurs.push(identifiant(req.query.medecin_id, 'L’identifiant du médecin'));
    }
    const periode = lirePeriode(req.query, { obligatoire: false });
    if (periode) {
      conditions.push('r.date >= ?', 'r.date <= ?');
      valeurs.push(periode.du, periode.au);
    }
    const lignes = db.prepare(`${SELECT_RENDEZ_VOUS}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY r.date, r.heure, r.id`).all(...valeurs);
    journaliserPatientsListe(db, req.user.id, lignes.map((ligne) => ({ patient_id: ligne.patient_id })));
    return res.json({ rendez_vous: lignes.map(rendezVousPersonnel) });
  }));

  routeur.post('/rendez-vous', session, requireRole('patient', 'personnel'), gerer((req, res) => {
    if (!objet(req.body)) throw new ErreurApi('Les informations envoyées sont invalides.');
    const patientOuPersonnel = req.user.role === 'patient' || req.user.role === 'personnel';
    if (!patientOuPersonnel) throw new ErreurApi('Vous n’avez pas les droits nécessaires.', 403);
    const patientId = req.user.role === 'patient'
      ? req.user.id
      : identifiant(req.body.patient_id, 'L’identifiant du patient');
    const medecinId = identifiant(req.body.medecin_id, 'L’identifiant du médecin');
    const date = dateIso(req.body.date);
    const heure = heureIso(req.body.heure);
    const rendezVousId = dansTransaction(db, () => {
      if (!chargerMedecin(db, medecinId)) throw new ErreurApi('Médecin introuvable.', 404);
      if (!chargerPatient(db, patientId)) throw new ErreurApi('Patient introuvable.', 404);
      validerFutur(date, heure);
      const duree = verifierCreneauLibre(db, medecinId, date, heure);
      const resultat = db.prepare(`
        INSERT INTO rendez_vous
          (medecin_id, patient_id, date, heure, duree_creneau, statut, cree_par_id, cree_le)
        VALUES (?, ?, ?, ?, ?, 'confirme', ?, ?)
      `).run(medecinId, patientId, date, heure, duree, req.user.id, new Date().toISOString());
      const id = Number(resultat.lastInsertRowid);
      if (req.user.role === 'personnel') {
        journaliserAcces(db, {
          quiId: req.user.id,
          quoi: 'creation_rendez_vous',
          cibleId: patientId,
          ressourceId: id
        });
      }
      return id;
    });
    const ligne = chargerRendezVous(db, rendezVousId);
    return res.status(201).json({ rendez_vous: req.user.role === 'personnel' ? rendezVousPersonnel(ligne) : rendezVousPatient(ligne) });
  }));

  routeur.post('/rendez-vous/:id/annulation', session, requireRole('patient', 'personnel'), gerer((req, res) => {
    if (!['patient', 'personnel'].includes(req.user.role)) {
      throw new ErreurApi('Vous n’avez pas les droits nécessaires.', 403);
    }
    const rendezVousId = identifiant(req.params.id, 'L’identifiant du rendez-vous');
    const ligne = dansTransaction(db, () => {
      const rendezVous = chargerRendezVous(db, rendezVousId);
      if (!rendezVous || (req.user.role === 'patient' && rendezVous.patient_id !== req.user.id)) {
        throw new ErreurApi('Rendez-vous introuvable.', 404);
      }
      if (rendezVous.statut !== 'confirme') throw new ErreurApi('Ce rendez-vous est déjà annulé.', 409);
      if (rendezVousEstPasse(rendezVous)) {
        throw new ErreurApi('Ce rendez-vous est passé et ne peut plus être modifié.', 409);
      }
      db.prepare(`
        UPDATE rendez_vous SET statut = 'annule', annule_par_id = ?, annule_le = ? WHERE id = ?
      `).run(req.user.id, new Date().toISOString(), rendezVousId);
      if (req.user.role === 'personnel') {
        journaliserAcces(db, {
          quiId: req.user.id,
          quoi: 'annulation_rendez_vous',
          cibleId: rendezVous.patient_id,
          ressourceId: rendezVousId
        });
      }
      return chargerRendezVous(db, rendezVousId);
    });
    return res.json({ rendez_vous: req.user.role === 'personnel' ? rendezVousPersonnel(ligne) : rendezVousPatient(ligne) });
  }));

  routeur.patch('/rendez-vous/:id', session, requireRole('personnel'), gerer((req, res) => {
    if (!objet(req.body)) throw new ErreurApi('Les informations envoyées sont invalides.');
    const rendezVousId = identifiant(req.params.id, 'L’identifiant du rendez-vous');
    const ligne = dansTransaction(db, () => {
      const rendezVous = chargerRendezVous(db, rendezVousId);
      if (!rendezVous) throw new ErreurApi('Rendez-vous introuvable.', 404);
      if (rendezVous.statut !== 'confirme') throw new ErreurApi('Ce rendez-vous est déjà annulé.', 409);
      if (rendezVousEstPasse(rendezVous)) {
        throw new ErreurApi('Ce rendez-vous est passé et ne peut plus être modifié.', 409);
      }
      const date = req.body.date == null ? rendezVous.date : dateIso(req.body.date);
      const heure = req.body.heure == null ? rendezVous.heure : heureIso(req.body.heure);
      if (date === rendezVous.date && heure === rendezVous.heure) throw new ErreurApi('Indiquez une nouvelle date ou une nouvelle heure.');
      validerFutur(date, heure);
      const duree = verifierCreneauLibre(db, rendezVous.medecin_id, date, heure, rendezVousId);
      db.prepare(`
        UPDATE rendez_vous SET date = ?, heure = ?, duree_creneau = ? WHERE id = ?
      `).run(date, heure, duree, rendezVousId);
      journaliserAcces(db, {
        quiId: req.user.id,
        quoi: 'deplacement_rendez_vous',
        cibleId: rendezVous.patient_id,
        ressourceId: rendezVousId
      });
      return chargerRendezVous(db, rendezVousId);
    });
    return res.json({ rendez_vous: rendezVousPersonnel(ligne) });
  }));

  routeur.get('/medecin/disponibilites', session, requireRole('medecin'), gerer((req, res) => {
    const periode = lirePeriode(req.query);
    const disponibilites = lignesDisponibilites(db, req.user.id, periode.du, periode.au);
    const rendezVous = db.prepare(`${SELECT_RENDEZ_VOUS}
      WHERE r.medecin_id = ? AND r.date >= ? AND r.date <= ?
      ORDER BY r.date, r.heure, r.id
    `).all(req.user.id, periode.du, periode.au).map(rendezVousAvecPatient);
    return res.json({ disponibilites, rendez_vous: rendezVous });
  }));

  routeur.put('/medecin/disponibilites/:lundi', session, requireRole('medecin'), gerer((req, res) => {
    const lundi = dateIso(req.params.lundi, 'La date du lundi');
    if (lundiDe(lundi) !== lundi) throw new ErreurApi('La date doit correspondre à un lundi.');
    const aujourdHui = dateEtHeureDakar().date;
    if (lundi < lundiDe(aujourdHui)) throw new ErreurApi('Cette semaine est déjà passée.');
    if (!Array.isArray(req.body) || req.body.length > 100) throw new ErreurApi('Envoyez un tableau de disponibilités valide.');

    const finSemaine = dateDansJours(lundi, 6);
    const plages = req.body.map((element) => {
      if (!objet(element)) throw new ErreurApi('Une disponibilité est invalide.');
      const date = dateIso(element.date);
      const heureDebut = heureIso(element.heure_debut, 'L’heure de début');
      const heureFin = heureIso(element.heure_fin, 'L’heure de fin');
      const duree = element.duree_creneau == null ? 30 : element.duree_creneau;
      if (date < lundi || date > finSemaine) throw new ErreurApi('Toutes les dates doivent appartenir à la semaine indiquée.');
      if (date < aujourdHui) throw new ErreurApi('Une disponibilité ne peut pas être créée dans le passé.');
      if (minutes(heureDebut) >= minutes(heureFin)) throw new ErreurApi('L’heure de fin doit suivre l’heure de début.');
      if (!DUREES_AUTORISEES.has(duree)) throw new ErreurApi('La durée doit être de 15, 20, 30, 45 ou 60 minutes.');
      return { date, heure_debut: heureDebut, heure_fin: heureFin, duree_creneau: duree };
    });
    const parDate = new Map();
    for (const plage of plages) {
      const jour = parDate.get(plage.date) || [];
      jour.push(plage);
      parDate.set(plage.date, jour);
    }
    for (const jour of parDate.values()) {
      jour.sort((a, b) => a.heure_debut.localeCompare(b.heure_debut));
      for (let index = 1; index < jour.length; index += 1) {
        if (minutes(jour[index].heure_debut) < minutes(jour[index - 1].heure_fin)) {
          throw new ErreurApi('Les disponibilités d’une même journée ne peuvent pas se chevaucher.');
        }
      }
    }

    const resultat = dansTransaction(db, () => {
      const rendezVous = db.prepare(`${SELECT_RENDEZ_VOUS}
        WHERE r.medecin_id = ? AND r.date >= ? AND r.date <= ? AND r.statut = 'confirme'
        ORDER BY r.date, r.heure, r.id
      `).all(req.user.id, lundi, finSemaine);
      const conflits = rendezVous.filter((rendezVous) => (
        !rendezVousEstPasse(rendezVous)
        && !plages.some((plage) => plageContientRendezVous(plage, rendezVous))
      ));
      if (conflits.length) return { conflits: conflits.map(rendezVousAvecPatient) };
      db.prepare('DELETE FROM disponibilites WHERE medecin_id = ? AND date >= ? AND date <= ?')
        .run(req.user.id, aujourdHui, finSemaine);
      const insertion = db.prepare(`
        INSERT INTO disponibilites (medecin_id, date, heure_debut, heure_fin, duree_creneau, cree_le)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const creeLe = new Date().toISOString();
      for (const plage of plages) {
        insertion.run(req.user.id, plage.date, plage.heure_debut, plage.heure_fin, plage.duree_creneau, creeLe);
      }
      return { conflits: [] };
    });
    if (resultat.conflits.length) {
      return res.status(409).json({
        erreur: 'Des rendez-vous confirmés occupent des créneaux qui seraient modifiés.',
        rendez_vous: resultat.conflits
      });
    }
    return res.json({ message: 'Les disponibilités de la semaine ont été enregistrées.', disponibilites: plages });
  }));

  routeur.get('/medecin/rendez-vous', session, requireRole('medecin'), gerer((req, res) => {
    const periode = lirePeriode(req.query);
    const lignes = db.prepare(`${SELECT_RENDEZ_VOUS}
      WHERE r.medecin_id = ? AND r.date >= ? AND r.date <= ?
      ORDER BY r.date, r.heure, r.id
    `).all(req.user.id, periode.du, periode.au);
    return res.json({ rendez_vous: lignes.map(rendezVousAvecPatient) });
  }));

  routeur.get('/personnel/patients', session, requireRole('personnel'), gerer((req, res) => {
    let recherche = '';
    if (req.query.recherche != null && req.query.recherche !== '') {
      if (typeof req.query.recherche !== 'string' || req.query.recherche.length > 100) {
        throw new ErreurApi('La recherche doit contenir au maximum 100 caractères.');
      }
      recherche = req.query.recherche.replace(/[\\%_]/g, '\\$&');
    }
    const patients = recherche
      ? db.prepare(`
          SELECT id, prenom, nom, email, telephone, date_naissance
          FROM utilisateurs WHERE role = 'patient'
            AND (prenom LIKE ? ESCAPE '\\' OR nom LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
              OR telephone LIKE ? ESCAPE '\\' OR date_naissance LIKE ? ESCAPE '\\')
          ORDER BY nom, prenom, id
        `).all(...Array(5).fill(`%${recherche}%`))
      : db.prepare(`
          SELECT id, prenom, nom, email, telephone, date_naissance
          FROM utilisateurs WHERE role = 'patient' ORDER BY nom, prenom, id
        `).all();
    journaliserPatientsListe(db, req.user.id, patients);
    return res.json({ patients });
  }));

  routeur.get('/personnel/patients/:id', session, requireRole('personnel'), gerer((req, res) => {
    const patientId = identifiant(req.params.id, 'L’identifiant du patient');
    const patient = chargerPatient(db, patientId);
    if (!patient) throw new ErreurApi('Patient introuvable.', 404);
    journaliserAcces(db, { quiId: req.user.id, quoi: 'consultation_fiche_patient', cibleId: patientId });
    const lignes = db.prepare(`${SELECT_RENDEZ_VOUS}
      WHERE r.patient_id = ? ORDER BY r.date DESC, r.heure DESC, r.id DESC
    `).all(patientId);
    const rendezVous = lignes.map((ligne) => ({
      id: ligne.id,
      date: ligne.date,
      heure: ligne.heure,
      duree_creneau: ligne.duree_creneau,
      statut: ligne.statut,
      medecin: {
        id: ligne.medecin_id,
        prenom: ligne.medecin_prenom,
        nom: ligne.medecin_nom,
        specialite: ligne.medecin_specialite,
        email: ligne.medecin_email,
        telephone: ligne.medecin_telephone
      }
    }));
    return res.json({ patient, rendez_vous: rendezVous });
  }));

  return routeur;
}

module.exports = { creerRouteRendezVous };
