#!/bin/sh
# Tokens stay out of Git remote URLs, command arguments, and logs.
# Trailing `*` tolerates git's askpass prompt spacing.
case "$1" in
  "Username for 'https://github.com':"*)
    printf '%s\n' "x-access-token" ;;
  "Password for 'https://"*"@github.com':"*)
    printf '%s\n' "$GITHUB_TOKEN" ;;
  *"Password for 'https://gitlab-ci-token@${CI_SERVER_HOST}':"*)
    printf '%s\n' "$CI_JOB_TOKEN" ;;
  *)
    exit 1 ;;
esac
