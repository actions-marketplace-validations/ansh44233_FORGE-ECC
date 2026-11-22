import path from "node:path";
import type { VercelRequest, VercelResponse } from "./_lib/vercel-types.js";
import { getQuery, getVerifiedInstallations, jsonError, readSession } from "./_lib/github-auth.js";
import { redisCommand } from "./_lib/github-app.js";
import { GitHubClient } from "../src/github/github-client.js";
import { buildRepoOverview, parseRepoFullName, runDashboardAction, type DashboardEvent } from "../src/github/dashboard-service.js";

/**
 * Hosted dashboard API (one function to stay within plan limits).
 *   GET  /api/app?op=session              signed-in user, installations and accessible repositories
 *   GET  /api/app?op=repo&name=owner/repo  live overview: profile, setup status, Shield, open PR risk, history
 *   POST /api/app?op=action               { name, action: "analyze" | "repair" } → setup pull request
 */

export const config = { api: { bodyParser: false } };

const FORGE_VERSION = "2.0.0";
const ALLOWED_ORIGIN = "https://forge-ecc.vercel.app";

async function readJson(req: VercelRequest): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 16 * 1024) throw new Error("Request body too large");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function history(fullName: string): Promise<DashboardEvent[]> {
  try {
    const items = await redisCommand<string[]>(["LRANGE", `forge:repo:${fullName.toLowerCase()}:events`, 0, 24]);
    return (items ?? []).flatMap(item => { try { return [JSON.parse(item) as DashboardEvent]; } catch { return []; } });
  } catch {
    return [];
  }
}

async function clientFor(installationId: number, repo: string): Promise<GitHubClient> {
  const appId = Number(process.env.GITHUB_APP_ID);
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!Number.isSafeInteger(appId) || appId <= 0 || !privateKey) throw new Error("GitHub App credentials are not configured");
  return GitHubClient.forInstallation({ appId, privateKey, installationId, repositories: [repo] });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const op = getQuery(req, "op");
  try {
    const session = await readSession(req);
    if (!session) return jsonError(res, 401, "Sign in with GitHub to continue");

    if (op === "session" && req.method === "GET") {
      const installations = await getVerifiedInstallations(session.installationIds);
      const active = new Set(installations.map(item => item.installationId));
      return res.status(200).json({
        user: { login: session.login },
        installations: installations.map(item => ({ id: item.installationId, account: item.account.login, type: item.account.type, selection: item.repositorySelection })),
        repositories: (session.repositories ?? []).filter(item => active.has(item.installationId)),
        reauthRequired: session.repositories === undefined,
      });
    }

    const target = op === "repo" ? parseRepoFullName(getQuery(req, "name")) : undefined;
    if (op === "repo" && req.method === "GET") {
      if (!target) return jsonError(res, 400, "Use name=owner/repo");
      const allowed = (session.repositories ?? []).find(item => item.fullName.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase());
      if (!allowed) return jsonError(res, 404, "Repository not found in your FORGE installations");
      const client = await clientFor(allowed.installationId, target.repo);
      const overview = await buildRepoOverview({ client, forgeVersion: FORGE_VERSION, catalogRoot: path.join(process.cwd(), "catalog") }, target.owner, target.repo, await history(allowed.fullName));
      return res.status(200).json(overview);
    }

    if (op === "action" && req.method === "POST") {
      const origin = req.headers.origin;
      if ((Array.isArray(origin) ? origin[0] : origin) !== ALLOWED_ORIGIN) return jsonError(res, 403, "Cross-origin request rejected");
      const body = await readJson(req) as { name?: unknown; action?: unknown };
      const repoTarget = parseRepoFullName(body.name);
      if (!repoTarget || (body.action !== "analyze" && body.action !== "repair")) return jsonError(res, 400, "Use { name: owner/repo, action: analyze | repair }");
      const allowed = (session.repositories ?? []).find(item => item.fullName.toLowerCase() === `${repoTarget.owner}/${repoTarget.repo}`.toLowerCase());
      if (!allowed) return jsonError(res, 404, "Repository not found in your FORGE installations");
      const client = await clientFor(allowed.installationId, repoTarget.repo);
      const result = await runDashboardAction({ client, forgeVersion: FORGE_VERSION, catalogRoot: path.join(process.cwd(), "catalog") }, repoTarget.owner, repoTarget.repo, body.action, session.login);
      const event: DashboardEvent = { at: new Date().toISOString(), event: "dashboard", action: body.action, detail: result.upToDate ? "up to date" : `${result.created} new, ${result.updated} updated`, ...(result.url ? { url: result.url } : {}) };
      await redisCommand(["LPUSH", `forge:repo:${allowed.fullName.toLowerCase()}:events`, JSON.stringify(event)]).catch(() => undefined);
      await redisCommand(["LTRIM", `forge:repo:${allowed.fullName.toLowerCase()}:events`, 0, 49]).catch(() => undefined);
      return res.status(200).json(result);
    }

    res.setHeader("Allow", "GET, POST");
    return jsonError(res, 405, "Unsupported operation");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return jsonError(res, /write access/.test(message) ? 403 : 502, message.slice(0, 200));
  }
}
