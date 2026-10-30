import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/postgres-adapter';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import pg from 'pg';
import { Server, type Socket } from 'socket.io';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { hashToken } from '../../lib/tokens.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { SESSION_COOKIE, sessionStillLive } from '../accounts/sessions.js';
import { ticketModels } from '../tickets/models.js';
import { LIVE_CHANNEL, type LiveSignal } from './signals.js';

interface Deps {
  config: Config;
  db: Database;
}

/** Who a live connection belongs to, set when it connects. */
export interface LiveIdentity {
  workspaceId: string;
  userId: string;
  name: string;
  sessionId: string;
  token: string;
  tokenHash: string;
  /** What the person is writing on each ticket they have open (F27). */
  writing?: Record<string, Typing>;
}

/** How often a connection checks that its session is still live (idle timeout, expiry). */
const SESSION_CHECK_MS = 60_000;
/** Messages from the browser are tiny (which ticket is open); refuse anything bigger. */
const MAX_MESSAGE_BYTES = 10_000;
/** Presence messages from one connection are passed on at most this often (F27). */
const PRESENCE_MIN_MS = 500;
type Typing = 'reply' | 'forward' | null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const workspaceRoom = (workspaceId: string) => `workspace:${workspaceId}`;
export const memberRoom = (workspaceId: string, userId: string) =>
  `member:${workspaceId}:${userId}`;
export const ticketRoom = (ticketId: string) => `ticket:${ticketId}`;

/** One cookie's value from a Cookie header. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The connection's opening request as the sign-in check reads a request: the address it was sent
 * to (behind a trusted proxy, X-Forwarded-Host), its session cookie, a read-only method.
 */
function asSignInRequest(config: Config, request: IncomingMessage, ip: string): FastifyRequest {
  const forwarded = config.TRUST_PROXY ? request.headers['x-forwarded-host'] : undefined;
  const host = (typeof forwarded === 'string' ? forwarded : request.headers.host) ?? '';
  const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
  // requireSignedIn reads only these fields of a request.
  return {
    hostname: host.split(',')[0]?.trim().replace(/:\d+$/, '') ?? '',
    cookies: token ? { [SESSION_COOKIE]: token } : {},
    method: 'GET',
    headers: request.headers,
    ip,
  } as unknown as FastifyRequest;
}

/**
 * Connections only from the app's own pages: a browser's Origin, when it sends one, must be the
 * address the connection is made to, and cross-site requests are refused (so another site cannot
 * open a connection with the member's cookie).
 */
export function sameOrigin(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    return new URL(origin).host === (Array.isArray(host) ? host[0] : host);
  } catch {
    return false;
  }
}

function databasePool(config: Config): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
    application_name: 'helpdesk-api:live',
    ...(config.DATABASE_SSL
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(config.DATABASE_SSL_CA_FILE
              ? // The path comes from validated settings, not from user input.
                // eslint-disable-next-line security/detect-non-literal-fs-filename
                { ca: readFileSync(config.DATABASE_SSL_CA_FILE, 'utf8') }
              : {}),
          },
        }
      : {}),
  });
}

export interface Live {
  io: Server;
  close(): Promise<void>;
}

/**
 * Live updates (F26): Socket.IO on the API's own server at /socket.io. A connection is a signed-in
 * member on their workspace's address, in rooms for the workspace, the member and the tickets
 * they have open. Changes reach it as short signals ("ticket 42 changed") from PostgreSQL NOTIFY,
 * sent by the API and the worker inside the transaction of the change; the browser reloads what
 * it shows through the REST API. Several API tasks share broadcasts through the PostgreSQL
 * adapter (no Redis); each delivers signals to its own connections.
 */
export async function startLive(
  server: HttpServer,
  deps: Deps,
  log: FastifyBaseLogger,
): Promise<Live> {
  const pool = databasePool(deps.config);
  const io = new Server(server, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    allowRequest: (request, callback) => {
      callback(null, sameOrigin(request));
    },
    adapter: createAdapter(pool),
  });

  io.use((socket, next) => {
    const request = asSignInRequest(deps.config, socket.request, socket.handshake.address);
    requireSignedIn(deps.config, deps.db, request)
      .then(async (signedIn) => {
        const identity: LiveIdentity = {
          workspaceId: signedIn.workspace.id,
          userId: signedIn.user.id,
          name: signedIn.user.name,
          sessionId: signedIn.session.id,
          token: signedIn.session.token,
          tokenHash: hashToken(signedIn.session.token),
        };
        socket.data = identity;
        // In the rooms before the browser hears it is connected, so no signal falls in between.
        await socket.join([
          workspaceRoom(identity.workspaceId),
          memberRoom(identity.workspaceId, identity.userId),
        ]);
      })
      .then(
        () => {
          next();
        },
        () => {
          next(new Error('UNAUTHORIZED'));
        },
      );
  });

  io.on('connection', (socket: Socket) => {
    const me = socket.data as LiveIdentity;

    // The browser opens a ticket: its changes reach this connection. Any ticket of the
    // workspace (every member sees every ticket); others are refused.
    socket.on('watch', (ticketId: unknown, ack?: unknown) => {
      const reply = (ok: boolean) => {
        if (typeof ack === 'function') (ack as (ok: boolean) => void)(ok);
      };
      if (typeof ticketId !== 'string' || !UUID.test(ticketId)) {
        reply(false);
        return;
      }
      withWorkspace(deps.db.writer, me.workspaceId, (transaction) =>
        ticketModels(deps.db.writer).Ticket.count({ where: { id: ticketId }, transaction }),
      ).then(
        async (found) => {
          if (found === 0) {
            reply(false);
            return;
          }
          await socket.join(ticketRoom(ticketId));
          reply(true);
          // Collision detection (F27): who is already here, from every API task.
          const here = await io.in(ticketRoom(ticketId)).fetchSockets();
          const told = new Set<string>();
          for (const other of here) {
            const them = other.data as LiveIdentity;
            if (other.id === socket.id || them.userId === me.userId || told.has(them.userId)) {
              continue;
            }
            told.add(them.userId);
            socket.emit('presence', {
              ticketId,
              userId: them.userId,
              name: them.name,
              // A fixed key: the ticket id checked above.
              // eslint-disable-next-line security/detect-object-injection
              typing: them.writing?.[ticketId] ?? null,
            });
          }
        },
        (err: unknown) => {
          log.warn({ err }, 'live: could not watch a ticket');
          reply(false);
        },
      );
    });
    // Collision detection (F27): who else has the ticket open, and whether they are writing a
    // reply or forward. Only for a ticket this connection watches; the name comes from the
    // session, never from the browser. Others drop someone who stops sending this for 30 seconds.
    let lastPresence = { at: 0, typing: null as Typing };
    socket.on('presence', (input: unknown) => {
      const { ticketId, typing } = (input ?? {}) as { ticketId?: unknown; typing?: unknown };
      if (typeof ticketId !== 'string' || !socket.rooms.has(ticketRoom(ticketId))) return;
      const writing: Typing = typing === 'reply' || typing === 'forward' ? typing : null;
      const now = Date.now();
      // At most twice a second, unless what they are doing changed.
      if (writing === lastPresence.typing && now - lastPresence.at < PRESENCE_MIN_MS) return;
      lastPresence = { at: now, typing: writing };
      (socket.data as LiveIdentity).writing = { [ticketId]: writing };
      socket.to(ticketRoom(ticketId)).emit('presence', {
        ticketId,
        userId: me.userId,
        name: me.name,
        typing: writing,
      });
    });
    const left = (room: string) => {
      socket.to(room).emit('presence', {
        ticketId: room.slice('ticket:'.length),
        userId: me.userId,
        name: me.name,
        left: true,
      });
    };
    socket.on('unwatch', (ticketId: unknown) => {
      if (
        typeof ticketId === 'string' &&
        UUID.test(ticketId) &&
        socket.rooms.has(ticketRoom(ticketId))
      ) {
        left(ticketRoom(ticketId));
        void socket.leave(ticketRoom(ticketId));
      }
    });
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) if (room.startsWith('ticket:')) left(room);
    });
  });

  const local = () => [...io.of('/').sockets.values()];
  const disconnectWhere = (matches: (me: LiveIdentity) => boolean) => {
    for (const socket of local()) {
      if (matches(socket.data as LiveIdentity)) socket.disconnect(true);
    }
  };

  const deliver = (signal: LiveSignal) => {
    switch (signal.type) {
      case 'ticket':
        io.local.to(ticketRoom(signal.ticketId)).emit('ticket', { ticketId: signal.ticketId });
        io.local.to(workspaceRoom(signal.workspaceId)).emit('tickets', {
          ticketId: signal.ticketId,
          created: signal.created ?? false,
        });
        return;
      case 'notification':
        io.local.to(memberRoom(signal.workspaceId, signal.userId)).emit('notifications');
        return;
      case 'session-ended':
        disconnectWhere((me) => me.tokenHash === signal.tokenHash);
        return;
      case 'sessions-ended':
        disconnectWhere(
          (me) => me.userId === signal.userId && me.sessionId !== signal.keepSessionId,
        );
        return;
      case 'member-removed':
        disconnectWhere(
          (me) => me.workspaceId === signal.workspaceId && me.userId === signal.userId,
        );
        return;
    }
  };

  // One connection listens for change signals; it comes back if the database drops it.
  let listener: pg.PoolClient | null = null;
  let closing = false;
  const listen = async (): Promise<void> => {
    try {
      const client = await pool.connect();
      client.on('notification', (message) => {
        if (message.channel !== LIVE_CHANNEL || !message.payload) return;
        try {
          deliver(JSON.parse(message.payload) as LiveSignal);
        } catch (err) {
          log.warn({ err }, 'live: a signal could not be read');
        }
      });
      client.on('error', (err) => {
        log.warn({ err }, 'live: the signal connection failed');
        client.release(true);
        listener = null;
        if (!closing) setTimeout(() => void listen(), 5_000);
      });
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      listener = client;
    } catch (err) {
      log.warn({ err }, 'live: could not listen for signals');
      if (!closing) setTimeout(() => void listen(), 5_000);
    }
  };
  await listen();

  // Sessions also end by idling or expiring: each connection checks now and then.
  const checker = setInterval(() => {
    for (const socket of local()) {
      const me = socket.data as LiveIdentity;
      sessionStillLive(deps, me.token, me.workspaceId).then(
        (live) => {
          if (!live) socket.disconnect(true);
        },
        (err: unknown) => {
          log.warn({ err }, 'live: could not check a session');
        },
      );
    }
  }, SESSION_CHECK_MS);
  checker.unref();

  return {
    io,
    async close() {
      closing = true;
      clearInterval(checker);
      // Not io.close(): that closes the HTTP server, which Fastify closes itself.
      io.disconnectSockets(true);
      await io.of('/').adapter.close();
      io.engine.close();
      listener?.release();
      await pool.end();
    },
  };
}
