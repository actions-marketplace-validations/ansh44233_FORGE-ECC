import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/**
 * Minimal, dependency-free GitHub REST client for the FORGE GitHub App.
 * Uses App JWTs (RS256) to mint short-lived, repository-scoped installation tokens.
 */

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "forge-ecc-github-app";

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Accept the private key however it was pasted into an environment variable:
 * real newlines, literal "\\n" escapes, CRLF, surrounding quotes, newlines turned
 * into spaces (single-line PEM), or the whole PEM base64-encoded.
 */
export function normalizePrivateKey(value: string): string {
  let key = value.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1).trim();
  key = key.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n");
  if (!key.includes("-----BEGIN")) {
    const decoded = Buffer.from(key.replace(/\s+/g, ""), "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) key = decoded.trim();
  }
  const match = key.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!match) return key;
  const body = (match[2] ?? "").replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----\n`;
}

/**
 * Describe the *shape* of a configured private key without revealing any key material.
 * Used by the health endpoint to diagnose misconfigured environment variables.
 */
export function describePrivateKey(value: string | undefined): Record<string, unknown> {
  if (!value) return { present: false };
  const normalized = normalizePrivateKey(value);
  const marker = normalized.match(/-----BEGIN ([A-Z0-9 ]+)-----/)?.[1] ?? null;
  const body = normalized.match(/-----BEGIN [A-Z0-9 ]+-----([\s\S]*?)-----END/)?.[1]?.replace(/\s+/g, "") ?? "";
  let parseOk = false;
  let parseError: string | null = null;
  let keyType: string | null = null;
  try {
    const key = createPrivateKey(normalized);
    parseOk = true;
    keyType = key.asymmetricKeyType ?? null;
  } catch (error) {
    parseError = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "parse_failed";
  }
  return {
    present: true,
    rawLength: value.length,
    rawLineCount: value.split(/\r?\n/).length,
    rawHasLiteralBackslashN: value.includes("\\n"),
    rawQuoted: /^\s*["']/.test(value),
    rawStartsWithBeginMarker: value.trimStart().startsWith("-----BEGIN"),
    looksLikeFingerprint: /^\s*SHA256:/i.test(value),
    marker,
    hasEndMarker: /-----END [A-Z0-9 ]+-----/.test(normalized),
    bodyBase64Length: body.length,
    bodyIsBase64: /^[A-Za-z0-9+/=]*$/.test(body),
    encrypted: marker === "ENCRYPTED PRIVATE KEY" || /Proc-Type: 4,ENCRYPTED/.test(normalized),
    parseOk,
    keyType,
    parseError,
    runtime: { node: process.version, openssl: process.versions.openssl },
  };
}

export function loadPrivateKey(value: string): KeyObject {
  try {
    return createPrivateKey(normalizePrivateKey(value));
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY could not be read. Paste the complete .pem file from the GitHub App settings (including the BEGIN/END lines) into the Vercel environment variable, then redeploy.");
  }
}

/** GitHub App JWT: issued 60s in the past to tolerate clock drift, valid for 9 minutes. */
export function createAppJwt(appId: number | string, privateKeyPem: string, now = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(loadPrivateKey(privateKeyPem)))}`;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface TreeEntry { path: string; type: "blob" | "tree" | "commit"; size?: number; sha: string }
export interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number; previous_filename?: string }
export interface CommitSummary { sha: string; message: string }

export class GitHubClient {
  constructor(private readonly token: string, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly baseUrl = API) {}

  async request<T>(method: string, path: string, body?: unknown, auth: "token" | "bearer" = "token"): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `${auth === "bearer" ? "Bearer" : "token"} ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": USER_AGENT,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = ((await response.json()) as { message?: string }).message ?? ""; } catch { /* ignore */ }
      throw new GitHubApiError(response.status, `GitHub ${method} ${path.split("?")[0]} failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  static async forInstallation(options: { appId: number | string; privateKey: string; installationId: number; repositories?: string[]; fetchImpl?: FetchLike; now?: Date }): Promise<GitHubClient> {
    const jwt = createAppJwt(options.appId, options.privateKey, options.now);
    const appClient = new GitHubClient(jwt, options.fetchImpl);
    const token = await appClient.request<{ token: string }>("POST", `/app/installations/${options.installationId}/access_tokens`, options.repositories?.length ? { repositories: options.repositories } : {}, "bearer");
    if (!token?.token) throw new Error("GitHub did not return an installation token.");
    return new GitHubClient(token.token, options.fetchImpl);
  }

  repo(owner: string, repo: string) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async getRepository(owner: string, repo: string): Promise<{ default_branch: string; private: boolean; full_name: string }> {
    return this.request("GET", this.repo(owner, repo));
  }

  async getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>("GET", `${this.repo(owner, repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  }

  async getTree(owner: string, repo: string, sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const tree = await this.request<{ tree: TreeEntry[]; truncated: boolean }>("GET", `${this.repo(owner, repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`);
    return { entries: tree.tree, truncated: tree.truncated };
  }

  async getFileText(owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
    try {
      const file = await this.request<{ content?: string; encoding?: string; type?: string; size?: number }>("GET", `${this.repo(owner, repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") return undefined;
      return Buffer.from(file.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async listCommits(owner: string, repo: string, ref: string, limit = 100): Promise<CommitSummary[]> {
    const commits = await this.request<Array<{ sha: string; commit: { message: string } }>>("GET", `${this.repo(owner, repo)}/commits?sha=${encodeURIComponent(ref)}&per_page=${Math.min(100, limit)}`);
    return commits.map(item => ({ sha: item.sha, message: item.commit.message }));
  }

  async listPullFiles(owner: string, repo: string, pull: number, maxPages = 3): Promise<PullFile[]> {
    const files: PullFile[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request<PullFile[]>("GET", `${this.repo(owner, repo)}/pulls/${pull}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  async getPull(owner: string, repo: string, pull: number): Promise<{ head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { ref: string } }> {
    return this.request("GET", `${this.repo(owner, repo)}/pulls/${pull}`);
  }

  async getCollaboratorPermission(owner: string, repo: string, username: string): Promise<string> {
    const result = await this.request<{ permission: string }>("GET", `${this.repo(owner, repo)}/collaborators/${encodeURIComponent(username)}/permission`);
    return result.permission;
  }

  async createIssueComment(owner: string, repo: string, issue: number, body: string): Promise<{ html_url: string }> {
    return this.request("POST", `${this.repo(owner, repo)}/issues/${issue}/comments`, { body: body.slice(0, 65_000) });
  }

  async createCheckRun(owner: string, repo: string, check: Record<string, unknown>): Promise<{ id: number; html_url?: string }> {
    return this.request("POST", `${this.repo(owner, repo)}/check-runs`, check);
  }

  /** Commit text files onto a new branch from `baseBranch` and open a pull request. */
  async openPullRequestWithFiles(options: { owner: string; repo: string; baseBranch: string; branch: string; title: string; body: string; message: string; files: Array<{ path: string; content: string }> }): Promise<{ html_url: string; number: number }> {
    const { owner, repo } = options;
    const baseSha = await this.getBranchSha(owner, repo, options.baseBranch);
    const baseCommit = await this.request<{ tree: { sha: string } }>("GET", `${this.repo(owner, repo)}/git/commits/${baseSha}`);
    const tree = await this.request<{ sha: string }>("POST", `${this.repo(owner, repo)}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: options.files.map(file => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
    });
    const commit = await this.request<{ sha: string }>("POST", `${this.repo(owner, repo)}/git/commits`, { message: options.message, tree: tree.sha, parents: [baseSha] });
    try {
      await this.request("POST", `${this.repo(owner, repo)}/git/refs`, { ref: `refs/heads/${options.branch}`, sha: commit.sha });
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
      // Branch exists from an earlier request: move it to the new commit.
      await this.request("PATCH", `${this.repo(owner, repo)}/git/refs/heads/${encodeURIComponent(options.branch)}`, { sha: commit.sha, force: true });
      const existing = await this.request<Array<{ html_url: string; number: number }>>("GET", `${this.repo(owner, repo)}/pulls?head=${encodeURIComponent(`${owner}:${options.branch}`)}&state=open`);
      if (existing[0]) return existing[0];
    }
    return this.request("POST", `${this.repo(owner, repo)}/pulls`, { title: options.title, head: options.branch, base: options.baseBranch, body: options.body.slice(0, 65_000), maintainer_can_modify: true });
  }
}
