# Loom

This repo uses **loom** — an autonomous agentic engineering system. You can drive it
through its MCP tools or its CLI.

## Workflow

1. `loom epic "<brief>"` — plan an epic (Analyst → PM → Architect personas).
2. Review the plan under `.loom/planning/<run-id>/`.
3. `loom approve <epic-id>` — release it for execution.
4. `loom run` — dispatch story agents, each in an isolated git worktree.
5. `loom status` — track progress and PR links.

## MCP tools

When the loom MCP server is connected (`.mcp.json`), these tools are available:
`loom_start_epic`, `loom_approve_plan`, `loom_reject_plan`, `loom_get_status`,
`loom_get_audit_log`, `loom_policy_check`, `loom_get_planning_artifacts`,
`loom_get_diff`, `loom_get_review`.

## Guardrails

A PreToolUse hook checks every Bash command against `.loom/policy.yaml`. Destructive
commands (force push, `git reset --hard`, deleting protected paths, command chaining)
are blocked at the OS level. Work with the guardrails — never try to bypass them.
