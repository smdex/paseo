import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectVcsBackend,
  isVersionAtLeast,
  parseJjVersion,
  resetJjRuntimeCache,
  resolveJjRepoIdentity,
  resolveJjRuntime,
} from "./vcs-backend";
import { createScratchJjRepo, isJjAvailable } from "../test-utils/jj";

const jjAvailable = isJjAvailable();

// Detection is pure fs: these fixtures do NOT need the jj binary.
describe("detectVcsBackend", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paseo-vcs-detect-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function subdir(...segments: string[]): string {
    const target = join(dir, ...segments);
    mkdirSync(target, { recursive: true });
    return target;
  }

  it("returns none for a plain directory", () => {
    expect(detectVcsBackend(subdir("plain"))).toBe("none");
  });

  it("detects a git repo and its subdirectories", () => {
    mkdirSync(join(subdir("gitrepo"), ".git"));
    expect(detectVcsBackend(join(dir, "gitrepo"))).toBe("git");
    expect(detectVcsBackend(subdir("gitrepo", "nested", "deeper"))).toBe("git");
  });

  it("detects a jj repo (marker only) and its subdirectories", () => {
    mkdirSync(join(subdir("jjrepo"), ".jj"));
    expect(detectVcsBackend(join(dir, "jjrepo"))).toBe("jj");
    expect(detectVcsBackend(subdir("jjrepo", "nested", "deeper"))).toBe("jj");
  });

  it("prefers jj when one directory holds both markers (colocated layout)", () => {
    const colocated = subdir("colocated");
    mkdirSync(join(colocated, ".git"));
    mkdirSync(join(colocated, ".jj"));
    expect(detectVcsBackend(colocated)).toBe("jj");
  });

  it("keeps a nested git repo inside a jj repo on git", () => {
    mkdirSync(join(subdir("outer-jj"), ".jj"));
    const nested = subdir("outer-jj", "inner-git");
    mkdirSync(join(nested, ".git"));
    expect(detectVcsBackend(nested)).toBe("git");
    expect(detectVcsBackend(subdir("outer-jj", "inner-git", "deep"))).toBe("git");
    expect(detectVcsBackend(subdir("outer-jj", "plain-sibling"))).toBe("jj");
  });

  it("keeps a nested jj repo inside a git repo on jj", () => {
    mkdirSync(join(subdir("outer-git"), ".git"));
    const nested = subdir("outer-git", "inner-jj");
    mkdirSync(join(nested, ".jj"));
    expect(detectVcsBackend(nested)).toBe("jj");
    expect(detectVcsBackend(subdir("outer-git", "plain-sibling"))).toBe("git");
  });

  it("is marker-based, not content-based: an empty .jj directory still counts", () => {
    mkdirSync(join(subdir("empty-marker"), ".jj"), { recursive: true });
    expect(detectVcsBackend(join(dir, "empty-marker"))).toBe("jj");
  });
});

describe("parseJjVersion", () => {
  it("parses `jj 0.45.1` output", () => {
    expect(parseJjVersion("jj 0.45.1\n")).toBe("0.45.1");
  });

  it("rejects malformed output", () => {
    expect(parseJjVersion("not jj")).toBeNull();
    expect(parseJjVersion("")).toBeNull();
    expect(parseJjVersion("jj dev")).toBeNull();
  });
});

describe("isVersionAtLeast", () => {
  it("compares numeric segments", () => {
    expect(isVersionAtLeast("0.45.1", "0.45.0")).toBe(true);
    expect(isVersionAtLeast("0.45.0", "0.45.0")).toBe(true);
    expect(isVersionAtLeast("0.44.9", "0.45.0")).toBe(false);
    expect(isVersionAtLeast("1.0.0", "0.45.0")).toBe(true);
    expect(isVersionAtLeast("0.46.0", "0.45.9")).toBe(true);
  });
});

describe("resolveJjRuntime", () => {
  beforeEach(() => {
    resetJjRuntimeCache();
  });

  afterEach(() => {
    resetJjRuntimeCache();
    delete process.env.PASEO_DISABLE_JJ;
  });

  it("is disabled when PASEO_DISABLE_JJ=1", async () => {
    process.env.PASEO_DISABLE_JJ = "1";
    const probe = await resolveJjRuntime();
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe("disabled");
  });

  describe.skipIf(!jjAvailable)("with the real binary", () => {
    it("probes ok with the installed version", async () => {
      const probe = await resolveJjRuntime();
      expect(probe.ok).toBe(true);
      expect(probe.version).not.toBeNull();
    });

    it("caches the probe across calls", async () => {
      const first = resolveJjRuntime();
      const second = resolveJjRuntime();
      expect(first).toBe(second);
      expect(await first).toEqual(await second);
    });
  });

  if (process.env.CI) {
    it("asserts jj is present on CI (a skip here means the pinned install broke)", () => {
      expect(jjAvailable).toBe(true);
    });
  }
});

describe.skipIf(!jjAvailable)("resolveJjRepoIdentity", () => {
  describe("colocated repo", () => {
    let fixture: ReturnType<typeof createScratchJjRepo>;

    beforeEach(() => {
      fixture = createScratchJjRepo({ files: { "a.txt": "x\n" } });
    });

    afterEach(() => {
      fixture.dispose();
    });

    it("resolves identity for the repo root and subdirectories", () => {
      mkdirSync(join(fixture.repoDir, "sub"));
      for (const cwd of [fixture.repoDir, join(fixture.repoDir, "sub")]) {
        const identity = resolveJjRepoIdentity(cwd);
        expect(identity).not.toBeNull();
        expect(identity?.workspaceRoot).toBe(fixture.repoDir);
        expect(identity?.sharedStorePath).toBe(join(fixture.repoDir, ".jj", "repo"));
        expect(identity?.primaryRoot).toBe(fixture.repoDir);
        expect(identity?.colocated).toBe(true);
      }
    });
  });

  describe("native (non-colocated) repo", () => {
    let fixture: ReturnType<typeof createScratchJjRepo>;

    beforeEach(() => {
      fixture = createScratchJjRepo({ colocate: false, files: { "a.txt": "x\n" } });
    });

    afterEach(() => {
      fixture.dispose();
    });

    it("reports colocated false", () => {
      const identity = resolveJjRepoIdentity(fixture.repoDir);
      expect(identity).not.toBeNull();
      expect(identity?.colocated).toBe(false);
      expect(identity?.primaryRoot).toBe(fixture.repoDir);
    });
  });

  describe("secondary workspace", () => {
    let fixture: ReturnType<typeof createScratchJjRepo>;
    let workspaceDir: string;

    beforeEach(() => {
      fixture = createScratchJjRepo({ files: { "a.txt": "x\n" } });
      workspaceDir = join(fixture.dir, "secondary");
      const added = fixture.jj(["workspace", "add", workspaceDir, "--name", "secondary"]);
      expect(added.status).toBe(0);
    });

    afterEach(() => {
      fixture.dispose();
    });

    it("resolves through the pointer file to the shared store and primary root", () => {
      const identity = resolveJjRepoIdentity(workspaceDir);
      expect(identity).not.toBeNull();
      expect(identity?.workspaceRoot).toBe(workspaceDir);
      expect(identity?.sharedStorePath).toBe(join(fixture.repoDir, ".jj", "repo"));
      expect(identity?.primaryRoot).toBe(fixture.repoDir);
      expect(identity?.colocated).toBe(true);
    });
  });

  it("returns null outside any jj repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-vcs-none-"));
    try {
      expect(resolveJjRepoIdentity(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the .jj layout is unreadable (repo mid-teardown)", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-vcs-broken-"));
    try {
      mkdirSync(join(dir, ".jj"));
      writeFileSync(join(dir, ".jj", "repo"), ""); // empty pointer file
      expect(resolveJjRepoIdentity(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
