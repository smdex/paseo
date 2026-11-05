#!/usr/bin/env python3
"""Rebase fork main on upstream main, then mirror the rebased main to the
GitHub fork (canonical) and the GitLab project that runs this pipeline."""

import os
import subprocess
import tempfile
from pathlib import Path

FORK_URL = "https://github.com/smdex/paseo.git"
UPSTREAM_URL = "https://github.com/getpaseo/paseo.git"
BRANCH = "main"


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


def require_mirror_behind(repo, original):
    """Refuse to overwrite a GitLab main that holds commits missing from GitHub."""
    git(repo, "fetch", "--no-tags", "mirror", f"+refs/heads/{BRANCH}:refs/mirror-main")
    ahead = git(repo, "rev-list", "--count", f"{original}..refs/mirror-main")
    if ahead.stdout.strip() != "0":
        raise RuntimeError(
            f"GitLab {BRANCH} is {ahead.stdout.strip()} commit(s) ahead of the "
            f"cloned GitHub {BRANCH}; push those to GitHub first, then rerun."
        )


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
    require_mirror_behind(repo, original)
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
    remote = output(repo, "ls-remote", "mirror", f"refs/heads/{BRANCH}")
    expected = remote.split()[0] if remote else ""
    git(
        repo,
        "push",
        "--atomic",
        f"--force-with-lease=refs/heads/{BRANCH}:{expected}",
        "mirror",
        f"HEAD:refs/heads/{BRANCH}",
    )
    print(f"Synced {BRANCH}: {head} (was {original})")


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
