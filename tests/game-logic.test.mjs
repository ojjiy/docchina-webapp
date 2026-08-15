import test from "node:test";
import assert from "node:assert/strict";
import {
  appendQueuedPlayerIds,
  answersToLeafIndex,
  childNodeIndex,
  createGenreSchedule,
  getPathNodeIndices,
  nodeDepth,
  predictionAnswerGroups,
  predictionCounts,
  predictionToLeafIndex,
  scoreRound,
  validateQuestionBank
} from "../game-logic.js";
import { SCORE_CONFIG, snapshotScoreConfig } from "../game-config.js";

test("Yesを左、Noを右として木をたどる", () => {
  assert.equal(childNodeIndex(0, true), 1);
  assert.equal(childNodeIndex(0, false), 2);
  assert.deepEqual(getPathNodeIndices([true, false, true]), [0, 1, 4]);
  assert.equal(answersToLeafIndex([true, false, true]), 2);
  assert.equal(answersToLeafIndex([true, true, true]), 0);
  assert.equal(answersToLeafIndex([false, false, false]), 7);
});

test("途中参加者を重複なく代表者キューの末尾へ追加する", () => {
  assert.deepEqual(appendQueuedPlayerIds(["a", "b"], ["a", "c", "d"]), ["a", "b", "c", "d"]);
  assert.deepEqual(appendQueuedPlayerIds(["a", "b"], ["c", "d"], 3), ["a", "b", "c"]);
});

test("幅優先インデックスから深さを算出する", () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => nodeDepth(index)), [0, 1, 1, 2, 2, 2, 2]);
});

test("8ジャンルの割当は各ラウンドで重複せず、8ラウンドで各深さを一度ずつ担当する", () => {
  const genres = Array.from({ length: 8 }, (_, index) => `g${index}`);
  const schedule = createGenreSchedule(genres, 8, () => 0.5);
  for (const round of schedule) assert.equal(new Set(round).size, 3);
  for (const genre of genres) {
    for (let depth = 0; depth < 3; depth += 1) {
      assert.equal(schedule.filter((round) => round[depth] === genre).length, 1);
    }
  }
});

test("全ノード予想から従来の予想到達点を導出して集計する", () => {
  const predictions = {
    a: { answersByNode: { 0: true, 1: false, 2: true, 3: false, 4: true, 5: false, 6: true } },
    b: { answersByNode: { 0: true, 1: false, 2: false, 3: true, 4: true, 5: true, 6: false } },
    c: { answersByNode: { 0: false, 1: true, 2: false, 3: true, 4: false, 5: true, 6: false } }
  };
  assert.equal(predictionToLeafIndex(predictions.a), 2);
  assert.equal(predictionToLeafIndex(predictions.b), 2);
  assert.equal(predictionToLeafIndex(predictions.c), 7);
  const counts = predictionCounts(predictions);
  assert.equal(counts[2], 2);
  assert.equal(counts[7], 1);
  assert.deepEqual(predictionAnswerGroups(predictions, 0), {
    yesPlayerIds: ["a", "b"],
    noPlayerIds: ["c"]
  });
  assert.deepEqual(predictionAnswerGroups(predictions, 2), {
    yesPlayerIds: ["a"],
    noPlayerIds: ["b", "c"]
  });
});

test("質問点・全問一致・自信・単独正解を質問ごとに採点する", () => {
  const predictions = {
    a: { answersByNode: { 0: true, 1: false, 2: false, 3: true, 4: true, 5: true, 6: false }, confidenceDepth: 1 },
    b: { answersByNode: { 0: false, 1: false, 2: true, 3: false, 4: true, 5: false, 6: true }, confidenceDepth: 0 },
    c: { answersByNode: { 0: false, 1: true, 2: false, 3: true, 4: false, 5: true, 6: true }, confidenceDepth: 2 }
  };
  const answers = [
    { nodeIndex: 0, depth: 0, answer: true },
    { nodeIndex: 1, depth: 1, answer: false },
    { nodeIndex: 4, depth: 2, answer: true }
  ];
  const result = scoreRound({
    predictions,
    answers,
    representativeId: "r",
    representativePrediction: { correctCountsByPlayerId: { a: 3, b: 2, c: 0 } },
    scoreConfig: SCORE_CONFIG
  });
  assert.equal(result.breakdowns.a.correctCount, 3);
  assert.equal(result.breakdowns.a.questionPoints, 15);
  assert.equal(result.breakdowns.a.allQuestionsCorrectBonus, 10);
  assert.equal(result.breakdowns.a.confidenceBonus, 5);
  assert.equal(result.breakdowns.a.soleCorrectBonus, 10);
  assert.equal(result.breakdowns.a.minorityCorrectBonus, 0);
  assert.equal(result.breakdowns.a.groupBonus, 10);
  assert.equal(result.breakdowns.a.total, 40);
  assert.equal(result.breakdowns.b.correctCount, 2);
  assert.equal(result.breakdowns.b.groupBonus, 0);
  assert.equal(result.breakdowns.c.correctCount, 0);
  assert.deepEqual(result.allCorrectIds, ["a"]);
  assert.equal(result.breakdowns.r.representativePredictionMatches, 3);
  assert.equal(result.breakdowns.r.total, 9);
});

test("少数正解は単独正解と重複せず、正解者が半数未満のときだけ付く", () => {
  const predictions = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [String(index), {
    answersByNode: {
      0: index < 2,
      1: index === 0,
      2: false,
      3: false,
      4: false,
      5: false,
      6: false
    },
    confidenceDepth: 2
  }]));
  const result = scoreRound({
    predictions,
    answers: [
      { nodeIndex: 0, depth: 0, answer: true },
      { nodeIndex: 1, depth: 1, answer: true },
      { nodeIndex: 3, depth: 2, answer: true }
    ],
    representativeId: "r",
    representativePrediction: { correctCountsByPlayerId: {} },
    scoreConfig: SCORE_CONFIG
  });
  assert.equal(result.breakdowns["0"].nodeResults[0].groupBonusType, "minority");
  assert.equal(result.breakdowns["0"].nodeResults[0].groupBonusPoints, 5);
  assert.equal(result.breakdowns["0"].nodeResults[1].groupBonusType, "sole");
  assert.equal(result.breakdowns["0"].nodeResults[1].groupBonusPoints, 10);
  assert.equal(result.breakdowns["0"].minorityCorrectBonus, 5);
  assert.equal(result.breakdowns["0"].soleCorrectBonus, 10);
});

test("予想者が一人だけのゲームでは人数系ボーナスを付けない", () => {
  const result = scoreRound({
    predictions: { a: { answersByNode: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, confidenceDepth: 0 } },
    answers: [
      { nodeIndex: 0, depth: 0, answer: true },
      { nodeIndex: 1, depth: 1, answer: true },
      { nodeIndex: 3, depth: 2, answer: true }
    ],
    representativeId: "r",
    representativePrediction: { correctCountsByPlayerId: { a: 3 } },
    scoreConfig: SCORE_CONFIG
  });
  assert.equal(result.breakdowns.a.groupBonus, 0);
  assert.equal(result.breakdowns.a.total, 30);
});

test("得点設定は不足値を初期設定で補い、ゼロも許可する", () => {
  assert.deepEqual(SCORE_CONFIG, {
    questionCorrect: 5,
    allQuestionsCorrectBonus: 10,
    confidenceCorrectBonus: 5,
    soleCorrectBonus: 10,
    minorityCorrectBonus: 5,
    representativePredictionPerPlayer: 3
  });
  assert.deepEqual(snapshotScoreConfig({ questionCorrect: 0, soleCorrectBonus: 12 }), {
    ...SCORE_CONFIG,
    questionCorrect: 0,
    soleCorrectBonus: 12
  });
});

test("質問バンクの重複IDと不足を検出する", () => {
  const invalid = { genres: [{ id: "a", label: "A", questions: [{ id: "q", text: "質問" }] }] };
  assert.ok(validateQuestionBank(invalid).length >= 2);
});
