# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead:
👉 https://github.com/BrowyHQ/browy/security/advisories/new

Include:
- A description of the issue
- Steps to reproduce
- Affected version (check `package.json` or the GitHub release tag)
- Your assessment of severity

If GitHub advisories are unavailable, DM the maintainer on GitHub.

We aim to acknowledge reports within 72 hours and to ship a fix or workaround within 14 days for high-severity issues.

## Scope

In scope:
- The native-messaging host (`src/`)
- The browser extension (`extension/`)
- The installer (`installer/`, `install.ps1`, `install.sh`)
- The build pipeline (anything that affects what users actually run)

Out of scope:
- The GitHub Copilot SDK and Copilot service itself — report those to GitHub directly
- Bugs in `playwright-core` upstream — report to Microsoft / the Playwright maintainers

## What we consider a vulnerability

- Code execution outside the agent's intended sandbox (`~/.browy/data/`)
- Native-messaging port hijacking (a non-Browy extension talking to our host)
- Secrets exfiltration (Copilot tokens, OS env vars, browser cookies the agent shouldn't see)
- CDP misuse that affects browsers Browy isn't supposed to be touching
- Installer privilege escalation

## Supported versions

While Browy is in 0.1 preview we only patch the latest released version. Please update before reporting if you're not on the latest.

## Hall of fame

Once we have credited reporters, they'll be listed here.
