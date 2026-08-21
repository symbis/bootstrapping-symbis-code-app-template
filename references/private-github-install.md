# Install from private Symbis GitHub

The only supported distribution source is:

```text
symbis/bootstrapping-symbis-code-app-template
```

The user must have access to this private repository. Check the existing GitHub CLI session and sign in only when required:

```bash
gh auth status || gh auth login --web --git-protocol https
```

Install the skill globally for Codex:

```bash
npx skills add symbis/bootstrapping-symbis-code-app-template --global --agent codex --copy --yes
```

The same command works in native Windows PowerShell and macOS terminals. `skills` uses configured Git credentials first, then the authenticated GitHub CLI, then SSH. Do not retrieve, copy, print, or pass a GitHub token manually.

If installation reports `Repository not found`, verify that the active GitHub account can view the repository:

```bash
gh auth status
gh repo view symbis/bootstrapping-symbis-code-app-template
```

Source: [official `skills` CLI private-repository documentation](https://github.com/vercel-labs/skills#private-repositories).
