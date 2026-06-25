---
description: Stage all changes, write a commit message, and push to main
argument-hint: [optional summary of what changed]
allowed-tools: Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*)
---

## Repo state

- Branch: !`git branch --show-current`
- Short status: !`git status --short`
- Change summary: !`git diff HEAD --stat`
- Recent history (match the message style): !`git log --oneline -8`

## Your task

Commit everything currently changed and push it to `main`.

User-supplied context (may be empty): **$ARGUMENTS**

Steps:

1. If the short status above is empty, stop and report "nothing to commit" — do not create an empty commit.
2. Read the diff stat (and `git diff HEAD` for anything non-obvious) so the message reflects the actual change. If `$ARGUMENTS` was provided, use it as the intent/summary and reconcile it with what the diff shows.
3. Stage everything with `git add -A`.
4. Write a [Conventional Commits](https://www.conventionalcommits.org) message:
   - Subject line: `type: imperative summary` (≤ 72 chars). Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`.
   - If the change is non-trivial, add a body explaining the **why**, not just the what.
   - End the message with this trailer on its own line:
     `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   - Use a HEREDOC so the multi-line message is preserved:
     ```
     git commit -m "$(cat <<'EOF'
     <subject>

     <body>

     Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
     EOF
     )"
     ```
5. Push: `git push origin HEAD:main`. If the current branch is not `main`, still push it to `main` as the user intends `/save` to update `main` directly.
6. If the push is rejected (remote ahead), run `git pull --rebase origin main`, resolve trivially if possible, then push again. If the rebase has real conflicts, stop and report them — do not force-push.
7. Report the final commit subject and the push result.
