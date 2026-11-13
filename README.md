# Socle

Une seule plateforme pour les mini-apps de la maison. Socle fournit une fois pour toutes ce que chaque app refaisait
dans son coin : la connexion, les sessions, les notifications, l'installation sur l'écran d'accueil, le build et la
base de données. Une app n'apporte plus que ses écrans et sa logique, sous forme de fichiers sources, et il ne reste
qu'un seul service à tenir à jour.

## Où en est le projet

| Étape | Contenu                                                                                  | État    |
| ----- | ---------------------------------------------------------------------------------------- | ------- |
| 1     | Connexion Google, session par sous-domaine, PWA et notifications, app de démo            | fait    |
| 2     | Build des apps sans `npm install`, base SQLite par app, fonctions serveur en bac à sable | fait    |
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

| Chemin                         | Rôle                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `/_socle/vendor/*`             | React, le SDK (`@socle/sdk`) et les composants (`@socle/ui`), servis une fois |
| `/_socle/api/fn/<nom>`         | Les fonctions serveur de l'app                                                |
| `/_socle/api/events`           | Le flux qui prévient les pages ouvertes quand une donnée change               |
| `/_socle/sw.js`                | Le service worker (notifications), le même pour toutes les apps               |
| `/_socle/manifest.webmanifest` | Le manifeste d'installation, généré à partir de la fiche de l'app             |
| `/_socle/login`, `/_socle/sso` | La connexion                                                                  |

## Une app

Une app est un dossier de fichiers sources. Elle n'installe aucun paquet : tout ce qu'elle importe vient de ses
propres fichiers ou de la plateforme.

| Fichier                | Contenu                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `app.json`             | Nom, description, couleurs                                                          |
| `web/main.tsx`         | Les écrans, en React et classes Tailwind ; exporte le composant racine              |
| `server/index.ts`      | Les fonctions serveur : `query` pour lire, `mutation` pour modifier                 |
| `migrations/NNN_*.sql` | Le schéma de la base de l'app, appliqué une fois par fichier, dans l'ordre des noms |
| `shared/`              | Ce que les écrans et le serveur ont en commun                                       |

```ts
// server/index.ts
import { mutation, query, v } from '@socle/server';

export const list = query(({ db }) => db.all('SELECT id, label FROM items ORDER BY id'));

export const add = mutation({
  input: v.object({ label: v.string().min(1).max(80) }),
  handler: ({ db, user, notify }, { label }) => {
    db.run('INSERT INTO items (label, author) VALUES (?, ?)', label, user.id);
    notify('others', { title: `${user.name} a ajouté ${label}` });
  },
});
```

```tsx
// web/main.tsx
import { api, useQuery } from '@socle/sdk';
import { Button, List, ListItem, Page } from '@socle/ui';

export default function App() {
  const items = useQuery<{ id: number; label: string }[]>('list');
  return (
    <Page title="Courses">
      <List>
        {items.data?.map((item) => (
          <ListItem key={item.id}>{item.label}</ListItem>
        ))}
      </List>
      <Button onClick={() => api.add({ label: 'Pain' })}>Ajouter du pain</Button>
    </Page>
  );
}
```

Chaque fonction s'exécute dans une transaction sur la base de l'app : si elle échoue, rien n'est écrit. Après une
modification réussie, toutes les pages ouvertes de l'app rechargent ce qu'elles affichent. `src/demo/` est une app
complète écrite ainsi (`DEMO_APP=1`, servie sur `demo.<APPS_DOMAIN>`) : elle vérifie sur un vrai téléphone la
connexion, l'installation, les notifications et une liste partagée.

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

Le code des apps est écrit par des agents : la plateforme le traite comme hostile.

- **Deux conteneurs** : `web` détient les secrets et n'exécute jamais de code d'app. `runner` construit les apps et
  exécute leurs fonctions, sans réseau, sans secret et sans accès à la base de la plateforme.
- **Bac à sable** : les fonctions serveur tournent dans un interpréteur JavaScript compilé en WebAssembly, qui n'a ni
  fichiers, ni réseau, ni processus. Chaque appel reçoit un interpréteur neuf.
- **Une base par app** : une fonction ne peut nommer que les tables de sa propre app. Une lecture ne peut pas écrire.
- **Limites** de temps, de mémoire et de taille : un appel qui dépasse son délai est arrêté en tuant le processus qui
  l'exécute, et sa transaction est annulée.
- **Build sans installation** : le code est assemblé en mémoire à partir des fichiers envoyés ; un import de paquet
  ou de fichier extérieur est une erreur de build.

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
autorisées ; le serveur refuse de démarrer avec cette option hors de `localhost`. En développement, le serveur lance
lui-même les processus du runner.

## Déploiement

L'image `ghcr.io/tonyctalope/socle` est construite par la CI (amd64 et arm64). `compose.yaml` donne un exemple
derrière Traefik. Il faut :

1. Deux entrées DNS vers le serveur : celle du plan de contrôle et un joker `*.<APPS_DOMAIN>`.
2. Un certificat joker pour `*.<APPS_DOMAIN>` (défi DNS-01).
3. Un client OAuth Google de type « application Web », avec `<CONTROL_URL>/auth/google/callback` comme URI de
   redirection autorisée.
4. Un fichier `.env` à côté de `compose.yaml` (voir `.env.example`).
5. Les dossiers de données, créés avant le premier démarrage par l'utilisateur qui fait tourner les conteneurs
   (`SOCLE_UID`) : `mkdir -p data/apps data/run`.

`compose.yaml` démarre deux conteneurs à partir de la même image : `socle` (web) et `socle-runner`, qui n'a pas de
réseau et ne reçoit pas le fichier `.env`.

La base de la plateforme est dans `data/socle.db`, celle de chaque app dans `data/apps/<app>/live.db`. Une copie de
chacune est écrite chaque nuit (`data/backups/` et `data/apps/<app>/backups/`, 14 conservées).

## Mises à jour

- Dependabot ouvre chaque semaine une demande groupée ; les mises à jour mineures et correctives sont fusionnées
  automatiquement quand la CI passe.
- La CI reconstruit l'image chaque nuit, ce qui embarque aussi les correctifs de l'image de base.
- Le job « Known vulnerabilities » échoue dès qu'une dépendance de production a une alerte haute ou critique.
