import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the actual store without booting the browser application.
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const storeSource = source.slice(source.indexOf('class RoomStore'), source.indexOf('async function boot'));
function setup(playerId = 'old') {
  const state = { playerId };
  const context = vm.createContext({ state, structuredClone });
  vm.runInContext(`${storeSource}\nglobalThis.Store = RoomStore;`, context);
  const store = new context.Store({});
  store.user = { uid: 'same-user' };
  return store;
}
const room = () => ({ players: [
  { id: 'old', uid: 'same-user', score: 10, kickedAt: 'earlier' },
  { id: 'new', uid: 'same-user', score: 0 }
] });

test('キック済みの席から名前登録の更新だけ許可する', () => {
  const value = room();
  const result = setup().applyMutation(value, current => {
    current.players.push({ id: 'rejoined', uid: 'same-user', score: 0 });
    return current;
  }, { allowRejoin: true });
  assert.equal(result.players.length, 3);
  assert.equal(result.players[0].score, 10);
  assert.equal(result.players[0].kickedAt, 'earlier');
  assert.equal(value.players.length, 2);
});

test('キック済みの席から通常更新は拒否する', () => {
  assert.throws(() => setup().applyMutation(room(), current => current), /kick/);
});

test('同じUIDで再参加した新しい席から操作できる', () => {
  assert.equal(setup('new').applyMutation(room(), current => current).players.length, 2);
});

test('退出中は再参加フォーム、同じUIDの新しい席ではゲーム画面を表示する', () => {
  const state = { roomId: 'ABC234', room: { ...room(), rulesVersion: 1 }, playerId: 'old', store: { userId: () => 'same-user' } };
  const context = vm.createContext({
    state, GAME_RULES_VERSION: 1,
    currentPlayer: () => state.room.players.find(p => p.id === state.playerId && !p.kickedAt),
    renderNameRegistration: rejoining => rejoining ? 'rejoin' : 'register',
    renderRoom: () => 'game'
  });
  const renderSource = source.slice(source.indexOf('function renderContent()'), source.indexOf('function appShell('));
  vm.runInContext(renderSource, context);
  assert.equal(vm.runInContext('renderContent()', context), 'rejoin');
  state.playerId = 'new';
  assert.equal(vm.runInContext('renderContent()', context), 'game');
});
