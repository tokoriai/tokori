# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Email **security@tokori.ai** with:

- A description of the issue and where in the code it lives.
- A minimal reproduction if you have one.
- The impact you think it could have.
- (Optional) Any suggested fix.

You'll get an acknowledgement within 72 hours. We aim to triage,
confirm, and produce a fix or mitigation within 30 days for
high-severity issues, longer for lower-severity ones. We'll keep you
in the loop and credit you in the release notes if you'd like.

## Scope

In scope:

- The Tokori desktop app (this repository).
- The bundled MCP server in `mcp-server/`.
- Documented endpoints of the local HTTP API on `127.0.0.1:53210`.

Out of scope:

- Issues in third-party LLM providers (OpenAI, Anthropic, Gemini,
  Ollama, etc.) — report those upstream.
- Issues that require an attacker with local code execution or
  filesystem access already (Tokori is a local-first app; we assume
  the user controls the machine).
- Issues in unmaintained forks.

## Supported versions

We patch the latest minor release. If you're running an older version,
the first step is usually to upgrade — please confirm the issue still
reproduces on `main` before reporting.

## Disclosure

We follow coordinated disclosure: we'll publish a CVE and a release
note once a fix is shipped. If you'd prefer to publish your own
write-up, we'll coordinate timing with you.
