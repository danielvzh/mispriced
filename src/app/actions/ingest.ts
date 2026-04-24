"use server";

import {
  clientIngestLlmOptions,
  ingestFromGamma,
  type IngestResult,
} from "@/lib/ingest";

/**
 * Triggers a server-side sync from the UI. In production, set
 * `ALLOW_CLIENT_INGEST=1` in Vercel to enable (otherwise use cron + curl
 * with x-admin-secret).
 */
export async function runIngestFromUi(): Promise<
  { ok: true; result: IngestResult } | { ok: false; error: string }
> {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_CLIENT_INGEST !== "1") {
    return { ok: false, error: "Set ALLOW_CLIENT_INGEST=1 on the server, or use POST /api/ingest with a secret" };
  }
  try {
    const result = await ingestFromGamma(clientIngestLlmOptions());
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
