import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Config } from '../../config/index.js';

/** One email waiting in the mailbox, as received (raw MIME). */
export interface ReceivedEmail {
  id: string;
  raw: Buffer;
}

/**
 * Where email sent to workspace addresses waits until the worker takes it (F14). Each email is
 * taken once: the worker stores it and queues a job, then removes it here.
 */
export interface InboundMailbox {
  /** Up to `limit` emails addressed to TICKET_EMAIL_DOMAIN. */
  take(limit: number): Promise<ReceivedEmail[]>;
  remove(ids: string[]): Promise<void>;
}

interface MailpitSearch {
  messages: { ID: string; Size: number }[];
}

/**
 * Mailpit (locally and on the temporary dev server): every email lands there, so the worker reads
 * the ones addressed to a workspace through Mailpit's API. Larger than `maxBytes` are removed
 * unread (the sender gets no ticket; SES refuses them on AWS too).
 */
export function mailpitMailbox(
  config: Pick<Config, 'MAILPIT_API_URL' | 'TICKET_EMAIL_DOMAIN' | 'INBOUND_EMAIL_MAX_MB'>,
  fetcher: typeof fetch = fetch,
): InboundMailbox {
  const url = (path: string) => new URL(path, config.MAILPIT_API_URL).href;
  const maxBytes = config.INBOUND_EMAIL_MAX_MB * 1024 * 1024;
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetcher(url(path), init);
    if (!response.ok) throw new Error(`Mailpit answered ${String(response.status)} for ${path}`);
    return response;
  };
  return {
    async take(limit) {
      // To, Cc and Bcc separately: "addressed:" would also match our own ticket email, which
      // comes from and has Reply-To on this domain.
      const found = new Map<string, MailpitSearch['messages'][number]>();
      for (const header of ['to', 'cc', 'bcc']) {
        const query = new URLSearchParams({
          query: `${header}:"@${config.TICKET_EMAIL_DOMAIN}"`,
          limit: String(limit),
        });
        const page = (await (
          await call(`/api/v1/search?${query.toString()}`)
        ).json()) as MailpitSearch;
        for (const message of page.messages) found.set(message.ID, message);
      }
      const messages = [...found.values()];
      const tooLarge = messages.filter((message) => message.Size > maxBytes);
      if (tooLarge.length > 0) await this.remove(tooLarge.map((message) => message.ID));
      const emails: ReceivedEmail[] = [];
      for (const message of messages.filter((item) => item.Size <= maxBytes).slice(0, limit)) {
        const raw = await call(`/api/v1/message/${encodeURIComponent(message.ID)}/raw`);
        emails.push({ id: message.ID, raw: Buffer.from(await raw.arrayBuffer()) });
      }
      return emails;
    },
    async remove(ids) {
      if (ids.length === 0) return;
      await call('/api/v1/messages', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ IDs: ids }),
      });
    },
  };
}

/** The part of the S3 client this adapter uses, so tests can stand in for it. */
export type S3Sender = Pick<S3Client, 'send'>;

/**
 * SES receiving (real email): a receipt rule saves every email to a workspace address as one
 * object under INBOUND_EMAIL_PREFIX in INBOUND_EMAIL_BUCKET. The worker reads and then deletes
 * them; a bucket rule removes anything left after 7 days. Credentials come from the AWS SDK's
 * usual sources.
 */
export function s3Mailbox(
  config: Pick<
    Config,
    | 'INBOUND_EMAIL_BUCKET'
    | 'INBOUND_EMAIL_PREFIX'
    | 'INBOUND_EMAIL_REGION'
    | 'INBOUND_EMAIL_MAX_MB'
  >,
  client: S3Sender = new S3Client({ region: config.INBOUND_EMAIL_REGION }),
): InboundMailbox {
  const bucket = config.INBOUND_EMAIL_BUCKET ?? '';
  const maxBytes = config.INBOUND_EMAIL_MAX_MB * 1024 * 1024;
  const remove = async (ids: string[]) => {
    if (ids.length === 0) return;
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: ids.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  };
  return {
    async take(limit) {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: config.INBOUND_EMAIL_PREFIX,
          MaxKeys: limit,
        }),
      );
      const objects = (listed.Contents ?? []).filter(
        (object): object is { Key: string; Size?: number } => typeof object.Key === 'string',
      );
      await remove(
        objects.filter((object) => (object.Size ?? 0) > maxBytes).map((object) => object.Key),
      );
      const emails: ReceivedEmail[] = [];
      for (const object of objects.filter((item) => (item.Size ?? 0) <= maxBytes)) {
        const found = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
        if (!found.Body) continue;
        emails.push({ id: object.Key, raw: Buffer.from(await found.Body.transformToByteArray()) });
      }
      return emails;
    },
    remove,
  };
}

/** The mailboxes INBOUND_EMAIL_DRIVER names (none when receiving is off). */
export function createInboundMailboxes(config: Config): InboundMailbox[] {
  return config.INBOUND_EMAIL_DRIVER.map((driver) =>
    driver === 'mailpit' ? mailpitMailbox(config) : s3Mailbox(config),
  );
}
