// What the platform wrote into the page before the app's code runs.

export interface Member {
  id: number;
  name: string;
}

export interface Boot {
  /** Who is signed in. */
  user: Member;
  app: { slug: string; name: string };
  /** Everyone who can open this app, the signed-in user included. */
  members: Member[];
  push: { publicKey: string };
}

function read(): Boot {
  const text = document.getElementById('socle-boot')?.textContent;
  if (!text) throw new Error('socle: this page was not served by the platform');
  return JSON.parse(text) as Boot;
}

export const boot: Boot = read();
