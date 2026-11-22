import type { VercelRequest, VercelResponse } from "../_lib/vercel-types.js";
import { describePrivateKey } from "../../src/github/github-client.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const configured = Boolean(
    process.env.GITHUB_APP_SLUG &&
      process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_WEBHOOK_SECRET &&
      process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET &&
      (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
      (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
  );
  return res.status(configured ? 200 : 503).json({
    status: configured ? "configured" : "setup_required",
    message: configured
      ? "GitHub App backend environment variables are present."
      : "One or more GitHub App backend environment variables are missing.",
    // Shape-only diagnostics (never key material) to debug GITHUB_APP_PRIVATE_KEY formatting.
    ...(req.query?.check === "key" ? { privateKey: describePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY) } : {}),
  });
}
