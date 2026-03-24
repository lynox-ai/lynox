import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ITrigger, TriggerCallback, HttpTriggerConfig } from '../../types/index.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB

export class HttpTrigger implements ITrigger {
  readonly type = 'http';
  private readonly port: number;
  private readonly path: string;
  private readonly hmacSecret: string | undefined;
  private server: Server | null = null;

  constructor(config: HttpTriggerConfig) {
    this.port = config.port;
    this.path = config.path ?? '/webhook';
    this.hmacSecret = config.hmacSecret;
  }

  start(callback: TriggerCallback): void {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('error', () => {
        // Ignore aborted/closed request stream errors.
      });

      if (req.url !== this.path || req.method !== 'POST') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          res.writeHead(413);
          res.end('Payload too large');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return;
        const body = Buffer.concat(chunks).toString('utf-8');

        if (this.hmacSecret) {
          const sig = req.headers['x-signature-256'] ?? req.headers['x-hub-signature-256'];
          if (!sig || typeof sig !== 'string' || !this.verifyHmac(body, sig)) {
            res.writeHead(401);
            res.end('Invalid signature');
            return;
          }
        }

        let payload: unknown;
        try {
          payload = JSON.parse(body) as unknown;
        } catch {
          payload = body;
        }

        res.writeHead(200);
        res.end('OK');

        void callback({
          source: 'http',
          payload: { body: payload, method: req.method, path: req.url },
          timestamp: new Date().toISOString(),
        }).catch(() => {
          // Ignore callback failures after the HTTP response has already been sent.
        });
      });
    });

    this.server.listen(this.port);
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private verifyHmac(body: string, signature: string): boolean {
    if (!this.hmacSecret) return false;
    const expected = 'sha256=' + createHmac('sha256', this.hmacSecret).update(body).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}
