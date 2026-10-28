# Operator setup (manual, not executed during preparation)

Build/test work requires no live CRM or external database. Actual replication requires an independent PostgreSQL database, an existing Deployment row and authorized Salesforce API credentials.

1. Install Node 22.x, then `npm ci`, `npm run prisma:generate`, `npm run build`.
2. Provision the target database, copy `.env.example` to ignored `.env`, and supply actual source/store settings privately. Never commit them. The examples are synthetic and do not describe a live service.
3. For a new disposable database, review and apply the checked-in schema with `node --env-file=.env node_modules/prisma/build/index.js migrate deploy`. For an existing operator database, review backup, identity upgrade and reference-preservation validation first. Do not run migrate dev against it.
4. Create a Deployment row with your own stable ID. For example, using the generated client against your configured database:

```js
// Run only after you intentionally provisioned/configured the target database.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  await prisma.deployment.create({ data: { id: 'local-demo', name: 'Local demo' } });
} finally { await prisma.$disconnect(); }
```

Set DEPLOYMENT_ID to that row's ID. Then run `node --env-file=.env dist/cli.js`. Set explicit entity scope and use a low-privilege integration account appropriate to your source. The CLI currently uses password plus security-token authentication; OAuth is an adapter API capability, not a separate configured CLI mode.

Incremental runs use source-defined tokens. Serialize runs per deployment and do not edit tokens to infer progress. Projection refresh follows successful checkpoint publication. Changing an existing canonical attribute's type/relationship targets is rejected rather than silently migrating historical values.

PostgreSQL consumers resolve projection descriptors or consult `wide.__replcrm_projections`, including column mappings. Do not assume a physical name from an entity key. Existing installations require `20261026_scoped_record_identity` and a consumer registry upgrade where not yet applied.

None of these operator commands was executed against an existing database for this candidate. Production upgrade, live source behavior and external consumer compatibility remain separate validation gates.
