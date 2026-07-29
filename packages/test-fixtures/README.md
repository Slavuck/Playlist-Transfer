# Synthetic gold and guided integration fixtures

`gold-dataset.ts` creates a deterministic, provider-neutral CC0 corpus. It does
not contain provider exports, copied catalogue metadata, credentials, or live
URLs for real media. The default corpus has 1,800 labelled cases: 300 for each
ordered provider direction and 50% deliberately hard cases.

`quality-evaluator.ts` evaluates the production normalization, scoring and
decision modules. The gate checks safe-mode precision/false positives and
top-five recall without changing thresholds to fit the generated results.

`guided-harness.ts` is entirely offline. It exercises all transfer modes and
settings with real domain/planner/state/evidence code and a fake durable journal.
No provider request, scraping, DOM automation or automatic UI writing occurs.
