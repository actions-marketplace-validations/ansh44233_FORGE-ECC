/**
 * Pull request risk scoring from the changed-file list alone (no checkout needed).
 * Explainable: every point of the score comes with a reason.
 */

export interface ChangedFile { filename: string; status: string; additions: number; deletions: number; previous_filename?: string }
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskReason { points: number; reason: string; files?: string[] }

export interface PullRequestRisk {
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  stats: { files: number; additions: number; deletions: number; sourceFiles: number; testFiles: number };
  suggestedReviewers: string[];
}

interface SensitiveArea { id: string; points: number; pattern: RegExp; reason: string; reviewer: string }

const AREAS: SensitiveArea[] = [
  { id: "agent-config", points: 25, pattern: /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|\.gemini\/settings\.json|\.claude\/hooks\/|\.forge\/harness-hooks\.json)$|(?:^|\/)\.claude\/hooks\//, reason: "Changes agent permissions, hooks or MCP servers", reviewer: "security-reviewer" },
  { id: "ci", points: 20, pattern: /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\/|(?:^|\/)action\.ya?ml$/, reason: "Changes CI/CD pipelines (runs with repository secrets)", reviewer: "devops-engineer" },
  { id: "auth", points: 20, pattern: /(?:^|\/)(?:auth|authn|authz|login|oauth|session|permission|rbac|acl|security|crypto|jwt|password)[\w.-]*(?:\/|\.)/i, reason: "Touches authentication, authorization or cryptography", reviewer: "security-reviewer" },
  { id: "secrets", points: 30, pattern: /(?:^|\/)(?:\.env(?!\.(?:example|sample|template)$)(?:\.[\w-]+)?|[^/]+\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|credentials\.json)$/i, reason: "Adds or changes a secret/credential file", reviewer: "security-reviewer" },
  { id: "migrations", points: 15, pattern: /(?:^|\/)(?:migrations?|migrate|schema\.prisma|alembic)\/|(?:^|\/)schema\.prisma$|\.sql$/i, reason: "Changes database schema or migrations", reviewer: "database-reviewer" },
  { id: "dependencies", points: 8, pattern: /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|requirements[\w-]*\.txt|pyproject\.toml|poetry\.lock|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?)$/, reason: "Changes dependencies (supply-chain surface)", reviewer: "security-reviewer" },
  { id: "infra", points: 12, pattern: /(?:^|\/)(?:Dockerfile|docker-compose[\w.-]*\.ya?ml|[\w-]+\.tf|vercel\.json|netlify\.toml|fly\.toml|k8s\/|helm\/|terraform\/)/i, reason: "Changes deployment or infrastructure configuration", reviewer: "devops-engineer" },
  { id: "payments", points: 15, pattern: /(?:^|\/)[\w./-]*(?:billing|payment|checkout|stripe|invoice|subscription)[\w.-]*(?:\/|\.)/i, reason: "Touches billing or payments", reviewer: "code-reviewer" },
];

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala|vue|svelte|dart|c|cc|cpp|h)$/i;
const TEST = /(?:^|\/)(?:tests?|__tests__|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|Test\.(?:java|kt)$/;
const GENERATED = /(?:^|\/)(?:dist|build|vendor|node_modules)\/|\.min\.(?:js|css)$|(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json|poetry\.lock|Cargo\.lock|go\.sum)$/;

export function assessPullRequestRisk(files: readonly ChangedFile[]): PullRequestRisk {
  const reasons: RiskReason[] = [];
  const reviewers = new Set<string>(["code-reviewer"]);
  const names = files.map(file => file.filename);
  for (const area of AREAS) {
    const matched = names.filter(name => area.pattern.test(name));
    if (!matched.length) continue;
    reasons.push({ points: area.points, reason: area.reason, files: matched.slice(0, 10) });
    reviewers.add(area.reviewer);
  }

  const meaningful = files.filter(file => !GENERATED.test(file.filename));
  const additions = meaningful.reduce((sum, file) => sum + file.additions, 0);
  const deletions = meaningful.reduce((sum, file) => sum + file.deletions, 0);
  const churn = additions + deletions;
  if (churn > 1500) reasons.push({ points: 20, reason: `Very large change (${churn} lines) — hard to review thoroughly; consider splitting` });
  else if (churn > 600) reasons.push({ points: 12, reason: `Large change (${churn} lines)` });
  else if (churn > 250) reasons.push({ points: 5, reason: `Medium-sized change (${churn} lines)` });
  if (meaningful.length > 40) reasons.push({ points: 8, reason: `Touches ${meaningful.length} files` });

  const sourceFiles = meaningful.filter(file => SOURCE.test(file.filename) && !TEST.test(file.filename));
  const testFiles = meaningful.filter(file => TEST.test(file.filename));
  const sourceChurn = sourceFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (sourceFiles.length && !testFiles.length && sourceChurn >= 20) {
    reasons.push({ points: 15, reason: `Source changed (${sourceFiles.length} files, ${sourceChurn} lines) without any test changes`, files: sourceFiles.slice(0, 10).map(f => f.filename) });
    reviewers.add("test-engineer");
  }
  const removedTests = files.filter(file => file.status === "removed" && TEST.test(file.filename));
  if (removedTests.length) reasons.push({ points: 12, reason: "Deletes test files", files: removedTests.map(f => f.filename).slice(0, 10) });
  const renamed = files.filter(file => file.status === "renamed" && file.previous_filename && SOURCE.test(file.filename));
  if (renamed.length >= 5) reasons.push({ points: 4, reason: `Renames ${renamed.length} source files (check imports and references)` });

  const score = Math.min(100, reasons.reduce((sum, item) => sum + item.points, 0));
  const level: RiskLevel = score >= 60 ? "critical" : score >= 35 ? "high" : score >= 15 ? "medium" : "low";
  return {
    score,
    level,
    reasons: reasons.sort((a, b) => b.points - a.points),
    stats: { files: files.length, additions, deletions, sourceFiles: sourceFiles.length, testFiles: testFiles.length },
    suggestedReviewers: [...reviewers],
  };
}

export function formatRiskMarkdown(risk: PullRequestRisk): string {
  const badge = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" }[risk.level];
  const lines = [
    `### ${badge} Change risk: ${risk.level} (${risk.score}/100)`,
    "",
    `${risk.stats.files} files · +${risk.stats.additions} / −${risk.stats.deletions} · ${risk.stats.sourceFiles} source · ${risk.stats.testFiles} test`,
    "",
  ];
  if (!risk.reasons.length) lines.push("No elevated-risk signals in the changed files.");
  else {
    lines.push("| Points | Why |", "|---:|---|");
    for (const item of risk.reasons) lines.push(`| +${item.points} | ${item.reason}${item.files?.length ? `<br><sub>${item.files.slice(0, 5).map(f => `\`${f}\``).join(", ")}${item.files.length > 5 ? " …" : ""}</sub>` : ""} |`);
  }
  lines.push("", `Suggested FORGE reviewers: ${risk.suggestedReviewers.map(r => `\`${r}\``).join(", ")}`);
  return lines.join("\n");
}
