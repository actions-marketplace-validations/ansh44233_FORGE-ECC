import { analyzeRepository, type RepoProfile } from "./repo-analysis.js";
import { computeRemoteDoctor, readRepository, remoteShield, runRemoteSetup, type AppContext, type RemoteDoctor } from "./app-handlers.js";
import { assessPullRequestRisk, type PullRequestRisk } from "./pr-risk.js";
import type { ShieldReport } from "../core/forge-shield.js";

/**
 * Data for the hosted FORGE dashboard (forge-ecc.vercel.app/app).
 * Every function takes an installation client already scoped to one repository.
 */

export interface DashboardEvent { at: string; event: string; action: string; detail?: string; url?: string }

export interface RepoOverview {
  repository: { fullName: string; defaultBranch: string; private: boolean };
  generatedAt: string;
  profile: RepoProfile;
  setup: RemoteDoctor;
  shield: Pick<ShieldReport, "score" | "grade" | "summary" | "filesScanned" | "findings">;
  pulls: Array<{ number: number; title: string; url: string; author: string; draft: boolean; risk: Pick<PullRequestRisk, "score" | "level" | "reasons" | "stats" | "suggestedReviewers"> }>;
  history: DashboardEvent[];
}

interface PullSummary { number: number; title: string; html_url: string; draft?: boolean; user?: { login?: string } }

export async function buildRepoOverview(context: AppContext, owner: string, repo: string, history: DashboardEvent[] = []): Promise<RepoOverview> {
  const { client } = context;
  const repository = await client.getRepository(owner, repo);
  const ref = repository.default_branch;
  const data = await readRepository(client, owner, repo, ref);
  const files = data.entries.filter(entry => entry.type === "blob").map(entry => entry.path).filter(file => !/^\.forge\/|(?:^|\/)forge-[\w.-]+(?:\/SKILL)?\.(?:md|mdc|toml)$/.test(file));
  const profile = analyzeRepository({ name: `${owner}/${repo}`, files, manifests: data.manifests, commits: data.commits.map(commit => commit.message) });
  const [setup, shield, pulls] = await Promise.all([
    computeRemoteDoctor(context, owner, repo, { ref, entries: data.entries }),
    remoteShield(client, owner, repo, ref, data.entries),
    client.request<PullSummary[]>("GET", `${client.repo(owner, repo)}/pulls?state=open&per_page=6&sort=updated`).catch(() => [] as PullSummary[]),
  ]);
  const scoredPulls = await Promise.all(pulls.slice(0, 6).map(async pull => {
    const risk = assessPullRequestRisk(await client.listPullFiles(owner, repo, pull.number, 1).catch(() => []));
    return { number: pull.number, title: pull.title, url: pull.html_url, author: pull.user?.login ?? "", draft: Boolean(pull.draft), risk: { score: risk.score, level: risk.level, reasons: risk.reasons.slice(0, 5), stats: risk.stats, suggestedReviewers: risk.suggestedReviewers } };
  }));
  return {
    repository: { fullName: repository.full_name, defaultBranch: ref, private: repository.private },
    generatedAt: (context.now ?? (() => new Date()))().toISOString(),
    profile,
    setup,
    shield: { score: shield.score, grade: shield.grade, summary: shield.summary, filesScanned: shield.filesScanned, findings: shield.findings.slice(0, 50) },
    pulls: scoredPulls,
    history: history.slice(0, 25),
  };
}

export type DashboardAction = "analyze" | "repair";

export async function runDashboardAction(context: AppContext, owner: string, repo: string, action: DashboardAction, login: string): Promise<{ url?: string; upToDate: boolean; created: number; updated: number; shieldScore: number }> {
  const permission = await context.client.getCollaboratorPermission(owner, repo, login);
  if (!["admin", "maintain", "write"].includes(permission)) throw new Error("You need write access to this repository to open FORGE pull requests.");
  const outcome = await runRemoteSetup(context, owner, repo, action);
  return { ...(outcome.pull ? { url: outcome.pull.html_url } : {}), upToDate: !outcome.pull, created: outcome.setup.created.length, updated: outcome.setup.updated.length, shieldScore: outcome.shield.score };
}

export function parseRepoFullName(value: unknown): { owner: string; repo: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (!match || match[2] === "." || match[2] === "..") return undefined;
  return { owner: match[1] as string, repo: match[2] as string };
}
