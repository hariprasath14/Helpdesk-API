const REF = /"#\/components\/schemas\/([^"]+)"/g;

function refsIn(value: unknown): Set<string> {
  return new Set([...JSON.stringify(value).matchAll(REF)].map((match) => match[1] ?? ''));
}

/**
 * Removes named schemas that nothing in the spec refers to. The Zod provider emits an input and
 * an output copy of every named schema (`HealthResponse` and `HealthResponseInput`); dropping the
 * unused copies keeps the frontend's generated types to the ones the API really uses.
 */
export function pruneUnusedSchemas<T extends object>(doc: T): T {
  const { components, ...rest } = doc as { components?: { schemas?: Record<string, unknown> } };
  if (!components?.schemas) return doc;
  const schemas = new Map(Object.entries(components.schemas));

  // Start from everything outside the schema list, then follow refs between schemas.
  const used = refsIn({ ...rest, components: { ...components, schemas: undefined } });
  const queue = [...used];
  while (queue.length > 0) {
    const name = queue.pop() ?? '';
    for (const ref of refsIn(schemas.get(name))) {
      if (!used.has(ref)) {
        used.add(ref);
        queue.push(ref);
      }
    }
  }

  const kept = Object.fromEntries([...schemas].filter(([name]) => used.has(name)));
  return { ...doc, components: { ...components, schemas: kept } };
}
