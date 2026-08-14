export const TREE_DEPTH = 3;
export const NODE_COUNT = 7;
export const LEAF_COUNT = 8;
export const MIN_QUESTIONS_PER_GENRE = 7;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function nodeDepth(index) {
  if (!Number.isInteger(index) || index < 0 || index >= NODE_COUNT) return -1;
  return Math.floor(Math.log2(index + 1));
}

export function childNodeIndex(parentIndex, answer) {
  return parentIndex * 2 + (answer ? 1 : 2);
}

export function answersToLeafIndex(answers) {
  if (!Array.isArray(answers) || answers.length !== TREE_DEPTH) {
    throw new Error(`${TREE_DEPTH}個の回答が必要です。`);
  }
  return answers.reduce((leaf, answer) => leaf * 2 + (answer ? 0 : 1), 0);
}

export function getPathNodeIndices(answers) {
  const path = [];
  let current = 0;
  for (const answer of answers || []) {
    path.push(current);
    if (path.length < TREE_DEPTH) current = childNodeIndex(current, Boolean(answer));
  }
  return path;
}

export function createGenreSchedule(genreIds, roundCount, random = Math.random) {
  if (!Array.isArray(genreIds) || genreIds.length < TREE_DEPTH) {
    throw new Error(`${TREE_DEPTH}種類以上のジャンルが必要です。`);
  }
  const count = Math.max(1, Math.min(Number(roundCount) || 1, genreIds.length));
  const order = shuffle(genreIds, random);
  return Array.from({ length: count }, (_, round) =>
    Array.from({ length: TREE_DEPTH }, (_, depth) => order[(round + depth) % order.length])
  );
}

export function validateQuestionBank(bank) {
  const errors = [];
  const genres = Array.isArray(bank?.genres) ? bank.genres : [];
  const genreIds = new Set();
  const questionIds = new Set();
  if (genres.length < MAX_PLAYERS) errors.push(`ジャンルは${MAX_PLAYERS}種類以上必要です。`);

  for (const genre of genres) {
    if (!genre?.id || genreIds.has(genre.id)) errors.push(`ジャンルIDが不正または重複しています: ${genre?.id || "(空)"}`);
    genreIds.add(genre?.id);
    if (!String(genre?.label || "").trim()) errors.push(`ジャンル名が空です: ${genre?.id || "(不明)"}`);
    if (!Array.isArray(genre?.questions) || genre.questions.length < MIN_QUESTIONS_PER_GENRE) {
      errors.push(`${genre?.label || genre?.id || "ジャンル"}には${MIN_QUESTIONS_PER_GENRE}問以上必要です。`);
      continue;
    }
    for (const question of genre.questions) {
      if (!question?.id || questionIds.has(question.id)) errors.push(`問題IDが不正または重複しています: ${question?.id || "(空)"}`);
      questionIds.add(question?.id);
      if (!String(question?.text || "").trim()) errors.push(`問題文が空です: ${question?.id || "(不明)"}`);
    }
  }
  return errors;
}

export function sampleRoundNodes(bank, genreByDepth, usedQuestionIds = [], random = Math.random) {
  const used = new Set(usedQuestionIds);
  const genres = new Map(bank.genres.map((genre) => [genre.id, genre]));
  const nodes = [];
  for (let depth = 0; depth < TREE_DEPTH; depth += 1) {
    const genreId = genreByDepth[depth];
    const genre = genres.get(genreId);
    if (!genre) throw new Error(`ジャンル ${genreId} が見つかりません。`);
    const required = 2 ** depth;
    const candidates = shuffle(genre.questions.filter((question) => !used.has(question.id)), random);
    if (candidates.length < required) throw new Error(`${genre.label}の未使用問題が不足しています。`);
    for (let offset = 0; offset < required; offset += 1) {
      const question = candidates[offset];
      nodes.push({
        index: 2 ** depth - 1 + offset,
        depth,
        genreId,
        genreLabel: genre.label,
        questionId: question.id,
        originalText: question.text,
        text: question.text
      });
      used.add(question.id);
    }
  }
  return nodes.sort((a, b) => a.index - b.index);
}

export function rerollNode(bank, nodes, usedQuestionIds, nodeIndex, random = Math.random) {
  const target = nodes.find((node) => node.index === nodeIndex);
  if (!target) throw new Error("対象の問題が見つかりません。");
  const genre = bank.genres.find((item) => item.id === target.genreId);
  const excluded = new Set([...usedQuestionIds, ...nodes.filter((node) => node.index !== nodeIndex).map((node) => node.questionId)]);
  const candidates = shuffle(genre.questions.filter((question) => !excluded.has(question.id) && question.id !== target.questionId), random);
  if (!candidates.length) throw new Error("このジャンルには引き直せる問題がありません。");
  const question = candidates[0];
  return nodes.map((node) => node.index === nodeIndex
    ? { ...node, questionId: question.id, originalText: question.text, text: question.text }
    : node
  );
}

export function predictionPathAnswers(prediction) {
  const answersByNode = prediction?.answersByNode || {};
  const answers = [];
  let currentNodeIndex = 0;
  for (let depth = 0; depth < TREE_DEPTH; depth += 1) {
    const answer = answersByNode[currentNodeIndex];
    if (typeof answer !== "boolean") return null;
    answers.push(answer);
    if (depth < TREE_DEPTH - 1) currentNodeIndex = childNodeIndex(currentNodeIndex, answer);
  }
  return answers;
}

export function predictionToLeafIndex(prediction) {
  const answers = predictionPathAnswers(prediction);
  return answers ? answersToLeafIndex(answers) : null;
}

export function predictionCounts(predictions) {
  const counts = Array(LEAF_COUNT).fill(0);
  for (const prediction of Object.values(predictions || {})) {
    const leaf = predictionToLeafIndex(prediction);
    if (Number.isInteger(leaf) && leaf >= 0 && leaf < LEAF_COUNT) counts[leaf] += 1;
  }
  return counts;
}

export function scoreRound({ predictions, answers, representativeId, representativePrediction, scoreConfig }) {
  const predictorEntries = Object.entries(predictions || {});
  const pathAnswers = Array.isArray(answers) ? answers : [];
  if (pathAnswers.length !== TREE_DEPTH) throw new Error(`${TREE_DEPTH}問分の回答が必要です。`);

  const config = {
    questionCorrect: Number(scoreConfig?.questionCorrect || 0),
    allQuestionsCorrectBonus: Number(scoreConfig?.allQuestionsCorrectBonus || 0),
    confidenceCorrectBonus: Number(scoreConfig?.confidenceCorrectBonus || 0),
    soleCorrectBonus: Number(scoreConfig?.soleCorrectBonus || 0),
    minorityCorrectBonus: Number(scoreConfig?.minorityCorrectBonus || 0),
    representativePredictionPerPlayer: Number(scoreConfig?.representativePredictionPerPlayer || 0)
  };
  const correctPlayerIdsByNode = new Map(pathAnswers.map((answer) => {
    const correctIds = predictorEntries
      .filter(([, prediction]) => prediction?.answersByNode?.[answer.nodeIndex] === Boolean(answer.answer))
      .map(([playerId]) => playerId);
    return [answer.nodeIndex, correctIds];
  }));

  const breakdowns = {};
  for (const [playerId, prediction] of predictorEntries) {
    const nodeResults = pathAnswers.map((answer) => {
      const correct = prediction?.answersByNode?.[answer.nodeIndex] === Boolean(answer.answer);
      const correctCount = correctPlayerIdsByNode.get(answer.nodeIndex)?.length || 0;
      let groupBonusType = null;
      let groupBonusPoints = 0;
      if (correct && predictorEntries.length >= 2 && correctCount === 1) {
        groupBonusType = "sole";
        groupBonusPoints = config.soleCorrectBonus;
      } else if (correct && correctCount > 1 && correctCount < predictorEntries.length / 2) {
        groupBonusType = "minority";
        groupBonusPoints = config.minorityCorrectBonus;
      }
      const confidenceCorrect = correct && prediction.confidenceDepth === answer.depth;
      return {
        nodeIndex: answer.nodeIndex,
        depth: answer.depth,
        predictedAnswer: prediction?.answersByNode?.[answer.nodeIndex],
        actualAnswer: Boolean(answer.answer),
        correct,
        correctPlayerCount: correctCount,
        questionPoints: correct ? config.questionCorrect : 0,
        confidencePoints: confidenceCorrect ? config.confidenceCorrectBonus : 0,
        groupBonusType,
        groupBonusPoints
      };
    });
    const correctCount = nodeResults.filter((result) => result.correct).length;
    const questionPoints = nodeResults.reduce((sum, result) => sum + result.questionPoints, 0);
    const confidenceBonus = nodeResults.reduce((sum, result) => sum + result.confidencePoints, 0);
    const soleCorrectBonus = nodeResults
      .filter((result) => result.groupBonusType === "sole")
      .reduce((sum, result) => sum + result.groupBonusPoints, 0);
    const minorityCorrectBonus = nodeResults
      .filter((result) => result.groupBonusType === "minority")
      .reduce((sum, result) => sum + result.groupBonusPoints, 0);
    const groupBonus = soleCorrectBonus + minorityCorrectBonus;
    const allQuestionsCorrectBonus = correctCount === TREE_DEPTH ? config.allQuestionsCorrectBonus : 0;
    breakdowns[playerId] = {
      role: "predictor",
      correctCount,
      questionPoints,
      allQuestionsCorrectBonus,
      confidenceBonus,
      soleCorrectBonus,
      minorityCorrectBonus,
      groupBonus,
      representativePredictionMatches: 0,
      representativePredictionBonus: 0,
      total: questionPoints + allQuestionsCorrectBonus + confidenceBonus + groupBonus,
      nodeResults
    };
  }

  const guessedCounts = representativePrediction?.correctCountsByPlayerId || {};
  const representativePredictionMatches = predictorEntries.filter(([playerId]) => (
    Number(guessedCounts[playerId]) === breakdowns[playerId].correctCount
  )).length;
  const representativePredictionBonus = representativePredictionMatches * config.representativePredictionPerPlayer;
  breakdowns[representativeId] = {
    role: "representative",
    correctCount: null,
    questionPoints: 0,
    allQuestionsCorrectBonus: 0,
    confidenceBonus: 0,
    soleCorrectBonus: 0,
    minorityCorrectBonus: 0,
    groupBonus: 0,
    representativePredictionMatches,
    representativePredictionBonus,
    total: representativePredictionBonus,
    nodeResults: []
  };

  return {
    breakdowns,
    allCorrectIds: predictorEntries
      .filter(([playerId]) => breakdowns[playerId].correctCount === TREE_DEPTH)
      .map(([playerId]) => playerId)
  };
}

export function appendQueuedPlayerIds(gamePlayerIds, playerIds, maximum = MAX_PLAYERS) {
  const result = [...gamePlayerIds];
  for (const playerId of playerIds) {
    if (result.length >= maximum) break;
    if (!result.includes(playerId)) result.push(playerId);
  }
  return result;
}
