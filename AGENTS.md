<!-- OPS_VAULT_POINTER -->
# Agent Instructions (Required)

- Primary docs live in C:\\Dev\\_OpsVault\\translation\\Docs.
- Session notes/logs must be written to C:\\Dev\\_OpsVault\\translation\\Sessions.
- Secrets and .env files live in C:\\Dev\\_OpsVault\\translation\\Secrets (never in repo).
- Use `.env.example` in the repo for required keys (values live in the vault).
- Pointer file: `docs\\WHERE_ARE_MY_DOCS.md`.
- Global rules: `C:\\Dev\\_OpsVault\\_GLOBAL\\AGENT-RULES.md`.

Detailed instructions (if present) are in the vault docs folder:
- `AGENTS.md`, `CLAUDE.md`, or `README.md` inside the vault docs.


# ────────────── GLOBAL SKILLS (auto-installed) ──────────────
# Skills: C:\Dev\_OpsVault\_GLOBAL\Skills\
#
# /commit - Full deploy pipeline
#   Read: C:\Dev\_OpsVault\_GLOBAL\Skills\commit\SKILL.md
#   Flow: git commit+push → detect deploy → wait 180s → verify → session notes → /log
#
# /log - Append to master dev log
#   Read: C:\Dev\_OpsVault\_GLOBAL\Skills\log\SKILL.md
#   Appends timestamped tagged entry to C:\Dev\_OpsVault\_GLOBAL\DEV_LOG.md
#
# When user says /commit or /log, READ the SKILL.md FIRST, then follow exactly.
# ─────────────────────────────────────────────────────────────

