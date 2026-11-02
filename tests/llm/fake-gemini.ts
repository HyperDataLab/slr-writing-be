import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
  rawBody: string;
}

type Reply = (res: ServerResponse, request: SeenRequest) => void;

/** A stand-in for the Gemini API on a random local port. Replies are queued; when the queue is empty the last one repeats. */
export class FakeGemini {
  readonly requests: SeenRequest[] = [];
  baseUrl = '';
  private server!: Server;
  private replies: Reply[] = [];

  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: any;
        try { body = JSON.parse(rawBody); } catch { body = undefined; }
        const seen: SeenRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, rawBody };
        this.requests.push(seen);
        const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
        if (!reply) { res.statusCode = 500; res.end('{}'); return; }
        reply(res, seen);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() { return new Promise<void>((resolve) => { this.server.closeAllConnections(); this.server.close(() => resolve()); }); }
  reset() { this.replies = []; this.requests.length = 0; }

  /** Queue replies, used in order. */
  enqueue(...replies: Reply[]) { this.replies.push(...replies); return this; }

  static json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
    return (res) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(JSON.stringify(body)); };
  }

  /** A normal answer: the model said `text`. */
  static answer(text: string, options: { finishReason?: string; usage?: Record<string, number>; parts?: unknown[] } = {}): Reply {
    return FakeGemini.json(200, {
      candidates: [{ content: { parts: options.parts ?? [{ text }] }, finishReason: options.finishReason ?? 'STOP' }],
      usageMetadata: options.usage ?? { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    });
  }

  static raw(status: number, text: string, headers: Record<string, string> = {}): Reply {
    return (res) => { res.statusCode = status; for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(text); };
  }

  static hang(): Reply { return () => { /* never answers */ }; }
  static redirect(to: string): Reply { return (res) => { res.statusCode = 302; res.setHeader('location', to); res.end(); }; }
}
