import { PostgresReplicaStore } from "./stores/postgres/index.js";
import { SourceClient } from "./sources/salesforce/client.js";
import { PrismaClient } from "@prisma/client";
import { loadConfig, type MigrationConfig } from "./config.js";
import { runReplication } from "./core/orchestrator.js";

async function main(): Promise<void> {
  const arg: string | undefined = process.argv[2];
  if (arg === "--help") {
    console.log("ReplCRM: npm run replicate (metadata, users, records, relationships, wide views). No stage-specific commands are implemented.");
    return;
  }
  if (arg && !["full", "metadata", "records"].includes(arg)) throw new Error(`Unsupported command: ${arg}`);
  if (arg || process.env["npm_lifecycle_event"]?.startsWith("migrate")) {
    console.warn("Deprecated migrate command: use npm run replicate. Legacy stage names run the FULL pipeline, as before.");
  }
  const config: MigrationConfig = loadConfig();
  const prisma: PrismaClient = new PrismaClient();
  try {
    await runReplication({ store: new PostgresReplicaStore(prisma), config, sourceClient: new SourceClient(config.source) });
    console.log(`Replication complete for deployment ${config.deploymentId}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
