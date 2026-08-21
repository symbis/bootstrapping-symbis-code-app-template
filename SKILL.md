---
name: bootstrapping-symbis-code-app-template
description: Use when installing the Symbis Code App template, preparing an existing checkout, or resolving Windows/macOS setup failures involving Developer Mode, symlinks, Node, GNU Make, Azure DevOps authentication, or make install.
---

# Bootstrapping the Symbis Code App Template

## Overview

Turn a fresh machine, an empty current directory, or an existing checkout into a validated template workspace while preserving user files. Support native Windows PowerShell and macOS; do not require WSL or Git Bash.

## Install this skill

The canonical source is the public Symbis GitHub repository. Installing the skill does not require a GitHub account or GitHub CLI authentication.

```bash
npx skills add symbis/bootstrapping-symbis-code-app-template --global --agent codex --copy --yes
```

Keep `--copy` so installing the bootstrap skill itself does not depend on Windows symlink support. The skill is public, but the Azure DevOps template remains private. The helper proves repository read access before cloning and never treats token issuance alone as proof of access.

## Choose the project folder

For a new installation, inspect the current directory first. If it is empty, offer to use it. Otherwise, when the user has not supplied a target, ask once:

> Do you want to use the current empty folder, provide a different full path, or name a new folder under `~/Projects` on macOS or `$HOME\Projects` on Windows?

When the user says “here” or “current folder,” pass the current directory's absolute path. When the user supplies only a folder name, validate it and resolve it explicitly under the platform's `Projects` directory. Do not invent a generic name, silently slugify it, or infer it from the template repository. The helper accepts only absolute `--target` paths so agent wording and script resolution cannot diverge. Show that absolute target in the plan. Existing checkouts keep their current path and are never renamed.

## Authentication

Use `--auth auto` unless the user explicitly chooses another route:

1. Run an ordinary `git ls-remote` without `http.extraHeader`. This lets the configured Git credential helper use an existing Azure Repos credential from macOS Keychain or Windows Credential Manager and lets Git Credential Manager open its approved browser sign-in when needed.
2. Clone with the same ordinary Git route when read access succeeds.
3. Only when ordinary Git fails specifically for authentication, fall back to Azure CLI. Install Azure CLI only when that fallback is actually required and approved.
4. Prove an Azure CLI token with a Bearer-authenticated `git ls-remote` before cloning. A token for the wrong account or tenant must fail without blocking the working Git credential route.

Available overrides are `--auth git-credential-manager` and `--auth azure-cli`. On Azure `401/403`, report the active account and tenant without exposing the token. Stop on Conditional Access error `53003`; do not repeat authentication or bypass policy. Never infer write access from a successful read-only probe.

## Modes

- **New:** prove read access, clone the private Azure DevOps template, verify symlinks, resolve Safe Chain when present, run and validate `make install` while the original Git metadata remains recoverable, then initialize a fresh `main` repository.
- **Existing:** preserve the repository and unrelated changes, repair only unchanged tracked symlinks when needed, then run `make install`.

## Workflow

1. Determine `win32` versus `darwin`, obtain the absolute target through the folder intake above, and classify it as new or an existing checkout. Refuse a non-empty unrelated target.
2. Resolve the platform wrapper relative to this `SKILL.md`:
   - Windows: `scripts/bootstrap-template.ps1`
   - macOS: `scripts/bootstrap-template.sh`
3. Run it first with `--target <absolute-path> --mode auto --auth auto --plan`. Show prerequisite states, the authentication plan, the absolute target, and every action.
4. Ask one bundled confirmation only when `requiresSystemApproval` is true. If the current checkout contains `## Safe Chain Project Setup`, ask its required yes/no question separately. For a new clone, pass the user's choice when known; if a future template has no section, the helper ignores the option.
5. Rerun with `--approve-system-changes` only when required and with `--safe-chain yes` or `--safe-chain no` when decided. Tokens remain outside command arguments and persistent files.
6. Verify success, symbolic links, Node.js 22+, GNU Make, selected authentication route, repository read access, unchanged package manifests, and preservation of unrelated changes.

For a new clone, the helper runs `make install` before replacing template Git metadata. Unexpected tracked drift or a changed `package-lock.json` stops the workflow with the original `.git` intact. Repository initialization moves `.git` to a recoverable sibling backup, verifies the new `main` repository, and only then removes the backup.

## Adaptation rule

When repository prose contains the wrong shell syntax, treat the intended outcome as authoritative. Inspect the actual `Makefile`, `package.json`, and sibling `.mjs`, `.ps1`, or `.sh` helpers; select the native equivalent. Do not silently edit tracked instructions or bypass a failed platform check.

## Boundaries

- Never reset, clean, overwrite an unrelated target, or replace a locally changed link.
- Never request, print, or persist a PAT/access token.
- Never force a Bearer header onto the ordinary Git credential route.
- Never clone until the selected credential has proven repository read access.
- Do not run `code-init`, push, deploy, or change a Power Platform environment during template setup.
- UAC, browser sign-in, MFA, and managed-device policy remain user or administrator trust boundaries.
