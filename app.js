import {
  LEAF_COUNT,
  MAX_PLAYERS,
  MIN_PLAYERS,
  TREE_DEPTH,
  answersToLeafIndex,
  childNodeIndex,
  createGenreSchedule,
  getPathNodeIndices,
  nodeDepth,
  predictionCounts,
  rerollNode,
  sampleRoundNodes,
  scorePredictions,
  validateQuestionBank
} from "./game-logic.js";

const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
const FIREBASE_STORE_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
const FIREBASE_APP_CHECK_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js";
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENCE_INTERVAL_MS = 30 * 1000;
const HOST_STALE_MS = 90 * 1000;
const TREE_WIDTH = 1680;
const LEVEL_Y = [24, 210, 396, 582];
const LEAF_Y = 790;

const PHASE_LABELS = {
  lobby: "ロビー",
  treeSetup: "質問の準備",
  predicting: "到達点の予測",
  answering: "代表者の回答",
  reveal: "結果発表",
  gameOver: "最終結果"
};

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
  predictionDraft: null,
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
      state.predictionDraft = ownPrediction(room) ?? state.predictionDraft;
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
        h("span", { class: "phase-badge" }, PHASE_LABELS[state.room.phase] || state.room.phase),
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
      h("p", { class: "hero-copy" }, "4つのYes / Noをたどった先は、16の到達点のうちどこなのか。代表者の価値観を予測し、静かに一票を置くオンラインボードゲームです。"),
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
        step("01", "予測する", "代表者以外は、答えの先にある葉を一つ選びます。"),
        step("02", "答える", "代表者が4つの質問へYesまたはNoで答えます。"),
        step("03", "見届ける", "到達した葉を当てた参加者が1点を獲得します。")
      )
    )
  );
}

function renderMissingRoom() {
  return messagePanel("ルームが見つかりません", "URLまたは有効期限をご確認ください。ルームは最終操作から7日後に期限切れとなります。", "empty",
    h("a", { class: "button primary", href: baseUrl() }, "ホームへ戻る")
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
    ...room.players.map((player, index) => {
      const isRepresentative = room.currentRound?.representativeId === player.id && room.phase !== "gameOver";
      return h("li", { class: `player ${player.id === state.playerId ? "self" : ""} ${isRepresentative ? "representative" : ""}` },
        h("span", { class: "player-index" }, String(index + 1).padStart(2, "0")),
        h("span", { class: "player-info" },
          h("strong", {}, player.name, player.id === room.hostPlayerId ? h("small", {}, " HOST") : null),
          h("small", {}, activeIds.size && !activeIds.has(player.id) ? "観戦中" : isRepresentative ? "代表者" : "参加者")
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
      ruleCard("4", "質問数", "代表者は4つの質問に回答"),
      ruleCard("16", "到達点", "参加者は一つの葉を予測"),
      ruleCard("1", "正解点", "的中するごとに1ポイント")
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
  return h("div", { class: "stage-panel wide" },
    stageHeader(`ROUND ${round.roundNumber} · PREDICTION`, `${playerName(round.representativeId)}さんは、どこへ到達する？`, isRepresentative ? "皆さんが予測を確定するまでお待ちください。" : prediction != null ? `到達点 ${prediction + 1} で確定しました。` : "質問を読み、代表者の答えを予測して到達点を一つ選んでください。"),
    renderGenreLegend(round),
    renderTreeBoard({ selectableLeaves: eligible && prediction == null }),
    h("div", { class: "prediction-status" },
      h("p", {}, h("strong", {}, `${Object.keys(round.predictions || {}).length} / ${round.eligiblePredictorIds.length}`), " 名が予測済み"),
      eligible && prediction == null
        ? button(state.predictionDraft == null ? "到達点を選択してください" : `到達点 ${state.predictionDraft + 1} で確定`, submitPrediction, "primary large", { disabled: state.predictionDraft == null || state.loading })
        : h("p", { class: "waiting" }, isRepresentative ? "予測の確定を待っています。" : "予測は確定済みです。")
    ),
    isHost() ? h("div", { class: "danger-zone" }, button("このラウンドを無効終了", cancelRound, "danger compact")) : null
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
      isRepresentative
        ? h("div", { class: "answer-actions" }, button("NO", () => answerQuestion(false), "answer no", { disabled: state.loading }), button("YES", () => answerQuestion(true), "answer yes", { disabled: state.loading }))
        : h("p", { class: "waiting" }, "代表者が回答しています。")
    ),
    renderTreeBoard(),
    isHost() ? h("div", { class: "danger-zone" }, button("このラウンドを無効終了", cancelRound, "danger compact")) : null
  );
}

function renderReveal() {
  const round = state.room.currentRound;
  const canceled = Boolean(round.cancelled);
  return h("div", { class: "stage-panel wide" },
    stageHeader(`ROUND ${round.roundNumber} · RESULT`, canceled ? "このラウンドは無効になりました" : `到達点は ${round.reachedLeaf + 1}`, canceled ? "得点を加算せず、次の代表者へ進みます。" : round.winnerIds.length ? `${round.winnerIds.map((id) => playerName(id)).join("、")} が予測的中` : "このラウンドの的中者はいませんでした。"),
    renderTreeBoard({ revealNames: true }),
    !canceled ? h("section", { class: "round-result" },
      h("p", { class: "eyebrow" }, "CORRECT PREDICTIONS"),
      round.winnerIds.length
        ? h("div", { class: "winner-list" }, ...round.winnerIds.map((id) => h("span", {}, playerName(id), h("b", {}, "+1"))))
        : h("p", { class: "muted" }, "該当者なし")
    ) : null,
    h("div", { class: "stage-actions" }, isHost() ? button(round.roundNumber >= state.room.gamePlayerIds.length ? "最終結果を見る" : "次のラウンドへ", nextRound, "primary large", { disabled: state.loading }) : h("p", { class: "waiting" }, "ホストの進行をお待ちください。"))
  );
}

function renderGameOver() {
  const ranked = [...state.room.players]
    .filter((player) => state.room.gamePlayerIds.includes(player.id))
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.joinedAt.localeCompare(b.joinedAt));
  return h("div", { class: "stage-panel final-panel" },
    stageHeader("FINAL RESULT", "今宵の結果", "すべての代表者が回答を終えました。"),
    h("ol", { class: "ranking" }, ...ranked.map((player, index) => h("li", { class: index === 0 ? "first" : "" },
      h("span", { class: "rank" }, String(index + 1).padStart(2, "0")),
      h("strong", {}, player.name),
      h("span", {}, h("b", {}, String(player.score || 0)), " points")
    ))),
    h("details", { class: "history" }, h("summary", {}, "ラウンド履歴"), ...state.room.logs.map(renderLog)),
    h("div", { class: "stage-actions" },
      button("結果をコピー", copyResults, "secondary large"),
      isHost() ? button("同じメンバーでもう一度", resetGame, "primary large") : null
    )
  );
}

function renderTreeBoard(options = {}) {
  const round = state.room.currentRound;
  const counts = predictionCounts(round.predictions);
  const answerValues = round.answers.map((answer) => Boolean(answer.answer));
  const path = new Set(getPathNodeIndices(answerValues));
  if (state.room.phase === "answering" && round.currentNodeIndex != null) path.add(round.currentNodeIndex);
  const container = h("div", {
    class: "tree-scroll",
    tabindex: "0",
    "data-tree-key": `${round.roundNumber}-${state.room.phase}`,
    "aria-label": "質問の決定木。横方向にスクロールできます。"
  });
  const canvas = h("div", { class: "tree-canvas", style: `width:${TREE_WIDTH}px;height:930px` });
  canvas.append(connectorSvg(round, path));

  for (const node of round.nodes) {
    const depth = node.depth;
    const offset = node.index - (2 ** depth - 1);
    const x = (offset + 0.5) * (TREE_WIDTH / 2 ** depth);
    const classes = ["tree-node", `depth-${depth}`];
    if (path.has(node.index)) classes.push("on-path");
    if (state.room.phase === "answering" && round.currentNodeIndex === node.index) classes.push("current");
    const card = h("article", { class: classes.join(" "), style: `left:${x}px;top:${LEVEL_Y[depth]}px` },
      h("div", { class: "node-meta" }, h("span", {}, node.genreLabel), h("small", {}, `Q${node.index + 1}`)),
      options.editable
        ? h("textarea", { name: `node-${node.index}`, maxlength: "90", required: true, "aria-label": `質問${node.index + 1}` }, node.text)
        : h("p", {}, node.text),
      options.editable ? button("引き直す", () => rerollQuestion(node.index), "node-reroll", { type: "button", disabled: state.loading }) : null
    );
    canvas.append(card);
  }

  for (let leaf = 0; leaf < LEAF_COUNT; leaf += 1) {
    const x = (leaf + 0.5) * (TREE_WIDTH / LEAF_COUNT);
    const selected = state.predictionDraft === leaf || ownPrediction(state.room) === leaf;
    const reached = round.reachedLeaf === leaf;
    const names = options.revealNames ? predictorNamesAtLeaf(round, leaf) : [];
    const leafContent = [
      h("small", {}, "DEST."),
      h("strong", {}, String(leaf + 1).padStart(2, "0")),
      h("span", { class: "prediction-count" }, `${counts[leaf]}票`),
      ...names.map((name) => h("i", {}, name))
    ];
    const attrs = {
      class: `tree-leaf ${selected ? "selected" : ""} ${reached ? "reached" : ""}`,
      style: `left:${x}px;top:${LEAF_Y}px`,
      title: names.length ? names.join("、") : `到達点 ${leaf + 1}`
    };
    const leafNode = options.selectableLeaves
      ? h("button", { ...attrs, type: "button", onclick: () => selectLeaf(leaf), "aria-pressed": String(selected) }, ...leafContent)
      : h("div", attrs, ...leafContent);
    canvas.append(leafNode);
  }
  container.append(canvas);
  return container;
}

function connectorSvg(round, path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tree-connectors");
  svg.setAttribute("viewBox", `0 0 ${TREE_WIDTH} 930`);
  svg.setAttribute("aria-hidden", "true");
  for (let parent = 0; parent < 7; parent += 1) {
    const depth = nodeDepth(parent);
    const parentOffset = parent - (2 ** depth - 1);
    const parentX = (parentOffset + 0.5) * (TREE_WIDTH / 2 ** depth);
    for (const answer of [false, true]) {
      const child = childNodeIndex(parent, answer);
      const childDepth = depth + 1;
      const childOffset = child - (2 ** childDepth - 1);
      const childX = (childOffset + 0.5) * (TREE_WIDTH / 2 ** childDepth);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("d", `M ${parentX} ${LEVEL_Y[depth] + 138} C ${parentX} ${LEVEL_Y[depth] + 170}, ${childX} ${LEVEL_Y[childDepth] - 28}, ${childX} ${LEVEL_Y[childDepth]}`);
      line.setAttribute("class", path.has(parent) && path.has(child) ? "active" : "");
      svg.append(line);
    }
  }
  for (let parent = 7; parent < 15; parent += 1) {
    const offset = parent - 7;
    const parentX = (offset + 0.5) * (TREE_WIDTH / 8);
    for (const answer of [false, true]) {
      const leaf = offset * 2 + (answer ? 1 : 0);
      const leafX = (leaf + 0.5) * (TREE_WIDTH / LEAF_COUNT);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("d", `M ${parentX} ${LEVEL_Y[3] + 138} C ${parentX} 755, ${leafX} 755, ${leafX} ${LEAF_Y}`);
      const finalAnswer = round.answers.find((item) => item.nodeIndex === parent)?.answer;
      if (path.has(parent) && finalAnswer === answer) line.setAttribute("class", "active");
      svg.append(line);
    }
  }
  return svg;
}

function renderGenreLegend(round) {
  return h("div", { class: "genre-legend" }, ...round.genreByDepth.map((genreId, depth) => {
    const genre = state.questionBank.genres.find((item) => item.id === genreId);
    return h("span", {}, h("small", {}, `LEVEL ${depth + 1}`), h("b", {}, genre?.label || genreId));
  }));
}

function renderLog(log) {
  return h("article", { class: "history-item" },
    h("div", {}, h("strong", {}, `Round ${log.roundNumber}`), h("span", {}, log.cancelled ? "無効" : `到達点 ${log.reachedLeaf + 1}`)),
    h("p", {}, `代表者：${log.representativeName}`),
    !log.cancelled ? h("p", {}, `的中：${log.winnerNames.length ? log.winnerNames.join("、") : "なし"}`) : null
  );
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
      if (room.players.length >= 16) throw new Error("このルームは満席です。");
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
      room.gamePlayerIds = room.players.map((player) => player.id);
      room.representativeIndex = 0;
      room.genreSchedule = createGenreSchedule(state.questionBank.genres.map((genre) => genre.id), room.gamePlayerIds.length);
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
    answers: [],
    currentNodeIndex: 0,
    reachedLeaf: null,
    winnerIds: [],
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
    state.predictionDraft = null;
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

function selectLeaf(leaf) {
  state.predictionDraft = leaf;
  render();
  requestAnimationFrame(() => document.querySelector(".prediction-status")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

async function submitPrediction() {
  if (state.predictionDraft == null) return;
  await runAction(async () => {
    await state.store.update((room) => {
      requirePhase(room, "predicting");
      const round = room.currentRound;
      if (!round.eligiblePredictorIds.includes(state.playerId)) throw new Error("このラウンドでは予測できません。");
      if (round.predictions[state.playerId] != null) throw new Error("予測は確定済みです。");
      round.predictions[state.playerId] = state.predictionDraft;
      if (Object.keys(round.predictions).length === round.eligiblePredictorIds.length) room.phase = "answering";
      return room;
    });
  });
}

async function answerQuestion(answer) {
  await runAction(async () => {
    await state.store.update((room) => {
      requirePhase(room, "answering");
      const round = room.currentRound;
      if (round.representativeId !== state.playerId) throw new Error("回答できるのは代表者だけです。");
      const nodeIndex = round.currentNodeIndex;
      round.answers.push({ nodeIndex, answer: Boolean(answer), answeredAt: nowIso() });
      if (round.answers.length === TREE_DEPTH) {
        round.reachedLeaf = answersToLeafIndex(round.answers.map((item) => item.answer));
        round.winnerIds = scorePredictions(round.predictions, round.reachedLeaf);
        room.players = room.players.map((player) => round.winnerIds.includes(player.id) ? { ...player, score: (player.score || 0) + 1 } : player);
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
      room.currentRound.winnerIds = [];
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
    state.predictionDraft = null;
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
  });
}

function roundLog(room) {
  const round = room.currentRound;
  return {
    roundNumber: round.roundNumber,
    representativeId: round.representativeId,
    representativeName: playerName(round.representativeId, room),
    genreByDepth: [...round.genreByDepth],
    nodes: round.nodes.map((node) => ({ ...node })),
    predictions: { ...round.predictions },
    answers: round.answers.map((answer) => ({ ...answer })),
    reachedLeaf: round.reachedLeaf,
    winnerIds: [...round.winnerIds],
    winnerNames: round.winnerIds.map((id) => playerName(id, room)),
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
  const ranked = [...state.room.players].filter((player) => state.room.gamePlayerIds.includes(player.id)).sort((a, b) => b.score - a.score);
  ranked.forEach((player, index) => lines.push(`${index + 1}位 ${player.name}: ${player.score || 0}点`));
  for (const log of state.room.logs) {
    lines.push("", `Round ${log.roundNumber} 代表者: ${log.representativeName}`);
    lines.push(log.cancelled ? "無効終了" : `到達点: ${log.reachedLeaf + 1} / 的中: ${log.winnerNames.join("、") || "なし"}`);
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

function predictorNamesAtLeaf(round, leaf) {
  return Object.entries(round.predictions || {}).filter(([, prediction]) => prediction === leaf).map(([id]) => playerName(id));
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
