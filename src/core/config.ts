export interface ReplicationConfig {
  deploymentId: string;
  batchSize: number;
  // A single "*" requests source discovery; otherwise an explicit scope.
  entityKeys: string[];
  entityDenyKeys: string[];
  buildWideViews?: boolean;
}
