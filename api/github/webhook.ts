import type { VercelRequest, VercelResponse } from "../_lib/vercel-types.js";
import {
  installationRecord,
  parseInstallationRecord,
  isValidInstallationId,
  redisCommand,
  verifyGitHubSignature,
  type GitHubInstallation,
} from "../_lib/github-app.js";
import path from "node:path";
import { GitHubClient } from "../../src/github/github-client.js";
import { handleGitHubEvent } from "../../src/github/app-handlers.js";

const FORGE_VERSION = "2.0.1";
const APP_EVENTS = new Set(["issue_comment", "pull_request"]);

export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 1024 * 1024) throw new Error("Payload too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

const key = (id: number) => `forge:github:installation:${id}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const appId = Number(process.env.GITHUB_APP_ID);
  if (!secret || !Number.isSafeInteger(appId) || appId <= 0) {
    return res.status(503).json({ error: "GitHub App webhook is not configured" });
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(413).json({ error: "Webhook payload is too large or unreadable" });
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!verifyGitHubSignature(rawBody, Array.isArray(signature) ? signature[0] : signature, secret)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  let payload: {
    action?: string;
    installation?: GitHubInstallation;
  } & AppPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const event = req.headers["x-github-event"];
  if (typeof event !== "string") return res.status(400).json({ error: "Missing event header" });
  if (APP_EVENTS.has(event)) {
    return handleAppEvent(req, res, event, payload as AppPayload, appId);
  }
  if (event !== "installation" && event !== "installation_repositories") {
    return res.status(200).json({ received: true, ignored: true });
  }

  const installation = payload.installation;
  if (!installation || !isValidInstallationId(installation.id)) {
    return res.status(400).json({ error: "Invalid installation payload" });
  }
  if (installation.app_id !== appId) {
    return res.status(403).json({ error: "Webhook belongs to a different GitHub App or has no App ID" });
  }

  try {
    const recordKey = key(installation.id);
    if (event === "installation" && payload.action === "deleted") {
      await redisCommand(["DEL", recordKey]);
      return res.status(200).json({ received: true, deleted: true });
    }

    const stored = await redisCommand<string | null>(["GET", recordKey]);
    const previous = parseInstallationRecord(stored);
    const record = installationRecord(
      { ...installation, app_id: installation.app_id ?? appId },
      previous ?? undefined,
    );
    if (record.appId !== appId) {
      return res.status(403).json({ error: "Installation App ID mismatch" });
    }
    await redisCommand(["SET", recordKey, JSON.stringify(record)]);
    return res.status(200).json({ received: true, stored: true });
  } catch {
    return res.status(500).json({ error: "Could not persist installation event" });
  }
}

type AppPayload = {
  installation?: { id?: number };
  repository?: { name?: string; full_name?: string };
};

async function handleAppEvent(req: VercelRequest, res: VercelResponse, event: string, payload: AppPayload, appId: number) {
  const installationId = payload.installation?.id;
  const repositoryName = payload.repository?.name;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!isValidInstallationId(installationId) || !repositoryName) {
    return res.status(400).json({ error: "Event is missing installation or repository" });
  }
  if (!privateKey) return res.status(503).json({ error: "GitHub App private key is not configured" });

  // GitHub redelivers on timeouts; process each delivery once.
  const deliveryHeader = req.headers["x-github-delivery"];
  const delivery = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
  if (delivery && /^[A-Za-z0-9-]{8,80}$/.test(delivery)) {
    try {
      const fresh = await redisCommand<string | null>(["SET", `forge:github:delivery:${delivery}`, "1", "NX", "EX", 86400]);
      if (fresh === null) return res.status(200).json({ received: true, duplicate: true });
    } catch {
      // Redis unavailable: continue; handlers are idempotent where it matters (branch reuse, check runs).
    }
  }

  try {
    const client = await GitHubClient.forInstallation({ appId, privateKey, installationId, repositories: [repositoryName] });
    const result = await handleGitHubEvent({ client, forgeVersion: FORGE_VERSION, catalogRoot: path.join(process.cwd(), "catalog") }, event, payload);
    const fullName = payload.repository?.full_name?.toLowerCase();
    if (result.handled && fullName && /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(fullName)) {
      // Activity feed for the hosted dashboard (latest 50 events per repository).
      const entry = JSON.stringify({ at: new Date().toISOString(), event, action: result.action, ...(result.detail ? { detail: result.detail.slice(0, 200) } : {}), ...(result.url ? { url: result.url } : {}) });
      await redisCommand(["LPUSH", `forge:repo:${fullName}:events`, entry]).catch(() => undefined);
      await redisCommand(["LTRIM", `forge:repo:${fullName}:events`, 0, 49]).catch(() => undefined);
    }
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "unknown error";
    return res.status(500).json({ error: "FORGE could not process the event", detail: message });
  }
}
