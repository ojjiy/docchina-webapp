export const TREE_DEPTH = 4;
export const NODE_COUNT = 15;
export const LEAF_COUNT = 16;
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
  return parentIndex * 2 + (answer ? 2 : 1);
}

export function answersToLeafIndex(answers) {
  if (!Array.isArray(answers) || answers.length !== TREE_DEPTH) {
    throw new Error(`${TREE_DEPTH}個の回答が必要です。`);
  }
  return answers.reduce((leaf, answer) => leaf * 2 + (answer ? 1 : 0), 0);
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
    throw new Error("4種類以上のジャンルが必要です。");
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
  if (genres.length < TREE_DEPTH) errors.push("ジャンルは4種類以上必要です。");

  for (const genre of genres) {
    if (!genre?.id || genreIds.has(genre.id)) errors.push(`ジャンルIDが不正または重複しています: ${genre?.id || "(空)"}`);
    genreIds.add(genre?.id);
    if (!String(genre?.label || "").trim()) errors.push(`ジャンル名が空です: ${genre?.id || "(不明)"}`);
    if (!Array.isArray(genre?.questions) || genre.questions.length < LEAF_COUNT) {
      errors.push(`${genre?.label || genre?.id || "ジャンル"}には16問以上必要です。`);
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

export function predictionCounts(predictions) {
  const counts = Array(LEAF_COUNT).fill(0);
  for (const leaf of Object.values(predictions || {})) {
    if (Number.isInteger(leaf) && leaf >= 0 && leaf < LEAF_COUNT) counts[leaf] += 1;
  }
  return counts;
}

export function scorePredictions(predictions, reachedLeaf) {
  return Object.entries(predictions || {})
    .filter(([, leaf]) => leaf === reachedLeaf)
    .map(([playerId]) => playerId);
}
