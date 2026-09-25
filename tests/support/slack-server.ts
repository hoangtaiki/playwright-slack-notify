import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test as base } from '@playwright/test';

/**
 * A real loopback HTTP server standing in for Slack. Not a fetch
 * monkey-patch and not a mock library: this exercises the real undici fetch
 * stack in send.ts - real header parsing, real socket handling, real
 * `AbortSignal.timeout` behaviour - while staying entirely on 127.0.0.1 (no
 * network access, no DNS).
 */

export interface ScriptedResponse {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Delay before responding, for the timeout test. */
  readonly delayMs?: number;
  /** Destroy the socket instead of responding, for the network-error test. */
  readonly destroySocket?: boolean;
}

export interface ReceivedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: string;
  readonly body: unknown;
}

export interface SlackServer {
  readonly url: string;
  readonly requests: ReceivedRequest[];
  respondWith(...script: ScriptedResponse[]): void;
  reset(): void;
}

const DEFAULT_RESPONSE: ScriptedResponse = { status: 200, body: 'ok' };

function startServer(): Promise<{
  server: http.Server;
  api: SlackServer;
}> {
  let script: ScriptedResponse[] = [];
  const requests: ReceivedRequest[] = [];
  const pendingTimers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody,
        body,
      });

      const next =
        script.length > 1 ? script.shift()! : (script[0] ?? DEFAULT_RESPONSE);
      const respond = () => {
        if (next.destroySocket) {
          req.socket.destroy();
          return;
        }
        res.writeHead(next.status ?? 200, next.headers ?? {});
        res.end(next.body ?? 'ok');
      };
      if (next.delayMs) {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          respond();
        }, next.delayMs);
        pendingTimers.add(timer);
      } else {
        respond();
      }
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const api: SlackServer = {
        url: `http://127.0.0.1:${address.port}/services/T00000000/B00000000/FAKETOKEN000000000000`,
        requests,
        respondWith(...next) {
          script = next;
        },
        reset() {
          script = [];
          requests.length = 0;
        },
      };
      resolve({ server, api });
      // Expose for teardown.
      (
        server as unknown as { __pendingTimers: Set<NodeJS.Timeout> }
      ).__pendingTimers = pendingTimers;
    });
  });
}

export const test = base.extend<
  { slack: SlackServer },
  { slackWorker: { server: http.Server; api: SlackServer } }
>({
  // Worker-scoped: one server per worker process, reused across tests in
  // that worker. Bound to port 0 and read back from server.address() -
  // a hardcoded port would collide under fullyParallel workers.
  slackWorker: [
    // Playwright statically parses this parameter list at compile time, so
    // it must be a literal `{}` destructuring pattern, not a named parameter
    // - this fixture just does not depend on any other fixture.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const handle = await startServer();
      await use(handle);
      // closeAllConnections() BEFORE close() - undici's keep-alive pool
      // otherwise holds the socket open and worker teardown hangs.
      const pending = (
        handle.server as unknown as { __pendingTimers?: Set<NodeJS.Timeout> }
      ).__pendingTimers;
      if (pending) for (const t of pending) clearTimeout(t);
      handle.server.closeAllConnections();
      await new Promise<void>(resolve => handle.server.close(() => resolve()));
    },
    { scope: 'worker' },
  ],

  slack: async ({ slackWorker }, use) => {
    slackWorker.api.reset();
    await use(slackWorker.api);
    slackWorker.api.reset();
  },
});

export { expect } from '@playwright/test';
