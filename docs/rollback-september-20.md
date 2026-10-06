# September 20 application rollback

Restore product code to `0f7ae28` (the September 20 commit in its recorded timezone). Preserve Git history and all current database/R2 data. No database migrations, seeds, deletions, or balance transfers are run by this rollback.

Customer, rider, and admin return to the older feature set. Restaurant, merchant, and car Workers serve an unavailable page; the main website redirects to the customer app. Deployment tooling, domain routes, and preview routing stay current.

Compatibility exceptions:

- Keep sandbox/live isolation and the admin environment control. Preserve the existing environment setting.
- Keep migration history and the deployed Durable Object migration tags.
- Scope old wallet sharing and history to the primary wallet. Additional wallets remain stored, but have no interface in the older app.
- Respect locked fees on previously funded orders. New orders use the September 20 pricing behavior.
- Keep cancelled orders terminal and customer-hidden lists hidden.
- Preserve newer service orders, but block mutations through the older delivery workflow and exclude them from available jobs.
- Stop later scheduled feature handlers. Retain installed-app offline support with new cache names.

Read-only production audit before rollout: three active live delivery orders; three active sandbox restaurant orders; platform environment sandbox; one secondary wallet; nine locked-fee rows. A pending payment uses the historical `momo` provider identifier; the restored API leaves unknown-provider status pending. No records were modified.

A full D1 SQL export was saved outside the repository at `../rollback-backups/tuma-api-before-sep20-rollback-2026-10-06.sql`. Never commit this backup.

Validation: customer/rider/admin production builds; API and infrastructure typechecks; tests against the complete current migration schema covering wallet ownership, sandbox isolation, and existing payout deductions. Remote CI and deployment results must be checked before declaring completion.

Recovery: revert the rollback PR through a new codex branch and PR; the previous main commit is `1aa2e80b52388d6266705640f414308b3777c789`. Do not restore the database export unless separately requested, because doing so would discard later activity.
