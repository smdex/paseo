import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { dispatchGetCheckoutStatus } from "../utils/checkout-dispatch.js";
import { createScratchJjRepo, isJjAvailable } from "../test-utils/jj.js";
import { resolveJjRepoIdentity } from "../utils/vcs-backend.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

interface WatchEvent {
  path: string;
  type: "create" | "update" | "delete";
}

interface WatchRecord {
  directory: string;
  callback: (error: Error | null, events: WatchEvent[]) => void;
  ignore: Array<string | RegExp>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function createWatcherHarness() {
  const records: WatchRecord[] = [];
  const subscribe = vi.fn(
    async (
      directory: string,
      callback: WatchRecord["callback"],
      options?: { ignore?: Array<string | RegExp> },
    ) => {
      const unsubscribe = vi.fn(async () => {});
      records.push({
        directory,
        callback,
        ignore: options?.ignore ?? [],
        unsubscribe,
      });
      return { updateIgnore: vi.fn(async () => {}), unsubscribe };
    },
  );
  return { records, subscribe };
}

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function recordsFor(
  watcher: ReturnType<typeof createWatcherHarness>,
  directory: string,
): WatchRecord[] {
  return watcher.records.filter((record) => record.directory === directory);
}

describe.skipIf(!isJjAvailable())("WorkspaceGitService jj observation", () => {
  const fixtures: ReturnType<typeof createScratchJjRepo>[] = [];
  let previousJjRate: string | undefined;

  function fixture(options?: Parameters<typeof createScratchJjRepo>[0]) {
    const created = createScratchJjRepo(options);
    fixtures.push(created);
    return created;
  }

  beforeAll(() => {
    previousJjRate = process.env.PASEO_JJ_MAX_PROCESSES_PER_SECOND;
    process.env.PASEO_JJ_MAX_PROCESSES_PER_SECOND = "10000";
  });

  afterAll(() => {
    if (previousJjRate === undefined) {
      delete process.env.PASEO_JJ_MAX_PROCESSES_PER_SECOND;
    } else {
      process.env.PASEO_JJ_MAX_PROCESSES_PER_SECOND = previousJjRate;
    }
    for (const created of fixtures.splice(0)) {
      created.dispose();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createJjService(
    watcher: ReturnType<typeof createWatcherHarness>,
    overrides?: {
      statusCalls?: string[];
      hasOriginRemote?: ReturnType<typeof vi.fn>;
      runGitFetch?: ReturnType<typeof vi.fn>;
      gitCommandCalls?: string[][];
    },
  ) {
    return new WorkspaceGitServiceImpl({
      logger: createLogger(),
      paseoHome: "/tmp/paseo-jj-home",
      deps: {
        subscribe: watcher.subscribe,
        getCheckoutStatus: async (cwd: string, context?: unknown) => {
          overrides?.statusCalls?.push(cwd);
          return dispatchGetCheckoutStatus(
            cwd,
            context as Parameters<typeof dispatchGetCheckoutStatus>[1],
          );
        },
        hasOriginRemote:
          overrides?.hasOriginRemote ??
          vi.fn(async () => {
            throw new Error("hasOriginRemote must not run for jj repositories");
          }),
        runGitFetch:
          overrides?.runGitFetch ??
          vi.fn(async () => {
            throw new Error("git fetch must not run for jj repositories");
          }),
        ...(overrides?.gitCommandCalls
          ? {
              runGitCommand: vi.fn(async (args: string[]) => {
                overrides.gitCommandCalls?.push(args);
                return { stdout: "", stderr: "", truncated: false, exitCode: 0, signal: null };
              }),
            }
          : {}),
        createWatcherLivenessCanary: vi.fn(() => ({
          path: "",
          filterEvents: (events: WatchEvent[]) => events,
          verify: vi.fn(async () => {}),
        })),
      },
    });
  }

  async function waitForSnapshot(
    service: ReturnType<typeof createJjService>,
    cwd: string,
  ): Promise<void> {
    await vi.waitFor(
      () => {
        expect(service.peekSnapshot(cwd)?.git.isGit).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
  }

  beforeEach(() => {
    vi.setConfig({ testTimeout: 60_000 });
  });

  test("observes a colocated jj repo via the shared store, .git, and .jj exclusion", async () => {
    const fixtureRepo = fixture({ files: { "README.md": "hello\n" } });
    const watcher = createWatcherHarness();
    const statusCalls: string[] = [];
    const service = createJjService(watcher, { statusCalls });
    const subscription = service.registerWorkspace({ cwd: fixtureRepo.repoDir }, () => {});
    try {
      await waitForSnapshot(service, fixtureRepo.repoDir);
      const snapshot = await service.getSnapshot(fixtureRepo.repoDir);
      expect(snapshot.git.vcs).toBe("jj");
      expect(snapshot.git.changeId).toBeTruthy();

      const identity = resolveJjRepoIdentity(fixtureRepo.repoDir);
      expect(identity).not.toBeNull();

      // Repository metadata observation anchors on the shared store with no
      // git-relative pruning, and colocated repos keep the `.git` dir under
      // observation beside it.
      const storeRecords = recordsFor(watcher, identity!.sharedStorePath);
      expect(storeRecords.length).toBeGreaterThan(0);
      expect(storeRecords[0]!.ignore).toEqual([]);
      expect(recordsFor(watcher, join(fixtureRepo.repoDir, ".git")).length).toBeGreaterThan(0);

      // The working-tree watch excludes `.jj` alongside `.git`.
      const workingTree = recordsFor(watcher, fixtureRepo.repoDir);
      expect(workingTree.length).toBeGreaterThan(0);
      expect(workingTree[0]!.ignore).toContain(join(fixtureRepo.repoDir, ".jj"));
      expect(workingTree[0]!.ignore).toContain(join(fixtureRepo.repoDir, ".git"));

      // The git fetch cadence never starts for jj repositories.
      expect(statusCalls.length).toBeGreaterThan(0);
    } finally {
      subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("external jj describe refreshes through the store watch; own published echo does not", async () => {
    const fixtureRepo = fixture({
      colocate: false,
      files: { "README.md": "hello\n" },
    });
    const watcher = createWatcherHarness();
    const statusCalls: string[] = [];
    const service = createJjService(watcher, { statusCalls });
    const snapshots: string[] = [];
    const subscription = service.registerWorkspace({ cwd: fixtureRepo.repoDir }, (snapshot) => {
      snapshots.push(snapshot.git.changeId ?? "");
    });
    try {
      await waitForSnapshot(service, fixtureRepo.repoDir);
      const identity = resolveJjRepoIdentity(fixtureRepo.repoDir)!;
      const storeRecord = recordsFor(watcher, identity.sharedStorePath)[0]!;
      const callsAfterInitial = statusCalls.length;
      const initialChangeId = service.peekSnapshot(fixtureRepo.repoDir)!.git.changeId;

      // Own, already-published echo: no operation landed since the snapshot
      // was read, so the publication fence suppresses the refresh.
      storeRecord.callback(null, [
        { path: join(identity.sharedStorePath, "op_store", "operations", "echo"), type: "create" },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(statusCalls.length).toBe(callsAfterInitial);

      // External operation: start a new change outside Paseo. `jj new` moves
      // @ to a fresh change id, which the next facts read must observe.
      const external = fixtureRepo.jj(["new", "-m", "external change"]);
      expect(external.status).toBe(0);
      expect(service.peekSnapshot(fixtureRepo.repoDir)!.git.changeId).toBe(initialChangeId);

      storeRecord.callback(null, [
        {
          path: join(identity.sharedStorePath, "op_store", "operations", "external"),
          type: "create",
        },
      ]);
      await vi.waitFor(
        () => {
          expect(statusCalls.length).toBeGreaterThan(callsAfterInitial);
        },
        { timeout: 15_000, interval: 100 },
      );
      await vi.waitFor(
        () => {
          expect(service.peekSnapshot(fixtureRepo.repoDir)!.git.changeId).not.toBe(initialChangeId);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect(snapshots.length).toBeGreaterThan(0);
    } finally {
      subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("working_copy churn under .jj does not refresh the working tree", async () => {
    const fixtureRepo = fixture({
      colocate: false,
      files: { "README.md": "hello\n" },
    });
    const watcher = createWatcherHarness();
    const statusCalls: string[] = [];
    const service = createJjService(watcher, { statusCalls });
    const subscription = service.registerWorkspace({ cwd: fixtureRepo.repoDir }, () => {});
    try {
      await waitForSnapshot(service, fixtureRepo.repoDir);
      const workingTree = recordsFor(watcher, fixtureRepo.repoDir)[0]!;
      const callsAfterInitial = statusCalls.length;

      workingTree.callback(null, [
        {
          path: join(fixtureRepo.repoDir, ".jj", "working_copy", "working_copy.lock"),
          type: "update",
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(statusCalls.length).toBe(callsAfterInitial);
    } finally {
      subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("colocated git events route through the git metadata rules", async () => {
    const fixtureRepo = fixture({ files: { "README.md": "hello\n" } });
    const watcher = createWatcherHarness();
    const statusCalls: string[] = [];
    const service = createJjService(watcher, { statusCalls });
    const subscription = service.registerWorkspace({ cwd: fixtureRepo.repoDir }, () => {});
    try {
      await waitForSnapshot(service, fixtureRepo.repoDir);
      const gitDir = join(fixtureRepo.repoDir, ".git");
      const gitRecord = recordsFor(watcher, gitDir)[0]!;
      const callsAfterInitial = statusCalls.length;

      // HEAD moving in the colocated `.git` (owner-routed, refreshBase) —
      // the hybrid-workflow signal git rules already know how to route.
      gitRecord.callback(null, [{ path: join(gitDir, "HEAD"), type: "update" }]);
      await vi.waitFor(
        () => {
          expect(statusCalls.length).toBeGreaterThan(callsAfterInitial);
        },
        { timeout: 15_000, interval: 100 },
      );
    } finally {
      subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("native jj uses the static ignore floor and colocated uses git evaluation", async () => {
    const nativeRepo = fixture({ colocate: false, files: { "README.md": "hello\n" } });
    mkdirSync(join(nativeRepo.repoDir, "node_modules", "some-pkg"), { recursive: true });
    const gitCommandCalls: string[][] = [];
    const nativeWatcher = createWatcherHarness();
    const nativeService = createJjService(nativeWatcher, { statusCalls: [], gitCommandCalls });
    const nativeSubscription = nativeService.registerWorkspace(
      { cwd: nativeRepo.repoDir },
      () => {},
    );
    try {
      await waitForSnapshot(nativeService, nativeRepo.repoDir);
      const nativeWorkingTree = recordsFor(nativeWatcher, nativeRepo.repoDir)[0]!;
      expect(nativeWorkingTree.ignore).toContain(join(nativeRepo.repoDir, "node_modules"));
      // No git ls-files evaluation ran against the native jj checkout.
      expect(gitCommandCalls.filter((args) => args[0] === "ls-files")).toEqual([]);
    } finally {
      nativeSubscription.unsubscribe();
      await nativeService.dispose();
    }

    const colocatedRepo = fixture({ files: { "README.md": "hello\n" } });
    mkdirSync(join(colocatedRepo.repoDir, "ignored-dir", "nested"), { recursive: true });
    writeFileSync(join(colocatedRepo.repoDir, ".gitignore"), "ignored-dir/\n");
    execSync("git add .gitignore && git commit -q -m gitignore", {
      cwd: colocatedRepo.repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Paseo Test",
        GIT_AUTHOR_EMAIL: "paseo-test@example.invalid",
        GIT_COMMITTER_NAME: "Paseo Test",
        GIT_COMMITTER_EMAIL: "paseo-test@example.invalid",
      },
    });
    const colocatedWatcher = createWatcherHarness();
    const colocatedService = createJjService(colocatedWatcher, { statusCalls: [] });
    const colocatedSubscription = colocatedService.registerWorkspace(
      { cwd: colocatedRepo.repoDir },
      () => {},
    );
    try {
      await waitForSnapshot(colocatedService, colocatedRepo.repoDir);
      const colocatedWorkingTree = recordsFor(colocatedWatcher, colocatedRepo.repoDir)[0]!;
      expect(colocatedWorkingTree.ignore).toContain(join(colocatedRepo.repoDir, "ignored-dir"));
    } finally {
      colocatedSubscription.unsubscribe();
      await colocatedService.dispose();
    }
  });

  test("a native jj repo with a remote never starts the git fetch cadence", async () => {
    const fixtureRepo = fixture({ colocate: false, files: { "README.md": "hello\n" } });
    // A bare git remote so facts report a remote URL.
    execSync("git init --bare origin.git", { cwd: fixtureRepo.dir });
    const remote = fixtureRepo.jj([
      "git",
      "remote",
      "add",
      "origin",
      join(fixtureRepo.dir, "origin.git"),
    ]);
    expect(remote.status).toBe(0);

    const watcher = createWatcherHarness();
    const hasOriginRemote = vi.fn(async () => true);
    const runGitFetch = vi.fn(async () => {
      throw new Error("git fetch must not run");
    });
    const service = createJjService(watcher, {
      statusCalls: [],
      hasOriginRemote,
      runGitFetch,
    });
    const subscription = service.registerWorkspace({ cwd: fixtureRepo.repoDir }, () => {});
    try {
      await waitForSnapshot(service, fixtureRepo.repoDir);
      const snapshot = await service.getSnapshot(fixtureRepo.repoDir);
      expect(snapshot.git.hasRemote).toBe(true);
      expect(hasOriginRemote).not.toHaveBeenCalled();
      expect(runGitFetch).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
      await service.dispose();
    }
  });
});
