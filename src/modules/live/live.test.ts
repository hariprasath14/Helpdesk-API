import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { accountsKit, as, type Member } from '../../test/accounts.js';
import { testConfig, testDatabase } from '../../test/helpers.js';
import { startLive, sameOrigin, type Live } from './live.server.js';
import { sendSignal } from './signals.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;
const liveDb = testDatabase();
afterAll(async () => {
  await liveDb.close();
});

let live: Live | null = null;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await live?.close();
  live = null;
});

/** The test app listening on a free port, with live updates on it. */
async function liveServer(): Promise<string> {
  await kit.app.listen({ host: '127.0.0.1', port: 0 });
  live = await startLive(kit.app.server, { config: testConfig(), db: liveDb }, kit.app.log);
  const { port } = kit.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

/** A live connection as a member: their workspace address and their session cookie. */
function open(url: string, member: Pick<Member, 'address' | 'cookie'>, origin?: string) {
  const socket = connect(url, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: {
      host: member.address,
      cookie: member.cookie,
      ...(origin ? { origin } : {}),
    },
  });
  sockets.push(socket);
  return socket;
}

const connected = (socket: Socket) =>
  new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('connect_error', reject);
  });
const refused = (socket: Socket) =>
  new Promise<string>((resolve) => {
    socket.once('connect_error', (error) => {
      resolve(error.message);
    });
  });
const next = <T>(socket: Socket, event: string, matches: (data: T) => boolean = () => true) =>
  new Promise<T>((resolve) => {
    const handler = (data: T) => {
      if (!matches(data)) return;
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });
const watch = (socket: Socket, ticketId: string) =>
  new Promise<boolean>((resolve) => {
    socket.emit('watch', ticketId, resolve);
  });

interface Presence {
  ticketId: string;
  userId: string;
  name: string;
  typing?: string | null;
  left?: boolean;
}

const newTicket = async (member: Member, payload: Record<string, unknown> = {}) => {
  const response = await send({
    method: 'POST',
    url: '/api/v1/tickets',
    ...as(member),
    payload: {
      subject: 'Payslip missing',
      contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
      ...payload,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ id: string; number: number }>();
};

describe('live connections', () => {
  it('only lets the app’s own pages connect', () => {
    const request = (headers: Record<string, string>) =>
      ({ headers: { host: 'acme.helpdesk.test', ...headers } }) as unknown as IncomingMessage;
    expect(sameOrigin(request({}))).toBe(true);
    expect(sameOrigin(request({ origin: 'http://acme.helpdesk.test' }))).toBe(true);
    expect(sameOrigin(request({ origin: 'http://evil.example' }))).toBe(false);
    expect(sameOrigin(request({ origin: 'not a url' }))).toBe(false);
    expect(sameOrigin(request({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('needs a live session on the workspace address', async () => {
    const url = await liveServer();
    const ws = await teamWorkspace();
    expect(
      await refused(open(url, { address: ws.admin.address, cookie: 'helpdesk_session=nope' })),
    ).toBe('UNAUTHORIZED');
    const intruder = await teamWorkspace();
    expect(
      await refused(open(url, { address: ws.admin.address, cookie: intruder.admin.cookie })),
    ).toBe('UNAUTHORIZED');
    const other = open(url, ws.admin, 'http://evil.example');
    expect(await refused(other)).toBeTruthy();
  });

  it('signals new and changed tickets, open tickets and notifications', async () => {
    const url = await liveServer();
    const ws = await teamWorkspace();
    const agent = open(url, ws.agent);
    await connected(agent);

    // Every wait is set up before the change, since the signals come together.
    const created = next<{ ticketId: string; created: boolean }>(
      agent,
      'tickets',
      (data) => data.created,
    );
    const bell = next(agent, 'notifications');
    const ticket = await newTicket(ws.admin, { assigneeUserId: ws.agent.userId });
    expect(await created).toEqual({ ticketId: ticket.id, created: true });
    // Assigned to the agent: their bell updates.
    await bell;

    expect(await watch(agent, ticket.id)).toBe(true);
    const changed = next<{ ticketId: string }>(agent, 'ticket');
    const reply = await send({
      method: 'POST',
      url: `/api/v1/tickets/${String(ticket.number)}/messages`,
      ...as(ws.admin),
      payload: { kind: 'note', body: 'Checking payroll.' },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(await changed).toEqual({ ticketId: ticket.id });

    // A change saved by another process (the worker) reaches it too.
    const fromWorker = next<{ ticketId: string }>(agent, 'ticket');
    const [workspace] = await query<{ id: string }>(
      'SELECT workspace_id AS id FROM tickets WHERE id = :id',
      {
        id: ticket.id,
      },
    );
    await sendSignal(liveDb.writer, {
      type: 'ticket',
      workspaceId: workspace?.id ?? '',
      ticketId: ticket.id,
    });
    expect(await fromWorker).toEqual({ ticketId: ticket.id });

    // Another workspace's ticket cannot be watched.
    const intruder = await teamWorkspace();
    const theirs = await newTicket(intruder.admin);
    expect(await watch(agent, theirs.id)).toBe(false);
    expect(await watch(agent, 'not-an-id')).toBe(false);
  });

  it('closes on sign-out and on deactivation', async () => {
    const url = await liveServer();
    const ws = await teamWorkspace();
    const admin = open(url, ws.admin);
    const agent = open(url, ws.agent);
    await Promise.all([connected(admin), connected(agent)]);

    const agentGone = new Promise<void>((resolve) => {
      agent.once('disconnect', () => {
        resolve();
      });
    });
    const deactivated = await send({
      method: 'POST',
      url: `/api/v1/members/${ws.agent.userId}/deactivate`,
      ...as(ws.admin),
    });
    expect(deactivated.statusCode, deactivated.body).toBeLessThan(300);
    await agentGone;

    const adminGone = new Promise<void>((resolve) => {
      admin.once('disconnect', () => {
        resolve();
      });
    });
    const out = await send({ method: 'POST', url: '/api/v1/auth/logout', ...as(ws.admin) });
    expect(out.statusCode).toBeLessThan(300);
    await adminGone;
  });

  it('tells others viewing a ticket who is there and who is writing (F27)', async () => {
    const url = await liveServer();
    const ws = await teamWorkspace();
    const admin = open(url, ws.admin);
    const agent = open(url, ws.agent);
    await Promise.all([connected(admin), connected(agent)]);
    const ticket = await newTicket(ws.admin);
    const other = await newTicket(ws.admin, { subject: 'Another one' });
    expect(await watch(admin, ticket.id)).toBe(true);
    // Someone opening the ticket hears at once who is already there.
    const already = next<Presence>(agent, 'presence');
    expect(await watch(agent, ticket.id)).toBe(true);
    expect(await already).toMatchObject({
      ticketId: ticket.id,
      userId: ws.admin.userId,
      typing: null,
    });

    const heard = next<Presence>(admin, 'presence');
    agent.emit('presence', { ticketId: ticket.id, typing: 'reply' });
    expect(await heard).toEqual({
      ticketId: ticket.id,
      userId: ws.agent.userId,
      name: 'Ravi Shankar',
      typing: 'reply',
    });

    // Only for a ticket the connection watches; nobody hears about the other one.
    const stray: Presence[] = [];
    admin.on('presence', (data: Presence) => {
      stray.push(data);
    });
    agent.emit('presence', { ticketId: other.id, typing: null });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stray).toEqual([]);

    const gone = next<Presence>(admin, 'presence', (data) => data.left === true);
    agent.emit('unwatch', ticket.id);
    expect(await gone).toMatchObject({ userId: ws.agent.userId, left: true });

    expect(await watch(agent, ticket.id)).toBe(true);
    const closed = next<Presence>(admin, 'presence', (data) => data.left === true);
    agent.disconnect();
    expect(await closed).toMatchObject({ userId: ws.agent.userId, left: true });
  });
});
