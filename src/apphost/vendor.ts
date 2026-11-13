import { createHash } from 'node:crypto';
import type { Runner } from '../runner/client.ts';

// What every app page loads from the platform (React, the SDK, the UI kit, the base
// stylesheet). The runner builds it once; this keeps it in memory with a
// fingerprint, so browsers revalidate each file with a cheap "not modified".

export interface VendorAsset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
  etag: string;
}

export class VendorCache {
  private readonly runner: Runner;
  private loading: Promise<Map<string, VendorAsset>> | undefined;

  constructor(runner: Runner) {
    this.runner = runner;
  }

  private files(): Promise<Map<string, VendorAsset>> {
    this.loading ??= this.runner.vendor().then(
      (files) => {
        const encoder = new TextEncoder();
        return new Map(
          Object.entries(files).map(([name, file]) => [
            name,
            {
              body: encoder.encode(file.text),
              type: file.type,
              etag: `"${createHash('sha256').update(file.text).digest('hex').slice(0, 20)}"`,
            },
          ]),
        );
      },
      (error: unknown) => {
        this.loading = undefined; // try again at the next request
        throw error;
      },
    );
    return this.loading;
  }

  async get(name: string): Promise<VendorAsset | undefined> {
    return (await this.files()).get(name);
  }

  /** Starts the build ahead of the first page. */
  warm(): Promise<void> {
    return this.files().then(
      () => undefined,
      () => undefined,
    );
  }
}
