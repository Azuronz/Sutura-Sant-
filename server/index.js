'use strict';

require('dotenv').config();

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { ouvrirBase } = require('./db');
const { creerRouteAuth, creerRouteAdmin } = require('./auth');
const { creerRouteRendezVous } = require('./rendez-vous');

function creerApplication({ db } = {}) {
  if (!db) throw new TypeError('Une connexion SQLite est requise pour créer l’application.');
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    }
  }));
  app.use((req, res, next) => {
    if (req.path === '/prototype.html') {
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "object-src 'none'",
        "script-src 'self'",
        "script-src-attr 'unsafe-inline'",
        "style-src 'self'",
        "style-src-attr 'unsafe-inline'"
      ].join('; '));
    }
    return next();
  });
  app.use(express.json({ limit: '20kb', strict: true }));
  app.use('/api', (req, _res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
    const contentType = req.headers['content-type'];
    if (!contentType || /^application\/json(?:\s*;|$)/i.test(contentType)) return next();
    const erreur = new Error('Type de contenu non pris en charge. Envoyez du JSON.');
    erreur.status = 415;
    return next(erreur);
  });
  app.use(['/api/auth', '/api/admin'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    return next();
  });
  app.use('/api/auth', creerRouteAuth(db));
  app.use('/api/admin', creerRouteAdmin(db));
  app.use('/api', creerRouteRendezVous(db));
  app.use('/api', require('./informations'));
  app.use('/api', (_req, res) => res.status(404).json({ erreur: 'Route API introuvable.' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    extensions: ['html'],
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
  }));

  app.use((erreur, _req, res, _next) => {
    if (res.headersSent) return;
    if (erreur?.type === 'entity.parse.failed') {
      return res.status(400).json({ erreur: 'Le contenu envoyé n’est pas un JSON valide.' });
    }
    if (erreur?.type === 'entity.too.large') {
      return res.status(413).json({ erreur: 'Les informations envoyées sont trop volumineuses.' });
    }
    const codeErreur = [erreur?.status, erreur?.statusCode]
      .map(Number)
      .find((code) => Number.isInteger(code) && code >= 400 && code < 600);
    const statut = codeErreur || 500;
    return res.status(statut).json({
      erreur: statut === 500 ? 'Une erreur est survenue. Réessayez plus tard.' : 'La requête est invalide.'
    });
  });
  return app;
}

if (require.main === module) {
  const db = ouvrirBase();
  db.prepare('DELETE FROM sessions WHERE expire_le <= ?').run(new Date().toISOString());
  const app = creerApplication({ db });
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('La valeur de PORT est invalide.\n');
    db.close();
    process.exitCode = 1;
  } else {
    const serveur = app.listen(port, () => {
      process.stdout.write(`Sutura Santé écoute sur le port ${port}.\n`);
    });
    const arreter = () => serveur.close(() => {
      db.close();
      process.exit(0);
    });
    process.once('SIGINT', arreter);
    process.once('SIGTERM', arreter);
  }
}

module.exports = { creerApplication };
