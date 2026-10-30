import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { cleanDomain, isFreeEmailDomain } from './email-domains.js';

const kit = accountsKit();
const { send, teamWorkspace, signedUpWorkspace } = kit;

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface Contact {
  id: string;
  name: string;
  email: string | null;
  otherEmails: string[];
  phone: string | null;
  jobTitle: string | null;
  company: { id: string; name: string } | null;
  note: string | null;
  customFields: Record<string, unknown>;
}
interface Company {
  id: string;
  name: string;
  domains: string[];
  contactCount: number;
  website: string | null;
}
type Response = Awaited<ReturnType<typeof send>>;
const problems = (response: Response) =>
  Object.fromEntries(
    response
      .json<{ error: { details: { fields: { field: string; message: string }[] } } }>()
      .error.details.fields.map((item) => [item.field, item.message]),
  );

async function admin(): Promise<Member> {
  const workspace = await signedUpWorkspace();
  return {
    email: workspace.body.email,
    userId: '',
    address: workspace.address,
    cookie: workspace.cookie,
    csrf: workspace.csrf,
  };
}

const post = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });

async function contact(member: Member, payload: Record<string, unknown>): Promise<Contact> {
  const response = await post(member, '/contacts', payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Contact>();
}
async function company(member: Member, payload: Record<string, unknown>): Promise<Company> {
  const response = await post(member, '/companies', payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Company>();
}
async function lastAudit(member: Member) {
  const response = await get(member, '/audit-log?category=contacts');
  return response.json<{ entries: { summary: string }[] }>().entries[0]?.summary;
}

describe('email domains', () => {
  it.each([
    ['acme.com', 'acme.com'],
    [' @Acme.COM ', 'acme.com'],
    ['https://www.acme.co.in/about', 'acme.co.in'],
    ['acme', null],
    ['-acme.com', null],
    ['acme.c0m', null],
    ['a b.com', null],
  ])('%s → %s', (typed, expected) => {
    expect(cleanDomain(typed)).toBe(expected);
  });

  it('knows free email services', () => {
    expect(isFreeEmailDomain('gmail.com')).toBe(true);
    expect(isFreeEmailDomain('yahoo.co.in')).toBe(true);
    expect(isFreeEmailDomain('acme.com')).toBe(false);
  });
});

describe('adding contacts', () => {
  it('adds a contact with a main and other emails, in lowercase', async () => {
    const owner = await admin();
    const added = await contact(owner, {
      name: '  Neha Iyer ',
      email: 'Neha@Example.org',
      otherEmails: ['neha.iyer@Personal.org'],
      phone: ' +91 98765 43210 ',
      jobTitle: 'IT manager',
      note: 'Prefers phone calls.',
    });
    expect(added).toMatchObject({
      name: 'Neha Iyer',
      email: 'neha@example.org',
      otherEmails: ['neha.iyer@personal.org'],
      phone: '+91 98765 43210',
      jobTitle: 'IT manager',
      company: null,
      note: 'Prefers phone calls.',
      customFields: {},
    });
    expect((await get(owner, `/contacts/${added.id}`)).json()).toMatchObject({ name: 'Neha Iyer' });
  });

  it('needs an email or a phone, and a main email before other emails', async () => {
    const owner = await admin();
    expect(problems(await post(owner, '/contacts', { name: 'Nobody' }))).toEqual({
      email: 'Enter an email or a phone number.',
    });
    expect(
      problems(
        await post(owner, '/contacts', { name: 'X', phone: '1', otherEmails: ['x@example.org'] }),
      ),
    ).toEqual({ email: 'Add a main email before other emails.' });
    expect((await contact(owner, { name: 'Caller', phone: '044 2345 6789' })).email).toBeNull();
    expect((await post(owner, '/contacts', { name: 'X', email: 'not-an-email' })).statusCode).toBe(
      400,
    );
  });

  it('refuses an email another contact has, naming them', async () => {
    const owner = await admin();
    await contact(owner, {
      name: 'Neha Iyer',
      email: 'neha@example.org',
      otherEmails: ['n@example.org'],
    });
    expect(
      problems(
        await post(owner, '/contacts', {
          name: 'Copy',
          email: 'NEHA@example.org',
          otherEmails: ['other@example.org', 'n@example.org', 'OTHER@example.org'],
        }),
      ),
    ).toEqual({
      email: 'This email belongs to Neha Iyer.',
      'otherEmails.1': 'This email belongs to Neha Iyer.',
      'otherEmails.2': 'This email is already listed.',
    });
  });

  it('links a new contact to the company with its email domain, never for free email', async () => {
    const owner = await admin();
    const acme = await company(owner, { name: 'Acme', domains: ['acme.com'] });
    expect((await contact(owner, { name: 'A', email: 'a@ACME.com' })).company).toEqual({
      id: acme.id,
      name: 'Acme',
    });
    expect((await contact(owner, { name: 'B', email: 'b@gmail.com' })).company).toBeNull();
    expect(
      (await contact(owner, { name: 'C', email: 'c@acme.com', companyId: null })).company,
    ).toBeNull();
    const other = await company(owner, { name: 'Other' });
    expect(
      (await contact(owner, { name: 'D', email: 'd@acme.com', companyId: other.id })).company?.name,
    ).toBe('Other');
    expect(
      problems(await post(owner, '/contacts', { name: 'E', phone: '1', companyId: UNKNOWN_ID })),
    ).toEqual({ companyId: 'This company no longer exists.' });
  });

  it('checks custom field values: defaults, required fields and unknown keys', async () => {
    const owner = await admin();
    await post(owner, '/custom-fields', {
      recordType: 'contact',
      label: 'Employee ID',
      type: 'text',
      required: 'always',
    });
    await post(owner, '/custom-fields', {
      recordType: 'contact',
      label: 'VIP',
      type: 'checkbox',
      checkboxDefault: true,
    });
    expect(
      problems(
        await post(owner, '/contacts', {
          name: 'X',
          email: 'x@example.org',
          customFields: { nope: 1 },
        }),
      ),
    ).toEqual({
      'customFields.nope': 'This field does not exist.',
      'customFields.employee_id': 'Employee ID is required.',
    });
    const added = await contact(owner, {
      name: 'X',
      email: 'x@example.org',
      customFields: { employee_id: 'E-7' },
    });
    expect(added.customFields).toEqual({ employee_id: 'E-7', vip: true });
  });

  it('returns the new contact even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await admin();
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/contacts',
        headers: { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { name: 'Lagging Lalitha', email: 'lalitha@example.org' },
      },
      ['Lagging Lalitha'],
    );
  });
});

describe('changing and deleting contacts', () => {
  it('changes only the fields given and replaces the other emails', async () => {
    const owner = await admin();
    const added = await contact(owner, {
      name: 'Neha',
      email: 'neha@example.org',
      otherEmails: ['a@example.org', 'b@example.org'],
      jobTitle: 'Manager',
    });
    const changed = (
      await patch(owner, `/contacts/${added.id}`, {
        name: 'Neha Iyer',
        otherEmails: ['b@example.org', 'c@example.org'],
        note: '',
      })
    ).json<Contact>();
    expect(changed).toMatchObject({
      name: 'Neha Iyer',
      email: 'neha@example.org',
      otherEmails: ['b@example.org', 'c@example.org'],
      jobTitle: 'Manager',
      note: null,
    });
    // The removed email is free for someone else now.
    await contact(owner, { name: 'Someone else', email: 'a@example.org' });

    const swapped = (
      await patch(owner, `/contacts/${added.id}`, {
        email: 'c@example.org',
        otherEmails: ['neha@example.org'],
      })
    ).json<Contact>();
    expect(swapped).toMatchObject({ email: 'c@example.org', otherEmails: ['neha@example.org'] });
  });

  it('refuses taken emails and a contact with neither email nor phone', async () => {
    const owner = await admin();
    await contact(owner, { name: 'Taken', email: 'taken@example.org' });
    const added = await contact(owner, { name: 'Neha', email: 'neha@example.org' });
    expect(
      problems(await patch(owner, `/contacts/${added.id}`, { email: 'taken@example.org' })),
    ).toEqual({ email: 'This email belongs to Taken.' });
    expect(problems(await patch(owner, `/contacts/${added.id}`, { email: null }))).toEqual({
      email: 'Enter an email or a phone number.',
    });
    expect((await patch(owner, `/contacts/${UNKNOWN_ID}`, { name: 'X' })).statusCode).toBe(404);
  });

  it('links a contact without a company when its new email matches a domain', async () => {
    const owner = await admin();
    const acme = await company(owner, { name: 'Acme', domains: ['acme.com'] });
    const added = await contact(owner, { name: 'Neha', email: 'neha@gmail.com' });
    const moved = (
      await patch(owner, `/contacts/${added.id}`, { email: 'neha@acme.com' })
    ).json<Contact>();
    expect(moved.company?.id).toBe(acme.id);
    const cleared = (
      await patch(owner, `/contacts/${added.id}`, { companyId: null })
    ).json<Contact>();
    expect(cleared.company).toBeNull();
  });

  it('merges custom field values and enforces required ones on edit', async () => {
    const owner = await admin();
    const added = await contact(owner, { name: 'Neha', email: 'neha@example.org' });
    await post(owner, '/custom-fields', {
      recordType: 'contact',
      label: 'Plan',
      type: 'text',
      required: 'always',
    });
    await post(owner, '/custom-fields', { recordType: 'contact', label: 'City', type: 'text' });
    expect(problems(await patch(owner, `/contacts/${added.id}`, { name: 'Neha I' }))).toEqual({
      'customFields.plan': 'Plan is required.',
    });
    await patch(owner, `/contacts/${added.id}`, { customFields: { plan: 'Pro', city: 'Pune' } });
    const changed = (
      await patch(owner, `/contacts/${added.id}`, { customFields: { city: null } })
    ).json<Contact>();
    expect(changed.customFields).toEqual({ plan: 'Pro' });
  });

  it('returns the changed contact even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await admin();
    const added = await contact(owner, { name: 'Neha', email: 'neha@example.org' });
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: `/api/v1/contacts/${added.id}`,
        headers: { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { jobTitle: 'Head of lagging' },
      },
      ['Head of lagging'],
    );
  });

  it('deletes a contact, frees its emails and records it in the audit log', async () => {
    const owner = await admin();
    const added = await contact(owner, { name: 'Neha Iyer', email: 'neha@example.org' });
    const deleted = await send({
      method: 'DELETE',
      url: `/api/v1/contacts/${added.id}`,
      ...as(owner),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await get(owner, `/contacts/${added.id}`)).statusCode).toBe(404);
    expect(await lastAudit(owner)).toBe(
      'Ravi Shankar deleted the contact Neha Iyer (neha@example.org).',
    );
    await contact(owner, { name: 'New Neha', email: 'neha@example.org' });
  });
});

describe('contact lists', () => {
  it('pages A to Z with a cursor and counts on the first page', async () => {
    const owner = await admin();
    for (const name of ['delta', 'Alpha', 'charlie', 'Bravo', 'echo']) {
      await contact(owner, { name, phone: '1' });
    }
    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : '';
      const page = (await get(owner, `/contacts?limit=2${query}`)).json<{
        contacts: Contact[];
        nextCursor: string | null;
        total: number | null;
      }>();
      if (pages === 0) expect(page.total).toBe(5);
      else expect(page.total).toBeNull();
      names.push(...page.contacts.map((item) => item.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(names).toEqual(['Alpha', 'Bravo', 'charlie', 'delta', 'echo']);
    expect(pages).toBe(3);

    const recent = (await get(owner, '/contacts?sort=updated&limit=2')).json<{
      contacts: Contact[];
      nextCursor: string;
    }>();
    expect(recent.contacts.map((item) => item.name)).toEqual(['echo', 'Bravo']);
    const next = (
      await get(owner, `/contacts?sort=updated&limit=2&cursor=${recent.nextCursor}`)
    ).json<{ contacts: Contact[] }>();
    expect(next.contacts.map((item) => item.name)).toEqual(['charlie', 'Alpha']);
    expect((await get(owner, `/contacts?cursor=${recent.nextCursor}`)).statusCode).toBe(400);
  });

  it('searches names, phones and every email, and filters by company', async () => {
    const owner = await admin();
    const acme = await company(owner, { name: 'Acme', domains: ['acme.com'] });
    await contact(owner, { name: 'Neha Iyer', email: 'neha@acme.com', phone: '98765 43210' });
    await contact(owner, {
      name: 'Arjun',
      email: 'arjun@example.org',
      otherEmails: ['boss_50@example.org'],
    });
    await contact(owner, { name: 'Sara 50', phone: '1' });
    const search = async (query: string) =>
      (await get(owner, `/contacts?${query}`))
        .json<{ contacts: Contact[] }>()
        .contacts.map((item) => item.name);

    expect(await search('q=iyer')).toEqual(['Neha Iyer']);
    expect(await search('q=43210')).toEqual(['Neha Iyer']);
    expect(await search('q=_50')).toEqual(['Arjun']);
    expect(await search('q=50')).toEqual(['Arjun', 'Sara 50']);
    expect(await search(`companyId=${acme.id}`)).toEqual(['Neha Iyer']);
  });

  it('lets every member read, add and edit contacts, and only admins and supervisors delete', async () => {
    const team = await teamWorkspace();
    const added = await contact(team.admin, { name: 'Neha', email: 'neha@example.org' });
    await expectOnlyRoles(kit, team, ['admin', 'supervisor', 'agent'], (member) => ({
      url: '/api/v1/contacts',
      ...as(member),
    }));
    await expectOnlyRoles(kit, team, ['admin', 'supervisor', 'agent'], (member) => ({
      method: 'POST',
      url: '/api/v1/contacts',
      ...as(member),
      payload: { name: 'By anyone', phone: '1' },
    }));
    await expectOnlyRoles(kit, team, ['admin', 'supervisor', 'agent'], (member) => ({
      method: 'PATCH',
      url: `/api/v1/contacts/${added.id}`,
      ...as(member),
      payload: { jobTitle: 'Changed' },
    }));
    await expectOnlyRoles(kit, team, ['admin', 'supervisor'], (member) => ({
      method: 'DELETE',
      url: `/api/v1/contacts/${UNKNOWN_ID}`,
      ...as(member),
    }));
  });

  it("never shows or changes another workspace's contacts (tenant isolation)", async () => {
    const owner = await admin();
    const intruder = await admin();
    const added = await contact(owner, { name: 'Secret Sunita', email: 'sunita@secret.org' });
    const byAddress = new Map([
      [owner.address, owner],
      [intruder.address, intruder],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: owner.address, intruder: intruder.address },
      setup: () =>
        Promise.resolve({
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/contacts?q=sunita' } },
            { kind: 'item', request: { method: 'GET', url: `/api/v1/contacts/${added.id}` } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/contacts/${added.id}`,
                payload: { jobTitle: 'x' },
              },
            },
            { kind: 'item', request: { method: 'DELETE', url: `/api/v1/contacts/${added.id}` } },
          ],
          secrets: ['Secret Sunita', 'sunita@secret.org'],
        }),
      actAs: (address) => {
        const member = byAddress.get(address);
        if (!member) throw new Error('unknown workspace');
        return Promise.resolve({
          headers: { host: member.address, cookie: member.cookie, 'x-csrf-token': member.csrf },
        });
      },
    });
    // Emails are unique per workspace only.
    await contact(intruder, { name: 'Their Sunita', email: 'sunita@secret.org' });
  });
});

describe('companies', () => {
  it('adds a company with tidied domains, refusing free email, taken domains and names', async () => {
    const owner = await admin();
    const acme = await company(owner, {
      name: 'Acme',
      domains: ['@Acme.com', 'https://www.acme.in/', 'acme.com'],
      website: 'acme.com',
    });
    expect(acme).toMatchObject({
      name: 'Acme',
      domains: ['acme.com', 'acme.in'],
      contactCount: 0,
      website: 'acme.com',
    });
    expect(
      problems(
        await post(owner, '/companies', {
          name: 'ACME',
          domains: ['gmail.com', 'acme.in', 'not a domain'],
        }),
      ),
    ).toEqual({
      'domains.0': "gmail.com is a free email service, so it can't belong to one company.",
      'domains.1': 'acme.in belongs to Acme.',
      'domains.2': 'Enter a domain like acme.com.',
      name: 'A company with this name already exists.',
    });
  });

  it('lists A to Z with contact counts, searches names and domains, and pages', async () => {
    const owner = await admin();
    const acme = await company(owner, { name: 'Acme', domains: ['acme.com'] });
    await company(owner, { name: 'beta Labs', domains: ['betalabs.io'] });
    await company(owner, { name: 'Zeta' });
    await contact(owner, { name: 'A', email: 'a@acme.com' });
    await contact(owner, { name: 'B', email: 'b@acme.com' });

    const first = (await get(owner, '/companies?limit=2')).json<{
      companies: Company[];
      nextCursor: string;
      total: number;
    }>();
    expect(first.total).toBe(3);
    expect(first.companies.map((item) => [item.name, item.contactCount])).toEqual([
      ['Acme', 2],
      ['beta Labs', 0],
    ]);
    const second = (await get(owner, `/companies?limit=2&cursor=${first.nextCursor}`)).json<{
      companies: Company[];
      nextCursor: string | null;
    }>();
    expect(second.companies.map((item) => item.name)).toEqual(['Zeta']);
    expect(second.nextCursor).toBeNull();
    const found = (await get(owner, '/companies?q=betalabs')).json<{ companies: Company[] }>();
    expect(found.companies.map((item) => item.name)).toEqual(['beta Labs']);
    expect((await get(owner, `/companies/${acme.id}`)).json()).toMatchObject({ contactCount: 2 });
  });

  it('renames (even only the case), replaces domains and checks custom fields', async () => {
    const owner = await admin();
    const acme = await company(owner, { name: 'Acme', domains: ['acme.com'] });
    await post(owner, '/custom-fields', {
      recordType: 'company',
      label: 'Tier',
      type: 'dropdown',
      choices: [{ label: 'Gold' }],
    });
    const tier = (await get(owner, '/custom-fields?recordType=company'))
      .json<{ fields: { choices: { id: string }[] }[] }>()
      .fields.at(0)?.choices[0]?.id;
    const changed = (
      await patch(owner, `/companies/${acme.id}`, {
        name: 'ACME',
        domains: ['acme.in'],
        customFields: { tier },
      })
    ).json<Company & { customFields: Record<string, unknown> }>();
    expect(changed).toMatchObject({ name: 'ACME', domains: ['acme.in'], customFields: { tier } });
    // acme.com is free again.
    await company(owner, { name: 'New Acme', domains: ['acme.com'] });
    expect(
      problems(await patch(owner, `/companies/${acme.id}`, { customFields: { tier: 'gold' } })),
    ).toEqual({ 'customFields.tier': 'Choose one of the options.' });
    expect(problems(await patch(owner, `/companies/${acme.id}`, { name: 'new acme' }))).toEqual({
      name: 'A company with this name already exists.',
    });
  });

  it('returns the new and changed company even when the reader lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await admin();
    const headers = { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf };
    const created = await expectReadAfterWrite(
      kit.app,
      { method: 'POST', url: '/api/v1/companies', headers, payload: { name: 'Lag Ltd' } },
      ['Lag Ltd'],
    );
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: `/api/v1/companies/${created.json<Company>().id}`,
        headers,
        payload: { website: 'lag.example' },
      },
      ['lag.example'],
    );
  });

  it('deletes a company, keeping its contacts without a company, and audits it', async () => {
    const owner = await admin();
    const acme = await company(owner, { name: 'Acme', domains: ['acme.com'] });
    const neha = await contact(owner, { name: 'Neha', email: 'neha@acme.com' });
    const deleted = await send({
      method: 'DELETE',
      url: `/api/v1/companies/${acme.id}`,
      ...as(owner),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await get(owner, `/contacts/${neha.id}`)).json<Contact>().company).toBeNull();
    expect(await lastAudit(owner)).toBe('Ravi Shankar deleted the company Acme.');
    expect((await get(owner, `/companies/${acme.id}`)).statusCode).toBe(404);
  });

  it('lets every member manage companies except deleting them', async () => {
    const team = await teamWorkspace();
    const acme = await company(team.admin, { name: 'Acme' });
    await expectOnlyRoles(kit, team, ['admin', 'supervisor', 'agent'], (member) => ({
      url: `/api/v1/companies/${acme.id}`,
      ...as(member),
    }));
    await expectOnlyRoles(kit, team, ['admin', 'supervisor', 'agent'], (member) => ({
      method: 'PATCH',
      url: `/api/v1/companies/${acme.id}`,
      ...as(member),
      payload: { note: 'Edited' },
    }));
    await expectOnlyRoles(kit, team, ['admin', 'supervisor', 'agent'], (member) => ({
      method: 'POST',
      url: '/api/v1/companies',
      ...as(member),
      payload: { name: `By ${member.email}` },
    }));
    await expectOnlyRoles(kit, team, ['admin', 'supervisor'], (member) => ({
      method: 'DELETE',
      url: `/api/v1/companies/${UNKNOWN_ID}`,
      ...as(member),
    }));
  });

  it("never shows or changes another workspace's companies (tenant isolation)", async () => {
    const owner = await admin();
    const intruder = await admin();
    const acme = await company(owner, { name: 'Secret Corp', domains: ['secretcorp.com'] });
    const byAddress = new Map([
      [owner.address, owner],
      [intruder.address, intruder],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: owner.address, intruder: intruder.address },
      setup: () =>
        Promise.resolve({
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/companies?q=secret' } },
            { kind: 'item', request: { method: 'GET', url: `/api/v1/companies/${acme.id}` } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/companies/${acme.id}`,
                payload: { note: 'x' },
              },
            },
            { kind: 'item', request: { method: 'DELETE', url: `/api/v1/companies/${acme.id}` } },
          ],
          secrets: ['Secret Corp', 'secretcorp.com'],
        }),
      actAs: (address) => {
        const member = byAddress.get(address);
        if (!member) throw new Error('unknown workspace');
        return Promise.resolve({
          headers: { host: member.address, cookie: member.cookie, 'x-csrf-token': member.csrf },
        });
      },
    });
    // Names and domains are unique per workspace only.
    await company(intruder, { name: 'Secret Corp', domains: ['secretcorp.com'] });
  });
});
