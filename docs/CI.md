# Domovoy fork CI

This fork runs **CI** for every pull request, every push to
`main`, and manual dispatch. Documentation changes run the same checks, so a
required check cannot remain pending because of a path filter.

The inherited workflows run backend lint/build/race tests, frontend lint/type
checks/build, SQLite and PostgreSQL integration tests, and the four Playwright
shards across Chromium, Firefox and WebKit. They use synthetic local test data;
no production service, Codex subscription, private photos or printer is used.
The stable **Required** job reports each workflow result in its Job summary and
passes only when Backend, Frontend and Browser all succeed. Failure, cancellation,
skipped and missing results fail the gate. An outdated run is cancelled when a
new commit arrives.

Open a pull request's **Checks** tab to inspect the failing step. Browser jobs
retain blob reports and failure traces for seven days, then merge available
reports into an HTML report retained for 30 days. Backend coverage is retained
for seven days when generated. Only these test outputs are uploaded; databases,
settings and credentials are excluded.

Repository-native commands used by CI:

```sh
task go:build
task go:coverage
# golangci-lint is run by its upstream GitHub Action in backend/.
cd frontend
pnpm install --frozen-lockfile
pnpm run lint:ci
pnpm run typecheck
pnpm run build
cd ..
task test:ci
task test:ci:postgresql
task test:e2e -- --shard=1/4
```

Each integration task runs in its own job with the synthetic database settings
in `Taskfile.yml`; the PostgreSQL jobs supply their isolated service. The e2e
shard command is repeated for shards 1–4. Local execution requires the versions
already declared upstream (Go from `backend/go.mod`, Node 24 and pnpm 10), Task,
and a local test PostgreSQL instance for PostgreSQL integration tests.

Before merging, require a green **Required** and the issue's actual acceptance
checks. Branch protection must use the status name returned by GitHub after the
first run. Availability of mandatory checks is verified in repository settings;
this file alone does not configure or prove enforcement. The parent Domovoy
private repository on GitHub Free uses a manual merge rule.

Inherited publishing, release, currency-update, issue automation, cleanup,
upgrade and Copilot setup workflows are restricted to `sysadminsmedia/homebox`.
They do not execute in this fork. CI does not publish images, deploy, update QA,
or change the application dependencies or runtime behavior.

Tracking issue: https://github.com/nd2go/domovoy/issues/19. Complete acceptance
also requires red/green runs, a documentation-only PR and a push to `main` in
all three repositories; introducing this workflow alone does not complete it.
