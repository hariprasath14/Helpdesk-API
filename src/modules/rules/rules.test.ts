import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../adapters/storage/index.js';
import { createJobQueue } from '../../jobs/queue.js';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { captureEmails, LAGGING_READER, testConfig, testDatabase } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { ticketReplyAddress } from '../email/addresses.js';
import { receiveEmail } from '../email/incoming.service.js';
import { sendTeamEmail, sendTicketEmail } from '../email/outgoing.service.js';
import { changesFrom } from './actions.js';
import { runTimeRules } from './schedule.js';
import { evaluate, type TicketFacts } from './conditions.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;
// For calling the email services directly, as the worker does.
const kitDb = testDatabase();
const kitJobs = createJobQueue(kitDb.writer);
afterAll(async () => {
  await kitJobs.stop();
  await kitDb.close();
});

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
const problems = (response: Response) =>
  Object.fromEntries(
    response
      .json<{ error: { details: { fields: { field: string; message: string }[] } } }>()
      .error.details.fields.map((item) => [item.field, item.message]),
  );

interface Rule {
  id: string;
  name: string;
  position: number;
}
interface Ticket {
  number: number;
  priority: string;
  status: string;
  team: { id: string; name: string } | null;
  assignee: { userId: string; name: string } | null;
  tags: string[];
}
interface Message {
  kind: string;
  body: string;
  author: { type: string; name: string } | null;
}

const addRule = async (member: Member, body: Record<string, unknown>) =>
  ok<Rule>(
    await post(member, '/rules', {
      event: 'ticket_created',
      conditions: { match: 'all', items: [] },
      ...body,
    }),
  );

const newTicket = async (member: Member, subject: string, email = 'neha@acme.test') =>
  ok<Ticket>(await post(member, '/tickets', { subject, contact: { name: 'Neha Iyer', email } }));

describe('rule conditions', () => {
  const facts: TicketFacts = {
    subject: 'Invoice is WRONG',
    description: 'Please check the billing.',
    status: 'open',
    priority: 'medium',
    type: null,
    source: 'email',
    teamId: null,
    assigneeUserId: 'u1',
    companyId: 'c1',
    requesterEmail: 'neha@globex.test',
    tags: ['vip', 'payroll'],
    ticketFields: { severity: 'choice-high', count: 3 },
    contactFields: { verified: true },
    companyFields: { plan: 'choice-premium', modules: ['choice-a', 'choice-b'] },
    changed: ['priority', 'tags'],
    previousStatus: 'waiting_on_customer',
    message: 'It is still BROKEN',
    createdAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-26T00:00:00Z'),
    statusChangedAt: new Date('2026-10-25T00:00:00Z'),
    now: new Date('2026-10-28T00:00:00Z'),
  };
  const check = (field: string, operator: string, value?: string | string[]) =>
    evaluate({ match: 'all', items: [{ field, operator: operator as 'is', value }] }, facts)
      .matched;

  it('compares text without case, choices by value or "none", and lists by item', () => {
    expect(check('subject', 'contains_any', ['invoice', 'refund'])).toBe(true);
    expect(check('subject_or_description', 'contains_any', ['BILLING'])).toBe(true);
    expect(check('subject', 'contains_none', ['invoice'])).toBe(false);
    expect(check('requester_email', 'contains_any', ['@globex.test'])).toBe(true);
    expect(check('subject', 'is', 'invoice is wrong')).toBe(true);
    expect(check('subject', 'is_not', 'invoice is wrong')).toBe(false);
    expect(check('description', 'is_empty')).toBe(false);
    expect(check('description', 'is_not_empty')).toBe(true);
    expect(check('team', 'is_any', ['none'])).toBe(true);
    expect(check('assignee', 'is_none', ['u1'])).toBe(false);
    expect(check('source', 'is_any', ['email', 'web_form'])).toBe(true);
    expect(check('tags', 'contains_any', ['VIP'])).toBe(true);
    expect(check('tags', 'contains_none', ['refund'])).toBe(true);
    expect(check('company.plan', 'is_any', ['choice-premium'])).toBe(true);
    expect(check('company.modules', 'contains_any', ['choice-b'])).toBe(true);
    expect(check('contact.verified', 'is_checked')).toBe(true);
    expect(check('contact.other', 'is_unchecked')).toBe(true);
    expect(check('ticket.count', 'is', '3')).toBe(true);
    expect(check('unknown.field', 'is_empty')).toBe(true);
    expect(check('changed', 'contains_any', ['priority'])).toBe(true);
    expect(check('previous_status', 'is_any', ['waiting_on_customer'])).toBe(true);
    expect(check('message', 'contains_any', ['broken'])).toBe(true);
    expect(check('hours_in_status', 'at_least', '72')).toBe(true);
    expect(check('hours_in_status', 'at_least', '73')).toBe(false);
    expect(check('hours_since_created', 'less_than', '200')).toBe(true);
    expect(check('hours_since_updated', 'less_than', '48')).toBe(false);
    expect(check('hours_since_updated', 'at_least', 'many')).toBe(false);
  });

  it('needs every condition for "all", one for "any", and none to match everything', () => {
    const items = [
      { field: 'priority', operator: 'is_any' as const, value: ['urgent'] },
      { field: 'status', operator: 'is_any' as const, value: ['open'] },
    ];
    expect(evaluate({ match: 'all', items }, facts)).toEqual({
      matched: false,
      results: [false, true],
    });
    expect(evaluate({ match: 'any', items }, facts).matched).toBe(true);
    expect(evaluate({ match: 'all', items: [] }, facts).matched).toBe(true);
  });

  it('turns actions into one change, later ones winning, tags merged', () => {
    expect(
      changesFrom(
        [
          { type: 'set_priority', value: 'low' },
          { type: 'set_priority', value: 'high' },
          { type: 'set_team', value: 'none' },
          { type: 'set_type', value: 'incident' },
          { type: 'set_assignee', value: 'u2' },
          { type: 'set_status', value: 'pending' },
          { type: 'add_tags', value: ['Billing', 'vip'] },
          { type: 'remove_tags', value: 'payroll' },
          { type: 'add_note', value: 'Checked by a rule' },
        ],
        ['vip', 'payroll'],
      ),
    ).toEqual({
      changes: {
        priority: 'high',
        teamId: null,
        type: 'incident',
        assigneeUserId: 'u2',
        status: 'pending',
        tags: ['vip', 'billing'],
      },
      notes: ['Checked by a rule'],
      emails: [],
    });
  });
});

describe('rules on new tickets', () => {
  it('routes matching tickets, adds tags and a note, and shows the rule as who did it', async () => {
    const ws = await teamWorkspace();
    const accounts = ok<{ id: string }>(await post(ws.admin, '/teams', { name: 'Accounts' }));
    await addRule(ws.admin, {
      name: 'Billing to Accounts',
      conditions: {
        match: 'any',
        items: [
          {
            field: 'subject_or_description',
            operator: 'contains_any',
            value: ['billing', 'invoice'],
          },
        ],
      },
      actions: [
        { type: 'set_team', value: accounts.id },
        { type: 'set_priority', value: 'high' },
        { type: 'add_tags', value: ['Billing'] },
        { type: 'add_note', value: 'Routed to Accounts.' },
      ],
    });

    const routed = await newTicket(ws.agent, 'Invoice amount is wrong');
    expect(routed).toMatchObject({
      team: { name: 'Accounts' },
      priority: 'high',
      tags: ['billing'],
    });
    const other = await newTicket(ws.agent, 'VPN is down');
    expect(other).toMatchObject({ team: null, priority: 'medium', tags: [] });

    const messages = ok<{ messages: Message[] }>(
      await get(ws.agent, `/tickets/${String(routed.number)}/messages`),
    ).messages;
    expect(messages).toMatchObject([
      {
        kind: 'note',
        body: 'Routed to Accounts.',
        author: { type: 'rule', name: 'Rule: Billing to Accounts' },
      },
    ]);
    const history = ok<{ activity: { actor: { name: string }; action: string }[] }>(
      await get(ws.agent, `/tickets/${String(routed.number)}/activity`),
    ).activity;
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      action: 'updated',
      actor: { name: 'Rule: Billing to Accounts' },
    });
  });

  it('runs in order, stops where a rule says so, and skips rules that are off', async () => {
    const ws = await teamWorkspace();
    const first = await addRule(ws.admin, {
      name: 'Everything is urgent',
      actions: [{ type: 'set_priority', value: 'urgent' }],
      stopAfter: true,
    });
    const second = await addRule(ws.admin, {
      name: 'Tag everything',
      actions: [{ type: 'add_tags', value: ['triage'] }],
    });
    const off = await addRule(ws.admin, {
      name: 'Never',
      enabled: false,
      actions: [{ type: 'set_priority', value: 'low' }],
    });
    expect([first.position, second.position, off.position]).toEqual([1, 2, 3]);

    expect(await newTicket(ws.agent, 'One')).toMatchObject({ priority: 'urgent', tags: [] });

    const reordered = ok<{ rules: Rule[] }>(
      await send({
        method: 'PUT',
        url: '/api/v1/rules/order',
        ...as(ws.admin),
        payload: { ruleIds: [second.id, first.id, off.id] },
      }),
    ).rules;
    expect(reordered.map((item) => item.name)).toEqual([
      'Tag everything',
      'Everything is urgent',
      'Never',
    ]);
    expect(await newTicket(ws.agent, 'Two')).toMatchObject({
      priority: 'urgent',
      tags: ['triage'],
    });

    // Missing or repeated ids mean the list changed meanwhile.
    expect(
      (
        await send({
          method: 'PUT',
          url: '/api/v1/rules/order',
          ...as(ws.admin),
          payload: { ruleIds: [second.id, first.id] },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('looks at the requester, their company and custom fields', async () => {
    const ws = await teamWorkspace();
    const senior = ok<{ id: string }>(await post(ws.admin, '/teams', { name: 'Senior agents' }));
    const plan = ok<{
      fields: { label: string; key: string; choices: { id: string; label: string }[] }[];
    }>(
      await post(ws.admin, '/custom-fields', {
        recordType: 'company',
        label: 'Plan',
        type: 'dropdown',
        choices: [{ label: 'Basic' }, { label: 'Premium' }],
      }),
    ).fields.find((field) => field.label === 'Plan') ?? { key: '', choices: [] };
    const premium = plan.choices.find((choice) => choice.label === 'Premium')?.id ?? '';
    ok(
      await post(ws.admin, '/companies', {
        name: 'Globex',
        domains: ['globex.test'],
        customFields: { [plan.key]: premium },
      }),
    );
    await addRule(ws.admin, {
      name: 'Premium to senior agents',
      conditions: {
        match: 'all',
        items: [{ field: `company.${plan.key}`, operator: 'is_any', value: [premium] }],
      },
      actions: [{ type: 'set_team', value: senior.id }],
    });
    expect(await newTicket(ws.agent, 'Help', 'raj@globex.test')).toMatchObject({
      team: { name: 'Senior agents' },
    });
    expect(await newTicket(ws.agent, 'Help', 'raj@other.test')).toMatchObject({ team: null });
  });

  it('assigns with the "assigned to you" email, and explains a change the ticket refuses', async () => {
    const ws = await teamWorkspace();
    const [workspace] = await query<{ id: string }>(
      'SELECT id FROM workspaces WHERE subdomain = :s',
      { s: ws.admin.address.split('.')[0] },
    );
    ok(
      await post(ws.admin, '/custom-fields', {
        recordType: 'ticket',
        label: 'Root cause',
        type: 'text',
        required: 'on_resolve',
      }),
    );
    await addRule(ws.admin, {
      name: 'Auto resolve',
      actions: [
        { type: 'set_assignee', value: ws.agent.userId },
        { type: 'set_status', value: 'resolved' },
      ],
    });
    const ticket = await newTicket(ws.admin, 'Password reset');
    // Resolving needs Root cause, so nothing in that change happens.
    expect(ticket).toMatchObject({ status: 'open', assignee: null });
    const notes = ok<{ messages: Message[] }>(
      await get(ws.admin, `/tickets/${String(ticket.number)}/messages`),
    ).messages;
    expect(notes[0]?.body).toBe('This rule could not change the ticket: Root cause is required.');

    await patch(ws.admin, `/rules/${(await listOf(ws.admin))[0]?.id ?? ''}`, {
      actions: [{ type: 'set_assignee', value: ws.agent.userId }],
    });
    expect(await newTicket(ws.admin, 'Another')).toMatchObject({
      assignee: { userId: ws.agent.userId },
    });
    const jobs = await query<{ data: { assignedBy: string } }>(
      "SELECT data FROM pgboss.job WHERE name = 'assignment-email' AND data->>'workspaceId' = :id",
      { id: workspace?.id },
    );
    expect(jobs.map((job) => job.data.assignedBy)).toEqual(['Rule: Auto resolve']);
  });
});

describe('assigning in turn', () => {
  it('goes round the team, skips people who are deactivated, and says when nobody can take it', async () => {
    const ws = await teamWorkspace();
    const [workspace] = await query<{ id: string }>(
      'SELECT id FROM workspaces WHERE subdomain = :s',
      { s: ws.admin.address.split('.')[0] },
    );
    const people = [ws.admin.userId, ws.supervisor.userId, ws.agent.userId];
    const support = ok<{ id: string }>(
      await post(ws.admin, '/teams', {
        name: 'Support',
        members: people.map((userId) => ({ userId })),
      }),
    );
    const empty = ok<{ id: string }>(await post(ws.admin, '/teams', { name: 'Night shift' }));
    await addRule(ws.admin, {
      name: 'Night to night shift',
      conditions: {
        match: 'all',
        items: [{ field: 'subject', operator: 'contains_any', value: ['night'] }],
      },
      actions: [{ type: 'assign_in_turn', value: empty.id }],
      stopAfter: true,
    });
    await addRule(ws.admin, {
      name: 'Everything to Support',
      actions: [{ type: 'assign_in_turn', value: support.id }],
    });

    const assignees: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const ticket = await newTicket(ws.agent, `Question ${String(n)}`);
      expect(ticket.team?.name).toBe('Support');
      assignees.push(ticket.assignee?.userId ?? '');
    }
    expect(new Set(assignees.slice(0, 3))).toEqual(new Set(people));
    expect(assignees[3]).toBe(assignees[0]);

    // Deactivated people are skipped; the others keep taking turns.
    const skipped = assignees[1] ?? '';
    await query(
      "UPDATE memberships SET status = 'deactivated' WHERE workspace_id = :w AND user_id = :u",
      {
        w: workspace?.id,
        u: skipped,
      },
    );
    const next = [];
    for (const n of [5, 6, 7]) {
      next.push((await newTicket(ws.admin, `Question ${String(n)}`)).assignee?.userId);
    }
    expect(next).not.toContain(skipped);
    expect(next[0]).toBe(assignees[2]);
    expect(next[2]).toBe(next[0]);

    const night = await newTicket(ws.admin, 'Night outage');
    expect(night).toMatchObject({ team: { name: 'Night shift' }, assignee: null });
    const notes = ok<{ messages: Message[] }>(
      await get(ws.admin, `/tickets/${String(night.number)}/messages`),
    ).messages;
    expect(notes[0]?.body).toBe(
      'Nobody in Night shift can take tickets right now, so this ticket was left unassigned.',
    );
  });

  it('lets a later "assign to" win, and needs a team', async () => {
    const ws = await teamWorkspace();
    const support = ok<{ id: string }>(
      await post(ws.admin, '/teams', { name: 'Support', members: [{ userId: ws.agent.userId }] }),
    );
    await addRule(ws.admin, {
      name: 'Support, but Ravi',
      actions: [
        { type: 'assign_in_turn', value: support.id },
        { type: 'set_assignee', value: ws.admin.userId },
      ],
    });
    expect(await newTicket(ws.agent, 'Hello')).toMatchObject({
      team: { name: 'Support' },
      assignee: { userId: ws.admin.userId },
    });
    expect(
      problems(
        await post(ws.admin, '/rules', {
          name: 'No team',
          event: 'ticket_created',
          conditions: { match: 'all', items: [] },
          actions: [{ type: 'assign_in_turn', value: 'none' }],
        }),
      ),
    ).toEqual({ 'actions.0.value': 'Choose a team.' });
  });
});

const workspaceIdOf = async (member: Member) =>
  (
    await query<{ id: string }>('SELECT id FROM workspaces WHERE subdomain = :s', {
      s: member.address.split('.')[0],
    })
  )[0]?.id ?? '';

const jobsIn = (queue: string, workspaceId: string) =>
  query<{ data: Record<string, unknown> }>(
    "SELECT data FROM pgboss.job WHERE name = :queue AND data->>'workspaceId' = :workspaceId ORDER BY created_on",
    { queue, workspaceId },
  );

describe('rules when a ticket is changed or the customer replies', () => {
  it("run after a member's change, know what changed, and are not started by rules", async () => {
    const ws = await teamWorkspace();
    const workspaceId = await workspaceIdOf(ws.admin);
    const support = ok<{ id: string }>(
      await post(ws.admin, '/teams', {
        name: 'Support',
        members: [{ userId: ws.supervisor.userId, isLead: true }],
      }),
    );
    await addRule(ws.admin, {
      name: 'Urgent alert',
      event: 'ticket_updated',
      conditions: {
        match: 'all',
        items: [
          { field: 'changed', operator: 'contains_any', value: ['priority'] },
          { field: 'priority', operator: 'is_any', value: ['urgent'] },
        ],
      },
      actions: [
        { type: 'add_tags', value: ['urgent'] },
        { type: 'set_team', value: support.id },
        { type: 'email_team', value: 'An urgent ticket needs a lead.' },
      ],
    });
    await addRule(ws.admin, {
      name: 'Back from waiting',
      event: 'ticket_updated',
      conditions: {
        match: 'all',
        items: [{ field: 'previous_status', operator: 'is_any', value: ['waiting_on_customer'] }],
      },
      actions: [{ type: 'add_tags', value: ['was-waiting'] }],
    });

    const ticket = await newTicket(ws.agent, 'Printer');
    const path = `/tickets/${String(ticket.number)}`;
    expect(ok<Ticket>(await patch(ws.agent, path, { priority: 'urgent' }))).toMatchObject({
      tags: ['urgent'],
      team: { name: 'Support' },
    });
    expect(await jobsIn('team-email', workspaceId)).toMatchObject([
      {
        data: {
          to: 'team_leads',
          ruleName: 'Urgent alert',
          text: 'An urgent ticket needs a lead.',
        },
      },
    ]);
    // The rule's own change (tags, team) does not start the rules again.
    const history = ok<{ activity: { actor: { name: string } }[] }>(
      await get(ws.agent, `${path}/activity`),
    ).activity;
    expect(history.filter((entry) => entry.actor.name === 'Rule: Urgent alert')).toHaveLength(1);

    // A reply that also sets the status is a change too, with the status it had.
    ok(await patch(ws.agent, path, { status: 'waiting_on_customer' }));
    ok(await post(ws.agent, `${path}/messages`, { kind: 'note', body: 'Asked', status: 'open' }));
    expect(ok<Ticket>(await get(ws.agent, path)).tags).toEqual(['urgent', 'was-waiting']);
  });

  it('run when the customer replies, with their message, and can email the assignee', async () => {
    const ws = await teamWorkspace();
    const workspaceId = await workspaceIdOf(ws.admin);
    await addRule(ws.admin, {
      name: 'Still broken',
      event: 'customer_replied',
      conditions: {
        match: 'all',
        items: [
          { field: 'message', operator: 'contains_any', value: ['still'] },
          { field: 'previous_status', operator: 'is_any', value: ['waiting_on_customer'] },
        ],
      },
      actions: [
        { type: 'set_priority', value: 'high' },
        { type: 'email_assignee', value: 'The customer says it is still broken.' },
      ],
    });
    const ticket = await newTicket(ws.agent, 'Login fails');
    const path = `/tickets/${String(ticket.number)}`;
    ok(
      await patch(ws.admin, path, {
        assigneeUserId: ws.agent.userId,
        status: 'waiting_on_customer',
      }),
    );
    const replyTo = ticketReplyAddress(
      testConfig(),
      { id: workspaceId, subdomain: ws.admin.address.split('.')[0] ?? '' },
      ticket.number,
    );
    const deps = {
      config: testConfig(),
      db: kitDb,
      storage: createFileStorage(testConfig()),
      jobs: kitJobs,
    };
    const raw = await new MailComposer({
      from: 'Neha Iyer <neha@acme.test>',
      to: replyTo,
      subject: 'Re: Login fails',
      text: 'It is still not working.',
      messageId: `<${String(Date.now())}@customer.test>`,
    })
      .compile()
      .build();
    expect(await receiveEmail(deps, raw)).toMatchObject({ result: 'reply' });
    expect(ok<Ticket>(await get(ws.agent, path))).toMatchObject({
      priority: 'high',
      status: 'open',
    });
    expect(await jobsIn('team-email', workspaceId)).toMatchObject([
      { data: { to: 'assignee', ruleName: 'Still broken' } },
    ]);

    // Sending: the assignee gets it; nobody fits, nothing goes.
    const emails = captureEmails();
    const outgoing = { ...deps, email: emails.sender };
    const [job] = await jobsIn('team-email', workspaceId);
    await sendTeamEmail(outgoing, job?.data as Parameters<typeof sendTeamEmail>[1]);
    expect(emails.sent).toMatchObject([
      { to: ws.agent.email, subject: `Ticket #${String(ticket.number)}: Login fails` },
    ]);
    expect(emails.sent[0]?.text).toContain('The customer says it is still broken.');
    expect(emails.sent[0]?.text).toContain('Sent by the rule "Still broken".');
    await sendTeamEmail(outgoing, {
      ...(job?.data as Parameters<typeof sendTeamEmail>[1]),
      to: 'team_leads',
    });
    expect(emails.sent).toHaveLength(1);
  });

  it('emails the requester as a reply on the ticket, signed by the workspace', async () => {
    const ws = await teamWorkspace();
    const workspaceId = await workspaceIdOf(ws.admin);
    await addRule(ws.admin, {
      name: 'Thanks',
      actions: [{ type: 'email_requester', value: 'Thanks, we are on it.' }],
    });
    const ticket = await newTicket(ws.agent, 'Hello');
    const messages = ok<{
      messages: (Message & { id: string; emailStatus: string; to: string[] })[];
    }>(await get(ws.agent, `/tickets/${String(ticket.number)}/messages`)).messages;
    expect(messages).toMatchObject([
      {
        kind: 'reply',
        body: 'Thanks, we are on it.',
        author: { type: 'rule', name: 'Rule: Thanks' },
        to: ['neha@acme.test'],
        emailStatus: 'queued',
      },
    ]);
    const emails = captureEmails();
    await sendTicketEmail(
      {
        config: testConfig(),
        db: kitDb,
        storage: createFileStorage(testConfig()),
        email: emails.sender,
      },
      { workspaceId, messageId: messages[0]?.id ?? '' },
      { retryCount: 0, retryLimit: 4 },
      { warn: () => undefined },
    );
    expect(emails.sent[0]?.messageId).toMatch(/^<.+@/);
    expect(emails.sent[0]?.text).toContain('--\nAcme Support\n');
    expect(emails.sent[0]?.text).not.toContain('Rule: Thanks');

    // A requester without an email gets a note instead.
    const phoned = ok<Ticket>(
      await post(ws.agent, '/tickets', {
        subject: 'Phoned',
        contact: { name: 'Caller', phone: '1' },
      }),
    );
    const notes = ok<{ messages: Message[] }>(
      await get(ws.agent, `/tickets/${String(phoned.number)}/messages`),
    ).messages;
    expect(notes[0]?.body).toBe(
      'This rule could not email the requester: they have no email address.',
    );
  });

  it('keeps event fields to their events', async () => {
    const ws = await teamWorkspace();
    expect(
      problems(
        await post(ws.admin, '/rules', {
          name: 'Wrong',
          event: 'ticket_created',
          conditions: {
            match: 'all',
            items: [
              { field: 'changed', operator: 'contains_any', value: ['status'] },
              { field: 'message', operator: 'contains_any', value: ['x'] },
            ],
          },
          actions: [{ type: 'email_requester', value: ' ' }],
        }),
      ),
    ).toEqual({
      'conditions.items.0.field': 'This field is only for rules that run when a ticket is changed.',
      'conditions.items.1.field':
        'This field is only for rules that run when the customer replies.',
      'actions.0.value': 'Write a message of up to 2000 characters.',
    });
  });
});

describe('rules on a schedule', () => {
  it('remind once after 3 days waiting, close after 7, and start again after a new stay', async () => {
    const ws = await teamWorkspace();
    const waiting = { field: 'status', operator: 'is_any', value: ['waiting_on_customer'] };
    const remind = await addRule(ws.admin, {
      name: 'Remind after 3 days',
      event: 'time',
      conditions: {
        match: 'all',
        items: [waiting, { field: 'hours_in_status', operator: 'at_least', value: '72' }],
      },
      actions: [{ type: 'email_requester', value: 'Do you still need help?' }],
    });
    const close = await addRule(ws.admin, {
      name: 'Close after 7 days',
      event: 'time',
      conditions: {
        match: 'all',
        items: [waiting, { field: 'hours_in_status', operator: 'at_least', value: '168' }],
      },
      actions: [{ type: 'set_status', value: 'closed' }],
    });
    const ticket = await newTicket(ws.agent, 'Payslip');
    const path = `/tickets/${String(ticket.number)}`;
    ok(await patch(ws.agent, path, { status: 'waiting_on_customer' }));
    const deps = { db: kitDb, jobs: kitJobs };
    const hoursLater = (hours: number) => new Date(Date.now() + hours * 3_600_000);
    const replies = async () =>
      ok<{ messages: Message[] }>(await get(ws.agent, `${path}/messages`)).messages.filter(
        (message) => message.kind === 'reply',
      );

    await runTimeRules(deps, hoursLater(10));
    expect(await replies()).toEqual([]);
    await runTimeRules(deps, hoursLater(73));
    await runTimeRules(deps, hoursLater(74));
    expect(await replies()).toMatchObject([
      { body: 'Do you still need help?', author: { name: 'Rule: Remind after 3 days' } },
    ]);
    expect(ok<Ticket>(await get(ws.agent, path)).status).toBe('waiting_on_customer');

    await runTimeRules(deps, hoursLater(170));
    expect(ok<Ticket>(await get(ws.agent, path)).status).toBe('closed');
    expect(await replies()).toHaveLength(1);

    // Back to waiting later: a new stay, so the reminder can come again.
    ok(await patch(ws.agent, path, { status: 'waiting_on_customer' }));
    await runTimeRules(deps, hoursLater(73));
    expect(await replies()).toHaveLength(2);

    // Turned off, they no longer run (and the test leaves nothing scheduled behind).
    for (const rule of [remind, close]) {
      await send({ method: 'DELETE', url: `/api/v1/rules/${rule.id}`, ...as(ws.admin) });
    }
  });

  it('needs a time condition, all conditions, and whole hours', async () => {
    const ws = await teamWorkspace();
    const timeRule = (conditions: Record<string, unknown>) =>
      post(ws.admin, '/rules', {
        name: 'T',
        event: 'time',
        conditions,
        actions: [{ type: 'set_priority', value: 'high' }],
      });
    const message =
      'A scheduled rule needs a time condition such as "Hours in this status is at least 72", and all its conditions must match.';
    expect(problems(await timeRule({ match: 'all', items: [] }))).toEqual({ conditions: message });
    expect(
      problems(
        await timeRule({
          match: 'any',
          items: [{ field: 'hours_in_status', operator: 'at_least', value: '24' }],
        }),
      ),
    ).toEqual({ conditions: message });
    expect(
      problems(
        await timeRule({
          match: 'all',
          items: [
            { field: 'hours_in_status', operator: 'at_least', value: '1.5' },
            { field: 'hours_since_created', operator: 'less_than', value: '9000' },
          ],
        }),
      ),
    ).toEqual({
      'conditions.items.0.value': 'Enter whole hours, from 1 to 8760 (a year).',
      'conditions.items.1.value': 'Enter whole hours, from 1 to 8760 (a year).',
    });
    expect(
      problems(
        await post(ws.admin, '/rules', {
          name: 'Created',
          event: 'ticket_created',
          conditions: {
            match: 'all',
            items: [{ field: 'hours_in_status', operator: 'at_least', value: '24' }],
          },
          actions: [{ type: 'set_priority', value: 'high' }],
        }),
      ),
    ).toEqual({
      'conditions.items.0.field': 'This field is only for rules that run on a schedule.',
    });
  });
});

const listOf = async (member: Member) => ok<{ rules: Rule[] }>(await get(member, '/rules')).rules;

describe('managing rules', () => {
  it('checks every condition and action against the workspace', async () => {
    const ws = await teamWorkspace();
    const response = await post(ws.admin, '/rules', {
      name: 'Bad',
      event: 'ticket_created',
      conditions: {
        match: 'all',
        items: [
          { field: 'mood', operator: 'is', value: 'x' },
          { field: 'priority', operator: 'contains_any', value: ['high'] },
          { field: 'priority', operator: 'is_any', value: ['huge'] },
          { field: 'subject', operator: 'contains_any', value: [] },
          { field: 'subject', operator: 'is', value: ['a', 'b'] },
          { field: 'team', operator: 'is_any', value: ['00000000-0000-4000-8000-000000000000'] },
        ],
      },
      actions: [
        { type: 'set_team', value: '00000000-0000-4000-8000-000000000000' },
        { type: 'set_assignee', value: '00000000-0000-4000-8000-000000000000' },
        { type: 'set_status', value: 'gone' },
        { type: 'add_note', value: ' ' },
        { type: 'add_tags', value: [] },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(problems(response)).toEqual({
      'conditions.items.0.field': 'This field does not exist.',
      'conditions.items.1.operator': 'This comparison does not fit the field.',
      'conditions.items.2.value': 'Choose from the list.',
      'conditions.items.3.value': 'Add at least one value.',
      'conditions.items.4.value': 'Enter one value.',
      'conditions.items.5.value': 'Choose from the list.',
      'actions.0.value': 'Choose a team.',
      'actions.1.value': 'Choose an active member.',
      'actions.2.value': 'Choose a status.',
      'actions.3.value': 'Write a note of up to 2000 characters.',
      'actions.4.value': 'Add at least one tag.',
    });
    expect(
      problems(
        await post(ws.admin, '/rules', {
          name: 'Nothing',
          event: 'ticket_created',
          conditions: { match: 'all', items: [] },
          actions: [],
        }),
      ),
    ).toEqual({ actions: 'Add at least one action.' });
  });

  it('changes, turns off and deletes rules, each audited', async () => {
    const ws = await teamWorkspace();
    const created = await addRule(ws.admin, {
      name: 'Tag VIPs',
      actions: [{ type: 'add_tags', value: ['vip'] }],
    });
    ok(await patch(ws.admin, `/rules/${created.id}`, { name: 'Tag VIP customers' }));
    ok(await patch(ws.admin, `/rules/${created.id}`, { enabled: false }));
    // The same values again change nothing and record nothing.
    ok(await patch(ws.admin, `/rules/${created.id}`, { enabled: false }));
    expect(
      (await send({ method: 'DELETE', url: `/api/v1/rules/${created.id}`, ...as(ws.admin) }))
        .statusCode,
    ).toBe(204);
    expect(await listOf(ws.admin)).toEqual([]);
    const audit = ok<{ entries: { action: string; summary: string }[] }>(
      await get(ws.admin, '/audit-log?category=settings'),
    ).entries.filter((entry) => entry.action.startsWith('rule'));
    expect(audit.map((entry) => entry.summary)).toEqual([
      'Ravi Shankar deleted the rule "Tag VIP customers".',
      'Ravi Shankar turned off the rule "Tag VIP customers".',
      'Ravi Shankar changed the rule "Tag VIP customers".',
      'Ravi Shankar added the rule "Tag VIPs".',
    ]);
  });

  it('tests conditions on a ticket without changing it', async () => {
    const ws = await teamWorkspace();
    await newTicket(ws.agent, 'Refund for invoice 42');
    expect(
      ok(
        await post(ws.admin, '/rules/test', {
          ticketNumber: 1,
          conditions: {
            match: 'all',
            items: [
              { field: 'subject', operator: 'contains_any', value: ['invoice'] },
              { field: 'priority', operator: 'is_any', value: ['urgent'] },
            ],
          },
        }),
      ),
    ).toEqual({ matched: false, results: [true, false] });
    expect(
      (
        await post(ws.admin, '/rules/test', {
          ticketNumber: 99,
          conditions: { match: 'all', items: [] },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('is for admins only, and per workspace', { timeout: 30_000 }, async () => {
    const ws = await teamWorkspace();
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      url: '/api/v1/rules',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'POST',
      url: '/api/v1/rules',
      ...as(member),
      payload: {
        name: 'R',
        event: 'ticket_created',
        conditions: { match: 'all', items: [] },
        actions: [{ type: 'set_priority', value: 'high' }],
      },
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
        const secret = await addRule(ws.admin, {
          name: 'Secret routing rule',
          actions: [{ type: 'set_priority', value: 'high' }],
        });
        return {
          secrets: ['Secret routing rule'],
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/rules' } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/rules/${secret.id}`,
                payload: { name: 'Taken' },
              },
            },
            { kind: 'item', request: { method: 'DELETE', url: `/api/v1/rules/${secret.id}` } },
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
  });

  it('answers changes from the writer', async () => {
    const ws = await teamWorkspace();
    await kit.restartApp(LAGGING_READER);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/rules',
        headers: { host: ws.admin.address, cookie: ws.admin.cookie, 'x-csrf-token': ws.admin.csrf },
        payload: {
          name: 'Lagging rule',
          event: 'ticket_created',
          conditions: { match: 'all', items: [] },
          actions: [{ type: 'set_priority', value: 'high' }],
        },
      },
      ['Lagging rule'],
    );
  });
});
