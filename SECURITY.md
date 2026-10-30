# Security policy

## Report a vulnerability

Do not report a security problem in a public issue or a pull request.

Use GitHub private vulnerability reporting:

1. Go to https://github.com/openmaru-io/ai-agent-studio/security.
2. Click **Report a vulnerability**.
3. Write what is affected, how to reproduce the problem, and what an attacker can do.

Only the maintainers can see the report. We reply in the report.

## Supported versions

We fix security problems in the latest public snapshot on the `main` branch.

## Scope

- In scope: the code in this repository (the AI Agent Studio server, the read sidecar, the web UI and the compose files).
- Out of scope: Hermes Agent itself (report to https://github.com/NousResearch/hermes-agent), and the LLM server that you connect.

## Defaults to know

- The quick start binds the console to `127.0.0.1` only. If you open it to a network, put it behind TLS.
- AI Agent Studio does not start on an address other than `127.0.0.1` without a login. Set a strong `AAS_ADMIN_PASSWORD`.
- Keep `.env` out of version control. It holds the sidecar token, the Hermes dashboard password and the LLM key.
