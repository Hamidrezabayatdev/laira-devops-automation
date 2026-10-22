# Project implementation guidance

- Follow `IMPLEMENTATION-PLAN.md`; original challenge is preserved in the product brief.
- The primary agent owns architecture/integration. Use Gemini for implementation, independently verify meaningful milestones, and commit coherent verified batches normally.
- Never expose or commit `.env`, credentials, provider response bodies, or secret-bearing logs. Use fixtures for breadth; label them honestly.
- Ask before paid resources or infrastructure mutations. A provider request accepted is not a verified outcome.
- Development runs on Node 24 with pnpm. Web and persistent worker are separate processes.
- If internet connectivity fails, a local proxy is available on port **10808** (localhost). Try a command-scoped proxy setting as needed; determine whether HTTP or SOCKS is supported before relying on it. Do not persist proxy credentials or route private service traffic through it.
- Keep local PostgreSQL/object storage bound to localhost. Do not modify unrelated services or databases.
