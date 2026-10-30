import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Config } from '../../config/index.js';
import { PRODUCT_NAME } from '../../product.js';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Replaces EMAIL_FROM, for example a workspace's "Acme Support <acme@…>" (F13). */
  from?: string;
  replyTo?: string;
  cc?: string[];
  /** Threading (F13): this email's Message-ID and the ones it answers, all with angle brackets. */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: EmailAttachment[];
}

/** Every address the message goes to. */
export const recipientsOf = (message: EmailMessage) => [message.to, ...(message.cc ?? [])];

/**
 * The system sender: EMAIL_FROM as it is when it names a sender ("Support <noreply@…>"), otherwise
 * the address with the product name in front, so renaming the product renames the sender too.
 */
export const withSenderName = (from: string) =>
  from.includes('<') ? from : `"${PRODUCT_NAME.replace(/"/g, '')}" <${from.trim()}>`;

/** The message in nodemailer's shape (both adapters build the email from it). */
function mailOptions(config: Config, message: EmailMessage) {
  return {
    from: message.from ?? withSenderName(config.EMAIL_FROM),
    to: message.to,
    ...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references && message.references.length > 0
      ? { references: message.references }
      : {}),
    ...(message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
  };
}

/** The only way feature code sends email. Which service is used is a setting (EMAIL_DRIVER). */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** SMTP: Mailpit locally and on the temporary dev server (every email lands in its inbox). */
function smtpSender(config: Config): EmailSender {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    ...(config.SMTP_USER && config.SMTP_PASS
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } }
      : {}),
  });
  return {
    async send(message) {
      await transport.sendMail(mailOptions(config, message));
    },
  };
}

/** The part of the SES client the sender uses, so tests can pass a fake. */
export interface SesClient {
  send(command: SendEmailCommand): Promise<unknown>;
}

/**
 * Amazon SES (API, not SMTP): credentials come from the AWS SDK's usual sources. The email is
 * built as raw MIME, the same way as for SMTP, so threading headers and attachments go through.
 */
export function sesSender(config: Config, client: SesClient): EmailSender {
  return {
    async send(message) {
      const raw = await new MailComposer(mailOptions(config, message)).compile().build();
      await client.send(
        new SendEmailCommand({
          Destination: {
            ToAddresses: [message.to],
            ...(message.cc && message.cc.length > 0 ? { CcAddresses: message.cc } : {}),
          },
          Content: { Raw: { Data: raw } },
          ...(config.SES_CONFIGURATION_SET
            ? { ConfigurationSetName: config.SES_CONFIGURATION_SET }
            : {}),
        }),
      );
    },
  };
}

/** True when the address matches an entry: the exact address, or "@domain" for a whole domain. */
export function isAllowedRecipient(allowed: string[], address: string): boolean {
  const email = address.trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf('@'));
  return allowed.includes(email) || allowed.includes(domain);
}

/**
 * Sends through `real` only when every recipient is allowed, and otherwise through `fallback`
 * (the test mailbox). Used where the email service can reach anyone but must not (dev).
 */
export function allowListSender(
  allowed: string[],
  real: EmailSender,
  fallback: EmailSender,
): EmailSender {
  return {
    send(message) {
      return recipientsOf(message).every((address) => isAllowedRecipient(allowed, address))
        ? real.send(message)
        : fallback.send(message);
    },
  };
}

/**
 * Picks the adapter from settings: EMAIL_DRIVER, and EMAIL_ALLOWED_RECIPIENTS to keep SES to a
 * safety list (everyone else's email goes to SMTP).
 */
export function createEmailSender(config: Config): EmailSender {
  if (config.EMAIL_DRIVER === 'smtp') return smtpSender(config);
  const ses = sesSender(config, new SESv2Client({ region: config.SES_REGION }));
  return config.EMAIL_ALLOWED_RECIPIENTS?.length
    ? allowListSender(config.EMAIL_ALLOWED_RECIPIENTS, ses, smtpSender(config))
    : ses;
}
