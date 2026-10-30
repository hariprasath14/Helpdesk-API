/** What a placeholder is filled from. */
export interface PlaceholderFacts {
  contact: { name: string; email: string | null };
  ticket: { number: number; subject: string };
  agent: { name: string };
  workspace: { name: string };
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/** The placeholders a canned response can use, and what each becomes. */
export const PLACEHOLDERS: {
  key: string;
  label: string;
  value: (facts: PlaceholderFacts) => string;
}[] = [
  { key: 'contact.name', label: "Requester's name", value: (f) => f.contact.name },
  {
    key: 'contact.first_name',
    label: "Requester's first name",
    value: (f) => firstName(f.contact.name),
  },
  { key: 'contact.email', label: "Requester's email", value: (f) => f.contact.email ?? '' },
  { key: 'ticket.number', label: 'Ticket number', value: (f) => String(f.ticket.number) },
  { key: 'ticket.subject', label: 'Ticket subject', value: (f) => f.ticket.subject },
  { key: 'agent.name', label: 'Your name', value: (f) => f.agent.name },
  { key: 'agent.first_name', label: 'Your first name', value: (f) => firstName(f.agent.name) },
  { key: 'workspace.name', label: 'Workspace name', value: (f) => f.workspace.name },
];

const PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Placeholders in the text that are not in the list ("{{contact.phone}}" → contact.phone). */
export function unknownPlaceholders(text: string): string[] {
  const known = new Set(PLACEHOLDERS.map((placeholder) => placeholder.key));
  const found = [...text.matchAll(PATTERN)].map((match) => match[1] ?? '');
  return [...new Set(found.filter((key) => !known.has(key)))];
}

/** The text with each placeholder replaced; anything unknown is left as typed. */
export function fillPlaceholders(text: string, facts: PlaceholderFacts): string {
  const byKey = new Map(PLACEHOLDERS.map((placeholder) => [placeholder.key, placeholder]));
  return text.replace(PATTERN, (whole, key: string) => byKey.get(key)?.value(facts) ?? whole);
}
