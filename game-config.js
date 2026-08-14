export const GAME_RULES_VERSION = 2;

export const SCORE_CONFIG = Object.freeze({
  questionCorrect: 5,
  allQuestionsCorrectBonus: 10,
  confidenceCorrectBonus: 5,
  soleCorrectBonus: 10,
  minorityCorrectBonus: 5,
  representativePredictionPerPlayer: 3
});

export function snapshotScoreConfig(config = SCORE_CONFIG) {
  return Object.fromEntries(
    Object.entries(SCORE_CONFIG).map(([key, fallback]) => {
      const value = Number(config?.[key]);
      return [key, Number.isFinite(value) && value >= 0 ? value : fallback];
    })
  );
}
