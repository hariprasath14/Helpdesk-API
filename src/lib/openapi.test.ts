import { describe, expect, it } from 'vitest';
import { pruneUnusedSchemas } from './openapi.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

describe('pruneUnusedSchemas', () => {
  it('keeps schemas used by paths and the schemas they refer to, and drops the rest', () => {
    const doc = {
      paths: { '/tickets': { get: { responses: { 200: { schema: ref('TicketList') } } } } },
      components: {
        schemas: {
          TicketList: { type: 'array', items: ref('Ticket') },
          Ticket: { type: 'object', properties: { contact: ref('Contact') } },
          Contact: { type: 'object' },
          TicketListInput: { type: 'array' },
          Unused: { type: 'object', properties: { other: ref('Contact') } },
        },
      },
    };

    expect(Object.keys(pruneUnusedSchemas(doc).components.schemas).sort()).toEqual([
      'Contact',
      'Ticket',
      'TicketList',
    ]);
  });

  it('leaves a document without schemas unchanged', () => {
    const doc = { paths: {} };
    expect(pruneUnusedSchemas(doc)).toBe(doc);
  });
});
