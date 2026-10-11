import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../game-logic.js';

function room(phase = 'predicting') {
  return { phase, players: ['a', 'b', 'c'].map(id => ({ id, name: id, score: 10 })), hostPlayerId: 'a', gamePlayerIds: ['a', 'b', 'c'], representativeIndex: 0,
    currentRound: { representativeId: 'a', eligiblePredictorIds: ['b', 'c'], predictions: { b: { answersByNode: {} } }, representativePrediction: { correctCountsByPlayerId: { b: 2, c: 1 } }, allCorrectIds: [], scoreBreakdowns: {} } };
}

test('未提出者のkickで残った全員の提出が揃えば回答へ進む', () => {
  const value = room();
  logic.kickPlayer(value, 'b', 'c', 'now');
  assert.equal(value.phase, 'answering');
  assert.deepEqual(value.currentRound.eligiblePredictorIds, ['b']);
  assert.deepEqual(value.currentRound.representativePrediction.correctCountsByPlayerId, { b: 2 });
  assert.equal(value.players[2].kickedAt, 'now');
  assert.equal(value.players[2].score, 10);
});
test('提出済み予想者のkickで予想も除外する', () => {
  const value = room('answering');
  logic.kickPlayer(value, 'a', 'b', 'now');
  assert.deepEqual(value.currentRound.predictions, {});
  assert.equal(value.phase, 'answering');
});
for (const phase of ['treeSetup', 'predicting', 'answering']) {
  test(`${phase}で代表者をkickすると無得点終了しホストを引き継ぐ`, () => {
    const value = room(phase);
    logic.kickPlayer(value, 'b', 'a', 'now');
    assert.equal(value.phase, 'reveal');
    assert.equal(value.currentRound.cancelled, true);
    assert.equal(value.hostPlayerId, 'b');
    assert.equal(value.players[0].score, 10);
  });
}
test('採点後のkickは結果を書き換えない', () => {
  const value = room('reveal');
  value.currentRound.scoreBreakdowns = { b: { total: 20 } };
  logic.kickPlayer(value, 'a', 'b', 'now');
  assert.deepEqual(value.currentRound.scoreBreakdowns, { b: { total: 20 } });
  assert.ok(value.currentRound.predictions.b);
});
test('残り1人なら進行中ラウンドを無効にして結果へ進む', () => {
  const value = room();
  value.players[2].kickedAt = 'earlier';
  logic.kickPlayer(value, 'a', 'b', 'now');
  assert.equal(value.phase, 'gameOver');
  assert.equal(value.currentRound.cancelled, true);
});
test('本人・非参加者・kick済み参加者からの操作は拒否する', () => {
  for (const [actor, target] of [['a', 'a'], ['x', 'b'], ['a', 'x']]) {
    assert.throws(() => logic.kickPlayer(room(), actor, target, 'now'));
  }
  const value = room();
  value.players[1].kickedAt = 'earlier';
  assert.throws(() => logic.kickPlayer(value, 'b', 'a', 'now'));
  assert.throws(() => logic.kickPlayer(value, 'a', 'b', 'now'));
});
test('代表者の順序は履歴を保ちkick済みの人をスキップする', () => {
  const value = room();
  value.players[1].kickedAt = 'earlier';
  assert.equal(logic.nextRepresentativeIndex(value), 2);
  value.players[2].kickedAt = 'earlier';
  assert.equal(logic.nextRepresentativeIndex(value), 3);
});
