import { join } from "node:path";

import { isCollectionId } from "./photo.ts";

export interface Config {
  unsplashAccessKey: string;
  curatedCollectionId: string;
  port: number;
  curatedFile: string;
  curatedSyncMs: number;
  // take the client IP from X-Forwarded-For, set by a reverse proxy in front of us
  trustProxy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const unsplashAccessKey = required(env, "UNSPLASH_ACCESS_KEY");
  const curatedCollectionId = required(env, "CURATED_COLLECTION_ID");
  if (!isCollectionId(curatedCollectionId)) {
    throw new Error(
      `CURATED_COLLECTION_ID is not an Unsplash collection id: ${curatedCollectionId}`,
    );
  }
  return {
    unsplashAccessKey,
    curatedCollectionId,
    port: positiveInt(env, "PORT", 3000),
    curatedFile: join(env.DATA_DIR || "./data", "curated.json"),
    curatedSyncMs: positiveInt(env, "CURATED_SYNC_MINUTES", 360) * 60_000,
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return n;
}
