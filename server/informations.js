'use strict';

const express = require('express');
const fiches = require('./fiches.json');

const routeur = express.Router();

routeur.get('/informations', (_req, res) => {
  const informations = fiches.map(({ slug, titre, categorie, resume, statut_validation }) => ({
    slug,
    titre,
    categorie,
    resume,
    statut_validation
  }));
  return res.json({ informations });
});

routeur.get('/informations/:slug', (req, res) => {
  const fiche = fiches.find((element) => element.slug === req.params.slug);
  if (!fiche) return res.status(404).json({ erreur: 'Fiche d’information introuvable.' });
  return res.json({ fiche });
});

module.exports = routeur;
