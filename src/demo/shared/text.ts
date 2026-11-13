// The demo speaks the language of the instance. Screens pick their words with `words()` from
// `@socle/sdk`; server functions get `locale` in their context and pick theirs here.

export const SERVER_TEXT = {
  en: {
    empty: 'Write something to add.',
    full: 'The list is full: remove a line first.',
    added: (name: string, label: string) => `${name} added “${label}”`,
    sharedList: 'Shared list of the demo',
  },
  fr: {
    empty: 'Écrivez quelque chose à ajouter.',
    full: 'La liste est pleine : supprimez une ligne d’abord.',
    added: (name: string, label: string) => `${name} a ajouté « ${label} »`,
    sharedList: 'Liste partagée de la démo',
  },
};

export const serverText = (locale: string) => (locale === 'fr' ? SERVER_TEXT.fr : SERVER_TEXT.en);
