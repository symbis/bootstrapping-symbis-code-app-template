# Skill distribution

## Local folder or zip

`skills init` creates a blank skill scaffold; it does not import a received skill. Send this complete skill directory, extract it, and install from its local path. `--copy` keeps the installed version independent of the extracted source directory.

```bash
npx skills@latest add ./bootstrapping-symbis-code-app-template \
  --global --agent codex --copy --yes
```

The same command works in PowerShell; use the appropriate local path syntax.

## Private GitHub repository

Private GitHub works when Git can clone the repository and the current `skills` process receives GitHub API authentication. The CLI reads `GITHUB_TOKEN` or `GH_TOKEN`; do not paste or save a personal access token in a script, prompt, or skill file.

Authenticate GitHub CLI once:

```bash
gh auth status || gh auth login --web --git-protocol https
gh auth setup-git
```

Install on macOS with a process-scoped token:

```bash
SKILL_GITHUB_TOKEN="$(gh auth token)"
GH_TOKEN="$SKILL_GITHUB_TOKEN" npx skills@latest add <symbis-owner>/<skill-repository> \
  --skill bootstrapping-symbis-code-app-template --global --agent codex --copy --yes
unset SKILL_GITHUB_TOKEN
```

Install from PowerShell:

```powershell
gh auth status
if ($LASTEXITCODE -ne 0) { gh auth login --web --git-protocol https }
gh auth setup-git
$SkillGitHubToken = gh auth token
try {
    $env:GH_TOKEN = $SkillGitHubToken
    npx skills@latest add <symbis-owner>/<skill-repository> `
        --skill bootstrapping-symbis-code-app-template --global --agent codex --copy --yes
} finally {
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    $SkillGitHubToken = $null
}
```

Use the same temporary-token pattern around `npx skills@latest update` for a private source. A public GitHub repository needs no GitHub authentication.

Sources: [skills CLI package documentation](https://www.npmjs.com/package/skills), [current token resolution](https://github.com/vercel-labs/skills/blob/main/src/skill-lock.ts), and [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login).
