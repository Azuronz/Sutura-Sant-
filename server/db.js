'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function ouvrirBase(chemin = process.env.DB_PATH || './data/sutura.sqlite') {
  const cheminAbsolu = chemin === ':memory:' ? chemin : path.resolve(chemin);
  if (cheminAbsolu !== ':memory:') {
    fs.mkdirSync(path.dirname(cheminAbsolu), { recursive: true });
  }

  const db = new DatabaseSync(cheminAbsolu);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS utilisateurs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('patient', 'medecin', 'personnel', 'admin')),
      prenom TEXT NOT NULL,
      nom TEXT NOT NULL,
      email TEXT COLLATE NOCASE UNIQUE,
      telephone TEXT UNIQUE,
      date_naissance TEXT,
      mot_de_passe_hash TEXT NOT NULL,
      matricule TEXT COLLATE NOCASE UNIQUE,
      specialite TEXT CHECK (specialite IS NULL OR specialite IN ('médecin généraliste', 'psychologue')),
      cree_le TEXT NOT NULL,
      CHECK (email IS NOT NULL OR telephone IS NOT NULL OR matricule IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      expire_le TEXT NOT NULL,
      cree_le TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_utilisateur ON sessions(utilisateur_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiration ON sessions(expire_le);

    CREATE TABLE IF NOT EXISTS journal_acces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qui_id INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL,
      quoi TEXT NOT NULL,
      cible_id INTEGER,
      ressource_id INTEGER,
      quand TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_acces_cible_quand ON journal_acces(cible_id, quand);

    CREATE TABLE IF NOT EXISTS disponibilites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medecin_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      heure_debut TEXT NOT NULL
        CHECK (
          heure_debut GLOB '[0-2][0-9]:[0-5][0-9]'
          AND CAST(substr(heure_debut, 1, 2) AS INTEGER) BETWEEN 0 AND 23
        ),
      heure_fin TEXT NOT NULL
        CHECK (
          heure_fin GLOB '[0-2][0-9]:[0-5][0-9]'
          AND CAST(substr(heure_fin, 1, 2) AS INTEGER) BETWEEN 0 AND 23
        ),
      duree_creneau INTEGER NOT NULL CHECK (duree_creneau IN (15, 20, 30, 45, 60)),
      cree_le TEXT NOT NULL,
      CHECK (heure_debut < heure_fin),
      UNIQUE (medecin_id, date, heure_debut)
    );
    CREATE INDEX IF NOT EXISTS idx_disponibilites_medecin_date
      ON disponibilites(medecin_id, date, heure_debut);

    CREATE TABLE IF NOT EXISTS rendez_vous (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medecin_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE RESTRICT,
      patient_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE RESTRICT,
      date TEXT NOT NULL,
      heure TEXT NOT NULL
        CHECK (
          heure GLOB '[0-2][0-9]:[0-5][0-9]'
          AND CAST(substr(heure, 1, 2) AS INTEGER) BETWEEN 0 AND 23
        ),
      duree_creneau INTEGER NOT NULL CHECK (duree_creneau IN (15, 20, 30, 45, 60)),
      statut TEXT NOT NULL CHECK (statut IN ('confirme', 'annule')),
      cree_par_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE RESTRICT,
      cree_le TEXT NOT NULL,
      annule_par_id INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL,
      annule_le TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rendez_vous_creneau_confirme
      ON rendez_vous(medecin_id, date, heure) WHERE statut = 'confirme';
    CREATE INDEX IF NOT EXISTS idx_rendez_vous_patient_date
      ON rendez_vous(patient_id, date, heure);
    CREATE INDEX IF NOT EXISTS idx_rendez_vous_medecin_date
      ON rendez_vous(medecin_id, date, heure);
  `);

  const colonnesJournal = db.prepare('PRAGMA table_info(journal_acces)').all();
  if (!colonnesJournal.some((colonne) => colonne.name === 'ressource_id')) {
    db.exec('ALTER TABLE journal_acces ADD COLUMN ressource_id INTEGER');
  }

  return db;
}

function journaliserAcces(db, { quiId = null, quoi, cibleId = null, ressourceId = null }) {
  if (typeof quoi !== 'string' || !quoi.trim()) {
    throw new TypeError('Le type d’accès à journaliser est requis.');
  }
  return db.prepare(
    'INSERT INTO journal_acces (qui_id, quoi, cible_id, ressource_id, quand) VALUES (?, ?, ?, ?, ?)'
  ).run(quiId, quoi, cibleId, ressourceId, new Date().toISOString());
}

module.exports = { ouvrirBase, journaliserAcces };
