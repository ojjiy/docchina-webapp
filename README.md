# どっちーな Web App

Yes / Noで答える4段の決定木を使い、代表者が到達する葉を参加者が予測するオンラインボードゲームです。GitHub Pagesで配信できる静的アプリとして実装されています。

## ゲームの流れ

1. ホストがルームを作成し、2〜8名が表示名を登録します。
2. 各ラウンドでホストが15問を確認し、必要に応じて同ジャンル内での引き直しまたは文面編集を行います。
3. 代表者以外の参加者が16個の到達点から一つを予測します。予測中は票数だけが表示されます。
4. 代表者が4問にYes / Noで回答します。Noは左、Yesは右へ進みます。
5. 到達後に予測者名を公開し、正解者へ1点を加算します。全員が一度ずつ代表者を務めると終了します。

## ローカル起動

ES Modulesと`questions.json`の読み込みにHTTPアクセスが必要なため、ファイルを直接開かずローカルサーバーを使用してください。

```sh
npm run serve
```

ブラウザで `http://localhost:4173` を開きます。Firebase未設定時はlocalStorageモードになり、同じブラウザの複数タブで同期を確認できます。

## テスト

```sh
npm test
```

木の経路計算、ジャンル割当、問題データ、予測集計などの純粋ロジックをNode.js標準テストランナーで確認します。

## Firebase設定

1. FirebaseプロジェクトとWeb Appを作成し、Firestoreを有効にします。
2. `firebase-config.js` の `window.DOCCHINA_FIREBASE_CONFIG` にWeb App設定を記入します。FirebaseのWeb設定値はクライアントへ配布される識別情報であり、管理者秘密鍵ではありません。
3. `firestore.rules` をデプロイし、reCAPTCHA Enterpriseを利用するApp Checkを有効化します。
4. App Checkの許可ドメインへローカル確認用ドメインとGitHub Pagesのドメインを追加します。
5. FirestoreのTTLポリシーを `rooms` コレクショングループの `expiresAt` フィールドへ設定します。各ルームは最終操作から7日後を期限として保存します。

本アプリは厳密なユーザー認証を行わない、親しい参加者間のゲームを想定したMVPです。予測内容は通常UIでは名前を秘匿しますが、悪意ある参加者によるFirestoreへの直接アクセスを防ぐものではありません。

## GitHub Pages

ビルド工程はありません。GitHubリポジトリのSettingsからPagesを開き、`Deploy from a branch`、`main`、`/(root)`を選択します。共有URLはパスルーティングを使わず、`?room=ABC234` の形式で生成されます。

## 質問データ

`questions.json` は8ジャンル×16問のサンプルです。構造は次のとおりです。

```json
{
  "version": 1,
  "genres": [
    {
      "id": "genre-id",
      "label": "表示名",
      "questions": [{ "id": "unique-question-id", "text": "Yes / Noで答えられる質問" }]
    }
  ]
}
```

各問題IDはファイル全体で一意にしてください。現在の最大8ラウンドを重複なしで実行するには、8ジャンルそれぞれに16問以上が必要です。
