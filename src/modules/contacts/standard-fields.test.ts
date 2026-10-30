import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../openapi.js';
import { MAX_DOMAINS } from './companies.service.js';
import { MAX_TAGS } from '../tickets/tickets.service.js';
import { MAX_OTHER_EMAILS } from './contacts.service.js';
import { standardFieldsFor } from './standard-fields.js';

interface Spec {
  components: { schemas: Record<string, { properties: Record<string, unknown> }> };
}

/** A request schema's properties, except custom fields. */
async function requestFields(schema: string): Promise<string[]> {
  const spec = (await generateOpenApiSpec()) as Spec;
  const found = Object.entries(spec.components.schemas).find(([name]) => name.startsWith(schema));
  if (!found) throw new Error(`no ${schema} schema`);
  return Object.keys(found[1].properties).filter((key) => key !== 'customFields');
}

describe('standard fields', () => {
  // Settings lists these; if the API gains or drops a built-in field, this fails until the list
  // (and so Settings) is updated.
  it.each([
    ['ticket', 'CreateTicketRequest'],
    ['contact', 'CreateContactRequest'],
    ['company', 'CreateCompanyRequest'],
  ] as const)('list every built-in %s field the API takes', async (recordType, schema) => {
    const keys = standardFieldsFor(recordType).map((field) => field.key);
    // A ticket's `contact` is another way to give the requester (contactId), not its own field.
    const fields = (await requestFields(schema)).filter((key) => key !== 'contact');
    expect([...keys].sort()).toEqual(fields.sort());
  });

  it('describe the limits the checks use', () => {
    const contact = standardFieldsFor('contact').find((field) => field.key === 'otherEmails');
    const company = standardFieldsFor('company').find((field) => field.key === 'domains');
    expect(contact?.description).toContain(String(MAX_OTHER_EMAILS));
    expect(company?.description).toContain(String(MAX_DOMAINS));
    const tags = standardFieldsFor('ticket').find((field) => field.key === 'tags');
    expect(tags?.description).toContain(String(MAX_TAGS));
  });
});
