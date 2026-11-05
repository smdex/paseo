"""Self-checks for the fork sync. Runs in CI before every sync attempt."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
        git(self.repo, "config", "user.name", "test")
        git(self.repo, "config", "user.email", "test@invalid")
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


class SyncPublicationTest(TemporaryRepo):
    def setUp(self):
        super().setUp()
        self.fork = str(Path(self.repo, "fork.git"))
        self.mirror = str(Path(self.repo, "mirror.git"))
        self.upstream = str(Path(self.repo, "upstream.git"))
        git(self.repo, "clone", "--bare", ".", self.upstream)
        commit(self.repo, "fork change", "fork.txt", "fork\n")
        self.original = sync_upstream.output(self.repo, "rev-parse", "HEAD")
        git(self.repo, "clone", "--bare", ".", self.fork)
        git(self.repo, "clone", "--bare", ".", self.mirror)
        git(self.repo, "checkout", "--detach", self.base)
        commit(self.repo, "upstream change", "upstream.txt", "upstream\n")
        git(self.repo, "push", self.upstream, "HEAD:refs/heads/main")
        self.addCleanup(patch.stopall)
        patch.object(sync_upstream, "FORK_URL", self.fork).start()
        patch.object(sync_upstream, "UPSTREAM_URL", self.upstream).start()
        patch.dict(os.environ, {
            "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "test@invalid",
        }).start()

    def sync(self, run_id):
        checkout = Path(self.repo, f"checkout-{run_id}")
        checkout.mkdir()
        sync_upstream.sync(str(checkout), self.mirror, run_id)

    def tip(self, repo, ref="main"):
        return sync_upstream.output(repo, "rev-parse", ref)

    def test_sync_publishes_and_preserves_pre_rebase_backup(self):
        self.sync("success")
        self.assertNotEqual(self.tip(self.fork), self.original)
        self.assertEqual(self.tip(self.fork), self.tip(self.mirror))
        self.assertEqual(
            self.tip(self.fork, "sync-backup/gitlab-success"), self.original
        )

    def test_sync_rejects_mirror_commit_arriving_during_rebase(self):
        real_rebase = sync_upstream.rebase
        human_tip = None

        def advance_mirror_then_rebase(repo, onto):
            nonlocal human_tip
            git(self.repo, "checkout", "--detach", self.original)
            commit(self.repo, "human change", "human.txt", "keep me\n")
            human_tip = self.tip(self.repo, "HEAD")
            git(self.repo, "push", self.mirror, "HEAD:refs/heads/main")
            real_rebase(repo, onto)

        with patch.object(sync_upstream, "rebase", advance_mirror_then_rebase):
            with self.assertRaisesRegex(RuntimeError, "stale info"):
                self.sync("race")
        self.assertEqual(self.tip(self.mirror), human_tip)
        self.assertNotEqual(self.tip(self.fork), self.original)
        self.assertEqual(self.tip(self.fork, "sync-backup/gitlab-race"), self.original)
        # A retry must not erase the human commit, even after GitHub published.
        with self.assertRaisesRegex(RuntimeError, "ahead of the cloned"):
            self.sync("retry-race")
        self.assertEqual(self.tip(self.mirror), human_tip)

    def test_sync_partial_publication_requires_explicit_recovery(self):
        hook = Path(self.mirror, "hooks", "pre-receive")
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "pre-receive hook declined"):
            self.sync("partial")
        published = self.tip(self.fork)
        self.assertNotEqual(published, self.original)
        self.assertEqual(self.tip(self.mirror), self.original)
        backup = self.tip(self.fork, "sync-backup/gitlab-partial")
        self.assertEqual(backup, self.original)
        hook.unlink()
        # Removing the failure is insufficient: the old history is not ancestry.
        with self.assertRaisesRegex(RuntimeError, "ahead of the cloned"):
            self.sync("retry-partial")
        self.assertEqual(self.tip(self.fork), published)
        self.assertEqual(self.tip(self.mirror), backup)
        # Documented recovery is safe only when GitLab still equals the backup.
        git(self.fork, "push", f"--force-with-lease=refs/heads/main:{backup}",
            self.mirror, "main:refs/heads/main")
        self.sync("recovered")
        self.assertEqual(self.tip(self.mirror), published)


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
