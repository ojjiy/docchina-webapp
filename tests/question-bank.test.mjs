import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const CATEGORY_DIRECTORY = new URL("../question-bank/categories/", import.meta.url);
const MIN_QUESTIONS_PER_CATEGORY = 16;
const EXPECTED_CATEGORY_IDS = [
  "positive-choice",
  "negative-choice",
  "experience",
  "preference",
  "physical-ability",
  "knowledge",
  "values",
  "personality",
  "daily-habits",
  "communication",
  "work-learning"
];
const ALLOWED_THEMES = new Set([
  "food",
  "travel",
  "entertainment",
  "hobby",
  "daily",
  "relationships",
  "work-study",
  "money",
  "digital",
  "sports-health",
  "childhood",
  "future",
  "values",
  "senses",
  "challenge",
  "community"
]);
const KNOWLEDGE_SUBJECTS = [
  "psychology",
  "trivia",
  "kanji",
  "japanese",
  "technology",
  "history"
];
const ALLOWED_SENSITIVE_TOPICS = new Set([
  "body",
  "gender",
  "gender-expression",
  "intimacy",
  "marriage",
  "money",
  "mortality",
  "privacy",
  "relationships",
  "romance"
]);

async function readCategories() {
  const fileNames = (await readdir(CATEGORY_DIRECTORY))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  return Promise.all(fileNames.map(async (fileName) => ({
    fileName,
    data: JSON.parse(await readFile(new URL(fileName, CATEGORY_DIRECTORY), "utf8"))
  })));
}

test("問題バンクは定義した11カテゴリを個別ファイルで収録する", async () => {
  const categories = await readCategories();
  assert.equal(categories.length, EXPECTED_CATEGORY_IDS.length);
  assert.deepEqual(
    categories.map(({ data }) => data.id).sort(),
    [...EXPECTED_CATEGORY_IDS].sort()
  );
  for (const { fileName, data } of categories) {
    assert.equal(fileName, `${data.id}.json`);
    assert.ok(String(data.label).trim());
    assert.ok(String(data.description).trim());
    assert.ok(["yes-no", "binary-choice"].includes(data.answerType));
  }
});

test("各カテゴリは有効な問題を16問以上収録する", async () => {
  const categories = await readCategories();
  const questionIds = new Set();
  const questionTexts = new Set();
  let questionCount = 0;

  for (const { data } of categories) {
    assert.ok(
      data.questions.length >= MIN_QUESTIONS_PER_CATEGORY,
      `${data.label}の問題数が${MIN_QUESTIONS_PER_CATEGORY}問未満`
    );
    questionCount += data.questions.length;
    for (const question of data.questions) {
      assert.match(question.id, new RegExp(`^${data.id}-\\d{2}$`));
      assert.ok(!questionIds.has(question.id), `問題IDが重複: ${question.id}`);
      questionIds.add(question.id);

      const text = String(question.text).trim();
      assert.ok(text.endsWith("。"), `句点で終わっていない: ${question.id}`);
      assert.doesNotMatch(text, /[？?]/, `疑問文になっている: ${question.id}`);
      assert.ok(!questionTexts.has(text), `問題文が重複: ${question.id}`);
      questionTexts.add(text);

      assert.ok(ALLOWED_THEMES.has(question.theme), `不明なテーマ: ${question.id}`);
      if (question.sensitivityLevel !== undefined) {
        assert.ok([1, 2].includes(question.sensitivityLevel), `不正なセンシティブ度: ${question.id}`);
        assert.ok(Array.isArray(question.sensitiveTopics) && question.sensitiveTopics.length > 0);
        for (const topic of question.sensitiveTopics) {
          assert.ok(ALLOWED_SENSITIVE_TOPICS.has(topic), `不明なセンシティブ題材: ${question.id}`);
        }
        assert.equal(question.requiresOptIn, question.sensitivityLevel === 2);
      }
      if (question.namedEntities !== undefined) {
        assert.ok(Array.isArray(question.namedEntities) && question.namedEntities.length > 0);
        for (const entity of question.namedEntities) assert.ok(String(entity).trim());
        if (question.timeSensitive !== undefined) assert.equal(typeof question.timeSensitive, "boolean");
      }
      if (data.answerType === "binary-choice") {
        assert.ok(String(question.yesLabel).trim(), `Yesの選択肢が空: ${question.id}`);
        assert.ok(String(question.noLabel).trim(), `Noの選択肢が空: ${question.id}`);
        assert.notEqual(question.yesLabel, question.noLabel, `選択肢が同一: ${question.id}`);
        assert.doesNotMatch(
          text,
          /どちら(?:を選びます|が嬉しい)/,
          `Yes / Noで答えにくい二択表現: ${question.id}`
        );
      }
    }
  }

  assert.equal(questionIds.size, questionCount);
});

test("日常生活・習慣は行動傾向を表す文体に統一する", async () => {
  const categories = await readCategories();
  const dailyHabits = categories.find(({ data }) => data.id === "daily-habits").data;
  const tendencyCount = dailyHabits.questions.filter((question) =>
    /(ことが多い|方だ|少ない|している|抵抗がない)。$/.test(question.text)
  ).length;
  assert.ok(tendencyCount >= Math.ceil(dailyHabits.questions.length / 2));
});

test("知識・教養は6分野を5問ずつ収録する", async () => {
  const knowledge = JSON.parse(
    await readFile(new URL("knowledge.json", CATEGORY_DIRECTORY), "utf8")
  );
  const counts = Object.fromEntries(KNOWLEDGE_SUBJECTS.map((subject) => [subject, 0]));

  for (const question of knowledge.questions) {
    assert.ok(KNOWLEDGE_SUBJECTS.includes(question.subject), `不明な知識分野: ${question.id}`);
    counts[question.subject] += 1;
  }

  assert.deepEqual(counts, Object.fromEntries(KNOWLEDGE_SUBJECTS.map((subject) => [subject, 5])));
});
