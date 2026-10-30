import { Readable } from 'node:stream';
import type { Logger } from 'pino';
import type { InboundMailbox } from '../adapters/inbound-email/index.js';
import type { FileStorage } from '../adapters/storage/index.js';
import { newId } from '../lib/tokens.js';
import { receiveEmail, type IncomingDeps } from '../modules/email/incoming.service.js';

/** Emails taken from the mailbox per round. */
const BATCH = 25;

export interface InboundEmailJob {
  /** Where the raw email waits in file storage ("inbound/<id>"). */
  key: string;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/**
 * One round of picking up email from one mailbox (INBOUND_EMAIL_DRIVER): each email is stored, gets an
 * inbound-email job, and only then leaves the mailbox, so none is lost if the worker stops
 * half way (at worst it is taken twice, and the Message-ID check drops the copy).
 */
export async function takeInboundEmail(
  mailbox: InboundMailbox,
  storage: FileStorage,
  maxBytes: number,
  send: (job: InboundEmailJob) => Promise<void>,
): Promise<number> {
  const emails = await mailbox.take(BATCH);
  for (const email of emails) {
    const key = `inbound/${newId()}`;
    await storage.put(key, Readable.from(email.raw), maxBytes);
    await send({ key });
    await mailbox.remove([email.id]);
  }
  return emails.length;
}

/**
 * The inbound-email job: reads the stored email, makes it a ticket or a reply, then deletes the
 * stored copy. An email that is already gone was handled by an earlier try.
 */
export async function handleInboundEmail(
  deps: IncomingDeps,
  job: InboundEmailJob,
  log: Pick<Logger, 'info'>,
): Promise<void> {
  let raw: Buffer;
  try {
    const stored = await deps.storage.get(job.key);
    if (!('stream' in stored)) throw new Error('Inbound email must be read from storage');
    raw = await readAll(stored.stream);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const outcome = await receiveEmail(deps, raw);
  log.info({ ...outcome, key: job.key }, 'inbound email handled');
  await deps.storage.remove(job.key);
}
