import type { MigrationConfig } from "../../src/config.js";
import type { CanonicalEntity, ChangeBatch, CrmSource, SourceUser } from "../../src/core/source.js";

export const entity: CanonicalEntity = { key: "Account", label: "Account", pluralLabel: "Accounts", attributes: [] };
export const config: MigrationConfig = {
  deploymentId: "test",
  entityKeys: ["*"],
  entityDenyKeys: [],
  batchSize: 2,
  source: { loginUrl: "", username: "", password: "", securityToken: "" },
};

export class FakeSource implements CrmSource {
  async connect(): Promise<void> {}
  async logout(): Promise<void> {}
  async listEntities(): Promise<string[]> { return [entity.key]; }
  async describeEntity(): Promise<CanonicalEntity> { return entity; }
  async *streamUsers(): AsyncGenerator<SourceUser[]> {
    yield [{
      sourceId: "user", username: "user", email: "user@example.test",
      firstName: null, lastName: "User", role: null, isActive: true,
    }];
  }
  async *fetchChanges(): AsyncGenerator<ChangeBatch> {
    yield { records: [{ sourceId: "account", fields: {} }], nextCheckpoint: "next-page" };
  }
}
