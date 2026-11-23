import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateJson, safeDeploymentFileName, writePrivateJson } from "../../../cli-config-dir.js";

export interface OAuthTokens {
  loginUrl: string;
  instanceUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  issuedAt: string;
}

export interface TokenStore {
  load(deploymentId: string): Promise<OAuthTokens | undefined>;
  save(deploymentId: string, tokens: OAuthTokens): Promise<void>;
  clear(deploymentId: string): Promise<void>;
}

function storedFields(value: unknown): OAuthTokens {
  const { loginUrl, instanceUrl, clientId, accessToken, refreshToken, issuedAt } =
    (value ?? {}) as Partial<Record<keyof OAuthTokens, unknown>>;
  if (
    typeof loginUrl !== "string" || !loginUrl ||
    typeof instanceUrl !== "string" || !instanceUrl ||
    typeof clientId !== "string" || !clientId ||
    typeof accessToken !== "string" || !accessToken ||
    typeof refreshToken !== "string" || !refreshToken ||
    typeof issuedAt !== "string" || !issuedAt
  ) {
    throw new Error("Invalid stored OAuth credentials. Run auth login again.");
  }
  return { loginUrl, instanceUrl, clientId, accessToken, refreshToken, issuedAt };
}

export class FileTokenStore implements TokenStore {
  private readonly directory: string;

  constructor(configDir: string) {
    this.directory = join(configDir, "credentials");
  }

  private path(deploymentId: string): string {
    return join(this.directory, `${safeDeploymentFileName(deploymentId)}.json`);
  }

  private async directoryExists(): Promise<boolean> {
    const stat = await lstat(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return false;
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
      throw new Error("Expected an OAuth credentials directory with mode 0700.");
    }
    return true;
  }

  async load(deploymentId: string): Promise<OAuthTokens | undefined> {
    const path = this.path(deploymentId);
    if (!await this.directoryExists()) return undefined;
    const value = await readPrivateJson(path);
    return value === undefined ? undefined : storedFields(value);
  }

  async save(deploymentId: string, tokens: OAuthTokens): Promise<void> {
    const path = this.path(deploymentId);
    const value = storedFields(tokens);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.directoryExists();
    await writePrivateJson(path, value);
  }

  async clear(deploymentId: string): Promise<void> {
    const path = this.path(deploymentId);
    if (await this.directoryExists()) await rm(path, { force: true });
  }
}
