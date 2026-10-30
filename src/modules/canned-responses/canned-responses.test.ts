import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { fillPlaceholders, unknownPlaceholders } from './placeholders.js';

const kit = accountsKit();
const { send, teamWorkspace } = kit;

type Response = Awaited<ReturnType<typeof send>>;
// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });
const post = (member: Member, url: string, payload: Record<string, unknown> = {}) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
const remove = (member: Member, url: string) =>
  send({ method: 'DELETE', url: `/api/v1${url}`, ...as(member) });
const problems = (response: Response) =>
  Object.fromEntries(
    response
      .json<{ error: { details: { fields: { field: string; message: string }[] } } }>()
      .error.details.fields.map((item) => [item.field, item.message]),
  );

interface Canned {
  id: string;
  title: string;
  body: string;
  shared: boolean;
  mine: boolean;
  authorName: string;
  canEdit: boolean;
}
interface CannedList {
  cannedResponses: Canned[];
  placeholders: { key: string; label: string }[];
}

const add = async (member: Member, body: Record<string, unknown>) =>
  ok<Canned>(await post(member, '/canned-responses', body));
const listOf = async (member: Member) =>
  ok<CannedList>(await get(member, '/canned-responses')).cannedResponses;

describe('placeholders', () => {
  const facts = {
    contact: { name: 'Neha  Iyer', email: null },
    ticket: { number: 42, subject: 'Payslip missing' },
    agent: { name: 'Arun Kumar' },
    workspace: { name: 'Acme' },
  };

  it('fills the known ones, with or without spaces, and leaves the rest as typed', () => {
    expect(
      fillPlaceholders(
        'Hi {{contact.first_name}}, about #{{ ticket.number }} "{{ticket.subject}}" ({{contact.email}}). {{agent.first_name}} at {{workspace.name}} {{oops}}',
        facts,
      ),
    ).toBe('Hi Neha, about #42 "Payslip missing" (). Arun at Acme {{oops}}');
  });

  it('names the unknown ones once each', () => {
    expect(
      unknownPlaceholders('{{contact.name}} {{contact.phone}} {{ x }} {{contact.phone}}'),
    ).toEqual(['contact.phone', 'x']);
  });
});

describe('canned responses', () => {
  it('keeps personal ones to their owner and shows shared ones to everyone', async () => {
    const ws = await teamWorkspace();
    const mine = await add(ws.agent, {
      title: 'My sign-off',
      body: 'Cheers, {{agent.first_name}}',
    });
    expect(mine).toMatchObject({ shared: false, mine: true, canEdit: true });
    const shared = await add(ws.supervisor, {
      title: 'Password reset steps',
      body: 'Hi {{contact.first_name}}, open Settings → Security and choose Reset password.',
      shared: true,
    });
    expect(shared).toMatchObject({ shared: true, mine: false, canEdit: true });
    await add(ws.supervisor, { title: 'Supervisor only', body: 'Private' });

    const forAgent = ok<CannedList>(await get(ws.agent, '/canned-responses'));
    expect(forAgent.cannedResponses.map((item) => [item.title, item.canEdit])).toEqual([
      ['My sign-off', true],
      ['Password reset steps', false],
    ]);
    expect(forAgent.cannedResponses[1]?.authorName).toBe('Ravi Shankar');
    expect(forAgent.placeholders.map((item) => item.key)).toContain('contact.first_name');

    // Agents can't share, change or delete shared ones; someone else's personal one is not found.
    expect((await add(ws.agent, { title: 'T', body: 'B', shared: false })).shared).toBe(false);
    expect(
      (await post(ws.agent, '/canned-responses', { title: 'T', body: 'B', shared: true }))
        .statusCode,
    ).toBe(403);
    expect(
      (await patch(ws.agent, `/canned-responses/${shared.id}`, { title: 'Mine now' })).statusCode,
    ).toBe(403);
    expect(
      (await patch(ws.agent, `/canned-responses/${mine.id}`, { shared: true })).statusCode,
    ).toBe(403);
    expect((await remove(ws.agent, `/canned-responses/${shared.id}`)).statusCode).toBe(403);
    const hidden = (await listOf(ws.supervisor)).find((item) => item.title === 'Supervisor only');
    expect(
      (await patch(ws.agent, `/canned-responses/${hidden?.id ?? ''}`, { title: 'X' })).statusCode,
    ).toBe(404);

    // The owner changes their own; a supervisor shares it and deletes a shared one.
    expect(
      ok<Canned>(await patch(ws.agent, `/canned-responses/${mine.id}`, { title: 'Sign-off' }))
        .title,
    ).toBe('Sign-off');
    const ownBySupervisor = (await listOf(ws.supervisor)).find(
      (item) => item.title === 'Supervisor only',
    );
    expect(
      ok<Canned>(
        await patch(ws.supervisor, `/canned-responses/${ownBySupervisor?.id ?? ''}`, {
          shared: true,
        }),
      ).shared,
    ).toBe(true);
    expect((await listOf(ws.agent)).map((item) => item.title)).toContain('Supervisor only');
    expect((await remove(ws.supervisor, `/canned-responses/${shared.id}`)).statusCode).toBe(204);
    expect((await listOf(ws.agent)).map((item) => item.title)).not.toContain(
      'Password reset steps',
    );
    expect((await remove(ws.agent, `/canned-responses/${mine.id}`)).statusCode).toBe(204);
  });

  it('refuses unknown placeholders and empty text', async () => {
    const ws = await teamWorkspace();
    expect(
      problems(
        await post(ws.agent, '/canned-responses', { title: 'Bad', body: 'Call {{contact.phone}}' }),
      ),
    ).toEqual({
      body: '{{contact.phone}} is not a placeholder you can use. Pick one from the list.',
    });
    expect(problems(await post(ws.agent, '/canned-responses', { title: ' ', body: ' ' }))).toEqual({
      title: 'Enter a title.',
      body: 'Enter the text.',
    });
  });

  it('fills the placeholders for a ticket', async () => {
    const ws = await teamWorkspace();
    const ticket = ok<{ number: number }>(
      await post(ws.agent, '/tickets', {
        subject: 'Payslip missing',
        contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
      }),
    );
    const canned = await add(ws.agent, {
      title: 'Ack',
      body: 'Hi {{contact.first_name}}, we are on #{{ticket.number}} ({{ticket.subject}}). {{agent.name}}, {{workspace.name}}',
    });
    const filled = ok<{ body: string }>(
      await get(
        ws.agent,
        `/canned-responses/${canned.id}/filled?ticketNumber=${String(ticket.number)}`,
      ),
    );
    expect(filled.body).toBe(
      `Hi Neha, we are on #${String(ticket.number)} (Payslip missing). Ravi Shankar, Acme Support`,
    );
    expect(
      (await get(ws.agent, `/canned-responses/${canned.id}/filled?ticketNumber=999999`)).statusCode,
    ).toBe(404);
  });

  it('is for members who work tickets, separate per workspace, and answers from the writer', async () => {
    const ws = await teamWorkspace();
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
      url: '/api/v1/canned-responses',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor'], (member) => ({
      method: 'POST',
      url: '/api/v1/canned-responses',
      ...as(member),
      payload: { title: 'Shared', body: 'Text', shared: true },
    }));

    const intruder = await teamWorkspace();
    const byAddress = new Map([
      [ws.admin.address, ws.admin],
      [intruder.admin.address, intruder.admin],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: ws.admin.address, intruder: intruder.admin.address },
      setup: async () => {
        const secret = await add(ws.admin, {
          title: 'Secret refund wording',
          body: 'Secret text',
          shared: true,
        });
        return {
          secrets: ['Secret refund wording'],
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/canned-responses' } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/canned-responses/${secret.id}`,
                payload: { title: 'Taken' },
              },
            },
            {
              kind: 'item',
              request: { method: 'DELETE', url: `/api/v1/canned-responses/${secret.id}` },
            },
          ],
        };
      },
      actAs: (address) => {
        const member = byAddress.get(address);
        if (!member) throw new Error('unknown workspace');
        return Promise.resolve({
          headers: { host: member.address, cookie: member.cookie, 'x-csrf-token': member.csrf },
        });
      },
    });

    await kit.restartApp(LAGGING_READER);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/canned-responses',
        headers: { host: ws.agent.address, cookie: ws.agent.cookie, 'x-csrf-token': ws.agent.csrf },
        payload: { title: 'Lagging reply', body: 'Text' },
      },
      ['Lagging reply'],
    );
  });
});
