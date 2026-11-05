"""Self-checks for the fork sync. Runs in CI before every sync attempt."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import sync_upstream


def git(repo, *args):
    subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    )


def commit(repo, message, filename, content):
    Path(repo, filename).write_text(content)
    git(repo, "add", "--", filename)
    git(repo, "-c", "user.name=test", "-c", "user.email=test@invalid",
        "commit", "--no-gpg-sign", "-m", message)


class TemporaryRepo(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="paseo-sync-test-")
        self.addCleanup(self.dir.cleanup)
        self.repo = self.dir.name
        git(self.repo, "init", "-q", "--initial-branch=main")
        commit(self.repo, "base", "shared.txt", "base\n")
        self.base = sync_upstream.output(self.repo, "rev-parse", "HEAD")


class RebaseTest(TemporaryRepo):
    def test_conflict_aborts_and_restores_repo(self):
        git(self.repo, "checkout", "-q", "-b", "fork")
        commit(self.repo, "fork change", "shared.txt", "fork\n")
        fork_tip = sync_upstream.output(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "main")
        commit(self.repo, "upstream change", "shared.txt", "upstream\n")
        git(self.repo, "checkout", "-q", "fork")
        with self.assertRaises(RuntimeError) as ctx:
            sync_upstream.rebase(self.repo, "main")
        self.assertIn("shared.txt", str(ctx.exception))
        self.assertEqual(
            sync_upstream.output(self.repo, "rev-parse", "HEAD"), fork_tip
        )
        # No rebase left in progress; the tree is back to the fork state.
        self.assertEqual(
            sync_upstream.git(self.repo, "status", "--porcelain").stdout, ""
        )

    def test_clean_rebase_replays_fork_commits(self):
        git(self.repo, "checkout", "-q", "-b", "fork")
        commit(self.repo, "fork change", "fork-only.txt", "fork\n")
        git(self.repo, "checkout", "-q", "main")
        commit(self.repo, "upstream change", "upstream-only.txt", "upstream\n")
        git(self.repo, "checkout", "-q", "fork")
        sync_upstream.rebase(self.repo, "main")
        self.assertEqual(
            sync_upstream.output(self.repo, "rev-list", "--count", "main..HEAD"), "1"
        )
        self.assertTrue(Path(self.repo, "upstream-only.txt").exists())


class RequireMirrorBehindTest(TemporaryRepo):
    def test_ahead_mirror_is_rejected(self):
        git(self.repo, "checkout", "-q", "-b", "fork")
        commit(self.repo, "fork change", "fork.txt", "fork\n")
        bare = tempfile.mkdtemp(prefix="paseo-sync-test-mirror-")
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", bare]))
        git(self.repo, "clone", "-q", "--bare", self.repo, bare)
        git(self.repo, "remote", "add", "mirror", bare)
        # main..fork commit exists on the mirror but not on cloned main.
        git(self.repo, "push", "-q", "mirror", "fork:refs/heads/main")
        with self.assertRaises(RuntimeError) as ctx:
            sync_upstream.require_mirror_behind(self.repo, "main")
        self.assertIn("ahead of the cloned", str(ctx.exception))

    def test_equal_mirror_passes(self):
        bare = tempfile.mkdtemp(prefix="paseo-sync-test-mirror-")
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", bare]))
        git(self.repo, "clone", "-q", "--bare", self.repo, bare)
        git(self.repo, "remote", "add", "mirror", bare)
        sync_upstream.require_mirror_behind(self.repo, "main")  # Must not raise.


class AskpassTest(unittest.TestCase):
    def setUp(self):
        self.script = str(Path(__file__).with_name("git_askpass.sh"))

    def run_prompt(self, prompt, env):
        return subprocess.run(
            [self.script, prompt], env=env, capture_output=True, text=True
        )

    def test_refuses_unknown_prompts(self):
        result = self.run_prompt(
            "Password for 'https://evil.example':",
            {"PATH": os.environ["PATH"]},
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")

    def test_answers_github_password_with_token_only(self):
        result = self.run_prompt(
            "Password for 'https://x-access-token@github.com': ",
            {"PATH": os.environ["PATH"], "GITHUB_TOKEN": "secret-value"},
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "secret-value\n")


if __name__ == "__main__":
    unittest.main()
