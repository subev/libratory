# Security policy

## Reporting a vulnerability

Please [report vulnerabilities privately through GitHub](https://github.com/subev/libratory/security/advisories/new).
Include the affected version, operating system, reproduction steps, and expected impact. Use a
minimal sample rather than a private book, and remove API keys and other secrets from logs.
Please keep exploit details out of public issues until a fix or mitigation is available.

This is a personal project; there is no guaranteed response time or paid bug bounty.

## Supported versions

Security fixes target the latest release and `main`. Older releases do not receive backports.
Updating the desktop app may also require its managed runtime or page renderer to update.

## Deployment boundary

Libratory is a local tool with an unauthenticated server. Keep its default loopback binding.
If you expose it beyond your machine, put authentication and access controls in front of it.
CORS is not authentication. Only install models and runtime tools from sources you trust;
offline operation does not make an untrusted model or document safe.

## Dependency maintenance

Dependabot opens update PRs for review; updates are not automatically merged. CodeQL scans
JavaScript/TypeScript and Python through GitHub's default setup. The Security workflow audits
JavaScript and both Python environments on PRs, pushes to `main`, and weekly.
Compatibility constraints and any remaining findings are recorded in
[the security maintenance notes](docs/security-maintenance.md).
