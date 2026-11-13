// Live updates: every open page of an app holds one event stream, and the platform
// writes "change" on all of them after a successful mutation. Nothing about the
// change itself travels: pages simply ask again for what they show.

type Send = (event: string, data: string) => void;

interface Stream {
  userId: number;
  send: Send;
  close: () => void;
}

/** Open streams of one member on one app (tabs, phone, installed app…). */
export const MAX_STREAMS_PER_MEMBER = 8;

export class LiveHub {
  private readonly streams = new Map<string, Set<Stream>>();

  /** Null when this member already holds too many streams on this app. */
  subscribe(slug: string, userId: number, send: Send, close: () => void): (() => void) | null {
    let set = this.streams.get(slug);
    if (!set) {
      set = new Set();
      this.streams.set(slug, set);
    }
    let held = 0;
    for (const stream of set) if (stream.userId === userId) held += 1;
    if (held >= MAX_STREAMS_PER_MEMBER) return null;
    const stream: Stream = { userId, send, close };
    set.add(stream);
    return () => {
      set.delete(stream);
      if (set.size === 0) this.streams.delete(slug);
    };
  }

  publish(slug: string, event: string, data: unknown = {}): void {
    const text = JSON.stringify(data);
    for (const stream of this.streams.get(slug) ?? []) {
      try {
        stream.send(event, text);
      } catch {
        // a closed stream removes itself
      }
    }
  }

  count(slug: string): number {
    return this.streams.get(slug)?.size ?? 0;
  }

  closeAll(): void {
    for (const set of this.streams.values()) for (const stream of [...set]) stream.close();
    this.streams.clear();
  }
}
