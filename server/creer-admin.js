'use strict';

require('dotenv').config();

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const bcrypt = require('bcryptjs');
const { ouvrirBase } = require('./db');

function lireMotDePasseMasque() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const valeur = process.env.ADMIN_PASSWORD;
    if (!valeur) throw new Error('Dans un terminal interactif, relancez la commande. Sinon, définissez ADMIN_PASSWORD temporairement.');
    return Promise.resolve(valeur);
  }

  return new Promise((resolve, reject) => {
    stdout.write('Mot de passe admin (8 caractères minimum) : ');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let motDePasse = '';
    const terminer = (erreur) => {
      stdin.removeListener('data', recevoir);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (erreur) reject(erreur);
      else resolve(motDePasse);
    };
    const recevoir = (caracteres) => {
      for (const caractere of caracteres) {
        if (caractere === '\u0003') return terminer(new Error('Création annulée.'));
        if (caractere === '\r' || caractere === '\n') return terminer();
        if (caractere === '\u007f' || caractere === '\b') {
          if (motDePasse.length) {
            motDePasse = motDePasse.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (caractere >= ' ') {
          motDePasse += caractere;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', recevoir);
  });
}

function validerEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function main() {
  const invite = readline.createInterface({ input: stdin, output: stdout });
  let db;
  try {
    const prenom = (await invite.question('Prénom de l’admin : ')).trim();
    const nom = (await invite.question('Nom de l’admin : ')).trim();
    const email = (await invite.question('Adresse courriel de l’admin : ')).trim().toLowerCase();
    if (!prenom || prenom.length > 100 || !nom || nom.length > 100 || !validerEmail(email)) {
      throw new Error('Le prénom, le nom ou l’adresse courriel est invalide.');
    }
    invite.close();

    const motDePasse = await lireMotDePasseMasque();
    if (motDePasse.length < 8 || Buffer.byteLength(motDePasse, 'utf8') > 72) {
      throw new Error('Le mot de passe doit contenir au moins 8 caractères et au plus 72 octets UTF-8.');
    }

    db = ouvrirBase();
    const hash = await bcrypt.hash(motDePasse, 12);
    db.prepare(`
      INSERT INTO utilisateurs
        (role, prenom, nom, email, telephone, date_naissance, mot_de_passe_hash, matricule, specialite, cree_le)
      VALUES ('admin', ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?)
    `).run(prenom, nom, email, hash, new Date().toISOString());
    process.stdout.write('Compte administrateur créé.\n');
  } catch (erreur) {
    if (typeof erreur?.message === 'string' && erreur.message.includes('UNIQUE constraint failed')) {
      process.stderr.write('Un compte utilise déjà cette adresse courriel.\n');
      process.exitCode = 1;
    } else {
      process.stderr.write(`${erreur.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    invite.close();
    if (db) db.close();
  }
}

if (require.main === module) main();

module.exports = { lireMotDePasseMasque };
