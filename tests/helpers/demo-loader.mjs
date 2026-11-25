// Demo guard: database clients, the Salesforce adapter and its HTTP library must never load.
export async function resolve(specifier, context, nextResolve) {
  if (/(?:prisma|postgres|pglite|sql|kysely|(?:^|\/)pg(?:\/|$)|database|jsforce|sources\/salesforce)/i.test(specifier)) {
    throw new Error(`Demo import blocked: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
