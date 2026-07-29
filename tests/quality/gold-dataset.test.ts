import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GOLD_SEED,
  GOLD_DATASET_LICENSE,
  PROVIDER_DIRECTIONS,
  generateGoldDataset,
} from "../../packages/test-fixtures/gold-dataset.js";
import { evaluateGoldDataset } from "../../packages/test-fixtures/quality-evaluator.js";

test("synthetic gold corpus is deterministic, balanced and sufficiently hard", () => {
  const first = generateGoldDataset();
  const second = generateGoldDataset({ seed: DEFAULT_GOLD_SEED });
  assert.equal(GOLD_DATASET_LICENSE, "CC0-1.0 synthetic data");
  assert.deepEqual(first, second);
  assert.equal(first.length, 1_800);
  assert.equal(new Set(first.map((item) => item.id)).size, first.length);

  for (const direction of PROVIDER_DIRECTIONS) {
    const subset = first.filter((item) => item.direction[0] === direction[0] && item.direction[1] === direction[1]);
    assert.equal(subset.length, 300, `${direction.join(" -> ")} must have 300 cases`);
    assert.ok(subset.filter((item) => item.difficulty === "HARD").length >= 120);
  }
  assert.ok(first.filter((item) => item.difficulty === "HARD").length / first.length >= 0.4);
  assert.notDeepEqual(generateGoldDataset({ seed: DEFAULT_GOLD_SEED + 1 }), first);
});

test("safe-mode production matcher clears the Definition of Done quality gates", () => {
  const metrics = evaluateGoldDataset(generateGoldDataset());
  assert.equal(metrics.caseCount, 1_800);
  assert.ok(metrics.hardCaseShare >= 0.4, JSON.stringify(metrics));
  assert.ok(metrics.safeAutoSelectedCount > 0, "precision must not pass vacuously");
  assert.ok(metrics.safePrecision >= 0.99, JSON.stringify(metrics));
  assert.ok(metrics.safeFalsePositiveRate < 0.01, JSON.stringify(metrics));
  assert.ok(metrics.top5Recall >= 0.95, JSON.stringify(metrics));
});
