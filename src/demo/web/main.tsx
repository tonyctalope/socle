// Demo app: checks, on a real phone, what every app gets from the platform — the
// sign-in, the home-screen install, the notifications, and server functions whose
// results stay in sync between phones.
import { useState, type FormEvent } from 'react';
import { api, install, useMe, useQuery } from '@socle/sdk';
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
  Spinner,
} from '@socle/ui';

interface Item {
  id: number;
  label: string;
  done: number;
  author: number;
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
    <Card title="Liste partagée">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Ce que tu ajoutes ici apparaît aussitôt sur les autres téléphones, qui reçoivent une notification.
        </p>
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={label}
            maxLength={80}
            placeholder="Du pain, par exemple"
            aria-label="À ajouter"
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit">Ajouter</Button>
        </form>
        <ErrorNote>{error ?? items.error?.message}</ErrorNote>
        {items.loading ? (
          <Spinner />
        ) : !items.data?.length ? (
          <Empty title="La liste est vide" />
        ) : (
          <List>
            {items.data.map((item) => (
              <ListItem
                key={item.id}
                end={
                  <Button small variant="ghost" aria-label="Supprimer" onClick={() => run(api.remove({ id: item.id }))}>
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
    <Page title={`Bonjour ${user.name}`}>
      <p className="text-muted">
        Tu es connecté à « {app.name} » sur {location.host}.
      </p>
      <Card title="Installation">
        <p>
          {install.standalone()
            ? 'L’appli est ouverte depuis l’écran d’accueil.'
            : 'L’appli est ouverte dans le navigateur. Pour l’installer, choisis « Ajouter à l’écran d’accueil » dans le menu du navigateur.'}
        </p>
      </Card>
      <NotificationSettings />
      <SharedList />
      <LogoutButton />
    </Page>
  );
}
