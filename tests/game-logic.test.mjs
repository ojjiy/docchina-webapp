import test from "node:test";
import assert from "node:assert/strict";
import {
  answersToLeafIndex,
  childNodeIndex,
  createGenreSchedule,
  getPathNodeIndices,
  nodeDepth,
  predictionCounts,
  scorePredictions,
  validateQuestionBank
} from "../game-logic.js";

test("Noを左、Yesを右として木をたどる", () => {
  assert.equal(childNodeIndex(0, false), 1);
  assert.equal(childNodeIndex(0, true), 2);
  assert.deepEqual(getPathNodeIndices([false, true, false, true]), [0, 1, 4, 9]);
  assert.equal(answersToLeafIndex([false, true, false, true]), 5);
  assert.equal(answersToLeafIndex([true, true, true, true]), 15);
});

test("幅優先インデックスから深さを算出する", () => {
  assert.deepEqual(Array.from({ length: 15 }, (_, index) => nodeDepth(index)), [0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
});

test("8ジャンルの割当は各ラウンドで重複せず、8ラウンドで各深さを一度ずつ担当する", () => {
  const genres = Array.from({ length: 8 }, (_, index) => `g${index}`);
  const schedule = createGenreSchedule(genres, 8, () => 0.5);
  for (const round of schedule) assert.equal(new Set(round).size, 4);
  for (const genre of genres) {
    for (let depth = 0; depth < 4; depth += 1) {
      assert.equal(schedule.filter((round) => round[depth] === genre).length, 1);
    }
  }
});

test("予測人数と正解者を集計する", () => {
  const predictions = { a: 3, b: 3, c: 8 };
  const counts = predictionCounts(predictions);
  assert.equal(counts[3], 2);
  assert.equal(counts[8], 1);
  assert.deepEqual(scorePredictions(predictions, 3), ["a", "b"]);
});

test("質問バンクの重複IDと不足を検出する", () => {
  const invalid = { genres: [{ id: "a", label: "A", questions: [{ id: "q", text: "質問" }] }] };
  assert.ok(validateQuestionBank(invalid).length >= 2);
});
