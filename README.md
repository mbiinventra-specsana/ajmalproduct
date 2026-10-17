# ajmalproduct — New Project Workspace

This repository is the workspace for a new project. It starts from a full
reverse-engineering teardown of a reference site: the **MedArix RCM Simulator**
(a training simulator for medical billing / Revenue Cycle Management workflows).

## What's in here

- `docs/REVERSE_ENGINEERING.md` — the complete teardown report:
  tech stack, sitemap, feature inventory, case-simulator mechanics,
  data model, gamification, UI/UX notes, and the bugs found in the
  reference implementation (worth avoiding in the new build).

## Status

- [x] Reference site teardown completed (2026-10-17)
- [ ] New project scope decided
- [ ] Architecture chosen
- [ ] First build

## Notes

- All case/patient data in the reference product is fictional training data.
- This repo holds our own analysis and new work only — no third-party
  source code is reproduced here.

## MbiInventra RCM Academy — deploy guide (bill.mbiinventra.com)

Node.js + Express. Login only — no public registration; the owner creates
every account via the owner panel (`/owner`).

### Environment variables (set in NexPanel)

| Var | Purpose | Default |
|---|---|---|
| `DATA_DIR` | **SQLite folder — set to a path OUTSIDE the project** (e.g. `/home/youruser/rcm-data`) so GitHub redeploys never wipe the database | `./data` |
| `DB_ENGINE` | `sqlite` or `mysql` | `sqlite` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` / `DB_NAME` | MariaDB/MySQL connection (when `DB_ENGINE=mysql`); tables auto-create on boot | — |
| `ADMIN_USER` / `ADMIN_PASS` | Owner login (email is `ADMIN_USER@local`) | `admin` / `vip123` |
| `SESSION_SECRET` | Session signing secret — always set a long random value | dev default |
| `ADMIN_PATH` | Hidden legacy admin path | `/admin` |
| `PORT` | Listen port | `3000` |

### Data safety across redeploys

- The database is a **single file** (`bill.db`). Set `DATA_DIR` to a folder
  **outside** the deployed project directory — NexPanel replaces the project
  folder on every GitHub redeploy, so anything inside it can be wiped.
- Boot migrations are `CREATE TABLE IF NOT EXISTS` and the seed is
  idempotent: restarting the app never deletes data.
- With `DB_ENGINE=mysql`, data lives in your MariaDB database instead.

### Multi-student isolation

Every student API is scoped to the logged-in session's `user_id` — attempts,
answers, dashboard stats and progress can never cross between students
(verified by automated test). The owner panel (`/owner`, admin role only)
sees aggregate data across all students.
