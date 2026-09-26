# Staging Branch

This branch exists solely to give each of the 3 platforms (OpenAI, Anthropic, Meta) a stable, short, branch-scoped test domain that always reflects the latest candidate change before it's applied to release/v2 and promoted to production. See DECISIONS.md for full context (SYS-20260924 series).

Test URLs:
- https://carclever-oai-test.getcarwise.app/mcp
- https://carclever-anth-test.getcarwise.app/mcp
- https://carclever-meta-test.getcarwise.app/mcp

No application code differs from release/v2's tip at the time this branch was created.
