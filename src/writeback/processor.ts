import type { ReplicaStore } from "../core/replica-store.js";
import type { CanonicalEntity, CrmSource, SourceRecord } from "../core/source.js";
import { writableAttributes } from "./policy.js";
import type { ChangeRequest, ChangeTransition, OverrideDecision, WritebackStore } from "./requests.js";

export type UnknownResolution = { linkSourceId: string } | { resubmit: true } | { abandon: true };

export class ChangeRequestProcessor {
  constructor(
    private readonly store: Pick<WritebackStore, "readEntity" | "getWritebackPolicy" | "transitionChangeRequest" | "ensureWritebackRecord"> & Pick<ReplicaStore, "persistRecords">,
    private readonly source: Pick<CrmSource, "applyChange" | "readRecord">,
  ) {}

  private transition(request: ChangeRequest, change: ChangeTransition): Promise<ChangeRequest> {
    return this.store.transitionChangeRequest(request.deploymentId, request.id, request.status, change, request.updatedAt);
  }

  private async persist(request: ChangeRequest, entity: CanonicalEntity, record: SourceRecord): Promise<void> {
    await this.store.persistRecords(request.deploymentId, entity, { records: [record], nextCheckpoint: null });
  }

  async processChange(request: ChangeRequest): Promise<ChangeRequest> {
    if (request.status !== "pending" && request.status !== "overridden" && request.status !== "failed") {
      throw new Error("Change is not ready to send");
    }
    if (!this.source.applyChange) throw new Error("This source does not support write-back");
    const { deploymentId, entityKey, operation, fields } = request;
    const entity = await this.store.readEntity(deploymentId, entityKey);
    if (!entity) throw new Error(`Unknown object ${entityKey}`);
    const policy = await this.store.getWritebackPolicy(deploymentId, entityKey);
    const writable = new Set(writableAttributes(entity, policy, operation));
    if (request.status === "failed") {
      request = await this.transition(request, { status: "pending", retryAfter: null });
    }
    if (!policy.enabled || Object.keys(fields).some((key) => !writable.has(key))) {
      return this.transition(request, { status: "rejected", statusDetail: "Current write-back policy or field metadata disallows this change", sourceError: null });
    }
    const sending = await this.transition(request, { status: "sending", sourceError: null });
    const result = await this.source.applyChange({
      entity, operation, fields, targetSourceId: request.targetSourceId,
      authorKind: request.authorKind, authorLabel: request.authorLabel,
      overrideConflict: request.status === "overridden" && sending.overrideDecision?.side === "replica",
    });
    switch (result.status) {
      case "applied": {
        let detail = result.detail;
        if (result.record) {
          try {
            await this.persist(sending, entity, result.record);
          } catch (error) {
            detail = `Source confirmed the write. Replica persistence failed: ${String(error)}`;
          }
        }
        if (operation === "create" && (!result.record || detail) && this.store.ensureWritebackRecord) {
          try {
            await this.store.ensureWritebackRecord(deploymentId, entityKey, result.sourceId);
          } catch (error) {
            detail = [detail, `Replica link could not be saved: ${String(error)}`].filter(Boolean).join(" ");
          }
        }
        return this.transition(sending, {
          status: "applied", resultingSourceId: result.sourceId, sourceModifiedAt: result.modifiedAt,
          statusDetail: detail ?? null,
        });
      }
      case "conflict":
        return this.transition(sending, result);
      case "rejected":
        return this.transition(sending, { status: "rejected", statusDetail: result.error.message, sourceError: result.error });
      case "failed":
        return this.transition(sending, { status: "failed", statusDetail: result.detail, sourceError: result.error ?? null, ...(result.retryAfter !== undefined && { retryAfter: result.retryAfter }) });
      case "unknown":
        return this.transition(sending, { status: "unknown", statusDetail: result.detail });
    }
  }

  async overrideConflict(request: ChangeRequest, decision: OverrideDecision): Promise<ChangeRequest> {
    if (request.status !== "conflict") throw new Error("Only a conflicting request can be overridden");
    if (!decision.operatorLabel.trim() || !Number.isFinite(Date.parse(decision.time))) throw new Error("An operator label and decision time are required");
    if (decision.side === "source") {
      return this.transition(request, { status: "rejected", statusDetail: "kept Salesforce values", overrideDecision: decision });
    }
    if (decision.side !== "replica") throw new Error("Invalid override side");
    const overridden = await this.transition(request, { status: "overridden", overrideDecision: decision });
    return this.processChange(overridden);
  }

  async resolveUnknown(request: ChangeRequest, resolution: UnknownResolution, operatorLabel?: string): Promise<ChangeRequest> {
    if (request.status !== "unknown") throw new Error("Only an unknown request can be resolved");
    if (operatorLabel !== undefined && !operatorLabel.trim()) throw new Error("An operator label is required");
    const detail = (message: string) => operatorLabel === undefined ? message : `${message} (operator: ${operatorLabel})`;
    if ("resubmit" in resolution && resolution.resubmit === true) {
      return this.transition(request, { status: "pending", statusDetail: detail("Resubmission explicitly authorized"), operatorResubmission: true });
    }
    if ("abandon" in resolution && resolution.abandon === true) {
      return this.transition(request, { status: "rejected", statusDetail: detail("Operator abandoned the unresolved change") });
    }
    if (!("linkSourceId" in resolution) || !resolution.linkSourceId.trim()) throw new Error("A source record ID is required");
    if (request.operation === "update" && resolution.linkSourceId !== request.targetSourceId) {
      throw new Error("An update must be linked to its original source record");
    }
    const entity = await this.store.readEntity(request.deploymentId, request.entityKey);
    if (!entity || !this.source.readRecord) throw new Error("Source record lookup is unavailable");
    const record = await this.source.readRecord(entity, resolution.linkSourceId);
    if (!record || record.isDeleted) throw new Error("The source record is deleted or unavailable");
    await this.persist(request, entity, record);
    return this.transition(request, {
      status: "applied", resultingSourceId: record.sourceId, sourceModifiedAt: record.modifiedAt ?? null,
      statusDetail: detail("Operator linked the confirmed source record"),
    });
  }
}
