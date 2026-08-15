import {
  LEAF_COUNT,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NODE_COUNT,
  TREE_DEPTH,
  appendQueuedPlayerIds,
  answersToLeafIndex,
  childNodeIndex,
  createGenreSchedule,
  getPathNodeIndices,
  nodeDepth,
  predictionAnswerGroups,
  predictionCounts,
  predictionToLeafIndex,
  rerollNode,
  sampleRoundNodes,
  scoreRound,
  validateQuestionBank
} from "./game-logic.js";
import { GAME_RULES_VERSION, SCORE_CONFIG, snapshotScoreConfig } from "./game-config.js";

const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
const FIREBASE_STORE_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
const FIREBASE_APP_CHECK_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js";
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENCE_INTERVAL_MS = 30 * 1000;
const HOST_STALE_MS = 90 * 1000;
const TREE_WIDTH = 1200;
const NODE_HEIGHT = 212;
const LEVEL_Y = [24, 282, 540];
const LEAF_Y = 804;
const TREE_HEIGHT = 934;
const PLAYER_MARKS = ["●", "▲", "■", "◆", "★", "✦", "⬟", "✚"];

const state = {
  roomId: roomIdFromUrl(),
  playerId: null,
  hostKey: null,
  room: null,
  store: null,
  questionBank: null,
  questionError: "",
  missingRoom: false,
  syncMode: "local",
  loading: false,
  error: "",
  notice: "",
  nameDraft: "",
  predictionDraft: {},
  confidenceDraft: null,
  representativePredictionDraft: {},
  draftRoundKey: null,
  presenceTimer: null
};

const root = document.querySelector("#app");

class RoomStore {
  constructor(callbacks) {
    Object.assign(this, callbacks);
    this.mode = "local";
    this.roomId = null;
    this.room = null;
    this.db = null;
    this.fs = null;
    this.unsubscribe = null;
    this.storageHandler = null;
  }

  async init() {
    const config = window.DOCCHINA_FIREBASE_CONFIG;
    if (!config?.apiKey || !config?.projectId) return this.setMode("local");
    const { appCheckSiteKey, ...firebaseConfig } = config;
    try {
      const [{ initializeApp }, firestore, appCheck] = await Promise.all([
        import(FIREBASE_APP_URL),
        import(FIREBASE_STORE_URL),
        import(FIREBASE_APP_CHECK_URL)
      ]);
      const firebaseApp = initializeApp(firebaseConfig);
      if (appCheckSiteKey) {
        appCheck.initializeAppCheck(firebaseApp, {
          provider: new appCheck.ReCaptchaEnterpriseProvider(appCheckSiteKey),
          isTokenAutoRefreshEnabled: true
        });
      }
      this.fs = firestore;
      this.db = firestore.getFirestore(firebaseApp);
      this.setMode("firebase");
    } catch (error) {
      console.error(error);
      this.setMode("local");
      this.onError("Firebaseへ接続できないため、このブラウザ内で動作します。");
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.onMode(mode);
  }

  async create(room) {
    const normalized = normalizeRoom(room);
    if (this.mode === "firebase") {
      const ref = this.fs.doc(this.db, "rooms", normalized.id);
      await this.fs.runTransaction(this.db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists()) throw new Error("ルームIDが重複しました。");
        transaction.set(ref, toFirestoreRoom(normalized, this.fs));
      });
    } else {
      if (readLocalRoom(normalized.id)) throw new Error("ルームIDが重複しました。");
      writeLocalRoom(normalized);
    }
    await this.connect(normalized.id);
  }

  async connect(roomId) {
    this.disconnect();
    this.roomId = roomId;
    if (this.mode === "firebase") {
      const ref = this.fs.doc(this.db, "rooms", roomId);
      this.unsubscribe = this.fs.onSnapshot(ref, (snapshot) => {
        this.room = snapshot.exists() ? normalizeRoom(snapshot.data()) : null;
        this.onMissing(!this.room);
        this.onRoom(this.room);
      }, (error) => {
        console.error(error);
        this.onError("ルームを読み込めませんでした。");
      });
      return;
    }
    this.room = readLocalRoom(roomId);
    this.onMissing(!this.room);
    this.onRoom(this.room);
    this.storageHandler = (event) => {
      if (event.key !== localRoomKey(roomId)) return;
      this.room = readLocalRoom(roomId);
      this.onMissing(!this.room);
      this.onRoom(this.room);
    };
    window.addEventListener("storage", this.storageHandler);
  }

  disconnect() {
    if (this.unsubscribe) this.unsubscribe();
    if (this.storageHandler) window.removeEventListener("storage", this.storageHandler);
    this.unsubscribe = null;
    this.storageHandler = null;
  }

  async update(mutator) {
    if (!this.roomId) throw new Error("ルームが選択されていません。");
    if (this.mode === "firebase") {
      const ref = this.fs.doc(this.db, "rooms", this.roomId);
      await this.fs.runTransaction(this.db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error("ルームが見つかりません。");
        const current = normalizeRoom(snapshot.data());
        const next = mutator(structuredClone(current));
        if (!next) return;
        next.updatedAt = nowIso();
        next.expiresAt = expirationIso();
        transaction.set(ref, toFirestoreRoom(normalizeRoom(next), this.fs));
      });
      return;
    }
    const current = readLocalRoom(this.roomId);
    if (!current) throw new Error("ルームが見つかりません。");
    const next = mutator(structuredClone(current));
    if (!next) return;
    next.updatedAt = nowIso();
    next.expiresAt = expirationIso();
    this.room = normalizeRoom(next);
    writeLocalRoom(this.room);
    this.onMissing(false);
    this.onRoom(this.room);
  }
}

async function boot() {
  try {
    const response = await fetch("./questions.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.questionBank = await response.json();
    const errors = validateQuestionBank(state.questionBank);
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (error) {
    console.error(error);
    state.questionError = "質問データを読み込めませんでした。ローカルサーバーから開いてください。";
  }

  state.store = new RoomStore({
    onRoom: (room) => {
      state.room = room;
      if (room && state.playerId && !room.players.some((player) => player.id === state.playerId)) {
        state.playerId = null;
        sessionStorage.removeItem(playerKey(room.id));
      }
      const draftRoundKey = room?.currentRound?.createdAt || null;
      if (state.draftRoundKey !== draftRoundKey) {
        resetRoundDrafts();
        state.draftRoundKey = draftRoundKey;
      }
      render();
      maintainPresence();
    },
    onMissing: (missing) => {
      state.missingRoom = missing;
      render();
    },
    onMode: (mode) => {
      state.syncMode = mode;
      render();
    },
    onError: setError
  });

  await state.store.init();
  restoreSession(state.roomId);
  if (state.roomId) await state.store.connect(state.roomId);
  render();
}

function render() {
  const focused = captureFocus();
  const treePositions = captureTreePositions();
  root.replaceChildren(appShell(renderContent()));
  restoreFocus(focused);
  restoreTreePositions(treePositions);
}

function renderContent() {
  if (state.questionError) return messagePanel("準備できませんでした", state.questionError, "error");
  if (!state.roomId) return renderHome();
  if (state.missingRoom && !state.room) return renderMissingRoom();
  if (!state.room) return loadingPanel("ルームを読み込んでいます");
  if (state.room.rulesVersion !== GAME_RULES_VERSION) return renderIncompatibleRoom();
  if (!currentPlayer()) return renderNameRegistration();
  return renderRoom();
}

function appShell(content) {
  return h("div", { class: "app-shell" },
    h("header", { class: "site-header" },
      h("a", { class: "brand", href: baseUrl(), "aria-label": "どっちーな ホーム" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }, "D"),
        h("span", {}, h("strong", {}, "どっちーな"), h("small", {}, "YES / NO PREDICTION GAME"))
      ),
      state.room ? h("div", { class: "header-room" },
        h("button", { class: "room-code", onclick: copyInvite, title: "招待URLをコピー" }, `ROOM ${state.room.id}`)
      ) : null
    ),
    h("main", { id: "main-content", class: "main-content" },
      state.error ? h("div", { class: "alert error", role: "alert" }, state.error) : null,
      state.notice ? h("div", { class: "alert notice", role: "status" }, state.notice) : null,
      content
    ),
    h("footer", { class: "site-footer" },
      h("span", {}, "DOCCHINA GAME SOCIETY"),
      h("span", {}, state.syncMode === "firebase" ? "ONLINE · FIRESTORE" : "LOCAL SESSION")
    )
  );
}

function renderHome() {
  return h("div", { class: "home" },
    h("section", { class: "hero" },
      h("p", { class: "eyebrow" }, "A GAME OF INSIGHT AND PREDICTION"),
      h("h1", {}, "答えの先を、", h("br"), "誰よりも深く読む。"),
      h("p", { class: "hero-copy" }, "7つの質問を先読みし、代表者が実際にたどる3つのYes / Noを当てる。読みの深さと勝負勘を競うオンラインボードゲームです。"),
      h("div", { class: "ornament", "aria-hidden": "true" }, h("span"), h("i"), h("span"))
    ),
    h("section", { class: "entry-grid", "aria-label": "ゲームを始める" },
      h("article", { class: "entry-card featured" },
        h("span", { class: "card-number" }, "I"),
        h("h2", {}, "新しい卓を開く"),
        h("p", {}, "ルームを作成し、招待URLを参加者へ共有します。"),
        button("ルームを作成", createRoom, "primary", { disabled: state.loading })
      ),
      h("article", { class: "entry-card" },
        h("span", { class: "card-number" }, "II"),
        h("h2", {}, "卓へ参加する"),
        h("p", {}, "招待された6桁のルームコードを入力してください。"),
        h("form", { class: "join-form", onsubmit: joinRoom },
          label("ルームコード", h("input", { name: "roomId", maxlength: "6", pattern: "[A-Za-z2-9]{6}", autocomplete: "off", placeholder: "ABC234", required: true })),
          button("参加する", null, "secondary", { type: "submit" })
        )
      )
    ),
    h("section", { class: "how-to" },
      h("p", { class: "eyebrow" }, "HOW TO PLAY"),
      h("div", { class: "steps" },
        step("01", "予測する", "代表者以外は7問すべてを予想し、自信のあるカテゴリを選びます。"),
        step("02", "答える", "代表者は皆の正解数を予想してから、実経路の3問に答えます。"),
        step("03", "競い合う", "質問ごとの正解点と、全問一致・少数派などのボーナスを獲得します。")
      )
    )
  );
}

function renderMissingRoom() {
  return messagePanel("ルームが見つかりません", "URLまたは有効期限をご確認ください。ルームは最終操作から7日後に期限切れとなります。", "empty",
    h("a", { class: "button primary", href: baseUrl() }, "ホームへ戻る")
  );
}

function renderIncompatibleRoom() {
  return messagePanel(
    "このルームは旧ルールで作成されています",
    "新しい3段ルールとは互換性がないため、新しいルームを作成してください。",
    "empty",
    h("a", { class: "button primary", href: baseUrl() }, "新しいルームを作る")
  );
}

function renderNameRegistration() {
  return h("section", { class: "narrow-panel registration" },
    h("p", { class: "eyebrow" }, `ROOM ${state.room.id}`),
    h("h1", {}, "お名前をお聞かせください"),
    h("p", { class: "muted" }, "このゲーム中に表示する名前です。20文字以内で入力してください。"),
    h("form", { class: "stack", onsubmit: registerName },
      label("表示名", h("input", { name: "name", maxlength: "20", value: state.nameDraft, oninput: (event) => { state.nameDraft = event.currentTarget.value; }, autofocus: true, required: true, placeholder: "表示名" })),
      button("着席する", null, "primary", { type: "submit", disabled: state.loading })
    )
  );
}

function renderRoom() {
  const room = state.room;
  return h("div", { class: "room-layout" },
    h("aside", { class: "room-sidebar" },
      h("div", { class: "sidebar-heading" }, h("p", { class: "eyebrow" }, "MEMBERS"), h("h2", {}, "参加者")),
      renderPlayers(),
      renderRoomActions()
    ),
    h("section", { class: "game-stage" },
      room.phase === "lobby" ? renderLobby()
        : room.phase === "treeSetup" ? renderTreeSetup()
          : room.phase === "predicting" ? renderPrediction()
            : room.phase === "answering" ? renderAnswering()
              : room.phase === "reveal" ? renderReveal()
                : renderGameOver()
    )
  );
}

function renderPlayers() {
  const room = state.room;
  const activeIds = new Set(room.gamePlayerIds || []);
  return h("ol", { class: "player-list" },
    ...room.players.map((player) => {
      const isRepresentative = room.currentRound?.representativeId === player.id && room.phase !== "gameOver";
      return h("li", { class: `player ${player.id === state.playerId ? "self" : ""} ${isRepresentative ? "representative" : ""}` },
        renderPlayerMark(player.id, { decorative: true }),
        h("span", { class: "player-info" },
          h("strong", {}, player.name, player.id === room.hostPlayerId ? h("small", {}, " HOST") : null),
          h("small", {}, activeIds.size && !activeIds.has(player.id) ? "次ラウンドから参加" : isRepresentative ? "代表者" : "参加者")
        ),
        h("span", { class: "score" }, h("b", {}, String(player.score || 0)), " pt")
      );
    })
  );
}

function renderRoomActions() {
  const host = hostPlayer();
  const hostStale = host && Date.now() - Date.parse(host.lastSeenAt || host.joinedAt || 0) > HOST_STALE_MS;
  return h("div", { class: "sidebar-actions" },
    button("招待URLをコピー", copyInvite, "ghost compact"),
    !isHost() && hostStale ? button("進行役を引き継ぐ", claimHost, "ghost compact") : null,
    h("a", { class: "text-link", href: baseUrl() }, "ルームから退出")
  );
}

function renderLobby() {
  const count = state.room.players.length;
  return h("div", { class: "stage-panel lobby-panel" },
    stageHeader("THE DRAWING ROOM", "参加者をお待ちしています", "全員が着席したら、参加順に代表者を務めます。"),
    h("div", { class: "lobby-code" }, h("small", {}, "ROOM CODE"), h("strong", {}, state.room.id), button("コピー", copyInvite, "ghost compact")),
    h("div", { class: "rule-grid" },
      ruleCard("7", "予想問題", "予想者は全ノードへ回答"),
      ruleCard("3", "実経路", "代表者が答える質問数"),
      ruleCard(String(SCORE_CONFIG.questionCorrect), "質問正解点", "各問にボーナスの機会")
    ),
    h("div", { class: "stage-actions" },
      isHost()
        ? button(count < MIN_PLAYERS ? "2名以上で開始できます" : count > MAX_PLAYERS ? "8名まで参加できます" : "ゲームを開始", startGame, "primary large", { disabled: state.loading || count < MIN_PLAYERS || count > MAX_PLAYERS })
        : h("p", { class: "waiting" }, "ホストがゲームを開始するまでお待ちください。")
    )
  );
}

function renderTreeSetup() {
  const round = state.room.currentRound;
  return h("div", { class: "stage-panel wide" },
    stageHeader(`ROUND ${round.roundNumber} · PREPARATION`, `${playerName(round.representativeId)}さんへの質問`, isHost() ? "問題を引き直すか文面を調整し、質問の木を確定してください。" : "ホストが質問を準備しています。"),
    renderGenreLegend(round),
    h("form", { id: "tree-setup-form", onsubmit: confirmTree },
      renderTreeBoard({ editable: isHost() }),
      h("div", { class: "stage-actions sticky-actions" },
        isHost() ? button("この質問で予測を始める", null, "primary large", { type: "submit", disabled: state.loading }) : h("p", { class: "waiting" }, "質問の確定をお待ちください。")
      )
    )
  );
}

function renderPrediction() {
  const round = state.room.currentRound;
  const isRepresentative = round.representativeId === state.playerId;
  const prediction = ownPrediction(state.room);
  const eligible = round.eligiblePredictorIds.includes(state.playerId);
  const representativeSubmitted = Boolean(round.representativePrediction);
  const predictorSubmittedCount = Object.keys(round.predictions || {}).length;
  return h("div", { class: "stage-panel wide" },
    stageHeader(
      `ROUND ${round.roundNumber} · PREDICTION`,
      isRepresentative ? "みんなの正解数を読む" : `${playerName(round.representativeId)}さんの答えを読む`,
      isRepresentative
        ? representativeSubmitted ? "正解数の予想を確定しました。皆さんの提出をお待ちください。" : "他の参加者が実経路3問のうち何問を当てるか予想してください。"
        : prediction ? "7問の予想を確定しました。代表者の回答をお待ちください。" : "すべての質問へYes / Noで予想し、自信のあるカテゴリを一つ選んでください。"
    ),
    renderGenreLegend(round),
    renderTreeBoard({ predictionEditor: eligible && !prediction, showOwnPrediction: eligible }),
    isRepresentative && !representativeSubmitted ? renderRepresentativePredictionForm(round) : null,
    eligible && !prediction ? renderConfidencePicker(round) : null,
    h("div", { class: "prediction-status" },
      h("p", {}, h("strong", {}, `${predictorSubmittedCount} / ${round.eligiblePredictorIds.length}`), " 名の予想者が提出済み"),
      h("p", { class: "sub-status" }, `回答者の正解数予想：${representativeSubmitted ? "提出済み" : "未提出"}`),
      eligible && !prediction
        ? button(
          predictionReady(round) ? "7問の予想を確定" : "7問すべてと自信カテゴリを選んでください",
          submitPrediction,
          "primary large",
          { disabled: !predictionReady(round) || state.loading }
        )
        : h("p", { class: "waiting" }, isRepresentative ? "全員の提出が揃うと回答へ進みます。" : prediction ? "予想は確定済みです。" : "次のラウンドから予想へ参加できます。")
    ),
    isHost() ? h("div", { class: "danger-zone" }, button("このラウンドを無効終了", cancelRound, "danger compact")) : null
  );
}

function renderRepresentativePredictionForm(round) {
  return h("section", { class: "representative-prediction" },
    h("header", {}, h("p", { class: "eyebrow" }, "ANSWERER'S FORECAST"), h("h2", {}, "参加者ごとの正解数予想"), h("p", {}, "実経路3問のうち何問を当てるか、0〜3で選びます。")),
    h("div", { class: "count-prediction-grid" }, ...round.eligiblePredictorIds.map((playerId) => {
      const selected = state.representativePredictionDraft[playerId];
      return h("label", { class: "count-prediction-row" },
        h("strong", {}, playerName(playerId)),
        h("select", {
          onchange: (event) => {
            state.representativePredictionDraft[playerId] = Number(event.currentTarget.value);
            render();
          },
          "aria-label": `${playerName(playerId)}さんの正解数予想`
        },
        h("option", { value: "", disabled: true, selected: selected == null }, "選択"),
        ...Array.from({ length: TREE_DEPTH + 1 }, (_, count) => h("option", { value: String(count), selected: selected === count }, `${count}問`)))
      );
    })),
    button(
      representativePredictionReady(round) ? "正解数予想を確定" : "全員分を選んでください",
      submitRepresentativePrediction,
      "secondary large",
      { disabled: !representativePredictionReady(round) || state.loading }
    )
  );
}

function renderConfidencePicker(round) {
  return h("section", { class: "confidence-picker" },
    h("div", {}, h("p", { class: "eyebrow" }, "CONFIDENCE MARKER"), h("h2", {}, "自信のあるカテゴリを一つ選ぶ"), h("p", {}, `選んだカテゴリの実経路問題に正解すると +${state.room.scoringConfig.confidenceCorrectBonus}点です。`)),
    h("div", { class: "confidence-options" }, ...round.genreByDepth.map((genreId, depth) => {
      const genre = state.questionBank.genres.find((item) => item.id === genreId);
      const selected = state.confidenceDraft === depth;
      return button(`${depth + 1}段目 · ${genre?.label || genreId}`, () => {
        state.confidenceDraft = depth;
        render();
      }, selected ? "confidence selected" : "confidence", { "aria-pressed": String(selected) });
    }))
  );
}

function renderAnswering() {
  const round = state.room.currentRound;
  const node = round.nodes.find((item) => item.index === round.currentNodeIndex);
  const isRepresentative = round.representativeId === state.playerId;
  return h("div", { class: "stage-panel wide" },
    stageHeader(`ROUND ${round.roundNumber} · ANSWER`, `${playerName(round.representativeId)}さんの回答`, `${round.answers.length + 1}問目 / ${TREE_DEPTH}問`),
    h("section", { class: "answer-card" },
      h("p", { class: "genre-chip" }, node.genreLabel),
      h("h2", {}, node.text),
      renderCurrentPredictionPeek(round, node),
      isRepresentative
        ? h("div", { class: "answer-actions" }, button("YES", () => answerQuestion(true), "answer yes", { disabled: state.loading }), button("NO", () => answerQuestion(false), "answer no", { disabled: state.loading }))
        : h("p", { class: "waiting" }, "代表者が回答しています。")
    ),
    renderTreeBoard(),
    isHost() ? h("div", { class: "danger-zone" }, button("このラウンドを無効終了", cancelRound, "danger compact")) : null
  );
}

function renderCurrentPredictionPeek(round, node) {
  const { yesPlayerIds, noPlayerIds } = predictionAnswerGroups(round.predictions, node.index);
  const tooltipId = `current-predictions-${round.roundNumber}-${node.index}`;
  return h("div", { class: "current-prediction-peek" },
    button("みんなの予想", null, "prediction-peek-trigger", {
      "aria-describedby": tooltipId,
      "aria-label": `質問${node.index + 1}のみんなの予想を見る`
    }),
    h("div", { id: tooltipId, class: "current-prediction-tooltip", role: "tooltip" },
      renderPredictionAnswerGroup("YES", yesPlayerIds, "yes"),
      renderPredictionAnswerGroup("NO", noPlayerIds, "no")
    )
  );
}

function renderPredictionAnswerGroup(labelText, playerIds, answerClass) {
  return h("section", { class: `prediction-answer-group ${answerClass}` },
    h("header", {}, h("strong", {}, labelText), h("span", {}, `${playerIds.length}人`)),
    playerIds.length
      ? h("ul", {}, ...playerIds.map((playerId) => h("li", {}, playerName(playerId))))
      : h("p", {}, "該当者なし")
  );
}

function renderReveal() {
  const round = state.room.currentRound;
  const canceled = Boolean(round.cancelled);
  return h("div", { class: "stage-panel wide" },
    stageHeader(`ROUND ${round.roundNumber} · RESULT`, canceled ? "このラウンドは無効になりました" : "結果発表", canceled ? "得点を加算せず、次の代表者へ進みます。" : "予測結果を公開します。"),
    !canceled ? renderRoundScores(round) : null,
    renderTreeBoard({ revealNames: true }),
    h("div", { class: "stage-actions" }, isHost() ? button(isFinalRound(state.room) ? "最終結果を見る" : "次のラウンドへ", nextRound, "primary large", { disabled: state.loading }) : h("p", { class: "waiting" }, "ホストの進行をお待ちください。"))
  );
}

function renderRoundScores(round) {
  const orderedIds = [round.representativeId, ...round.eligiblePredictorIds];
  return h("section", { class: "round-scores" },
    h("header", {}, h("p", { class: "celebration-label" }, "ROUND SCORE"), h("h2", {}, "得点内訳")),
    h("div", { class: "round-score-grid" }, ...orderedIds.map((playerId) => renderRoundScoreCard(playerId, round.scoreBreakdowns?.[playerId])))
  );
}

function renderRoundScoreCard(playerId, breakdown) {
  if (!breakdown) return null;
  const details = breakdown.role === "representative"
    ? [`正解数予想 ${breakdown.representativePredictionMatches}人一致`, `予想一致 +${breakdown.representativePredictionBonus}`]
    : [
      `${breakdown.correctCount} / ${TREE_DEPTH}問正解`,
      `質問点 +${breakdown.questionPoints}`,
      breakdown.allQuestionsCorrectBonus ? `全問一致 +${breakdown.allQuestionsCorrectBonus}` : null,
      breakdown.confidenceBonus ? `自信 +${breakdown.confidenceBonus}` : null,
      breakdown.soleCorrectBonus ? `単独正解 +${breakdown.soleCorrectBonus}` : null,
      breakdown.minorityCorrectBonus ? `少数正解 +${breakdown.minorityCorrectBonus}` : null
    ].filter(Boolean);
  return h("article", { class: `round-score-card ${breakdown.role}` },
    h("div", {}, h("small", {}, breakdown.role === "representative" ? "回答者" : "予想者"), h("h3", {}, playerName(playerId))),
    h("ul", {}, ...details.map((detail) => h("li", {}, detail))),
    h("strong", {}, `+${breakdown.total} pt`)
  );
}

function renderGameOver() {
  const players = state.room.gamePlayerIds.map((id) => state.room.players.find((player) => player.id === id)).filter(Boolean);
  return h("div", { class: "stage-panel final-panel" },
    stageHeader("FINAL RESULT", "今宵の結果", "すべての代表者が回答を終えました。"),
    renderRanking(players),
    renderScoreMatrix(players, state.room.logs),
    h("section", { class: "answer-history" },
      h("header", {}, h("p", { class: "eyebrow" }, "ANSWER ARCHIVE"), h("h2", {}, "代表者ごとの回答")),
      h("div", { class: "answer-history-grid" }, ...state.room.logs.map(renderAnswerHistory))
    ),
    h("div", { class: "stage-actions" },
      button("結果をコピー", copyResults, "secondary large"),
      isHost() ? button("同じメンバーでもう一度", resetGame, "primary large") : null
    )
  );
}

function renderRanking(players) {
  const ranked = rankedPlayers(players);
  return h("ol", { class: "ranking" }, ...ranked.map(({ player, rank }) => h("li", { class: rank === 1 ? "first" : "" },
    h("span", { class: "rank" }, `${rank}位`),
    h("strong", {}, player.name),
    h("span", {}, h("b", {}, String(player.score || 0)), " pt")
  )));
}

function renderScoreMatrix(players, logs) {
  return h("section", { class: "matrix-section" },
    h("header", {}, h("p", { class: "eyebrow" }, "PREDICTION MATRIX"), h("h2", {}, "予測結果一覧"), h("p", {}, "縦軸が予測者、横軸が代表者です。")),
    h("div", { class: "matrix-scroll", tabindex: "0", "aria-label": "予測結果マトリクス。横方向にスクロールできます。" },
      h("table", { class: "score-matrix" },
        h("thead", {}, h("tr", {},
          h("th", { scope: "col" }, "予測者 ＼ 代表者"),
          ...players.map((player) => h("th", { scope: "col" }, player.name)),
          h("th", { scope: "col", class: "total-column" }, "合計点")
        )),
        h("tbody", {}, ...players.map((predictor) => {
          return h("tr", {},
            h("th", { scope: "row" }, predictor.name),
            ...players.map((representative) => renderMatrixCell(logs.find((item) => item.representativeId === representative.id), representative, predictor)),
            h("td", { class: "matrix-total" }, h("strong", {}, String(predictor.score || 0)), h("small", {}, " pt"))
          );
        }))
      )
    )
  );
}

function renderMatrixCell(log, representative, predictor) {
  if (!log || log.cancelled) return h("td", { class: "matrix-cell neutral", title: "予測対象外" }, "—");
  const breakdown = log.scoreBreakdowns?.[predictor.id];
  if (!breakdown) return h("td", { class: "matrix-cell neutral", title: "予測対象外" }, "—");
  if (representative.id === predictor.id) {
    return h("td", {
      class: "matrix-cell representative-result",
      title: `回答者予想 ${breakdown.representativePredictionMatches}人一致、${breakdown.total}点`
    }, h("strong", {}, `${breakdown.representativePredictionMatches}人`), h("small", {}, `+${breakdown.total} pt`));
  }
  const resultClass = breakdown.correctCount === TREE_DEPTH ? "success" : breakdown.correctCount > 0 ? "partial" : "failure";
  return h("td", {
    class: `matrix-cell ${resultClass}`,
    title: `${breakdown.correctCount}問正解、${breakdown.total}点`,
    "aria-label": `${predictor.name}は${TREE_DEPTH}問中${breakdown.correctCount}問正解、${breakdown.total}点獲得`
  }, h("strong", {}, `${breakdown.correctCount}/${TREE_DEPTH}`), h("small", {}, `+${breakdown.total} pt`));
}

function renderAnswerHistory(log) {
  return h("article", { class: "answer-history-card" },
    h("header", {}, h("small", {}, `ROUND ${log.roundNumber}`), h("h3", {}, log.representativeName), log.cancelled ? h("span", { class: "canceled-label" }, "無効") : null),
    log.answers.length
      ? h("ol", {}, ...log.answers.map((answer, index) => {
        const node = log.nodes.find((item) => item.index === answer.nodeIndex);
        return h("li", {}, h("span", { class: "answer-question" }, h("small", {}, `Q${index + 1}`), node?.text || "質問を確認できません"), h("strong", { class: answer.answer ? "answer-yes" : "answer-no" }, answer.answer ? "YES" : "NO"));
      }))
      : h("p", { class: "muted" }, "回答なし")
  );
}

function renderTreeBoard(options = {}) {
  const round = state.room.currentRound;
  const counts = predictionCounts(round.predictions);
  const answerValues = round.answers.map((answer) => Boolean(answer.answer));
  const path = new Set(getPathNodeIndices(answerValues));
  const ownSubmittedPrediction = ownPrediction(state.room);
  const displayedPrediction = ownSubmittedPrediction || {
    answersByNode: state.predictionDraft,
    confidenceDepth: state.confidenceDraft
  };
  const displayedPredictionLeaf = predictionToLeafIndex(displayedPrediction);
  const revealPredictions = state.room.phase === "reveal";
  if (state.room.phase === "answering" && round.currentNodeIndex != null) path.add(round.currentNodeIndex);
  const container = h("div", {
    class: "tree-scroll",
    tabindex: "0",
    "data-tree-key": `${round.roundNumber}-${state.room.phase}`,
    "aria-label": "質問の決定木。横方向にスクロールできます。"
  });
  const canvas = h("div", { class: "tree-canvas", style: `width:${TREE_WIDTH}px;height:${TREE_HEIGHT}px` });
  canvas.append(connectorSvg(round, path));

  for (const node of round.nodes) {
    const depth = node.depth;
    const offset = node.index - (2 ** depth - 1);
    const x = (offset + 0.5) * (TREE_WIDTH / 2 ** depth);
    const classes = ["tree-node", `depth-${depth}`];
    if (path.has(node.index)) classes.push("on-path");
    if (state.room.phase === "answering" && round.currentNodeIndex === node.index) classes.push("current");
    const predictedAnswer = displayedPrediction.answersByNode?.[node.index];
    const actualAnswer = round.answers.find((answer) => answer.nodeIndex === node.index)?.answer;
    const card = h("article", { class: classes.join(" "), style: `left:${x}px;top:${LEVEL_Y[depth]}px` },
      h("div", { class: "node-meta" }, h("span", {}, node.genreLabel), h("small", {}, `Q${node.index + 1}`)),
      options.editable
        ? h("textarea", { name: `node-${node.index}`, maxlength: "90", required: true, "aria-label": `質問${node.index + 1}` }, node.text)
        : h("p", {}, node.text),
      options.editable ? button("引き直す", () => rerollQuestion(node.index), "node-reroll", { type: "button", disabled: state.loading }) : null,
      options.predictionEditor ? h("div", { class: "node-prediction-controls", "aria-label": `質問${node.index + 1}の予想` },
        button("YES", () => selectPredictionAnswer(node.index, true), predictedAnswer === true ? "node-answer yes selected" : "node-answer yes", { "aria-pressed": String(predictedAnswer === true) }),
        button("NO", () => selectPredictionAnswer(node.index, false), predictedAnswer === false ? "node-answer no selected" : "node-answer no", { "aria-pressed": String(predictedAnswer === false) })
      ) : null,
      options.showOwnPrediction && ownSubmittedPrediction ? h("div", { class: `submitted-node-answer ${predictedAnswer ? "yes" : "no"}` }, `あなたの予想 ${predictedAnswer ? "YES" : "NO"}`) : null,
      state.room.phase === "reveal" && typeof actualAnswer === "boolean" ? renderPathPredictionVotes(round, node) : null
    );
    canvas.append(card);
  }

  for (let leaf = 0; leaf < LEAF_COUNT; leaf += 1) {
    const x = (leaf + 0.5) * (TREE_WIDTH / LEAF_COUNT);
    const selected = displayedPredictionLeaf === leaf;
    const reached = round.reachedLeaf === leaf;
    const names = revealPredictions && options.revealNames ? predictorNamesAtLeaf(round, leaf) : [];
    const tooltipId = `leaf-voters-${round.roundNumber}-${leaf}`;
    const leafContent = [
      h("small", {}, "DEST."),
      h("strong", {}, String(leaf + 1).padStart(2, "0")),
      revealPredictions ? h("span", { class: "prediction-count" }, `${counts[leaf]}票`) : null,
      names.length ? h("span", { class: "voter-hint" }, "投票者") : null,
      names.length ? h("span", { id: tooltipId, class: "leaf-voter-tooltip", role: "tooltip" },
        h("small", {}, "VOTERS"),
        ...names.map((name) => h("b", {}, name))
      ) : null
    ];
    const attrs = {
      class: `tree-leaf ${selected ? "selected" : ""} ${reached ? "reached" : ""} ${names.length ? "has-voters" : ""} ${leaf < 2 ? "tooltip-left" : ""} ${leaf > 13 ? "tooltip-right" : ""}`,
      style: `left:${x}px;top:${LEAF_Y}px`,
      title: names.length ? names.join("、") : `到達点 ${leaf + 1}`,
      tabindex: names.length ? "0" : null,
      "aria-describedby": names.length ? tooltipId : null,
      "aria-label": revealPredictions
        ? names.length ? `到達点 ${leaf + 1}、${counts[leaf]}票。投票者は${names.join("、")}` : `到達点 ${leaf + 1}、${counts[leaf]}票`
        : `到達点 ${leaf + 1}。票数は結果発表まで非公開`
    };
    canvas.append(h("div", attrs, ...leafContent));
  }
  container.append(canvas);
  return container;
}

function connectorSvg(round, path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tree-connectors");
  svg.setAttribute("viewBox", `0 0 ${TREE_WIDTH} ${TREE_HEIGHT}`);
  svg.setAttribute("aria-hidden", "true");
  const finalLevelStart = 2 ** (TREE_DEPTH - 1) - 1;
  for (let parent = 0; parent < finalLevelStart; parent += 1) {
    const depth = nodeDepth(parent);
    const parentOffset = parent - (2 ** depth - 1);
    const parentX = (parentOffset + 0.5) * (TREE_WIDTH / 2 ** depth);
    for (const answer of [true, false]) {
      const child = childNodeIndex(parent, answer);
      const childDepth = depth + 1;
      const childOffset = child - (2 ** childDepth - 1);
      const childX = (childOffset + 0.5) * (TREE_WIDTH / 2 ** childDepth);
      appendBranch(svg, parentX, LEVEL_Y[depth] + NODE_HEIGHT, childX, LEVEL_Y[childDepth], answer, path.has(parent) && path.has(child));
    }
  }
  for (let parent = finalLevelStart; parent < NODE_COUNT; parent += 1) {
    const offset = parent - finalLevelStart;
    const parentX = (offset + 0.5) * (TREE_WIDTH / 2 ** (TREE_DEPTH - 1));
    for (const answer of [true, false]) {
      const leaf = offset * 2 + (answer ? 0 : 1);
      const leafX = (leaf + 0.5) * (TREE_WIDTH / LEAF_COUNT);
      const finalAnswer = round.answers.find((item) => item.nodeIndex === parent)?.answer;
      appendBranch(svg, parentX, LEVEL_Y[TREE_DEPTH - 1] + NODE_HEIGHT, leafX, LEAF_Y, answer, path.has(parent) && finalAnswer === answer);
    }
  }
  return svg;
}

function appendBranch(svg, parentX, parentY, childX, childY, answer, active) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const middleY = (parentY + childY) / 2;
  line.setAttribute("d", `M ${parentX} ${parentY} C ${parentX} ${middleY}, ${childX} ${middleY}, ${childX} ${childY}`);
  line.setAttribute("class", `branch ${answer ? "yes" : "no"} ${active ? "active" : ""}`);
  svg.append(line);
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", String((parentX + childX) / 2));
  label.setAttribute("y", String(middleY - 5));
  label.setAttribute("class", `branch-label ${answer ? "yes" : "no"}`);
  label.setAttribute("text-anchor", "middle");
  label.textContent = answer ? "YES" : "NO";
  svg.append(label);
}

function renderGenreLegend(round) {
  return h("div", { class: "genre-legend" }, ...round.genreByDepth.map((genreId, depth) => {
    const genre = state.questionBank.genres.find((item) => item.id === genreId);
    return h("span", {}, h("small", {}, `LEVEL ${depth + 1}`), h("b", {}, genre?.label || genreId));
  }));
}

async function createRoom() {
  await runAction(async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomRoomId();
      const hostKey = randomId();
      try {
        state.roomId = id;
        state.hostKey = hostKey;
        sessionStorage.setItem(hostKeyName(id), hostKey);
        await state.store.create({
          id,
          hostKey,
          hostPlayerId: null,
          rulesVersion: GAME_RULES_VERSION,
          scoringConfig: null,
          phase: "lobby",
          players: [],
          gamePlayerIds: [],
          representativeIndex: 0,
          genreSchedule: [],
          usedQuestionIds: [],
          currentRound: null,
          logs: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
          expiresAt: expirationIso()
        });
        history.replaceState({}, "", roomUrl(id));
        return;
      } catch (error) {
        if (attempt === 7) throw error;
      }
    }
  });
}

async function joinRoom(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = String(form.get("roomId") || "").trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(id)) return setError("6桁のルームコードを入力してください。");
  location.href = roomUrl(id);
}

async function registerName(event) {
  event.preventDefault();
  const name = String(new FormData(event.currentTarget).get("name") || "").trim();
  if (!name) return setError("表示名を入力してください。");
  const playerId = randomId();
  await runAction(async () => {
    await state.store.update((room) => {
      if (room.players.length >= MAX_PLAYERS) throw new Error("このルームは8名で満席です。");
      room.players.push({ id: playerId, name, score: 0, joinedAt: nowIso(), lastSeenAt: nowIso() });
      if (!room.hostPlayerId && state.hostKey && state.hostKey === room.hostKey) room.hostPlayerId = playerId;
      return room;
    });
    state.playerId = playerId;
    sessionStorage.setItem(playerKey(state.room.id), playerId);
    state.nameDraft = "";
  });
}

async function startGame() {
  await runAction(async () => {
    await state.store.update((room) => {
      requireHost(room);
      if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) throw new Error("参加人数は2〜8名です。");
      room.players = room.players.map((player) => ({ ...player, score: 0 }));
      room.scoringConfig = snapshotScoreConfig(SCORE_CONFIG);
      room.gamePlayerIds = room.players.map((player) => player.id);
      room.representativeIndex = 0;
      room.genreSchedule = createGenreSchedule(state.questionBank.genres.map((genre) => genre.id), MAX_PLAYERS);
      room.usedQuestionIds = [];
      room.logs = [];
      room.currentRound = createRound(room, 0);
      room.phase = "treeSetup";
      return room;
    });
  });
}

function createRound(room, representativeIndex) {
  const genreByDepth = room.genreSchedule[representativeIndex];
  return {
    roundNumber: representativeIndex + 1,
    representativeId: room.gamePlayerIds[representativeIndex],
    eligiblePredictorIds: room.gamePlayerIds.filter((id) => id !== room.gamePlayerIds[representativeIndex]),
    genreByDepth,
    nodes: sampleRoundNodes(state.questionBank, genreByDepth, room.usedQuestionIds),
    predictions: {},
    representativePrediction: null,
    answers: [],
    currentNodeIndex: 0,
    reachedLeaf: null,
    allCorrectIds: [],
    scoreBreakdowns: {},
    cancelled: false,
    createdAt: nowIso()
  };
}

async function rerollQuestion(nodeIndex) {
  const edits = readTreeEdits();
  await runAction(async () => {
    await state.store.update((room) => {
      requireHost(room);
      requirePhase(room, "treeSetup");
      room.currentRound.nodes = room.currentRound.nodes.map((node) => ({ ...node, text: edits.get(node.index) ?? node.text }));
      room.currentRound.nodes = rerollNode(state.questionBank, room.currentRound.nodes, room.usedQuestionIds, nodeIndex);
      return room;
    });
  });
}

async function confirmTree(event) {
  event.preventDefault();
  const edits = readTreeEdits();
  await runAction(async () => {
    await state.store.update((room) => {
      requireHost(room);
      requirePhase(room, "treeSetup");
      room.currentRound.nodes = room.currentRound.nodes.map((node) => {
        const text = String(edits.get(node.index) ?? node.text).trim();
        if (!text) throw new Error("すべての質問文を入力してください。");
        return { ...node, text };
      });
      room.usedQuestionIds = [...new Set([...room.usedQuestionIds, ...room.currentRound.nodes.map((node) => node.questionId)])];
      room.phase = "predicting";
      return room;
    });
    resetRoundDrafts();
  });
}

function readTreeEdits() {
  const form = document.querySelector("#tree-setup-form");
  const edits = new Map();
  if (!form) return edits;
  new FormData(form).forEach((value, key) => {
    if (key.startsWith("node-")) edits.set(Number(key.slice(5)), String(value));
  });
  return edits;
}

function selectPredictionAnswer(nodeIndex, answer) {
  state.predictionDraft = { ...state.predictionDraft, [nodeIndex]: Boolean(answer) };
  render();
}

async function submitPrediction() {
  if (!predictionReady(state.room.currentRound)) return;
  const answersByNode = Object.fromEntries(
    state.room.currentRound.nodes.map((node) => [node.index, state.predictionDraft[node.index]])
  );
  const confidenceDepth = state.confidenceDraft;
  await runAction(async () => {
    await state.store.update((room) => {
      requirePhase(room, "predicting");
      const round = room.currentRound;
      if (!round.eligiblePredictorIds.includes(state.playerId)) throw new Error("このラウンドでは予測できません。");
      if (round.predictions[state.playerId] != null) throw new Error("予測は確定済みです。");
      if (Object.keys(answersByNode).length !== NODE_COUNT || Object.values(answersByNode).some((answer) => typeof answer !== "boolean")) {
        throw new Error("7問すべてに回答してください。");
      }
      if (!Number.isInteger(confidenceDepth) || confidenceDepth < 0 || confidenceDepth >= TREE_DEPTH) {
        throw new Error("自信のあるカテゴリを選んでください。");
      }
      round.predictions[state.playerId] = { answersByNode, confidenceDepth, submittedAt: nowIso() };
      maybeAdvanceToAnswering(room);
      return room;
    });
  });
}

async function submitRepresentativePrediction() {
  const roundSnapshot = state.room.currentRound;
  if (!representativePredictionReady(roundSnapshot)) return;
  const correctCountsByPlayerId = Object.fromEntries(
    roundSnapshot.eligiblePredictorIds.map((playerId) => [playerId, state.representativePredictionDraft[playerId]])
  );
  await runAction(async () => {
    await state.store.update((room) => {
      requirePhase(room, "predicting");
      const round = room.currentRound;
      if (round.representativeId !== state.playerId) throw new Error("正解数を予想できるのは回答者だけです。");
      if (round.representativePrediction) throw new Error("正解数の予想は確定済みです。");
      if (round.eligiblePredictorIds.some((playerId) => {
        const count = correctCountsByPlayerId[playerId];
        return !Number.isInteger(count) || count < 0 || count > TREE_DEPTH;
      })) throw new Error("全員分の正解数を0〜3で選んでください。");
      round.representativePrediction = { correctCountsByPlayerId, submittedAt: nowIso() };
      maybeAdvanceToAnswering(room);
      return room;
    });
  });
}

function maybeAdvanceToAnswering(room) {
  const round = room.currentRound;
  const allPredictorsSubmitted = Object.keys(round.predictions || {}).length === round.eligiblePredictorIds.length;
  if (allPredictorsSubmitted && round.representativePrediction) room.phase = "answering";
}

function predictionReady(round) {
  return Boolean(
    round
    && round.nodes.every((node) => typeof state.predictionDraft[node.index] === "boolean")
    && Number.isInteger(state.confidenceDraft)
    && state.confidenceDraft >= 0
    && state.confidenceDraft < TREE_DEPTH
  );
}

function representativePredictionReady(round) {
  return Boolean(round && round.eligiblePredictorIds.every((playerId) => {
    const count = state.representativePredictionDraft[playerId];
    return Number.isInteger(count) && count >= 0 && count <= TREE_DEPTH;
  }));
}

async function answerQuestion(answer) {
  await runAction(async () => {
    await state.store.update((room) => {
      requirePhase(room, "answering");
      const round = room.currentRound;
      if (round.representativeId !== state.playerId) throw new Error("回答できるのは代表者だけです。");
      const nodeIndex = round.currentNodeIndex;
      const node = round.nodes.find((item) => item.index === nodeIndex);
      round.answers.push({ nodeIndex, depth: node.depth, answer: Boolean(answer), answeredAt: nowIso() });
      if (round.answers.length === TREE_DEPTH) {
        round.reachedLeaf = answersToLeafIndex(round.answers.map((item) => item.answer));
        const scoring = scoreRound({
          predictions: round.predictions,
          answers: round.answers,
          representativeId: round.representativeId,
          representativePrediction: round.representativePrediction,
          scoreConfig: room.scoringConfig
        });
        round.allCorrectIds = scoring.allCorrectIds;
        round.scoreBreakdowns = scoring.breakdowns;
        room.players = room.players.map((player) => {
          const points = scoring.breakdowns[player.id]?.total || 0;
          return points ? { ...player, score: (player.score || 0) + points } : player;
        });
        room.phase = "reveal";
      } else {
        round.currentNodeIndex = childNodeIndex(nodeIndex, answer);
      }
      return room;
    });
  });
}

async function cancelRound() {
  if (!confirm("このラウンドを無効終了します。得点は加算されません。")) return;
  await runAction(async () => {
    await state.store.update((room) => {
      requireHost(room);
      if (!["predicting", "answering"].includes(room.phase)) throw new Error("このフェーズでは無効終了できません。");
      room.currentRound.cancelled = true;
      room.currentRound.allCorrectIds = [];
      room.currentRound.scoreBreakdowns = {};
      room.phase = "reveal";
      return room;
    });
  });
}

async function nextRound() {
  await runAction(async () => {
    await state.store.update((room) => {
      requireHost(room);
      requirePhase(room, "reveal");
      room.logs.push(roundLog(room));
      room.gamePlayerIds = appendQueuedPlayerIds(room.gamePlayerIds, room.players.map((player) => player.id));
      room.representativeIndex += 1;
      if (room.representativeIndex >= room.gamePlayerIds.length) {
        room.currentRound = null;
        room.phase = "gameOver";
      } else {
        room.currentRound = createRound(room, room.representativeIndex);
        room.phase = "treeSetup";
      }
      return room;
    });
    resetRoundDrafts();
  });
}

async function resetGame() {
  await runAction(async () => {
    await state.store.update((room) => {
      requireHost(room);
      room.phase = "lobby";
      room.gamePlayerIds = [];
      room.representativeIndex = 0;
      room.genreSchedule = [];
      room.usedQuestionIds = [];
      room.currentRound = null;
      room.logs = [];
      room.players = room.players.map((player) => ({ ...player, score: 0 }));
      return room;
    });
    resetRoundDrafts();
  });
}

function resetRoundDrafts() {
  state.predictionDraft = {};
  state.confidenceDraft = null;
  state.representativePredictionDraft = {};
}

function roundLog(room) {
  const round = room.currentRound;
  return {
    roundNumber: round.roundNumber,
    representativeId: round.representativeId,
    representativeName: playerName(round.representativeId, room),
    genreByDepth: [...round.genreByDepth],
    nodes: round.nodes.map((node) => ({ ...node })),
    predictions: structuredClone(round.predictions),
    representativePrediction: round.representativePrediction ? structuredClone(round.representativePrediction) : null,
    answers: round.answers.map((answer) => ({ ...answer })),
    reachedLeaf: round.reachedLeaf,
    allCorrectIds: [...round.allCorrectIds],
    scoreBreakdowns: structuredClone(round.scoreBreakdowns),
    cancelled: Boolean(round.cancelled),
    completedAt: nowIso()
  };
}

async function claimHost() {
  await runAction(async () => {
    await state.store.update((room) => {
      const host = room.players.find((player) => player.id === room.hostPlayerId);
      if (host && Date.now() - Date.parse(host.lastSeenAt || 0) <= HOST_STALE_MS) throw new Error("現在のホストは接続中です。");
      room.hostPlayerId = state.playerId;
      return room;
    });
  });
}

function maintainPresence() {
  if (!state.room || !currentPlayer()) return;
  if (!state.presenceTimer) state.presenceTimer = setInterval(sendPresence, PRESENCE_INTERVAL_MS);
  const lastSeen = Date.parse(currentPlayer().lastSeenAt || 0);
  if (Date.now() - lastSeen > PRESENCE_INTERVAL_MS / 2) sendPresence();
}

async function sendPresence() {
  if (!state.room || !state.playerId || state.loading) return;
  try {
    await state.store.update((room) => {
      const player = room.players.find((item) => item.id === state.playerId);
      if (player) player.lastSeenAt = nowIso();
      return room;
    });
  } catch (error) {
    console.error(error);
  }
}

async function copyInvite() {
  await copyText(roomUrl(state.room.id));
  setNotice("招待URLをコピーしました。");
}

async function copyResults() {
  const lines = ["どっちーな 最終結果"];
  const players = state.room.players.filter((player) => state.room.gamePlayerIds.includes(player.id));
  rankedPlayers(players).forEach(({ player, rank }) => lines.push(`${rank}位 ${player.name}: ${player.score || 0}点`));
  for (const log of state.room.logs) {
    lines.push("", `Round ${log.roundNumber} 代表者: ${log.representativeName}`);
    if (log.cancelled) {
      lines.push("無効終了");
      continue;
    }
    for (const [index, answer] of log.answers.entries()) {
      const node = log.nodes.find((item) => item.index === answer.nodeIndex);
      lines.push(`Q${index + 1}: ${node?.text || "質問不明"} → ${answer.answer ? "YES" : "NO"}`);
    }
    for (const playerId of [log.representativeId, ...Object.keys(log.predictions || {})]) {
      const breakdown = log.scoreBreakdowns?.[playerId];
      if (!breakdown) continue;
      if (breakdown.role === "representative") {
        lines.push(`${playerName(playerId)}（回答者）: 正解数予想 ${breakdown.representativePredictionMatches}人一致 / +${breakdown.total}点`);
      } else {
        lines.push(`${playerName(playerId)}: ${breakdown.correctCount}/${TREE_DEPTH}問正解 / +${breakdown.total}点`);
      }
    }
  }
  await copyText(lines.join("\n"));
  setNotice("結果をコピーしました。");
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = h("textarea", { style: "position:fixed;opacity:0", value: text });
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

async function runAction(action) {
  if (state.loading) return;
  state.loading = true;
  clearMessages();
  render();
  try {
    await action();
  } catch (error) {
    console.error(error);
    setError(error.message || "操作を完了できませんでした。");
  } finally {
    state.loading = false;
    render();
  }
}

function normalizeRoom(room) {
  const source = room || {};
  return {
    id: source.id || "",
    hostKey: source.hostKey || "",
    hostPlayerId: source.hostPlayerId || null,
    rulesVersion: Number(source.rulesVersion || 1),
    scoringConfig: source.scoringConfig ? snapshotScoreConfig(source.scoringConfig) : null,
    phase: source.phase || "lobby",
    players: Array.isArray(source.players) ? source.players.map((player) => ({ ...player, score: Number(player.score || 0) })) : [],
    gamePlayerIds: Array.isArray(source.gamePlayerIds) ? source.gamePlayerIds : [],
    representativeIndex: Number(source.representativeIndex || 0),
    genreSchedule: Array.isArray(source.genreSchedule) ? source.genreSchedule : [],
    usedQuestionIds: Array.isArray(source.usedQuestionIds) ? source.usedQuestionIds : [],
    currentRound: source.currentRound || null,
    logs: Array.isArray(source.logs) ? source.logs : [],
    createdAt: dateToIso(source.createdAt),
    updatedAt: dateToIso(source.updatedAt),
    expiresAt: dateToIso(source.expiresAt, expirationIso())
  };
}

function toFirestoreRoom(room, firestore) {
  return { ...room, expiresAt: firestore.Timestamp.fromDate(new Date(room.expiresAt)) };
}

function currentPlayer() {
  return state.room?.players.find((player) => player.id === state.playerId) || null;
}

function hostPlayer() {
  return state.room?.players.find((player) => player.id === state.room.hostPlayerId) || null;
}

function isHost() {
  return Boolean(state.playerId && state.room?.hostPlayerId === state.playerId);
}

function ownPrediction(room) {
  return room?.currentRound?.predictions?.[state.playerId] ?? null;
}

function playerName(playerId, room = state.room) {
  return room?.players.find((player) => player.id === playerId)?.name || "不明な参加者";
}

function renderPlayerMark(playerId, options = {}) {
  const playerIndex = Math.max(0, state.room?.players.findIndex((player) => player.id === playerId) ?? 0);
  const name = playerName(playerId);
  const decorative = Boolean(options.decorative);
  return h("span", {
    class: `player-mark player-mark-${playerIndex % PLAYER_MARKS.length}`,
    title: decorative ? null : name,
    tabindex: decorative ? null : "0",
    "data-player-name": decorative ? null : name,
    "aria-hidden": decorative ? "true" : null,
    "aria-label": decorative ? null : name
  }, PLAYER_MARKS[playerIndex % PLAYER_MARKS.length]);
}

function renderPathPredictionVotes(round, node) {
  const { yesPlayerIds, noPlayerIds } = predictionAnswerGroups(round.predictions, node.index);
  const group = (labelText, playerIds, answerClass) => h("div", { class: `path-prediction-group ${answerClass}` },
    h("strong", {}, labelText),
    h("span", { class: "path-prediction-marks" },
      playerIds.length
        ? playerIds.map((playerId) => renderPlayerMark(playerId))
        : h("span", { class: "path-prediction-empty", "aria-label": "該当者なし" }, "—")
    )
  );
  const yesNames = yesPlayerIds.map((playerId) => playerName(playerId)).join("、") || "なし";
  const noNames = noPlayerIds.map((playerId) => playerName(playerId)).join("、") || "なし";
  return h("div", {
    class: "path-prediction-votes",
    "aria-label": `みんなの予想。YES：${yesNames}。NO：${noNames}`
  }, group("YES", yesPlayerIds, "yes"), group("NO", noPlayerIds, "no"));
}

function isFinalRound(room) {
  const queuedPlayerExists = room.players.some((player) => !room.gamePlayerIds.includes(player.id));
  return !queuedPlayerExists && room.representativeIndex >= room.gamePlayerIds.length - 1;
}

function predictorNamesAtLeaf(round, leaf) {
  return Object.entries(round.predictions || {})
    .filter(([, prediction]) => predictionToLeafIndex(prediction) === leaf)
    .map(([id]) => playerName(id));
}

function rankedPlayers(players) {
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  let previousScore = null;
  let previousRank = 0;
  return sorted.map((player, index) => {
    const score = player.score || 0;
    const rank = score === previousScore ? previousRank : index + 1;
    previousScore = score;
    previousRank = rank;
    return { player, rank };
  });
}

function requireHost(room) {
  if (room.hostPlayerId !== state.playerId) throw new Error("この操作はホストのみ実行できます。");
}

function requirePhase(room, phase) {
  if (room.phase !== phase) throw new Error("ゲームの状態が更新されています。画面をご確認ください。");
}

function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value);
    else if (key === "class") element.className = value;
    else if (key === "value") element.value = value;
    else if (key === "style") element.setAttribute("style", value);
    else if (key in element && !key.startsWith("aria-")) element[key] = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function button(text, onclick, variant = "primary", attrs = {}) {
  return h("button", { class: `button ${variant}`, type: attrs.type || "button", onclick, ...attrs }, text);
}

function label(text, control) {
  return h("label", { class: "field" }, h("span", {}, text), control);
}

function step(number, title, copy) {
  return h("article", {}, h("span", {}, number), h("div", {}, h("h3", {}, title), h("p", {}, copy)));
}

function ruleCard(number, title, copy) {
  return h("article", { class: "rule-card" }, h("strong", {}, number), h("div", {}, h("h3", {}, title), h("p", {}, copy)));
}

function stageHeader(eyebrow, title, copy) {
  return h("header", { class: "stage-header" }, h("p", { class: "eyebrow" }, eyebrow), h("h1", {}, title), h("p", {}, copy));
}

function messagePanel(title, message, kind, action = null) {
  return h("section", { class: `narrow-panel message ${kind}` }, h("h1", {}, title), h("p", {}, message), action);
}

function loadingPanel(message) {
  return h("section", { class: "loading-panel" }, h("span", { class: "loading-mark", "aria-hidden": "true" }), h("p", {}, message));
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !["INPUT", "TEXTAREA"].includes(active.tagName) || !active.name) return null;
  return { name: active.name, start: active.selectionStart, end: active.selectionEnd };
}

function restoreFocus(focus) {
  if (!focus) return;
  const element = document.querySelector(`[name="${CSS.escape(focus.name)}"]`);
  if (!element || element.disabled) return;
  element.focus({ preventScroll: true });
  try { element.setSelectionRange(focus.start, focus.end); } catch { /* 対応しない入力形式 */ }
}

function captureTreePositions() {
  return new Map(Array.from(document.querySelectorAll(".tree-scroll"), (element) => [element.dataset.treeKey, element.scrollLeft]));
}

function restoreTreePositions(positions) {
  for (const element of document.querySelectorAll(".tree-scroll")) {
    const previous = positions.get(element.dataset.treeKey);
    if (previous != null) {
      element.scrollLeft = previous;
      continue;
    }
    const round = state.room?.currentRound;
    let focusX = TREE_WIDTH / 2;
    if (state.room?.phase === "answering" && round) {
      const depth = nodeDepth(round.currentNodeIndex);
      const offset = round.currentNodeIndex - (2 ** depth - 1);
      focusX = (offset + 0.5) * (TREE_WIDTH / 2 ** depth);
    } else if (state.room?.phase === "reveal" && round?.reachedLeaf != null) {
      focusX = (round.reachedLeaf + 0.5) * (TREE_WIDTH / LEAF_COUNT);
    }
    element.scrollLeft = Math.max(0, focusX - element.clientWidth / 2);
  }
}

function clearMessages() {
  state.error = "";
  state.notice = "";
}

function setError(message) {
  state.error = message;
  render();
}

function setNotice(message) {
  state.notice = message;
  render();
  setTimeout(() => {
    if (state.notice === message) {
      state.notice = "";
      render();
    }
  }, 3000);
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => chars[value % chars.length]).join("");
}

function roomIdFromUrl() {
  return new URL(location.href).searchParams.get("room")?.trim().toUpperCase() || null;
}

function baseUrl() {
  return `${location.origin}${location.pathname}`;
}

function roomUrl(id) {
  const url = new URL(baseUrl());
  url.searchParams.set("room", id);
  return url.href;
}

function localRoomKey(id) { return `docchina-room:${id}`; }
function playerKey(id) { return `docchina-player:${id}`; }
function hostKeyName(id) { return `docchina-host:${id}`; }
function nowIso() { return new Date().toISOString(); }
function expirationIso() { return new Date(Date.now() + ROOM_TTL_MS).toISOString(); }

function dateToIso(value, fallback = nowIso()) {
  if (!value) return fallback;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function readLocalRoom(id) {
  try {
    const room = JSON.parse(localStorage.getItem(localRoomKey(id)) || "null");
    if (!room) return null;
    if (Date.parse(room.expiresAt || 0) < Date.now()) {
      localStorage.removeItem(localRoomKey(id));
      return null;
    }
    return normalizeRoom(room);
  } catch {
    return null;
  }
}

function writeLocalRoom(room) {
  localStorage.setItem(localRoomKey(room.id), JSON.stringify(room));
}

function restoreSession(roomId) {
  if (!roomId) return;
  state.playerId = sessionStorage.getItem(playerKey(roomId));
  state.hostKey = sessionStorage.getItem(hostKeyName(roomId));
}

boot();
