// Demo app: checks, on a real phone, what every app gets from the platform — the
// sign-in, the home-screen install, the notifications, and server functions whose
// results stay in sync between phones.
import { useState, type FormEvent } from 'react';
import { api, install, useMe, useQuery, words } from '@socle/sdk';
import {
  Avatar,
  Button,
  Card,
  Empty,
  ErrorNote,
  Input,
  List,
  ListItem,
  LogoutButton,
  NotificationSettings,
  Page,
  Photo,
  PhotoButton,
  Spinner,
} from '@socle/ui';

const TEXT = words({
  en: {
    hello: (name: string) => `Hello ${name}`,
    signedIn: (app: string, host: string) => `You are signed in to “${app}” on ${host}.`,
    install: 'Install',
    standalone: 'The app is open from the Home Screen.',
    inBrowser: 'The app is open in the browser. To install it, choose “Add to Home Screen” in the browser menu.',
    sharedList: 'Shared list',
    sharedHelp: '{TEXT.sharedHelp}',
    placeholder: 'Bread, for instance',
    toAdd: 'To add',
    add: 'Add',
    empty: 'The list is empty',
    addPhoto: 'Add with a photo',
    photo: 'Photo',
    remove: 'Remove',
  },
  fr: {
    hello: (name: string) => `Bonjour ${name}`,
    signedIn: (app: string, host: string) => `Vous êtes connecté à « ${app} » sur ${host}.`,
    install: 'Installation',
    standalone: 'L’appli est ouverte depuis l’écran d’accueil.',
    inBrowser:
      'L’appli est ouverte dans le navigateur. Pour l’installer, choisissez « Ajouter à l’écran d’accueil » dans le menu du navigateur.',
    sharedList: 'Liste partagée',
    sharedHelp: 'Ce que vous ajoutez ici apparaît aussitôt sur les autres téléphones, qui reçoivent une notification.',
    placeholder: 'Du pain, par exemple',
    toAdd: 'À ajouter',
    add: 'Ajouter',
    empty: 'La liste est vide',
    addPhoto: 'Ajouter avec une photo',
    photo: 'Photo',
    remove: 'Supprimer',
  },
});

interface Item {
  id: number;
  label: string;
  done: number;
  author: number;
  photo: string | null;
}

function SharedList() {
  const { members } = useMe();
  const items = useQuery<Item[]>('list');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: number) => members.find((member) => member.id === id)?.name ?? '?';

  const run = (action: Promise<unknown>) => {
    setError(null);
    action.catch((failure: Error) => setError(failure.message));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return;
    run(api.add({ label }).then(() => setLabel('')));
  };

  return (
    <Card title={TEXT.sharedList}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{TEXT.sharedHelp}</p>
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={label}
            maxLength={80}
            placeholder={TEXT.placeholder}
            aria-label={TEXT.toAdd}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit">{TEXT.add}</Button>
        </form>
        {/* A photo is sent to the platform first; the item then carries its id. */}
        <PhotoButton
          onPhoto={(photo) =>
            run(api.add({ label: label.trim() || TEXT.photo, photo: photo.id }).then(() => setLabel('')))
          }
        >
          {TEXT.addPhoto}
        </PhotoButton>
        <ErrorNote>{error ?? items.error?.message}</ErrorNote>
        {items.loading ? (
          <Spinner />
        ) : !items.data?.length ? (
          <Empty title={TEXT.empty} />
        ) : (
          <List>
            {items.data.map((item) => (
              <ListItem
                key={item.id}
                end={
                  <Button
                    small
                    variant="ghost"
                    aria-label={TEXT.remove}
                    onClick={() => run(api.remove({ id: item.id }))}
                  >
                    ✕
                  </Button>
                }
              >
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5 accent-accent"
                    checked={item.done === 1}
                    onChange={() => run(api.toggle({ id: item.id }))}
                  />
                  {item.photo && <Photo id={item.photo} alt={item.label} className="size-12" />}
                  <span className={item.done ? 'text-muted line-through' : ''}>{item.label}</span>
                  <span className="ml-auto">
                    <Avatar name={nameOf(item.author)} />
                  </span>
                </label>
              </ListItem>
            ))}
          </List>
        )}
      </div>
    </Card>
  );
}

export default function App() {
  const { user, app } = useMe();
  return (
    <Page title={TEXT.hello(user.name)}>
      <p className="text-muted">{TEXT.signedIn(app.name, location.host)}</p>
      <Card title={TEXT.install}>
        <p>{install.standalone() ? TEXT.standalone : TEXT.inBrowser}</p>
      </Card>
      <NotificationSettings />
      <SharedList />
      <LogoutButton />
    </Page>
  );
}
