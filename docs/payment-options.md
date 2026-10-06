# Cash and mobile money

Cash is enabled and selected by default. Admin Settings can activate cash, mobile money, or both. The API validates the full selection and stores it in one settings row, so disabling both or racing separate saves cannot leave the app with no method. Changes are permission-gated and logged. Disabled methods cannot be used on new orders; existing orders retain their chosen method.

Mobile money is collected through Tuma. After handover and rider completion, the amount actually collected (less refunds and any fees already agreed on older orders) is sent to the rider's profile mobile-money number. New completions do not credit a wallet. Live mobile-money orders require both a configured collection provider and a configured disbursement provider. Flutterwave's current adapter collects only; configure an active Yo! provider for live payouts. Sandbox transactions stay simulated.

Each payout attempt has a unique, deterministic payment ID and an atomic submission claim. Repeated completion requests reuse the same record. Provider-confirmed failures can be retried; uncertain submission outcomes stay pending and must be verified with the provider before any resend. A scheduled worker checks pending transfer status, with the interval configurable in Admin (120 seconds initially). No wallet balances or historical settlement records are migrated or paid again.

Customer/rider wallet screens, links, spending, top-ups, withdrawals, and wallet refunds are disabled. Existing balances and records remain stored. The customer/rider interfaces always render English and ignore older saved language preferences. No database migration is needed.

Validation covers nonempty method selection, permissions, activity logging, concurrent admin saves, cash completion without transfer, disabled-method rejection, duplicate payout prevention, legacy fee deductions, unchanged wallet balances, failed-transfer retries, uncertain transfers, historical settlement protection, and live-provider readiness. Tests use an isolated in-memory database and stubbed/simulated providers; no real charges or payouts are made.
