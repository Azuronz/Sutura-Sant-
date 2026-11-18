const formulaireInscription = document.querySelector('#inscription');
const formulaireConnexion = document.querySelector('#form-connexion');
const formulaires = document.querySelector('#formulaires');
const session = document.querySelector('#session');
const bonjour = document.querySelector('#bonjour');
const annonce = document.querySelector('#annonce');
const invitationInstallationIos = document.querySelector('#installation-ios');
const ecrans = [...document.querySelectorAll('.ecran')];
const informationsListe = document.querySelector('#liste-informations');
const rechercheInformations = document.querySelector('#recherche-informations');
const etatInformations = document.querySelector('#etat-informations');
const detailInformation = document.querySelector('#detail-information');
const filtreSpecialite = document.querySelector('#filtre-specialite');
const choixMedecin = document.querySelector('#choix-medecin');
const listeCreneaux = document.querySelector('#liste-creneaux');
const mesRendezVous = document.querySelector('#mes-rendez-vous');
const listeRendezVousMedecin = document.querySelector('#rendez-vous-medecin');
const indicateurChargementInformations = creerElement('div', '', 'chargement');
indicateurChargementInformations.hidden = true;
etatInformations.classList.remove('chargement');
etatInformations.classList.add('field__aide');
etatInformations.before(indicateurChargementInformations);

let utilisateur = null;
let fiches = [];
let debutSemaineRendezVous = lundiCourant();
let debutSemainePlanning = lundiCourant();
let specialiteSuggeree = '';
let minuteurAnnonce = null;

async function api(chemin, options = {}) {
  const reponse = await fetch(chemin, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const contenu = await reponse.json().catch(() => ({}));
  if (!reponse.ok) throw new Error(contenu.erreur || 'Une erreur est survenue.');
  return contenu;
}

function lireFormulaire(formulaire) {
  return Object.fromEntries(new FormData(formulaire).entries());
}

function creerElement(nom, texte = '', classe = '') {
  const element = document.createElement(nom);
  if (texte !== '') element.textContent = String(texte);
  if (classe) element.className = classe;
  return element;
}

function activerAvecClavier(element, action) {
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  });
}

function creerEtatChargement(message) {
  const groupe = creerElement('div');
  groupe.append(creerElement('div', '', 'chargement'));
  const texte = creerElement('p', message, 'field__aide');
  texte.setAttribute('role', 'status');
  groupe.append(texte);
  return groupe;
}

function ajouterMessage(element, message, classe = '') {
  element.replaceChildren();
  element.textContent = message;
  if (classe) element.className = classe;
}

function afficherAnnonce(message) {
  annonce.textContent = message;
  annonce.hidden = false;
  window.clearTimeout(minuteurAnnonce);
  minuteurAnnonce = window.setTimeout(() => {
    annonce.hidden = true;
    annonce.textContent = '';
  }, 6000);
}

function afficherInvitationInstallationIos() {
  const estIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const estInstallee = navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  invitationInstallationIos.hidden = !estIOS || estInstallee;
}

function dateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function ajouterJours(date, jours) {
  return dateUtc(new Date(Date.parse(`${date}T00:00:00.000Z`) + jours * 86400000));
}

function lundiDe(date) {
  const jour = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const ecart = (jour + 6) % 7;
  return ajouterJours(date, -ecart);
}

function lundiCourant() {
  return lundiDe(dateUtc(new Date()));
}

function periodeSemaine(lundi) {
  return { du: lundi, au: ajouterJours(lundi, 6) };
}

function libelleSemaine(lundi) {
  const { au } = periodeSemaine(lundi);
  return `Du ${lundi} au ${au}`;
}

function estPasse(date, heure = '23:59') {
  const aujourdHui = dateUtc(new Date());
  const heureActuelle = new Date().toISOString().slice(11, 16);
  return date < aujourdHui || (date === aujourdHui && heure <= heureActuelle);
}

function afficherConnecte(connecte) {
  utilisateur = connecte;
  bonjour.textContent = `Bonjour, ${connecte.prenom}`;
  session.hidden = false;
  formulaires.hidden = true;
  document.querySelector('#lien-planning').hidden = connecte.role !== 'medecin';
  document.querySelector('#acces-rendez-vous').textContent = connecte.role === 'patient'
    ? ''
    : 'La prise de rendez-vous en ligne est réservée aux patients.';
  document.querySelector('#outils-rendez-vous').hidden = connecte.role !== 'patient';
  document.querySelector('#acces-planning').textContent = connecte.role === 'medecin'
    ? ''
    : 'Cet écran est réservé aux médecins connectés.';
  document.querySelector('#contenu-planning').hidden = connecte.role !== 'medecin';
}

function afficherDeconnecte() {
  utilisateur = null;
  session.hidden = true;
  formulaires.hidden = false;
  bonjour.textContent = '';
  document.querySelector('#lien-planning').hidden = true;
  document.querySelector('#outils-rendez-vous').hidden = true;
  document.querySelector('#contenu-planning').hidden = true;
  document.querySelector('#acces-rendez-vous').textContent = 'Connectez-vous avec un compte patient pour gérer vos rendez-vous.';
  document.querySelector('#acces-planning').textContent = 'Cet écran est réservé aux médecins connectés.';
}

function afficherEcran() {
  const fragment = location.hash.slice(1) || 'accueil';
  const ecran = ecrans.find((element) => element.id === fragment) || document.querySelector('#accueil');
  if (ecran.id === 'connexion' && utilisateur) {
    location.hash = '#accueil';
    return;
  }
  for (const element of ecrans) element.hidden = element !== ecran;
  for (const lien of document.querySelectorAll('.nav__item')) {
    lien.classList.toggle('nav__item--actif', lien.getAttribute('href') === `#${ecran.id}`);
  }
  if (ecran.id === 'informations' && fiches.length === 0) void chargerInformations();
  if (ecran.id === 'rendez-vous' && utilisateur?.role === 'patient') void initialiserRendezVous();
  if (ecran.id === 'planning-medecin' && utilisateur?.role === 'medecin') void chargerPlanningMedecin();
}

async function chargerInformations() {
  indicateurChargementInformations.hidden = false;
  etatInformations.hidden = false;
  etatInformations.textContent = 'Chargement des informations…';
  try {
    const resultat = await api('/api/informations');
    fiches = resultat.informations;
    etatInformations.textContent = '';
    etatInformations.hidden = true;
    indicateurChargementInformations.hidden = true;
    afficherListeInformations();
  } catch (erreur) {
    etatInformations.textContent = '';
    etatInformations.hidden = true;
    indicateurChargementInformations.hidden = true;
    afficherAnnonce(erreur.message);
  }
}

function afficherListeInformations() {
  const motCle = rechercheInformations.value.trim().toLocaleLowerCase('fr');
  const resultats = fiches.filter((fiche) => (
    `${fiche.titre} ${fiche.categorie} ${fiche.resume}`.toLocaleLowerCase('fr').includes(motCle)
  ));
  informationsListe.replaceChildren();
  for (const fiche of resultats) {
    const ligne = creerElement('li', '', 'liste');
    const bouton = creerElement('button', fiche.titre, 'btn btn--secondaire');
    bouton.type = 'button';
    bouton.setAttribute('aria-label', `Lire la fiche : ${fiche.titre}`);
    bouton.addEventListener('click', () => void chargerDetailInformation(fiche.slug));
    ligne.append(bouton, creerElement('p', fiche.resume), creerElement('span', fiche.categorie, 'badge badge--medical'));
    informationsListe.append(ligne);
  }
  if (resultats.length === 0) informationsListe.append(creerElement('li', 'Aucune fiche ne correspond à cette recherche.', 'etat-vide'));
}

function remplirListe(id, valeurs) {
  const conteneur = document.querySelector(id);
  conteneur.replaceChildren();
  for (const valeur of valeurs) conteneur.append(creerElement('li', valeur));
}

async function chargerDetailInformation(slug) {
  try {
    const resultat = await api(`/api/informations/${encodeURIComponent(slug)}`);
    const fiche = resultat.fiche;
    document.querySelector('#detail-categorie').textContent = fiche.categorie;
    document.querySelector('#detail-titre').textContent = fiche.titre;
    document.querySelector('#detail-resume').textContent = fiche.resume;
    remplirListe('#detail-alertes', fiche.signes_alerte);
    remplirListe('#detail-actions', fiche.quoi_faire);
    document.querySelector('#detail-consulter').textContent = fiche.quand_consulter;
    document.querySelector('#detail-specialite').textContent = fiche.specialite;
    document.querySelector('#consulter-medecin').dataset.specialite = fiche.specialite;
    detailInformation.hidden = false;
    detailInformation.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (erreur) {
    afficherAnnonce(erreur.message);
  }
}

async function chargerMedecins() {
  choixMedecin.replaceChildren();
  const optionVide = document.createElement('option');
  optionVide.value = '';
  optionVide.textContent = 'Sélectionnez un médecin';
  choixMedecin.append(optionVide);
  const parametres = new URLSearchParams();
  if (filtreSpecialite.value) parametres.set('specialite', filtreSpecialite.value);
  const suffixe = parametres.size ? `?${parametres}` : '';
  const resultat = await api(`/api/medecins${suffixe}`);
  for (const medecin of resultat.medecins) {
    const option = document.createElement('option');
    option.value = String(medecin.id);
    option.textContent = `${medecin.prenom} ${medecin.nom} — ${medecin.specialite}`;
    choixMedecin.append(option);
  }
  if (specialiteSuggeree && [...filtreSpecialite.options].some((option) => option.value === specialiteSuggeree)) {
    filtreSpecialite.value = specialiteSuggeree;
    specialiteSuggeree = '';
    await chargerMedecins();
  }
}

async function initialiserRendezVous() {
  const outils = document.querySelector('#outils-rendez-vous');
  if (utilisateur?.role !== 'patient') return;
  outils.hidden = false;
  try {
    await chargerMedecins();
    await chargerMesRendezVous();
    if (choixMedecin.value) await chargerCreneaux();
    else afficherSemaineRendezVous();
  } catch (erreur) {
    afficherAnnonce(erreur.message);
  }
}

function afficherSemaineRendezVous() {
  document.querySelector('#semaine-affichee').textContent = libelleSemaine(debutSemaineRendezVous);
}

async function chargerCreneaux() {
  afficherSemaineRendezVous();
  if (!choixMedecin.value) {
    listeCreneaux.replaceChildren(creerElement('p', 'Choisissez un médecin pour afficher ses créneaux.', 'etat-vide'));
    return;
  }
  listeCreneaux.replaceChildren(creerEtatChargement('Chargement des créneaux…'));
  const periode = periodeSemaine(debutSemaineRendezVous);
  const query = new URLSearchParams(periode);
  try {
    const resultat = await api(`/api/medecins/${encodeURIComponent(choixMedecin.value)}/creneaux?${query}`);
    listeCreneaux.replaceChildren();
    if (resultat.creneaux.length === 0) {
      listeCreneaux.append(creerElement('p', 'Aucun créneau disponible cette semaine.', 'etat-vide'));
      return;
    }
    for (const creneau of resultat.creneaux) {
      const item = creerElement('div', '', `slot__item ${creneau.statut === 'libre' ? 'slot--libre' : 'slot--pris'}`);
      const statut = creneau.statut === 'libre' ? 'Libre' : 'Pris';
      item.append(creerElement('span', creneau.heure), creerElement('small', statut));
      if (creneau.statut === 'libre') {
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', `${creneau.date} à ${creneau.heure}, créneau libre. Réserver.`);
        const reserver = () => void reserverCreneau(item, creneau);
        item.addEventListener('click', reserver);
        activerAvecClavier(item, reserver);
      } else {
        item.setAttribute('aria-label', `${creneau.date} à ${creneau.heure}, créneau pris`);
      }
      listeCreneaux.append(item);
    }
  } catch (erreur) {
    const message = creerElement('p', erreur.message, 'field__aide');
    message.setAttribute('role', 'status');
    listeCreneaux.replaceChildren(message);
  }
}

async function reserverCreneau(item, creneau) {
  if (item.getAttribute('aria-disabled') === 'true') return;
  item.setAttribute('aria-disabled', 'true');
  item.classList.remove('slot--libre');
  item.classList.add('slot--choisi');
  try {
    await api('/api/rendez-vous', {
      method: 'POST',
      body: JSON.stringify({
        medecin_id: Number(choixMedecin.value),
        date: creneau.date,
        heure: creneau.heure
      })
    });
    afficherAnnonce('Votre rendez-vous est confirmé.');
    await Promise.all([chargerCreneaux(), chargerMesRendezVous()]);
  } catch (erreur) {
    afficherAnnonce(erreur.message);
    item.setAttribute('aria-disabled', 'false');
    item.classList.remove('slot--choisi');
    item.classList.add('slot--libre');
  }
}

async function chargerMesRendezVous() {
  const resultat = await api('/api/rendez-vous');
  mesRendezVous.replaceChildren();
  if (resultat.rendez_vous.length === 0) {
    mesRendezVous.append(creerElement('li', 'Vous n’avez pas encore de rendez-vous.', 'etat-vide'));
    return;
  }
  for (const rendezVous of resultat.rendez_vous) {
    const medecin = rendezVous.medecin;
    const ligne = creerElement('li', '', 'card');
    ligne.append(creerElement('p', `${rendezVous.date} à ${rendezVous.heure}`));
    ligne.append(creerElement('p', `Dr ${medecin.prenom} ${medecin.nom} — ${medecin.specialite}`));
    ligne.append(creerElement('p', `Statut : ${rendezVous.statut === 'confirme' ? 'confirmé' : 'annulé'}`));
    if (rendezVous.statut === 'confirme' && !estPasse(rendezVous.date, rendezVous.heure)) {
      const bouton = creerElement('button', 'Annuler', 'btn btn--danger');
      bouton.type = 'button';
      bouton.addEventListener('click', () => void annulerRendezVous(rendezVous.id, bouton));
      ligne.append(bouton);
    }
    mesRendezVous.append(ligne);
  }
}

async function annulerRendezVous(id, bouton) {
  bouton.disabled = true;
  try {
    await api(`/api/rendez-vous/${encodeURIComponent(id)}/annulation`, { method: 'POST' });
    afficherAnnonce('Le rendez-vous a été annulé.');
    await Promise.all([chargerMesRendezVous(), chargerCreneaux()]);
  } catch (erreur) {
    afficherAnnonce(erreur.message);
    bouton.disabled = false;
  }
}

async function chargerPlanningMedecin() {
  if (utilisateur?.role !== 'medecin') return;
  const periode = periodeSemaine(debutSemainePlanning);
  document.querySelector('#semaine-planning').textContent = libelleSemaine(debutSemainePlanning);
  const ligneChargement = creerElement('li');
  ligneChargement.append(creerEtatChargement('Chargement du planning…'));
  listeRendezVousMedecin.replaceChildren(ligneChargement);
  try {
    const query = new URLSearchParams(periode);
    const resultat = await api(`/api/medecin/rendez-vous?${query}`);
    listeRendezVousMedecin.replaceChildren();
    if (resultat.rendez_vous.length === 0) {
      listeRendezVousMedecin.append(creerElement('li', 'Aucun rendez-vous cette semaine.', 'etat-vide'));
      return;
    }
    for (const rendezVous of resultat.rendez_vous) {
      const patient = rendezVous.patient;
      const ligne = creerElement('li', '', 'card');
      ligne.append(creerElement('p', `${rendezVous.date} à ${rendezVous.heure}`));
      ligne.append(creerElement('p', `Patient : ${patient.prenom} ${patient.nom}`));
      ligne.append(creerElement('p', `Statut : ${rendezVous.statut === 'confirme' ? 'confirmé' : 'annulé'}`));
      listeRendezVousMedecin.append(ligne);
    }
  } catch (erreur) {
    const message = creerElement('p', erreur.message, 'field__aide');
    message.setAttribute('role', 'status');
    const ligneErreur = creerElement('li');
    ligneErreur.append(message);
    listeRendezVousMedecin.replaceChildren(ligneErreur);
  }
}

formulaireInscription.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#message-inscription');
  const donnees = lireFormulaire(formulaireInscription);
  donnees.email ||= null;
  donnees.telephone ||= null;
  try {
    await api('/api/auth/inscription', { method: 'POST', body: JSON.stringify(donnees) });
    message.textContent = 'Votre compte patient a été créé. Vous pouvez vous connecter.';
    formulaireInscription.reset();
    for (const champ of formulaireInscription.querySelectorAll('.input')) champ.classList.remove('input--erreur');
  } catch (erreur) {
    message.textContent = erreur.message;
    const courriel = formulaireInscription.elements.email;
    const telephone = formulaireInscription.elements.telephone;
    const informationsContactAbsentes = !courriel.value.trim() && !telephone.value.trim();
    courriel.classList.toggle('input--erreur', informationsContactAbsentes);
    telephone.classList.toggle('input--erreur', informationsContactAbsentes);
  }
});

formulaireConnexion.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#message-connexion');
  const donnees = lireFormulaire(formulaireConnexion);
  donnees.rester_connecte = formulaireConnexion.elements.rester_connecte.checked;
  try {
    const resultat = await api('/api/auth/connexion', { method: 'POST', body: JSON.stringify(donnees) });
    formulaireConnexion.reset();
    message.textContent = '';
    afficherConnecte(resultat.utilisateur);
    location.hash = '#accueil';
    afficherAnnonce(`Bonjour, ${resultat.utilisateur.prenom}`);
  } catch (erreur) {
    message.textContent = erreur.message;
  }
});

document.querySelector('#deconnexion').addEventListener('click', async () => {
  try {
    await api('/api/auth/deconnexion', { method: 'POST' });
  } finally {
    afficherDeconnecte();
    afficherAnnonce('Vous êtes déconnecté.');
  }
});

document.querySelector('#consulter-medecin').addEventListener('click', () => {
  specialiteSuggeree = document.querySelector('#consulter-medecin').dataset.specialite || '';
  location.hash = '#rendez-vous';
});

rechercheInformations.addEventListener('input', afficherListeInformations);
filtreSpecialite.addEventListener('change', async () => {
  try {
    await chargerMedecins();
    listeCreneaux.replaceChildren(creerElement('p', 'Choisissez un médecin pour afficher ses créneaux.', 'etat-vide'));
  } catch (erreur) {
    afficherAnnonce(erreur.message);
  }
});
choixMedecin.addEventListener('change', () => {
  void chargerCreneaux();
});
document.querySelector('#semaine-precedente').addEventListener('click', () => {
  debutSemaineRendezVous = ajouterJours(debutSemaineRendezVous, -7);
  void chargerCreneaux();
});
document.querySelector('#semaine-suivante').addEventListener('click', () => {
  debutSemaineRendezVous = ajouterJours(debutSemaineRendezVous, 7);
  void chargerCreneaux();
});
document.querySelector('#actualiser-rendez-vous').addEventListener('click', async () => {
  try {
    await chargerMesRendezVous();
  } catch (erreur) {
    afficherAnnonce(erreur.message);
  }
});
document.querySelector('#planning-precedent').addEventListener('click', () => {
  debutSemainePlanning = ajouterJours(debutSemainePlanning, -7);
  void chargerPlanningMedecin();
});
document.querySelector('#planning-suivant').addEventListener('click', () => {
  debutSemainePlanning = ajouterJours(debutSemainePlanning, 7);
  void chargerPlanningMedecin();
});
window.addEventListener('hashchange', afficherEcran);
afficherInvitationInstallationIos();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.querySelector('#detail-information').hidden = true;
try {
  const resultat = await api('/api/auth/moi');
  afficherConnecte(resultat.utilisateur);
} catch {
  afficherDeconnecte();
}
afficherEcran();
