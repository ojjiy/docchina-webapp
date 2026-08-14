# 問題バンク

`categories/` には、コミュニケーションゲーム向けの問題を出題形式ごとに収録している。

各JSONファイルは次の構造を持つ。

```json
{
  "id": "カテゴリID",
  "label": "表示名",
  "answerType": "yes-no または binary-choice",
  "description": "カテゴリの説明",
  "questions": [
    {
      "id": "ファイル全体で一意の問題ID",
      "text": "Yes / Noで判定する自己記述文",
      "theme": "話題テーマID",
      "sensitivityLevel": 2,
      "sensitiveTopics": ["romance"],
      "requiresOptIn": true,
      "namedEntities": ["固有名詞"],
      "timeSensitive": false
    }
  ]
}
```

`binary-choice` の問題には、YesとNoに対応する選択肢として `yesLabel` と `noLabel` も含める。カテゴリとテーマの定義は [CATEGORIES.md](./CATEGORIES.md) を参照。

センシティブでない通常問題では `sensitivityLevel` などを省略する。レベル1は標準利用可能、レベル2は参加者全員の同意が必要であり、`requiresOptIn: true` を必須とする。レベル3相当の問題は標準バンクへ収録しない。

固有名詞が設問の意味に必要な場合は `namedEntities` に記録する。SNSなど内容が変化しやすいものには `timeSensitive: true` も付ける。

知識・教養カテゴリの問題には、分野を表す `subject` も含める。現在は `psychology`、`trivia`、`kanji`、`japanese`、`technology`、`history` を各5問収録している。

すべての `text` は疑問文ではなく、「〜したい。」「〜する方だ。」「〜したことがある。」などの言い切り表現に統一している。

この問題バンクは内容をレビューするための素材であり、現在アプリが読み込んでいるルートの `questions.json` は変更していない。

外部資料を問題案の参考にした場合の出典と変換方針は [SOURCES.md](./SOURCES.md) に記録する。
