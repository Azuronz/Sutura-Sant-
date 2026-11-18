# Sutura Santé — étapes 1 à 3

Le serveur Express fournit les comptes, les sessions, les rôles, les plannings hebdomadaires des médecins, la gestion des rendez-vous et les fiches d’information publiques. L’interface minimale de l’étape 3 permet de consulter les fiches, gérer les rendez-vous du patient et consulter le planning du médecin.

## Prérequis

- Node.js 22.13 ou plus récent, avec `node:sqlite` disponible.
- npm, fourni avec Node.js.

La base utilise le module intégré `node:sqlite`; aucun module SQLite natif n’est installé. Les mots de passe sont hachés avec `bcryptjs`, en JavaScript pur.

## Installation et lancement — Windows PowerShell

Exécutez ces commandes depuis la racine du projet :

```powershell
if (-not (Test-Path .\.env)) {
    Copy-Item -LiteralPath .\.env.example -Destination .\.env
}
npm.cmd install
npm.cmd start
```

Le serveur écoute sur `http://localhost:3000`. Pour le mode développement avec redémarrage automatique :

```powershell
npm.cmd run dev
```

Dans un second terminal, créez l’administrateur :

```powershell
npm.cmd run creer-admin
```

Pour lancer les tests :

```powershell
npm.cmd test
```

En production, définissez le mode avant de démarrer afin que le cookie porte l’attribut `Secure` :

```powershell
$env:NODE_ENV = "production"
npm.cmd start
```

## Installation et lancement — macOS/Linux

Exécutez ces commandes depuis la racine du projet :

```sh
if [ ! -f .env ]; then cp .env.example .env; fi
npm install
npm start
```

Pour le mode développement :

```sh
npm run dev
```

Dans un second terminal, créez l’administrateur et lancez les tests :

```sh
npm run creer-admin
npm test
```

En production sous macOS/Linux :

```sh
NODE_ENV=production npm start
```

En production, le serveur doit être servi en HTTPS. Le cookie de session est `httpOnly`, `SameSite=Lax` et reçoit `Secure` lorsque `NODE_ENV=production`.

## Routes de l’étape 1

- `POST /api/auth/inscription` : crée un patient. Prénom, nom, date de naissance, mot de passe d’au moins 8 caractères et courriel ou téléphone requis.
- `POST /api/auth/connexion` : accepte un courriel, téléphone ou matricule et un mot de passe. `rester_connecte: true` crée une session de 30 jours; sinon elle expire après 12 heures.
- `POST /api/auth/deconnexion` : supprime la session en base et efface le cookie.
- `GET /api/auth/moi` : renvoie les informations publiques de la session active, sinon une erreur 401.
- `POST /api/admin/comptes` : réservé à un administrateur; crée un médecin ou un membre du personnel.

## Routes de l’étape 2

Toutes ces routes exigent une session, sauf indication contraire. Les erreurs sont renvoyées en JSON sous la forme `{"erreur":"message en français"}`.

### Tous les rôles connectés

- `GET /api/medecins?specialite=…` : liste les médecins avec leur identifiant, prénom, nom et spécialité, sans coordonnées.
- `GET /api/medecins/:id/creneaux?du=AAAA-MM-JJ&au=AAAA-MM-JJ` : renvoie les créneaux planifiés sur une période de 31 jours maximum, avec seulement les statuts `libre` ou `pris`.

### Patient

- `POST /api/rendez-vous` avec `{ "medecin_id", "date", "heure" }` : réserve un créneau pour le patient connecté.
- `GET /api/rendez-vous` : affiche uniquement les rendez-vous du patient connecté.
- `POST /api/rendez-vous/:id/annulation` : annule l’un de ses rendez-vous; un rendez-vous d’un autre patient renvoie 404.

### Médecin

- `GET /api/medecin/disponibilites?du=…&au=…` : affiche ses plages de disponibilité et ses rendez-vous de la période.
- `PUT /api/medecin/disponibilites/:lundi` : remplace ses plages de la semaine commençant ce lundi; toutes les dates du corps doivent appartenir à cette semaine.
- `GET /api/medecin/rendez-vous?du=…&au=…` : affiche uniquement ses rendez-vous, avec le prénom et le nom du patient.

### Personnel

- `GET /api/rendez-vous?patient_id=…&medecin_id=…&du=…&au=…` : liste les rendez-vous, avec filtres facultatifs.
- `POST /api/rendez-vous` avec `{ "patient_id", "medecin_id", "date", "heure" }` : crée un rendez-vous pour un patient existant.
- `PATCH /api/rendez-vous/:id` avec `date`, `heure`, ou les deux : déplace le rendez-vous confirmé vers un créneau libre.
- `POST /api/rendez-vous/:id/annulation` : annule n’importe quel rendez-vous confirmé.
- `GET /api/personnel/patients?recherche=…` : recherche les patients par nom, prénom, courriel, téléphone ou date de naissance. Chaque patient retourné est journalisé.
- `GET /api/personnel/patients/:id` : affiche l’identité, les contacts et les rendez-vous du patient. La consultation est journalisée.

## Règles de planning et confidentialité

Les dates et heures sont interprétées en heure locale Africa/Dakar, actuellement UTC+0 sans heure d’été, et stockées sans fuseau. Un créneau est passé si sa date précède aujourd’hui ou si sa date est aujourd’hui et que son heure de début est inférieure ou égale à l’heure actuelle de Dakar. Une période de lecture peut couvrir au plus 31 jours. Les disponibilités peuvent utiliser des créneaux de 15, 20, 30, 45 ou 60 minutes; si la durée est omise, elle vaut 30 minutes. Une disponibilité datée d’avant aujourd’hui est refusée. Le remplacement d’une semaine ne touche que les dates à partir d’aujourd’hui : les plages et rendez-vous passés sont conservés et seuls les rendez-vous non passés comptent dans le contrôle des conflits. Une semaine entièrement passée reste non modifiable. Les créneaux passés ne sont pas présentés; un rendez-vous passé ne peut être ni annulé ni déplacé.

La réservation, le déplacement et le remplacement des disponibilités utilisent une transaction `BEGIN IMMEDIATE`. Un index unique partiel empêche deux rendez-vous confirmés pour un même médecin, une même date et une même heure. En cas de réservation concurrente, une seule requête réussit et l’autre reçoit 409.

Un patient ne voit jamais l’identité d’un autre patient; les créneaux publics ne contiennent aucune identité. Un médecin ne voit que ses rendez-vous et le nom du patient, sans ses coordonnées. Seul le personnel voit les coordonnées des patients et des médecins. Les rendez-vous ne contiennent ni motif ni note médicale. Les consultations des fiches et listes de patients ainsi que les actions de gestion prévues sont inscrites dans `journal_acces`, sans données personnelles dans le journal.

Les échecs de connexion sont limités à 5 par identifiant sur 15 minutes et à 50 par adresse IP sur 15 minutes. Ces compteurs sont en mémoire et reviennent à zéro au redémarrage. En production derrière un reverse proxy (Render, Railway ou Nginx), les requêtes peuvent sembler venir de la même adresse IP. Il faudra alors configurer Express avec `trust proxy`; cette option n’est pas activée actuellement.

## Tests

`npm test` exécute 44 cas nommés : 19 tests d’authentification, 23 tests de rendez-vous et 2 tests des informations publiques :

1. le médecin définit sa semaine et le patient voit des créneaux libres sans identité;
2. un patient prend un créneau libre (201);
3. deux patients visant le même créneau obtiennent un succès et un conflit 409;
4. un rendez-vous dans le passé est refusé (400);
5. un patient ne peut pas annuler le rendez-vous d’un autre patient (404);
6. un patient annule son rendez-vous et le créneau redevient libre;
7. un médecin ne peut pas retirer une plage occupée par un rendez-vous confirmé (409 avec liste);
8. un médecin ne voit que ses propres rendez-vous;
9. le personnel crée un rendez-vous, le déplace et libère l’ancien créneau;
10. le personnel consulte une fiche patient et une ligne est ajoutée au journal;
11. un patient ne peut pas appeler les routes du personnel (403);
12. un patient ne peut pas modifier les disponibilités d’un médecin (403);
13. prolonger une plage qui contient un rendez-vous confirmé réussit;
14. modifier les jours à venir préserve les disponibilités et rendez-vous passés de la semaine;
15. une disponibilité dont la date est passée est refusée avec un message clair;
16. la liste de créneaux masque les heures déjà passées;
17. un patient ne peut pas annuler un rendez-vous passé (409);
18. le personnel ne peut pas déplacer un rendez-vous passé (409);
19. le journal du déplacement cible le patient et garde le rendez-vous comme ressource;
20. la réservation et l’annulation par un patient ne sont pas inscrites au journal;
21. une base existante ajoute `ressource_id` sans perdre le journal;
22. un rendez-vous passé aujourd’hui ne bloque pas la réduction de la plage du jour;
23. un rendez-vous à venir aujourd’hui empêche de retirer sa plage avec la liste en conflit.

Les tests d’informations vérifient que `GET /api/informations` ne renvoie pas le détail des fiches et qu’un slug inconnu renvoie un 404 JSON.

Chaque test utilise une base SQLite temporaire et envoie ses requêtes uniquement à `127.0.0.1`.

## Prototype et textes légaux

Le prototype est disponible dans `public/prototype.html`; son CSS et son JavaScript sont dans `public/prototype.css` et `public/prototype.js`. Seules les mentions de marque ont été adaptées. Il utilise aussi des attributs `onclick`, `oninput` et `style`; une exception CSP limitée à cette page autorise ces attributs. La politique reste stricte sur les autres pages.

La mention « aucune donnée n’est partagée, revendue ou transférée hors de l’appareil » du prototype devient inexacte pour l’inscription et la connexion : les données du compte sont transmises au serveur et stockées dans SQLite, et le navigateur conserve un cookie de session. Les données de santé du prototype restent actuellement locales. Les textes légaux n’ont pas été modifiés, hormis le nom de l’application. Le changement de nom ne vaut pas modification juridique; ces passages devront être relus avant une mise en production.

## Ce qui n’est pas fait

- Styles complets : `public/styles.css` reste à produire par le designer. L’interface minimale et la prise de rendez-vous sont livrées.
- Assistant IA et corpus de sources validées.
- Déploiement, configuration HTTPS et politique de sauvegarde.
