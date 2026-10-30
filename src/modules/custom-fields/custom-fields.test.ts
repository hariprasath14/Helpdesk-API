import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { keyFromLabel } from './custom-fields.service.js';

const kit = accountsKit();
const { send, teamWorkspace, signedUpWorkspace } = kit;

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface Field {
  id: string;
  key: string;
  label: string;
  type: string;
  required: string;
  archived: boolean;
  position: number;
  helpText: string | null;
  checkboxDefault: boolean | null;
  choices: { id: string; label: string; removed: boolean; isDefault: boolean }[];
}
type Response = Awaited<ReturnType<typeof send>>;
const fieldsOf = (response: Response) => response.json<{ fields: Field[] }>().fields;
const message = (response: Response) =>
  response.json<{ error: { message: string } }>().error.message;

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

const create = (member: Member, body: Record<string, unknown>) =>
  send({ method: 'POST', url: '/api/v1/custom-fields', ...as(member), payload: body });
const update = (member: Member, id: string, body: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1/custom-fields/${id}`, ...as(member), payload: body });
const list = async (member: Member, recordType = 'ticket') =>
  fieldsOf(await send({ url: `/api/v1/custom-fields?recordType=${recordType}`, ...as(member) }));

async function lastAudit(member: Member) {
  const response = await send({ url: '/api/v1/audit-log?category=settings', ...as(member) });
  return response.json<{ entries: { summary: string }[] }>().entries[0]?.summary;
}

describe('field keys', () => {
  it.each([
    ['Employee ID', [], 'employee_id'],
    ['Contract value (₹)', [], 'contract_value'],
    ['Café Ñame', [], 'cafe_name'],
    ['123 code', [], 'field_123_code'],
    ['Employee ID', ['employee_id', 'employee_id_2'], 'employee_id_3'],
  ])('%s → %s', (label, taken, expected) => {
    expect(keyFromLabel(label, new Set(taken))).toBe(expected);
  });
});

describe('adding fields', () => {
  it('adds fields in order with a permanent key, and records it in the audit log', async () => {
    const owner = await admin();
    await create(owner, {
      recordType: 'ticket',
      label: 'Employee ID',
      type: 'text',
      required: 'always',
    });
    const response = await create(owner, {
      recordType: 'ticket',
      label: 'Employee ID',
      type: 'integer',
      helpText: '  As on the ID card  ',
    });
    expect(response.statusCode).toBe(200);
    expect(fieldsOf(response)).toMatchObject([
      { key: 'employee_id', type: 'text', required: 'always', position: 0, archived: false },
      {
        key: 'employee_id_2',
        type: 'integer',
        required: 'never',
        position: 1,
        helpText: 'As on the ID card',
      },
    ]);
    expect(await lastAudit(owner)).toBe('Ravi Shankar added the ticket field "Employee ID".');
    expect(await list(owner, 'contact')).toEqual([]);
    const contact = (
      await send({ url: '/api/v1/custom-fields?recordType=contact', ...as(owner) })
    ).json<{ standardFields: { label: string; rule: string | null }[] }>();
    expect(contact.standardFields.map((field) => field.label)).toEqual([
      'Name',
      'Email',
      'Phone',
      'Other emails',
      'Job title',
      'Company',
      'Note',
    ]);
    expect(
      response.json<{ standardFields: { label: string }[] }>().standardFields.map((f) => f.label),
    ).toEqual([
      'Requester',
      'Subject',
      'Description',
      'Status',
      'Priority',
      'Type',
      'Team',
      'Assignee',
      'Tags',
    ]);
  });

  it('needs choices for dropdowns, refuses duplicates and two defaults, and marks the default', async () => {
    const owner = await admin();
    const none = await create(owner, { recordType: 'company', label: 'Plan', type: 'dropdown' });
    expect(none.json()).toMatchObject({ error: { details: { fields: [{ field: 'choices' }] } } });
    const twice = await create(owner, {
      recordType: 'company',
      label: 'Plan',
      type: 'dropdown',
      choices: [{ label: 'Basic' }, { label: 'basic ' }],
    });
    expect(twice.json()).toMatchObject({
      error: {
        details: {
          fields: [{ field: 'choices.1', message: 'This choice is already in the list.' }],
        },
      },
    });
    const twoDefaults = await create(owner, {
      recordType: 'company',
      label: 'Plan',
      type: 'dropdown',
      choices: [
        { label: 'Basic', isDefault: true },
        { label: 'Premium', isDefault: true },
      ],
    });
    expect(twoDefaults.statusCode).toBe(400);

    const created = fieldsOf(
      await create(owner, {
        recordType: 'company',
        label: 'Plan',
        type: 'dropdown',
        choices: [{ label: 'Basic' }, { label: 'Premium', isDefault: true }],
      }),
    );
    expect(created[0]?.choices).toMatchObject([
      { label: 'Basic', isDefault: false, removed: false },
      { label: 'Premium', isDefault: true, removed: false },
    ]);
  });

  it('allows "required when resolving" for ticket fields only, and choices only for choice types', async () => {
    const owner = await admin();
    const contact = await create(owner, {
      recordType: 'contact',
      label: 'Root cause',
      type: 'text',
      required: 'on_resolve',
    });
    expect(contact.json()).toMatchObject({
      error: { details: { fields: [{ field: 'required' }] } },
    });
    const textChoices = await create(owner, {
      recordType: 'ticket',
      label: 'Root cause',
      type: 'text',
      choices: [{ label: 'A' }],
    });
    expect(textChoices.statusCode).toBe(400);
    const ticket = await create(owner, {
      recordType: 'ticket',
      label: 'Root cause',
      type: 'text',
      required: 'on_resolve',
    });
    expect(fieldsOf(ticket)[0]?.required).toBe('on_resolve');
  });

  it('stops at 50 active fields per record type', async () => {
    const owner = await admin();
    for (let n = 1; n <= 50; n += 1) {
      await create(owner, { recordType: 'contact', label: `Field ${String(n)}`, type: 'text' });
    }
    const fiftyFirst = await create(owner, {
      recordType: 'contact',
      label: 'One more',
      type: 'text',
    });
    expect(fiftyFirst.statusCode).toBe(409);
    const fields = await list(owner, 'contact');
    await send({
      method: 'POST',
      url: `/api/v1/custom-fields/${fields[0]?.id ?? ''}/archive`,
      ...as(owner),
    });
    expect(
      (await create(owner, { recordType: 'contact', label: 'One more', type: 'text' })).statusCode,
    ).toBe(200);
    const restore = await send({
      method: 'POST',
      url: `/api/v1/custom-fields/${fields[0]?.id ?? ''}/restore`,
      ...as(owner),
    });
    expect(restore.statusCode).toBe(409);
  }, 60_000);

  it('returns the new field even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await admin();
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/custom-fields',
        headers: { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { recordType: 'ticket', label: 'Lagging field', type: 'date' },
      },
      ['Lagging field'],
    );
  });
});

describe('changing fields', () => {
  it('renames without changing the key, and records the rename', async () => {
    const owner = await admin();
    const [field] = fieldsOf(
      await create(owner, { recordType: 'ticket', label: 'Emp ID', type: 'text' }),
    );
    const renamed = fieldsOf(
      await update(owner, field?.id ?? '', { label: 'Employee ID', type: 'integer', helpText: '' }),
    );
    expect(renamed[0]).toMatchObject({
      label: 'Employee ID',
      key: 'emp_id',
      type: 'text',
      helpText: null,
    });
    expect(await lastAudit(owner)).toBe(
      'Ravi Shankar renamed the ticket field "Emp ID" to "Employee ID".',
    );
  });

  it('renames, adds and removes choices, keeping removed ones for old records', async () => {
    const owner = await admin();
    const [field] = fieldsOf(
      await create(owner, {
        recordType: 'ticket',
        label: 'Plan',
        type: 'multi_select',
        choices: [{ label: 'Basic' }, { label: 'Pro' }, { label: 'Legacy', isDefault: true }],
      }),
    );
    const [basic, pro] = field?.choices ?? [];
    const changed = fieldsOf(
      await update(owner, field?.id ?? '', {
        choices: [
          { id: pro?.id, label: 'Professional', isDefault: true },
          { id: basic?.id, label: 'Basic' },
          { label: 'Enterprise', isDefault: true },
        ],
      }),
    )[0];
    expect(changed?.choices).toMatchObject([
      { label: 'Professional', removed: false, isDefault: true },
      { label: 'Basic', removed: false, isDefault: false },
      { label: 'Enterprise', removed: false, isDefault: true },
      { label: 'Legacy', removed: true, isDefault: false },
    ]);
    expect(await lastAudit(owner)).toBe('Ravi Shankar changed the ticket field "Plan" (choices).');

    const stale = await update(owner, field?.id ?? '', {
      choices: [{ id: UNKNOWN_ID, label: 'Ghost' }],
    });
    expect(stale.statusCode).toBe(400);
  });

  it('changes the required rule and a checkbox default, and refuses a default for other types', async () => {
    const owner = await admin();
    const [vip] = fieldsOf(
      await create(owner, { recordType: 'contact', label: 'VIP', type: 'checkbox' }),
    );
    expect(vip?.checkboxDefault).toBeNull();
    const changed = fieldsOf(
      await update(owner, vip?.id ?? '', { checkboxDefault: true, required: 'always' }),
    )[0];
    expect(changed).toMatchObject({ checkboxDefault: true, required: 'always' });
    const onResolve = await update(owner, vip?.id ?? '', { required: 'on_resolve' });
    expect(onResolve.statusCode).toBe(400);

    const text = fieldsOf(
      await create(owner, { recordType: 'contact', label: 'Code', type: 'text' }),
    ).find((f) => f.label === 'Code');
    expect((await update(owner, text?.id ?? '', { checkboxDefault: true })).statusCode).toBe(400);
  });

  it('archives and restores, restoring at the end, and records both', async () => {
    const owner = await admin();
    await create(owner, { recordType: 'ticket', label: 'First', type: 'text' });
    const [first] = fieldsOf(
      await create(owner, { recordType: 'ticket', label: 'Second', type: 'text' }),
    );
    const action = (id: string, verb: string) =>
      send({ method: 'POST', url: `/api/v1/custom-fields/${id}/${verb}`, ...as(owner) });

    const archived = fieldsOf(await action(first?.id ?? '', 'archive'));
    expect(archived.find((f) => f.id === first?.id)?.archived).toBe(true);
    expect(await lastAudit(owner)).toBe('Ravi Shankar archived the ticket field "First".');
    await create(owner, { recordType: 'ticket', label: 'Third', type: 'text' });

    const restored = fieldsOf(await action(first?.id ?? '', 'restore'));
    expect(restored.map((f) => f.label)).toEqual(['Second', 'Third', 'First']);
    expect(await lastAudit(owner)).toBe('Ravi Shankar restored the ticket field "First".');
    expect((await action(UNKNOWN_ID, 'archive')).statusCode).toBe(404);
  });

  it('reorders the active fields, and refuses a list that no longer matches', async () => {
    const owner = await admin();
    await create(owner, { recordType: 'ticket', label: 'A', type: 'text' });
    await create(owner, { recordType: 'ticket', label: 'B', type: 'text' });
    const fields = fieldsOf(
      await create(owner, { recordType: 'ticket', label: 'C', type: 'text' }),
    );
    const [a, b, c] = fields.map((f) => f.id);
    const order = (fieldIds: (string | undefined)[]) =>
      send({
        method: 'PUT',
        url: '/api/v1/custom-fields/order',
        ...as(owner),
        payload: { recordType: 'ticket', fieldIds },
      });

    expect(fieldsOf(await order([c, a, b])).map((f) => f.label)).toEqual(['C', 'A', 'B']);
    expect(await lastAudit(owner)).toBe('Ravi Shankar reordered the ticket fields.');
    const stale = await order([c, a]);
    expect(stale.statusCode).toBe(409);
    expect(message(stale)).toBe('The list of fields has changed. Reload and try again.');
  });
});

describe('who can see and manage fields', () => {
  it('lets every member read fields, and only admins change them', async () => {
    const team = await teamWorkspace();
    await expectOnlyRoles(kit, team, ['admin', 'supervisor', 'agent'], (member) => ({
      url: '/api/v1/custom-fields?recordType=ticket',
      ...as(member),
    }));
    const requests = [
      {
        method: 'POST',
        url: '/api/v1/custom-fields',
        payload: { recordType: 'ticket', label: 'X', type: 'text' },
      },
      { method: 'PATCH', url: `/api/v1/custom-fields/${UNKNOWN_ID}`, payload: { label: 'Y' } },
      { method: 'POST', url: `/api/v1/custom-fields/${UNKNOWN_ID}/archive` },
      { method: 'POST', url: `/api/v1/custom-fields/${UNKNOWN_ID}/restore` },
      {
        method: 'PUT',
        url: '/api/v1/custom-fields/order',
        payload: { recordType: 'ticket', fieldIds: [] },
      },
    ] as const;
    for (const request of requests) {
      await expectOnlyRoles(kit, team, ['admin'], (member) => ({ ...request, ...as(member) }));
    }
  });

  it("never shows or changes another workspace's fields (tenant isolation)", async () => {
    const owner = await admin();
    const intruder = await admin();
    const [field] = fieldsOf(
      await create(owner, { recordType: 'ticket', label: 'Secret field', type: 'text' }),
    );
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
            {
              kind: 'list',
              request: { method: 'GET', url: '/api/v1/custom-fields?recordType=ticket' },
            },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/custom-fields/${field?.id ?? ''}`,
                payload: { label: 'Secret field' },
              },
            },
            {
              kind: 'item',
              request: { method: 'POST', url: `/api/v1/custom-fields/${field?.id ?? ''}/restore` },
            },
          ],
          secrets: ['Secret field'],
        }),
      actAs: (address) => {
        const member = byAddress.get(address);
        if (!member) throw new Error('unknown workspace');
        return Promise.resolve({
          headers: { host: member.address, cookie: member.cookie, 'x-csrf-token': member.csrf },
        });
      },
    });
  });
});
