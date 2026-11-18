'use strict';

function requireRole(...rolesAutorises) {
  return function verifierRole(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ erreur: 'Vous devez vous connecter.' });
    }
    if (!rolesAutorises.includes(req.user.role)) {
      return res.status(403).json({ erreur: 'Vous n’avez pas les droits nécessaires.' });
    }
    return next();
  };
}

module.exports = { requireRole };
