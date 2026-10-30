import type { EmailMessage } from '../../adapters/email/index.js';
import { PRODUCT_NAME } from '../../product.js';

/**
 * The line ticket email starts with, so a customer's reply can be cut at it (F14) and only what
 * they wrote is added to the ticket.
 */
export const REPLY_ABOVE_LINE = '##- Please type your reply above this line -##';

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Plain text as HTML paragraphs: escaped, blank lines between paragraphs, line breaks kept. */
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 12px">${escapeHtml(block).replaceAll('\n', '<br>')}</p>`)
    .join('');

const formatDate = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);

/**
 * The frame of every email a customer gets (Step 5b): the reply-above line (the incoming-email
 * code cuts replies at it, F14), a top bar with the workspace's name and the ticket, the message
 * and a small footer. Inline styles and a layout table, since email apps ignore style sheets.
 */
function customerFrame(input: {
  senderName: string;
  /** Right of the name, for example "Ticket #42" or "Resolved · #42". */
  tag: string;
  /** The message, already HTML. */
  content: string;
  /** Plain text for the footer. */
  footer: string;
}): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px 12px;background:#f5f6f8;font-family:Arial,sans-serif;color:#212529;font-size:14px;line-height:1.5">
<p style="max-width:560px;margin:0 auto 8px;color:#9aa0ab;font-size:12px">${escapeHtml(REPLY_ABOVE_LINE)}</p>
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
<table role="presentation" width="100%" style="border-collapse:collapse;border-bottom:1px solid #e5e7eb"><tr>
<td style="padding:14px 24px;font-weight:bold;font-size:15px">${escapeHtml(input.senderName)}</td>
<td style="padding:14px 24px;text-align:right;color:#676d7b;font-size:12px">${escapeHtml(input.tag)}</td>
</tr></table>
<div style="padding:20px 24px">${input.content}</div>
<div style="padding:12px 24px;border-top:1px solid #e5e7eb;color:#676d7b;font-size:12px">${escapeHtml(input.footer)}</div>
</div>
</body></html>`;
}

export interface Quoted {
  author: string;
  at: Date;
  text: string;
}

export interface TicketEmailContent {
  /** What the agent wrote. */
  body: string;
  agentName: string;
  senderName: string;
  ticketNumber: number;
  timeZone: string;
  /** Earlier messages shown under the reply, newest first. */
  quoted: Quoted[];
  /** For a forward: a heading over the quoted messages. */
  forwardedHeading?: string;
  /** Files that were too large to attach. */
  notAttached: string[];
}

/** The text and HTML of a reply or forward. */
export function ticketEmailBodies(
  content: TicketEmailContent,
): Pick<EmailMessage, 'text' | 'html'> {
  const { body, agentName, senderName, ticketNumber, timeZone, quoted, notAttached } = content;
  const ref = `#${String(ticketNumber)}`;
  const quotedText = quoted
    .map(
      (item) =>
        `On ${formatDate(item.at, timeZone)}, ${item.author} wrote:\n${item.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}`,
    )
    .join('\n\n');
  const skipped =
    notAttached.length > 0
      ? `Not attached because they are too large to email: ${notAttached.join(', ')}. Ask us for them.`
      : '';
  const text = [
    REPLY_ABOVE_LINE,
    '',
    body,
    '',
    '--',
    ...(agentName === senderName ? [senderName] : [agentName, senderName]),
    ...(skipped ? ['', skipped] : []),
    ...(quotedText
      ? ['', ...(content.forwardedHeading ? [content.forwardedHeading, ''] : []), quotedText]
      : []),
    '',
    `This email is about ticket ${ref}. Reply to it to add to the ticket.`,
  ].join('\n');

  const quotedHtml = quoted
    .map(
      (item) =>
        `<p style="margin:16px 0 4px;color:#676d7b;font-size:13px">On ${escapeHtml(formatDate(item.at, timeZone))}, ${escapeHtml(item.author)} wrote:</p>
<blockquote style="margin:0;padding:0 0 0 12px;border-left:3px solid #dfe2e7;color:#4a505c">${paragraphs(item.text)}</blockquote>`,
    )
    .join('');
  const html = customerFrame({
    senderName,
    tag: `Ticket ${ref}`,
    content: `${paragraphs(body)}
<p style="margin:16px 0 0">--<br>${agentName === senderName ? '' : `${escapeHtml(agentName)}<br>`}${escapeHtml(senderName)}</p>
${skipped ? `<p style="margin:16px 0 0;color:#676d7b;font-size:13px">${escapeHtml(skipped)}</p>` : ''}
${content.forwardedHeading && quoted.length > 0 ? `<p style="margin:24px 0 0;font-weight:bold">${escapeHtml(content.forwardedHeading)}</p>` : ''}
${quotedHtml}`,
    footer: `This email is about ticket ${ref}. Reply to it to add to the ticket.`,
  });
  return { text, html };
}

/** Tells a member a ticket is now theirs (F12's "assigned to you", sent from F13). */
export function assignmentEmail(input: {
  to: string;
  name: string;
  assignedBy: string;
  workspaceName: string;
  ticketNumber: number;
  subject: string;
  link: string;
}): EmailMessage {
  const { to, name, assignedBy, workspaceName, ticketNumber, subject, link } = input;
  const ref = `#${String(ticketNumber)}`;
  return {
    to,
    subject: `Ticket ${ref} assigned to you: ${subject}`,
    text: [
      `Hi ${name},`,
      '',
      `${assignedBy} assigned you ticket ${ref} in ${workspaceName}:`,
      subject,
      '',
      link,
    ].join('\n'),
    html: `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#212529">
<div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:#002535">${escapeHtml(PRODUCT_NAME)}</p>
<p style="margin:0 0 16px">Hi ${escapeHtml(name)},</p>
<p style="margin:0 0 16px">${escapeHtml(assignedBy)} assigned you ticket <strong>${escapeHtml(ref)}</strong> in ${escapeHtml(workspaceName)}:</p>
<p style="margin:0 0 16px;font-size:16px;font-weight:bold">${escapeHtml(subject)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0c8577;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Open ticket ${escapeHtml(ref)}</a></p>
<p style="margin:24px 0 0;font-size:12px;color:#676d7b">You received this email because a ticket was assigned to you in ${PRODUCT_NAME}.</p>
</div></body></html>`,
  };
}

/** The emails a customer can get about their ticket (F15). */
export const CUSTOMER_NOTIFICATIONS = ['received', 'resolved', 'agentCreated'] as const;
export type CustomerNotification = (typeof CUSTOMER_NOTIFICATIONS)[number];
/** Emails customers get only when a member chooses to send them, not by a workspace setting. */
export type CustomerEmailEvent = CustomerNotification | 'merged';

/** The text of a customer notification: what happened, and that replying adds to the ticket. */
export function customerNotificationBodies(input: {
  event: CustomerEmailEvent;
  customerName: string;
  senderName: string;
  ticketNumber: number;
  subject: string;
  /** For agentCreated: who opened it. */
  agentName?: string | undefined;
  /** For merged (F28): the ticket that now carries the request. */
  mergedInto?: number | undefined;
}): Pick<EmailMessage, 'text' | 'html'> {
  const { event, customerName, senderName, ticketNumber, subject } = input;
  const ref = `#${String(ticketNumber)}`;
  const lines =
    event === 'received'
      ? [
          `Thanks for contacting ${senderName}. We have received your request and will get back to you soon.`,
          `Your ticket number is ${ref}: ${subject}`,
          'To add anything, reply to this email.',
        ]
      : event === 'merged'
        ? [
            `Your request ${ref} (${subject}) is now handled together with ticket #${String(input.mergedInto ?? '')}, so you get one answer.`,
            'To add anything, reply to this email.',
          ]
        : event === 'resolved'
          ? [
              `We have marked your ticket ${ref} (${subject}) as resolved.`,
              'If you still need help, reply to this email and the ticket opens again.',
            ]
          : [
              `${input.agentName ?? 'Our team'} opened ticket ${ref} for you: ${subject}`,
              'We will keep you updated here. To add anything, reply to this email.',
            ];
  const text = [
    REPLY_ABOVE_LINE,
    '',
    `Hi ${customerName},`,
    '',
    ...lines.flatMap((line) => [line, '']),
    '--',
    senderName,
  ].join('\n');
  const html = customerFrame({
    senderName,
    tag: event === 'resolved' ? `Resolved · ${ref}` : `Ticket ${ref}`,
    content: `<p style="margin:0 0 12px">Hi ${escapeHtml(customerName)},</p>
${lines.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join('\n')}
<p style="margin:16px 0 0">--<br>${escapeHtml(senderName)}</p>`,
    footer: `You get this because you contacted ${senderName}. Reply to this email to answer.`,
  });
  return { text, html };
}

/** An email to a member about a ticket (F24, SLA warnings and escalations): what happened, and a link. */
export function memberNoticeEmail(input: {
  to: string;
  name: string;
  subject: string;
  text: string;
  workspaceName: string;
  ticketNumber: number;
  ticketSubject: string;
  link: string;
}): EmailMessage {
  const { to, name, subject, text, workspaceName, ticketNumber, ticketSubject, link } = input;
  const ref = `#${String(ticketNumber)}`;
  return {
    to,
    subject,
    text: [
      `Hi ${name},`,
      '',
      text,
      '',
      `Ticket ${ref} in ${workspaceName}: ${ticketSubject}`,
      link,
    ].join('\n'),
    html: `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#212529">
<div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:#002535">${escapeHtml(PRODUCT_NAME)}</p>
<p style="margin:0 0 16px">Hi ${escapeHtml(name)},</p>
${paragraphs(text)}
<p style="margin:16px 0;font-size:16px;font-weight:bold">Ticket ${escapeHtml(ref)}: ${escapeHtml(ticketSubject)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0c8577;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Open ticket ${escapeHtml(ref)}</a></p>
<p style="margin:24px 0 0;font-size:12px;color:#676d7b">You received this email because you work tickets in ${escapeHtml(workspaceName)} on ${PRODUCT_NAME}.</p>
</div></body></html>`,
  };
}

/** A rule's email to a member about a ticket (F19): what the rule says, and a link. */
export function ruleNoticeEmail(input: {
  to: string;
  name: string;
  ruleName: string;
  text: string;
  workspaceName: string;
  ticketNumber: number;
  subject: string;
  link: string;
}): EmailMessage {
  const { to, name, ruleName, text, workspaceName, ticketNumber, subject, link } = input;
  const ref = `#${String(ticketNumber)}`;
  return {
    to,
    subject: `Ticket ${ref}: ${subject}`,
    text: [
      `Hi ${name},`,
      '',
      text,
      '',
      `Ticket ${ref} in ${workspaceName}: ${subject}`,
      link,
      '',
      `Sent by the rule "${ruleName}".`,
    ].join('\n'),
    html: `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#212529">
<div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:#002535">${escapeHtml(PRODUCT_NAME)}</p>
<p style="margin:0 0 16px">Hi ${escapeHtml(name)},</p>
${paragraphs(text)}
<p style="margin:16px 0;font-size:16px;font-weight:bold">Ticket ${escapeHtml(ref)}: ${escapeHtml(subject)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0c8577;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Open ticket ${escapeHtml(ref)}</a></p>
<p style="margin:24px 0 0;font-size:12px;color:#676d7b">Sent by the rule "${escapeHtml(ruleName)}" in ${escapeHtml(workspaceName)}.</p>
</div></body></html>`,
  };
}
