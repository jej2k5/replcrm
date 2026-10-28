// Runtime dependency guard: transitive imports are checked, including generated clients.
export async function resolve(specifier, context, nextResolve) {
  if (/(?:prisma|postgres|pglite|sql|kysely|adbc|oracle|snowflake|tedious|mysql|sqlite|(?:^|\/)pg(?:\/|$)|database)/i.test(specifier)) {
    throw new Error(`Database import blocked: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
