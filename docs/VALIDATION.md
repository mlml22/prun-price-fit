# Validation criteria (pre-registered)

These criteria were written down **before** running the walk-forward test, so the result cannot be
rationalised after the fact.

## What is tested

- **Signal**: `comboScore`, the equal-weight rank average of
  1. the daily mean-reversion signal `-(price / SMA10 - 1)`, and
  2. the monthly supply score (cross-sectional percentile of surplus, supply growth,
     profit per unit and extraction margin, all sign-flipped so higher = more bullish).
- **Target**: 30-day forward log return.
- **Method**: walk-forward. Train on the previous 365 calendar days, test on the next 30 days,
  step 30 days, **non-overlapping test windows**. No test data is used for fitting or for choosing
  weights. The monthly supply score for a date in month M uses month **M-1** only (monthly data is
  published after month end).

## Success criteria

| # | Criterion | Bar |
|---|---|---|
| 1 | Number of out-of-sample windows | >= 12 |
| 2 | Mean out-of-sample IC of `comboScore` | >= 15% |
| 3 | Mean top-decile spread (top 10% minus universe, 30-day) | >= +3 percentage points |
| 4 | Share of windows with positive IC | >= 70% |

All four must hold. If any fails, the signal stays in research and is **not** used for decisions.

## Reference points (not criteria)

The same windows also report mean-reversion alone and the 3-factor OLS model, so we can tell whether
merging actually adds value out of sample rather than only in sample.

## Result log

| Date | Windows | combo IC | combo spread | positive | Verdict |
|---|---|---|---|---|---|
| 2026-10-30 | 18 | 26.21% | +9.57 pp | 100% | PASS (see `site/data/validation.json`) |

Note after fixing a look-ahead bug (monthly score previously used the row's own month): the combo's
out-of-sample IC is 26.2%, while mean-reversion alone is 28.5%. The combo passes the pre-registered
bar, but it does **not** beat mean-reversion out of sample, so mean-reversion remains the primary
signal and the supply score is best used as context/filter rather than as an added weight.
