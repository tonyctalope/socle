// "@socle/ui": the components every app shares. They are styled with the platform's
// tokens (bg-card, text-muted, border-line, bg-accent…), follow light and dark mode,
// and are served once by the platform. Apps can mix them with their own Tailwind classes.
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';
import { logout, usePush, words } from '@socle/sdk';

const TEXT = words({
  en: {
    loading: 'Loading…',
    unsupported: 'This browser does not offer notifications.',
    denied: 'Notifications are blocked for this app in the browser settings.',
    off: 'Notifications are off on this device.',
    on: 'Notifications are on for this device.',
    needsInstall: 'On iPhone and iPad, notifications only work once the app is added to the Home Screen.',
    turnOn: 'Turn notifications on',
    turnOff: 'Turn notifications off',
    test: 'Send a test notification',
    signOut: 'Sign out',
  },
  fr: {
    loading: 'Chargement…',
    unsupported: 'Ce navigateur ne propose pas les notifications.',
    denied: 'Les notifications sont bloquées pour cette appli dans les réglages du navigateur.',
    off: 'Les notifications sont désactivées sur cet appareil.',
    on: 'Les notifications sont activées sur cet appareil.',
    needsInstall: 'Sur iPhone et iPad, les notifications ne marchent qu’une fois l’appli ajoutée à l’écran d’accueil.',
    turnOn: 'Activer les notifications',
    turnOff: 'Désactiver les notifications',
    test: 'Envoyer une notification de test',
    signOut: 'Se déconnecter',
  },
});

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** A screen: a title bar that stays on top, then the content in a readable column. */
export function Page(props: { title: ReactNode; back?: () => void; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        {props.back && (
          <button
            type="button"
            aria-label="Retour"
            onClick={props.back}
            className="-ml-2 rounded-lg px-2 py-1 text-2xl leading-none text-accent"
          >
            ‹
          </button>
        )}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{props.title}</h1>
        {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
      </header>
      <main className="flex flex-1 flex-col gap-4 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
        {props.children}
      </main>
    </div>
  );
}

export function Card(props: { title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-card p-4', props.className)}>
      {props.title && <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{props.title}</h2>}
      {props.children}
    </section>
  );
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-accent-ink',
  secondary: 'border border-line bg-card text-ink',
  danger: 'bg-danger text-white',
  ghost: 'text-accent',
};

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS; small?: boolean },
) {
  const { variant = 'primary', small, className, type, ...rest } = props;
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition active:opacity-70 disabled:opacity-50',
        small ? 'px-3 py-1.5 text-sm' : 'min-h-11 px-4 py-2.5',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}

/** A label above a form control, with an optional hint or error below. */
export function Field(props: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{props.label}</span>
      {props.children}
      {props.error ? (
        <span className="text-sm text-danger">{props.error}</span>
      ) : (
        props.hint && <span className="text-sm text-muted">{props.hint}</span>
      )}
    </label>
  );
}

const CONTROL =
  'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-base text-ink placeholder:text-muted disabled:opacity-50';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input className={cx(CONTROL, className)} {...rest} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, rows, ...rest } = props;
  return <textarea rows={rows ?? 3} className={cx(CONTROL, className)} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select className={cx(CONTROL, className)} {...rest} />;
}

export function Checkbox(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  const { label, className, id, ...rest } = props;
  const generated = useId();
  return (
    <label htmlFor={id ?? generated} className={cx('flex min-h-11 items-center gap-3', className)}>
      <input id={id ?? generated} type="checkbox" className="size-5 accent-accent" {...rest} />
      <span>{label}</span>
    </label>
  );
}

/** A list of rows inside one card. */
export function List(props: { children?: ReactNode; className?: string }) {
  return (
    <ul className={cx('divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card', props.className)}>
      {props.children}
    </ul>
  );
}

export function ListItem(props: {
  children?: ReactNode;
  /** Shown at the end of the row: an amount, a badge, a button… */
  end?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const content = (
    <>
      <div className="min-w-0 flex-1">{props.children}</div>
      {props.end && <div className="shrink-0">{props.end}</div>}
    </>
  );
  return (
    <li className={props.className}>
      {props.onClick ? (
        <button
          type="button"
          onClick={props.onClick}
          className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-line/40"
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3">{content}</div>
      )}
    </li>
  );
}

const BADGE_TONES = {
  neutral: 'bg-line/60 text-ink',
  accent: 'bg-accent/15 text-accent',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
};

export function Badge(props: { children?: ReactNode; tone?: keyof typeof BADGE_TONES }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        BADGE_TONES[props.tone ?? 'neutral'],
      )}
    >
      {props.children}
    </span>
  );
}

/** What a list shows when there is nothing in it yet. */
export function Empty(props: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-2xl border border-dashed border-line px-4 py-10 text-center">
      <p className="font-medium">{props.title}</p>
      {props.children && <div className="text-sm text-muted">{props.children}</div>}
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-8 text-muted">
      <span className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" />
      <span>{props.label ?? TEXT.loading}</span>
    </div>
  );
}

/** A message about something that went wrong, e.g. the `error` of useQuery. */
export function ErrorNote(props: { children?: ReactNode }) {
  if (!props.children) return null;
  return (
    <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      {props.children}
    </p>
  );
}

/** A member's initials in a circle. */
export function Avatar(props: { name: string }) {
  const initials = props.name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
      {initials}
    </span>
  );
}

/** Ready-made settings block: turn this app's notifications on or off on this device, and try one. */
export function NotificationSettings() {
  const { state, needsInstall, busy, error, toggle, test } = usePush();
  if (state === null) return null;
  return (
    <Card title="Notifications">
      <div className="flex flex-col gap-3">
        <p>{needsInstall ? TEXT.needsInstall : TEXT[state]}</p>
        {(state === 'on' || state === 'off') && (
          <Button onClick={() => void toggle()} disabled={busy} variant={state === 'on' ? 'secondary' : 'primary'}>
            {state === 'on' ? TEXT.turnOff : TEXT.turnOn}
          </Button>
        )}
        {state === 'on' && (
          <Button variant="ghost" disabled={busy} onClick={() => void test()}>
            {TEXT.test}
          </Button>
        )}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Card>
  );
}

export function LogoutButton(props: { className?: string }) {
  return (
    <Button variant="ghost" className={props.className} onClick={() => void logout()}>
      {TEXT.signOut}
    </Button>
  );
}
