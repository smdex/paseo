const fs = require("node:fs");
const path = require("node:path");

// This extends the worker's existing external gh adapter, only for a seeded fixture.
module.exports = function handlePullRequestMutations(args, origin) {
  const statePath = path.join(process.cwd(), ".git", "paseo-e2e-pr-mutations.json");
  if (origin !== "https://github.com/paseo-e2e/local-fixture.git" || !fs.existsSync(statePath))
    return false;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const command = args.slice(0, 2).join(" ");
  const pr = {
    number: state.number,
    title: "Native published request",
    url: `https://github.com/paseo-e2e/local-fixture/pull/${state.number}`,
    state: state.merged ? "MERGED" : "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: state.headSha,
    headRepositoryOwner: { login: "paseo-e2e" },
    mergedAt: state.merged ? "2026-01-01T00:00:00Z" : null,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    statusCheckRollup: [],
    mergeStateStatus: state.blocked ? "BLOCKED" : "CLEAN",
    autoMergeRequest: state.autoMergeEnabled
      ? {
          enabledAt: "2026-01-01T00:00:00Z",
          mergeMethod: "SQUASH",
          enabledBy: { login: "paseo-e2e" },
        }
      : null,
    viewerCanEnableAutoMerge: true,
    viewerCanDisableAutoMerge: true,
    viewerCanMergeAsAdmin: false,
    viewerCanUpdateBranch: false,
    isMergeQueueEnabled: false,
    isInMergeQueue: false,
  };
  const repository = {
    owner: { login: "paseo-e2e" },
    name: "local-fixture",
    isFork: false,
    parent: null,
    autoMergeAllowed: true,
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    viewerDefaultMergeMethod: "SQUASH",
    pullRequest: pr,
    pullRequests: { nodes: [pr] },
  };
  function send(value) {
    process.stdout.write(JSON.stringify(value));
    return true;
  }
  if (command === "auth status") return true;
  if (command === "repo view") return send(repository);
  if (command === "pr view") return send(pr);
  if (command === "pr list") return send([pr]);
  if (args[0] === "api" && args[1]?.startsWith("repos/paseo-e2e/local-fixture/pulls?"))
    return send([
      {
        number: state.number,
        state: state.merged ? "closed" : "open",
        head: {
          ref: "feature",
          sha: state.headSha,
          repo: { full_name: "paseo-e2e/local-fixture" },
        },
        base: { repo: { full_name: "paseo-e2e/local-fixture" } },
      },
    ]);
  if (command === "api graphql") {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    const data = {
      repository,
      rateLimit: { limit: 10000, remaining: 9999, resetAt: "2099-01-01T00:00:00Z" },
    };
    for (const match of query.matchAll(/(t\d+):\s*repository\(/g)) data[match[1]] = repository;
    return send({ data });
  }
  if (command === "pr merge") return mutatePullRequest(args, state, statePath);
  return false;
};

function mutatePullRequest(args, state, statePath) {
  let operation = "merge";
  if (args.includes("--disable-auto")) operation = "disable";
  else if (args.includes("--auto")) operation = "enable";
  state.commands.push({ operation, args });
  fs.writeFileSync(statePath, JSON.stringify(state));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  if (state.fail) {
    process.stderr.write("Provider refused the captured PR. Retry when eligible.\n");
    process.exitCode = 1;
    return true;
  }
  if (args[args.indexOf("--repo") + 1] !== "github.com/paseo-e2e/local-fixture") {
    process.stderr.write("Expected explicit native PR target\n");
    process.exitCode = 1;
    return true;
  }
  if (operation === "merge") state.merged = true;
  else state.autoMergeEnabled = operation === "enable";
  fs.writeFileSync(statePath, JSON.stringify(state));
  return true;
}
