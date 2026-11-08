#!/usr/bin/env python3
"""Rebase fork main on upstream main, then mirror the rebased main to the
GitHub fork (canonical) and the GitLab project that runs this pipeline."""

import os
import re
import subprocess
import tempfile
from pathlib import Path

FORK_URL = "https://github.com/smdex/paseo.git"
UPSTREAM_URL = "https://github.com/getpaseo/paseo.git"
BRANCH = "main"
STABLE_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
# Any fork release tag for a base version counts as "already released", across
# both historic spellings (v0.11.2-smdex, v0.15.0-smdex.2).
MAPPED_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)-smdex(?:\.\d+)?$")


def git(repo, *args, check=True):
    result = subprocess.run(
        ["git", "-c", "gc.auto=0", "-c", "maintenance.auto=false", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode:
        raise RuntimeError(f"git {args[0]} failed:\n{result.stderr}")
    return result


def output(repo, *args):
    return git(repo, *args).stdout.strip()


def conflicted(repo):
    return git(repo, "diff", "--name-only", "--diff-filter=U").stdout.split()


def rebase(repo, onto):
    """Rebase onto `onto`; on conflict abort and fail without touching remotes."""
    result = git(repo, "rebase", onto, check=False)
    if not result.returncode:
        return
    paths = conflicted(repo)
    git(repo, "rebase", "--abort", check=False)
    detail = f"Conflicts in: {', '.join(paths)}" if paths else "no unmerged paths"
    raise RuntimeError(
        f"Rebase aborted; remotes unchanged. {detail}\n{result.stderr}"
    )


def require_linear_fork_history(repo, original, onto):
    """Reject fork-only merge commits: a linear rebase replays their parents and
    silently drops changes that only exist in the merge resolution."""
    merges = git(repo, "rev-list", "--merges", original, f"^{onto}").stdout.split()
    if merges:
        raise RuntimeError(
            f"Fork history has {len(merges)} merge commit(s) not present upstream "
            f"(e.g. {merges[0][:12]}); a linear rebase would drop their merge "
            "resolutions. Flatten them into regular fork commits before the next "
            "sync. Remotes unchanged."
        )


def require_mirror_behind(repo, original):
    """Reject GitLab-only work; return the checked OID for the later push lease."""
    git(repo, "fetch", "--no-tags", "mirror", f"+refs/heads/{BRANCH}:refs/mirror-main")
    ahead = git(repo, "rev-list", "--count", f"{original}..refs/mirror-main")
    if ahead.stdout.strip() != "0":
        raise RuntimeError(
            f"GitLab {BRANCH} is {ahead.stdout.strip()} commit(s) ahead of the "
            f"cloned GitHub {BRANCH}; reconcile both histories before rerunning "
            "(see docs/development.md, Upstream sync recovery)."
        )
    return output(repo, "rev-parse", "refs/mirror-main")


def newest_upstream_stable(repo):
    """Highest vX.Y.Z tag on upstream; prerelease-suffixed tags are ignored."""
    git(repo, "fetch", "--no-tags", "upstream", "refs/tags/v*:refs/tags/v*")
    tags = output(
        repo, "for-each-ref", "--format=%(refname:short)", "refs/tags"
    ).splitlines()
    stable = [t for t in tags if STABLE_TAG.fullmatch(t)]
    return max(stable, key=lambda t: tuple(int(n) for n in t[1:].split("."))) if stable else None


def remote_smdex_tags(repo, remote):
    listing = git(repo, "ls-remote", "--tags", remote, "refs/tags/*smdex*").stdout
    return {
        line.split("\t")[1][len("refs/tags/") :]
        for line in listing.splitlines()
        if line and not line.endswith("^{}")
    }


def base_of(tag):
    m = MAPPED_TAG.fullmatch(tag)
    return f"v{m.group(1)}.{m.group(2)}.{m.group(3)}" if m else None


def release_new_upstream_stable(repo):
    """Tag the synced HEAD vX.Y.Z-smdex.1 when upstream's newest stable release
    still has no fork release tag. Plain upstream tags are never mirrored: a
    pushed upstream-numbered tag would build releases of non-fork code. Older
    unmapped releases are deliberately never backfilled."""
    upstream_tag = newest_upstream_stable(repo)
    if upstream_tag is None:
        print("Upstream has no stable tags; nothing to release")
        return
    origin_tags = remote_smdex_tags(repo, "origin")
    mirror_tags = remote_smdex_tags(repo, "mirror")
    # Tag parity: replicate origin-only release tags (e.g. after a failed
    # mirror push) so both forks keep the same tag set.
    for tag in sorted(origin_tags - mirror_tags):
        git(repo, "fetch", "--no-tags", "origin", f"refs/tags/{tag}:refs/tags/{tag}")
        git(repo, "push", "mirror", f"refs/tags/{tag}")
        print(f"Replicated release tag {tag} to mirror")
    if upstream_tag in {base_of(t) for t in origin_tags if base_of(t)}:
        print(f"Upstream {upstream_tag} already has a fork release tag")
        return
    fork_tag = f"{upstream_tag}-smdex.1"
    if fork_tag in mirror_tags:
        raise RuntimeError(
            f"Mirror already holds {fork_tag} while GitHub does not; reconcile "
            "the release tags manually before the next sync."
        )
    git(repo, "tag", "-a", fork_tag, "-m", f"Paseo {fork_tag} over upstream {upstream_tag}", "HEAD")
    # GitHub first: the tag push there starts the release workflows.
    git(repo, "push", "origin", f"refs/tags/{fork_tag}")
    git(repo, "push", "mirror", f"refs/tags/{fork_tag}")
    print(f"Released {fork_tag} at synced HEAD for upstream {upstream_tag}")


def sync(repo, mirror_url, run_id):
    git(repo, "clone", "--no-tags", "--branch", BRANCH, FORK_URL, ".")
    git(repo, "config", "user.name", os.environ["GIT_AUTHOR_NAME"])
    git(repo, "config", "user.email", os.environ["GIT_AUTHOR_EMAIL"])
    git(repo, "config", "merge.conflictStyle", "merge")
    git(repo, "remote", "add", "upstream", UPSTREAM_URL)
    git(repo, "remote", "add", "mirror", mirror_url)
    git(
        repo,
        "fetch",
        "--no-tags",
        "upstream",
        f"+refs/heads/{BRANCH}:refs/remotes/upstream/{BRANCH}",
    )
    original = output(repo, "rev-parse", "HEAD")
    mirror_original = require_mirror_behind(repo, original)
    require_linear_fork_history(repo, original, f"upstream/{BRANCH}")
    rebase(repo, f"upstream/{BRANCH}")
    head = output(repo, "rev-parse", "HEAD")
    if head != original:
        # Keep the pre-rebase tip recoverable before rewriting history.
        git(repo, "push", "origin", f"{original}:refs/heads/sync-backup/gitlab-{run_id}")
    git(
        repo,
        "push",
        "--atomic",
        f"--force-with-lease=refs/heads/{BRANCH}:{original}",
        "origin",
        f"HEAD:refs/heads/{BRANCH}",
    )
    git(
        repo,
        "push",
        "--atomic",
        f"--force-with-lease=refs/heads/{BRANCH}:{mirror_original}",
        "mirror",
        f"HEAD:refs/heads/{BRANCH}",
    )
    print(f"Synced {BRANCH}: {head} (was {original})")
    release_new_upstream_stable(repo)


def main():
    if (
        os.environ.get("CI_COMMIT_REF_PROTECTED") != "true"
        or os.environ.get("CI_COMMIT_BRANCH") != BRANCH
    ):
        raise RuntimeError(f"Maintenance must run on protected {BRANCH}")
    os.environ["GIT_TERMINAL_PROMPT"] = "0"
    os.environ["GIT_ASKPASS"] = str(Path(__file__).with_name("git_askpass.sh").resolve())
    mirror_url = (
        os.environ["CI_PROJECT_URL"].replace("https://", "https://gitlab-ci-token@", 1)
        + ".git"
    )
    with tempfile.TemporaryDirectory(prefix="paseo-sync-") as repo:
        sync(repo, mirror_url, os.environ["CI_PIPELINE_ID"])


if __name__ == "__main__":
    main()
