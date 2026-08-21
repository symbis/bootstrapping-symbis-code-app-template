---
name: bootstrapping-symbis-code-app-template
description: Use when installing the Symbis Code App template, preparing an existing checkout, or resolving Windows/macOS setup failures involving Developer Mode, symlinks, Node, GNU Make, Azure DevOps authentication, or make install.
---

# Bootstrapping the Symbis Code App Template

## Overview

Turn a fresh machine or existing checkout into a validated template workspace while preserving user files. Support native Windows PowerShell and macOS; do not require WSL or Git Bash.

## Install this skill

The canonical source is the private Symbis GitHub repository. Users need repository access and an authenticated GitHub CLI session.

```bash
gh auth status || gh auth login --web --git-protocol https
npx skills add symbis/bootstrapping-symbis-code-app-template --global --agent codex --copy --yes
```

Keep `--copy` so installing the bootstrap skill itself does not depend on Windows symlink support. For access failures, read [references/private-github-install.md](references/private-github-install.md).

## Choose the project folder

For a new installation, use an exact target path supplied by the user. If the user has not supplied one, ask once:

> What should the new project folder be called? I will create it under `~/Projects` on macOS or `$HOME\Projects` on Windows by default; you can also provide a different full path.

Do not invent a generic name such as `MyApp`, silently slugify the answer, or infer the folder name from the template repository. Reject an empty name, `.` or `..`, path separators in a folder-name answer, and names invalid on the current OS. Resolve and show the absolute target in the plan before requesting approval. If the target is an existing checkout, use its current path without asking for a new name and never rename it.

## Modes

- **New:** authenticate through the browser, clone the canonical private Azure DevOps template, verify symlinks, start a fresh `main` repository, then run `make install`.
- **Existing:** preserve the repository and unrelated changes, repair only unchanged tracked symlinks when needed, then run `make install`.

## Workflow

1. Determine `win32` versus `darwin`, obtain the target through the folder intake above, and classify it as new or an existing checkout. Refuse a non-empty unrelated target.
2. Resolve the platform wrapper relative to this `SKILL.md`:
   - Windows: `scripts/bootstrap-template.ps1`
   - macOS: `scripts/bootstrap-template.sh`
3. Run it first with `--target <path> --mode auto --plan`. Show the resulting plan.
4. Ask one bundled confirmation before global package installs and Windows Developer Mode changes. If the target still contains `## Safe Chain Project Setup`, ask its required yes/no question once as a separate choice.
5. Rerun with `--approve-system-changes` and, when required, `--safe-chain yes` or `--safe-chain no`. The helper installs only missing prerequisites, opens Azure CLI browser authentication when needed, keeps the token out of command arguments, and runs `make install`.
6. Verify the helper succeeded, the expected links are symbolic links, `node --version` is 22+, `make --version` reports GNU Make, and unrelated Git changes remain.

## Adaptation rule

When repository prose contains the wrong shell syntax, treat the intended outcome as authoritative. Inspect the actual `Makefile`, `package.json`, and sibling `.mjs`, `.ps1`, or `.sh` helpers; select the native equivalent. Do not silently edit tracked instructions or bypass a failed platform check.

## Boundaries

- Never reset, clean, overwrite an unrelated target, or replace a locally changed link.
- Never request, print, or persist a PAT/access token.
- Do not run `code-init`, push, deploy, or change a Power Platform environment during template setup.
- UAC, browser sign-in, MFA, and managed-device policy remain user or administrator trust boundaries.
