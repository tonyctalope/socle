import { words } from './boot.ts';
import { ApiError, toLogin } from './http.ts';

// Photos and documents: the platform keeps the file, the app keeps its id (in a column of
// one of its tables, sent to one of its functions like any other value).

const TEXT = words({
  en: { offline: 'No connection to the server.', failed: 'The file could not be sent.' },
  fr: { offline: 'Pas de connexion au serveur.', failed: 'Le fichier n’a pas pu être envoyé.' },
});

export interface UploadedFile {
  /** What the app stores: `files.url(id)` shows the file, a function's `files.remove(id)` deletes it. */
  id: string;
  /** Its address in this app, for an <img src> or a link. */
  url: string;
  /** What the platform recognised it as: image/jpeg, image/png, image/webp, image/gif or application/pdf. */
  type: string;
  bytes: number;
}

// A page sends its files one after the other: the platform receives few at a time, and a
// phone's connection is no faster for being shared.
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = turn.then(work, work);
  turn = mine.catch(() => {});
  return mine;
}

/** How often, and how far apart, a file is offered again to a platform that is receiving others. */
const BUSY_TRIES = 6;
const BUSY_WAIT_MS = 2000;

const send = (body: Blob): Promise<UploadedFile> => inTurn(() => sendNow(body));

async function sendNow(body: Blob): Promise<UploadedFile> {
  let response: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch('/_socle/api/files', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
        body,
      });
    } catch {
      throw new ApiError(TEXT.offline, 0, 'offline');
    }
    if (response.status !== 503 || attempt >= BUSY_TRIES) break;
    await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
  }
  if (response.status === 401) return toLogin();
  const data = (await response.json().catch(() => null)) as
    (UploadedFile & { error?: string; message?: string }) | null;
  if (!response.ok || !data) throw new ApiError(data?.message || TEXT.failed, response.status, data?.error || 'error');
  return data;
}

/** A picture drawn again no larger than `maxEdge`, as JPEG: smaller to send, and without what the camera wrote in it (place, device). */
async function shrink(picture: Blob, maxEdge: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(picture);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return picture;
    // A photo has no transparency; a drawing that has gets a white sheet behind it.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob ?? picture), 'image/jpeg', quality),
    );
  } finally {
    bitmap.close();
  }
}

export const files = {
  /** The address of a file of this app, from its id. */
  url: (id: string): string => `/_socle/files/${id}`,

  /** Sends a file as it is: a picture (JPEG, PNG, WebP, GIF) or a PDF, 8 MB at most. */
  upload: (file: Blob): Promise<UploadedFile> => send(file),

  /**
   * Sends a photo, made smaller first (1600 pixels on its longer side unless told otherwise):
   * what a phone's camera takes is far larger than a screen shows. Use it for anything picked
   * from a camera or a gallery.
   */
  async uploadImage(picture: Blob, options: { maxEdge?: number; quality?: number } = {}): Promise<UploadedFile> {
    let prepared = picture;
    try {
      prepared = await shrink(picture, options.maxEdge ?? 1600, options.quality ?? 0.85);
    } catch {
      // A picture this browser cannot draw is sent as it is: the platform says whether it keeps it.
    }
    return send(prepared);
  },
};
