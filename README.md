# Socle

Une seule plateforme pour les mini-apps de la maison. Socle fournit une fois pour toutes ce que chaque app refaisait
dans son coin : la connexion, les sessions, les notifications et l'installation sur l'écran d'accueil. Une app n'a
plus qu'à apporter ses écrans et sa logique, et il ne reste qu'un seul service à tenir à jour.

## Où en est le projet

| Étape | Contenu                                                                                  | État    |
| ----- | ---------------------------------------------------------------------------------------- | ------- |
| 1     | Connexion Google, session par sous-domaine, PWA et notifications, app de démo            | fait    |
| 2     | Build des apps sans `npm install`, base SQLite par app, fonctions serveur en bac à sable | à faire |
| 3     | Serveurs MCP : un pour créer les apps, un par app ; brouillon, publication, versions     | à faire |
| 4     | Portage de tasker puis de tricount                                                       | à faire |
| 5     | Portage de plantes                                                                       | à faire |

## Comment ça marche

Un seul serveur répond sur deux types d'adresses :

- **Le plan de contrôle** (`CONTROL_URL`, par exemple `https://socle.example.com`) : connexion avec Google, réservée
  aux adresses de `ALLOWED_EMAILS`, et page d'accueil qui liste les apps.
- **Une adresse par app** (`https://<app>.<APPS_DOMAIN>`) : chaque app est une origine à part, donc une PWA à part,
  avec ses propres notifications.

Quand quelqu'un ouvre une app sans être connecté, le navigateur passe par le plan de contrôle, qui renvoie un code à
usage unique valable une minute pour cette app seulement. L'app échange ce code contre son propre cookie de session.
Se déconnecter depuis n'importe quelle app déconnecte de toutes sur ce navigateur.

Sur chaque app, la plateforme sert sous `/_socle/` :

| Chemin                         | Rôle                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `/_socle/sdk.js`               | Ce que l'app importe : `me()`, `push`, `install`, `logout()`      |
| `/_socle/api/*`                | L'API derrière le SDK                                             |
| `/_socle/sw.js`                | Le service worker (notifications), le même pour toutes les apps   |
| `/_socle/manifest.webmanifest` | Le manifeste d'installation, généré à partir de la fiche de l'app |
| `/_socle/login`, `/_socle/sso` | La connexion                                                      |

Une app de démo (`DEMO_APP=1`, servie sur `demo.<APPS_DOMAIN>`) vérifie les trois choses sur un vrai téléphone :
connexion, installation, notification de test.

## Sécurité

Le plan de contrôle et les apps sont des sous-domaines voisins d'un même domaine. Pour un navigateur, des voisins
forment un seul « site » : les cookies `SameSite` ne les séparent pas. La séparation repose donc sur quatre règles,
toutes couvertes par des tests :

- **Cookies** `__Host-` uniquement : liés à une seule adresse, illisibles en JavaScript, impossibles à remplacer
  depuis une adresse voisine.
- **Origine exacte** : toute requête qui modifie quelque chose est refusée si elle ne vient pas d'une page de la même
  adresse.
- **Pages d'app confinées** : une politique de contenu leur interdit d'appeler une autre adresse que la leur, et seul
  le service worker de la plateforme peut être enregistré.
- **Sessions par adresse** : la session d'une app n'est acceptée nulle part ailleurs.

Limites connues : une app peut toujours envoyer ses propres données ailleurs en redirigeant le navigateur, poser des
cookies visibles par les autres services du domaine parent, et déconnecter la personne de toutes les apps.

## Développement

Node 26 exécute les sources TypeScript directement, sans étape de build.

```bash
npm install
cp .env.example .env    # puis activer le bloc « Local development »
npm run dev             # http://socle.localhost:8787 et http://demo.apps.localhost:8787
npm test
npm run typecheck
npm run format
```

Les navigateurs résolvent `*.localhost` tout seuls. `DEV_LOGIN=1` remplace Google par une page qui liste les adresses
autorisées ; le serveur refuse de démarrer avec cette option hors de `localhost`.

## Déploiement

L'image `ghcr.io/tonyctalope/socle` est construite par la CI (amd64 et arm64). `compose.yaml` donne un exemple
derrière Traefik. Il faut :

1. Deux entrées DNS vers le serveur : celle du plan de contrôle et un joker `*.<APPS_DOMAIN>`.
2. Un certificat joker pour `*.<APPS_DOMAIN>` (défi DNS-01).
3. Un client OAuth Google de type « application Web », avec `<CONTROL_URL>/auth/google/callback` comme URI de
   redirection autorisée.
4. Un fichier `.env` à côté de `compose.yaml` (voir `.env.example`) et un dossier `data/` accessible en écriture.

La base est dans `data/socle.db` ; une copie est écrite chaque nuit dans `data/backups/` (14 conservées).

## Mises à jour

- Dependabot ouvre chaque semaine une demande groupée ; les mises à jour mineures et correctives sont fusionnées
  automatiquement quand la CI passe.
- La CI reconstruit l'image chaque nuit, ce qui embarque aussi les correctifs de l'image de base.
- Le job « Known vulnerabilities » échoue dès qu'une dépendance de production a une alerte haute ou critique.
