import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../test/helpers.js';
import {
  allowListSender,
  createEmailSender,
  isAllowedRecipient,
  sesSender,
  withSenderName,
  type EmailMessage,
  type EmailSender,
} from './index.js';
import { PRODUCT_NAME } from '../../product.js';

const message: EmailMessage = {
  to: 'Neha@Acme.com',
  subject: 'Confirm your email',
  text: 'Hello',
  html: '<p>Hello</p>',
};

function recorder() {
  const sent: string[] = [];
  const sender: EmailSender = {
    send(item) {
      sent.push(item.to);
      return Promise.resolve();
    },
  };
  return { sent, sender };
}

describe('SES email', () => {
  it('sends raw MIME from EMAIL_FROM, with the configuration set when there is one', async () => {
    const commands: SendEmailCommand[] = [];
    const client = {
      send(command: SendEmailCommand) {
        commands.push(command);
        return Promise.resolve({});
      },
    };
    const config = testConfig({
      EMAIL_FROM: 'Helpdesk <noreply@company.example>',
      SES_CONFIGURATION_SET: 'helpdesk-dev',
    });
    await sesSender(config, client).send(message);
    const input = commands[0]?.input;
    expect(input?.Destination).toEqual({ ToAddresses: ['Neha@Acme.com'] });
    expect(input?.ConfigurationSetName).toBe('helpdesk-dev');
    const raw = Buffer.from(input?.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    expect(raw).toContain('From: Helpdesk <noreply@company.example>');
    expect(raw).toContain('Subject: Confirm your email');
    expect(raw).toContain('Hello');
    expect(raw).toContain('<p>Hello</p>');

    await sesSender(testConfig(), client).send(message);
    expect(commands[1]?.input).not.toHaveProperty('ConfigurationSetName');
  });

  it('carries a workspace sender, copies, threading headers and files', async () => {
    const commands: SendEmailCommand[] = [];
    const client = {
      send(command: SendEmailCommand) {
        commands.push(command);
        return Promise.resolve({});
      },
    };
    await sesSender(testConfig(), client).send({
      ...message,
      from: 'Acme Support <acme@mail.helpdesk.test>',
      replyTo: 'acme+42-abc@mail.helpdesk.test',
      cc: ['boss@acme.com'],
      messageId: '<m1@mail.helpdesk.test>',
      inReplyTo: '<c1@acme.com>',
      references: ['<c1@acme.com>'],
      attachments: [
        { filename: 'steps.txt', content: Buffer.from('one'), contentType: 'text/plain' },
      ],
    });
    const input = commands[0]?.input;
    expect(input?.Destination).toEqual({
      ToAddresses: ['Neha@Acme.com'],
      CcAddresses: ['boss@acme.com'],
    });
    const raw = Buffer.from(input?.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    for (const header of [
      'From: Acme Support <acme@mail.helpdesk.test>',
      'Reply-To: acme+42-abc@mail.helpdesk.test',
      'Cc: boss@acme.com',
      'Message-ID: <m1@mail.helpdesk.test>',
      'In-Reply-To: <c1@acme.com>',
      'References: <c1@acme.com>',
      'filename=steps.txt',
    ]) {
      expect(raw).toContain(header);
    }
  });
});

describe('the system sender', () => {
  it('puts the product name in front of a bare address, and keeps a named sender', () => {
    expect(withSenderName(' noreply@company.example ')).toBe(
      `"${PRODUCT_NAME}" <noreply@company.example>`,
    );
    expect(withSenderName('Support <noreply@company.example>')).toBe(
      'Support <noreply@company.example>',
    );
  });
});

describe('the safety list', () => {
  it('matches exact addresses and whole domains, ignoring case', () => {
    const allowed = ['@company.example', 'ravi@gmail.com'];
    expect(isAllowedRecipient(allowed, 'Priya@Company.Example')).toBe(true);
    expect(isAllowedRecipient(allowed, 'ravi@gmail.com')).toBe(true);
    expect(isAllowedRecipient(allowed, 'other@gmail.com')).toBe(false);
    expect(isAllowedRecipient(allowed, 'someone@sub.company.example')).toBe(false);
  });

  it('sends allowed recipients through the real service and everyone else to the test mailbox', async () => {
    const real = recorder();
    const mailbox = recorder();
    const sender = allowListSender(['@company.example'], real.sender, mailbox.sender);
    await sender.send({ ...message, to: 'priya@company.example' });
    await sender.send({ ...message, to: 'e2e-123@example.test' });
    expect(real.sent).toEqual(['priya@company.example']);
    expect(mailbox.sent).toEqual(['e2e-123@example.test']);
  });

  it('keeps a message in the test mailbox when any copy goes outside the list', async () => {
    const real = recorder();
    const mailbox = recorder();
    const sender = allowListSender(['@company.example'], real.sender, mailbox.sender);
    await sender.send({ ...message, to: 'priya@company.example', cc: ['someone@gmail.com'] });
    expect(real.sent).toEqual([]);
    expect(mailbox.sent).toEqual(['priya@company.example']);
  });

  it('is read from settings as a comma-separated list', () => {
    expect(
      testConfig({ EMAIL_ALLOWED_RECIPIENTS: ' @Company.Example , ravi@gmail.com,, ' })
        .EMAIL_ALLOWED_RECIPIENTS,
    ).toEqual(['@company.example', 'ravi@gmail.com']);
    expect(testConfig().EMAIL_ALLOWED_RECIPIENTS).toBeUndefined();
  });

  it('builds an SES sender only when EMAIL_DRIVER is ses', () => {
    expect(createEmailSender(testConfig())).toHaveProperty('send');
    expect(
      createEmailSender(
        testConfig({ EMAIL_DRIVER: 'ses', EMAIL_ALLOWED_RECIPIENTS: '@company.example' }),
      ),
    ).toHaveProperty('send');
    expect(createEmailSender(testConfig({ EMAIL_DRIVER: 'ses' }))).toHaveProperty('send');
  });
});
