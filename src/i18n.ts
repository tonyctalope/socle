// The platform's own words (sign-in pages, error messages), in the language of the
// instance (APP_LOCALE). The English sentence is the key: code reads naturally, and a
// sentence without a translation is shown in English. What apps say is theirs to write.

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

export const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

/** `t('Hello {name}', { name })`: the sentence in the instance's language, with its values filled in. */
export type Translate = (text: string, values?: Record<string, string>) => string;

const FR: Record<string, string> = {
  // Control plane
  'Sign in to open your apps.': 'Connectez-vous pour ouvrir vos applis.',
  'Sign in': 'Se connecter',
  'Sign in with {name}': 'Se connecter avec {name}',
  Home: 'Accueil',
  'Hello {name}': 'Bonjour {name}',
  'No app yet.': 'Aucune appli pour l’instant.',
  'To install an app on your phone, open it, then choose “Add to Home Screen” in the browser menu.':
    'Pour installer une appli sur votre téléphone, ouvrez-la puis choisissez « Ajouter à l’écran d’accueil » dans le menu du navigateur.',
  'Sign out': 'Se déconnecter',
  'Too many attempts': 'Trop de tentatives',
  'Try again in a minute.': 'Réessayez dans une minute.',
  'Try again': 'Réessayer',
  'Sign-in unavailable': 'Connexion indisponible',
  'The sign-in service is not answering. Try again in a moment.':
    'Le service de connexion ne répond pas. Réessayez dans un instant.',
  'Sign-in cancelled': 'Connexion annulée',
  'The sign-in was cancelled.': 'La connexion a été annulée.',
  'Sign-in expired': 'Connexion expirée',
  'This sign-in attempt is no longer valid. Start again.':
    'Cette tentative de connexion n’est plus valide. Recommencez.',
  'Sign-in failed': 'Connexion impossible',
  'The answer of the sign-in service could not be verified.':
    'La réponse du service de connexion n’a pas pu être vérifiée.',
  'The sign-in service did not provide an e-mail address.': 'Le service de connexion n’a pas fourni d’adresse e-mail.',
  'Access restricted': 'Accès réservé',
  '{email} is not allowed here. Ask the administrator to add it, or sign in with another account.':
    'L’adresse {email} n’est pas autorisée ici. Demandez à l’administrateur de l’ajouter, ou connectez-vous avec un autre compte.',
  'Choose another account': 'Choisir un autre compte',
  'Invalid link': 'Lien invalide',
  'This sign-in link is incomplete.': 'Ce lien de connexion est incomplet.',
  'App not found': 'Appli introuvable',
  'This app does not exist.': 'Cette appli n’existe pas.',
  'You do not have access to {name}.': 'Vous n’avez pas accès à {name}.',
  'Too many sign-ins in progress': 'Trop de connexions en cours',
  'Page not found': 'Page introuvable',
  'This page does not exist.': 'Cette page n’existe pas.',

  // Administration
  Administration: 'Administration',
  'Only an administrator can open this page.': 'Seul un administrateur peut ouvrir cette page.',
  '{name} is published.': '{name} est publiée.',
  'The draft of {name} was discarded.': 'Le brouillon de {name} a été abandonné.',
  Published: 'Publiée',
  'Never published': 'Jamais publiée',
  'Open the draft': 'Ouvrir le brouillon',
  'No draft': 'Pas de brouillon',
  'The draft does not build:': 'Le brouillon ne se construit pas :',
  'What publishing would change': 'Ce que la publication changerait',
  'Publish the draft': 'Publier le brouillon',
  'Discard the draft': 'Abandonner le brouillon',
  'Not published': 'Non publiée',
  'Nothing changed for the members.': 'Rien n’a changé pour les membres.',

  // OAuth (MCP clients)
  'Authorize access': 'Autoriser l’accès',
  '{client} wants to use {name}': '{client} souhaite utiliser {name}',
  'An application': 'Une application',
  'You are signed in as {email}.': 'Vous êtes connecté en tant que {email}.',
  'The identity of this application is published by {host}.': 'L’identité de cette application est publiée par {host}.',
  'The application chose this name itself: nothing verifies it.':
    'L’application a choisi ce nom elle-même : rien ne le vérifie.',
  'This application did not give its name.': 'Cette application n’a pas indiqué son nom.',
  'Your answer is sent to {host}.': 'Votre réponse est envoyée à {host}.',
  'Your answer is sent to an application on this device ({host}).':
    'Votre réponse est envoyée à une application de cet appareil ({host}).',
  'Only allow this if you have just started the connection yourself, from an application on this device.':
    'N’autorisez que si vous venez de lancer la connexion vous-même, depuis une application de cet appareil.',
  Allow: 'Autoriser',
  Deny: 'Refuser',
  'Back to the application': 'Retour à l’application',
  'You are being sent back to the application.': 'Vous êtes renvoyé vers l’application.',
  Continue: 'Continuer',
  'Too many requests': 'Trop de demandes',
  'Try again in a few minutes.': 'Réessayez dans quelques minutes.',
  'Invalid request': 'Demande invalide',
  'The client_id parameter is missing.': 'Le paramètre client_id est manquant.',
  'Unknown application': 'Application inconnue',
  'This application is not recognised ({reason}).': 'Cette application n’est pas reconnue ({reason}).',
  'Return address refused': 'Adresse de retour refusée',
  'The return address does not match the application.': 'L’adresse de retour ne correspond pas à l’application.',
  'Request expired': 'Demande expirée',
  'Start the connection again from your application.': 'Relancez la connexion depuis votre application.',
  'Request refused': 'Requête refusée',
  'Session expired': 'Session expirée',
  'Sign in again, then start the connection again from your application.':
    'Reconnectez-vous, puis relancez la connexion depuis votre application.',
  'the app builder': 'l’atelier des applis',
  'It will be able to create apps and change their drafts. It cannot publish: an administrator does.':
    'Elle pourra créer des applis et modifier leurs brouillons. Elle ne peut pas publier : un administrateur s’en charge.',

  // App hosts
  'There is no app at this address.': 'Aucune appli à cette adresse.',
  'You are signed out.': 'Vous êtes déconnecté.',
  'Sign-in interrupted': 'Connexion interrompue',
  'The sign-in link expired, or cookies are blocked for this site.':
    'Le lien de connexion a expiré ou les cookies sont bloqués pour ce site.',
  'This app has no published version yet.': 'Cette appli n’a pas encore de version publiée.',
  'This app has no draft that builds yet.': 'Cette appli n’a pas encore de brouillon qui fonctionne.',
  '{name} needs JavaScript to work.': '{name} a besoin de JavaScript pour fonctionner.',
  'Sign-in required.': 'Connexion requise.',
  'Unexpected origin.': 'Origine inattendue.',
  'Too many requests.': 'Trop de requêtes.',
  'Invalid request.': 'Requête invalide.',
  'Unrecognised push subscription.': 'Abonnement push non reconnu.',
  'Too many test notifications. Try again in a minute.': 'Trop de notifications de test. Réessayez dans une minute.',
  '{name}: it works': '{name} : ça marche',
  'Notifications from this app will arrive here.': 'Les notifications de cette appli arriveront ici.',
  'Unknown function.': 'Fonction inconnue.',
  'The app ran into an error.': 'L’appli a rencontré une erreur.',
  'The app took too long to answer.': 'L’appli a mis trop de temps à répondre.',
  'The app is busy. Try again in a moment.': 'L’appli est occupée. Réessayez dans un instant.',
  'The service is temporarily unavailable.': 'Le service est momentanément indisponible.',
};

const TABLES: Record<Locale, Record<string, string> | null> = { en: null, fr: FR };

export function translator(locale: Locale): Translate {
  const table = TABLES[locale];
  return (text, values) => {
    const sentence = table?.[text] ?? text;
    if (!values) return sentence;
    return sentence.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
  };
}

/** Every sentence that has a translation, for the test that keeps the table and the code in step. */
export const translatedSentences = (locale: Locale): string[] => Object.keys(TABLES[locale] ?? {});
