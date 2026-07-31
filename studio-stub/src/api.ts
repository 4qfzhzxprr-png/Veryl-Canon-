// The app's own HTTP face, in the shape registry-stub and source-stub use.
// This is what a person (or a demonstration script) talks to; behind it, every
// question becomes one Knowledge API call to Veryl Canon carrying the app's
// passport and that person's Canon actor id.
//
// The app authenticates its own callers in a real deployment — that is
// Studio's problem, not Canon's. Here, being a test double, the caller simply
// says who they are, and the honest liberty is stated rather than hidden: an
// app that lied about who it was acting for would be lying to Canon, and
// Canon's audit log would faithfully record the lie against the app's name.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { BenefitsApp, Person } from './app.js';

interface Failure {
  status: number;
  error: string;
  message: string;
}

function fail(status: number, error: string, message: string): Failure {
  return { status, error, message };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(400, 'invalid', 'Request body must be JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function personFrom(value: unknown): Person {
  if (typeof value === 'string' && value.trim()) return { actorId: value.trim() };
  if (value && typeof value === 'object') {
    const p = value as { actorId?: unknown; name?: unknown };
    if (typeof p.actorId === 'string' && p.actorId.trim()) {
      return { actorId: p.actorId.trim(), ...(typeof p.name === 'string' ? { name: p.name } : {}) };
    }
  }
  throw fail(400, 'no_person', 'Every question is asked for someone: send "person" as a Canon actor id');
}

export function createStudioApi(app: BenefitsApp): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://studio');

      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true, product: 'Veryl Studio app', stage: 'stub', app: app.name });
        return;
      }

      // The question box. One call in, one Knowledge API call out.
      if (req.method === 'POST' && url.pathname === '/ask') {
        const body = await readBody(req);
        const person = personFrom(body.person);
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question) throw fail(400, 'no_question', 'A question is required');
        const answer = await app.answerFor(person, question, {
          collectionId: typeof body.collectionId === 'string' ? body.collectionId : undefined,
        });
        send(res, 200, answer);
        return;
      }

      // What can this app find for this person? The same three gates, listed.
      if (req.method === 'GET' && url.pathname === '/find') {
        const person = personFrom(url.searchParams.get('person'));
        const q = url.searchParams.get('q') ?? '';
        if (!q.trim()) throw fail(400, 'no_query', 'A query (q) is required');
        send(res, 200, { person, q, hits: await app.find(person, q) });
        return;
      }

      // The intersection as it stands, which is what a support call needs.
      if (req.method === 'GET' && url.pathname === '/whoami') {
        const person = personFrom(url.searchParams.get('person'));
        send(res, 200, await app.context(person));
        return;
      }

      send(res, 404, { error: 'not_found', message: `No route: ${req.method} ${url.pathname}` });
    } catch (err) {
      const failure = err as Partial<Failure>;
      if (typeof failure.status === 'number' && typeof failure.error === 'string') {
        send(res, failure.status, { error: failure.error, message: failure.message });
      } else {
        send(res, 500, { error: 'internal', message: (err as Error).message });
      }
    }
  });
}
