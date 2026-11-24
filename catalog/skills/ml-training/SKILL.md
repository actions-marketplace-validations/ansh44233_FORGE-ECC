---
description: Train and evaluate ML models reproducibly: data splits, baselines, experiment tracking, leakage checks and model cards
profile: full
languages: python
tags: ai, ml, data, python
---

# ML training

Use when training, fine-tuning or evaluating machine learning models.

## Data
- Split before anything else (train, validation, test). Split by entity or time when rows are related, to avoid leakage.
- Check for leakage: features computed from the label or from future data, and duplicates across splits.
- Version datasets (hash or DVC) and record their stats.

## Baselines
Start with a simple baseline (majority class, linear model, previous model) so you know what "better" means.

## Reproducibility
Fix seeds, record the code commit, data version, hyperparameters, environment and hardware, and track runs (MLflow, Weights & Biases).

## Evaluation
- Pick metrics that match the product decision (precision at the operating threshold, calibration, cost-weighted errors), not only accuracy.
- Evaluate on the untouched test set once, and by important slices (segments, languages, devices) to catch hidden regressions.
- Report confidence intervals or variance across seeds.

## Training hygiene
Watch training and validation curves, use early stopping, checkpoint regularly, and profile the data loader before buying bigger GPUs.

## Ship
Write a model card (data, intended use, metrics, slices, limitations), and monitor drift and performance after deployment.

## Verify
Re-run training from the recorded config and reproduce the metrics within tolerance, then compare against the baseline and the current production model on the same test set.
