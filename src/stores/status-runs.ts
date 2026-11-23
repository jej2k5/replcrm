import type { Counts } from "../core/replica-store.js";

export interface StatusRun extends Counts {
  startedAt: Date;
  completedAt: Date | null;
  status: "Running" | "Succeeded" | "Failed";
  errorMessage: string | null;
}

export interface FailedStatusRun {
  entityKey: string | null;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}
