# CodeMytra

**A multi-agent AI application builder that turns natural language descriptions into complete, inspectable, full-stack applications.**

> ⚠️ **Attribution:** The foundational Chai0 prototype (teacher's original project) is preserved in the `backup/old-project` branch. This repository builds upon it with substantial new architecture, security fixes, and features developed independently. See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full breakdown.

---

## What CodeMytra Does

You describe what you want to build. CodeMytra's orchestrated team of specialised AI agents — Planner, Designer, Architect, Frontend, Backend, Database, Integration, QA — work together to generate a complete, working application. You can:

- Preview the generated app live in a sandboxed environment
- Inspect and modify the generated source code
- Restore previous project revisions
- Export the source code as a ZIP file
- Continue iterating across multiple prompts

> **Deployment of generated apps** is coming in a future release. The **Deploy — Coming Soon** button is visible but intentionally disabled for the MVP.

---

## Tech Stack

| Layer              | Technology                              |
| ------------------ | --------------------------------------- |
| Frontend + Backend | Next.js 16 (App Router, Server Actions) |
| Database           | Neon PostgreSQL + Prisma 7              |
| Authentication     | Clerk                                   |
| AI Orchestration   | Inngest + OpenAI (GPT-4o, GPT-4o mini)  |
| Code Sandboxes     | E2B                                     |
| Hosting            | Vercel                                  |
| Version Control    | GitHub                                  |

---

## Feature Status

| Feature                       | Status                   |
| ----------------------------- | ------------------------ |
| User authentication (Clerk)   | ✅ Working               |
| Project creation and listing  | ✅ Working               |
| Multi-agent code generation   | ✅ Working (OpenAI)      |
| Sandbox file persistence      | ✅ Working               |
| Code viewer + iframe preview  | ✅ Working               |
| Hardcoded credentials removed | ✅ Fixed                 |
| Project revision snapshots    | ✅ Working               |
| Multi-agent orchestration     | ✅ Working               |
| PRD review and approval flow  | 📋 Planned               |
| Full-stack template (with DB) | ✅ Working               |
| ZIP export                    | ✅ Working               |
| Credit metering + billing     | 📋 Planned (Razorpay)    |
| Customer app deployment       | ⏸ Deferred (Coming Soon) |

---

## Quick Start (Local Development)

### Prerequisites

- Node.js 20+
- `npm` (do **not** mix with `yarn` or `pnpm`)
- A [Neon](https://neon.tech) PostgreSQL database
- A [Clerk](https://clerk.dev) development application
- An [OpenAI](https://platform.openai.com) API key
- An [Inngest](https://inngest.com) account (or use the local dev server)
- Your own [E2B](https://e2b.dev) account and API key

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_GITHUB/CodeMytra.git
cd CodeMytra

# 2. Install dependencies
npm ci

# 3. Configure environment variables
cp .env.example .env
# Edit .env and fill in all required values (see .env.example for guidance)

# 4. Generate the Prisma client
npx prisma generate

# 5. Run database migrations (uses DATABASE_URL_DIRECT for Neon compatibility)
npx prisma migrate deploy

# 6. Start the development server
npm run dev

# 7. In a separate terminal, start the Inngest dev server
npx inngest-cli@latest dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment Variables

Copy `.env.example` to `.env` and fill in your own credentials.  
**Never commit `.env`.**  
See `.env.example` for all required variables and where to get them.

---

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for:

- The full architecture breakdown
- Which code is inherited vs original
- Database migration strategy
- Multi-agent orchestration design
- Local setup troubleshooting

See [ENGINEERING_HANDOFF.md](./ENGINEERING_HANDOFF.md) for the detailed implementation specification, milestone plan, and go/no-go checklists.

---

## Testing

```bash
# Type checking
npx tsc --noEmit

# Linting
npm run lint

# (Tests are in progress — see DEVELOPMENT.md for current test coverage status)
```

---

## Deployment (CodeMytra Platform)

CodeMytra itself is deployed on Vercel. The Inngest production endpoint must be registered separately.

See [DEVELOPMENT.md — Deployment section](./DEVELOPMENT.md#deployment) for the full checklist.

**Note:** Customer-generated applications are preview-only in this MVP. The "Deploy" button for generated apps is intentionally disabled.

---

## Security

- All secrets are environment variables — never committed to git
- All legacy/sample API keys from upstream prototypes have been scrubbed from this repository. The project owner must generate and configure their own isolated credentials via `.env`.
- Tenant isolation enforced in all server actions
- No platform credentials are accessible inside the code execution sandbox

---

## License & Attribution

This project is built on top of the Chai0 prototype created by the original teacher/author. Their work is preserved in `backup/old-project`. New features, architecture, security hardening, and production infrastructure are original contributions. See [DEVELOPMENT.md](./DEVELOPMENT.md) for the detailed distinction.
