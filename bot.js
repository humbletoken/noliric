#!/usr/bin/env node
'use strict';
/*
 * noliric — угадай трек по секунде · @noliricapp
 * Telegram Bot API 10.3 · Node.js 22+ · better-sqlite3 · ffmpeg
 *
 * Поток: исполнитель/альбом → треки (Deezer, запасной — iTunes) → превью →
 * один проход ffmpeg режет 4 уровня (1 сек начало+конец, 3, 5, 10 сек) → квиз на 30 сек.
 * Чем длиннее фрагмент понадобился — тем меньше очков; на 10 сек — ноль.
 * Готовые фрагменты кэшируются на диске и по file_id в Telegram — повторные треки летят мгновенно.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

/* ═══════════════════════════ config ═══════════════════════════ */

try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch (err) { console.warn('[env]', err.message); }

const env = (key, def = '') => String(process.env[key] ?? '').trim() || def;
const envInt = (key, def) => { const n = parseInt(env(key), 10); return Number.isFinite(n) ? n : def; };

const DATA_DIR = path.resolve(__dirname, env('DATA_DIR', 'data'));
const CFG = {
  token: env('BOT_TOKEN'),
  admins: new Set(env('ADMIN_IDS').split(/[\s,;]+/).filter(Boolean).map(Number)),
  username: env('BOT_USERNAME', 'noliricapp').replace(/^@/, ''),
  dbPath: path.resolve(__dirname, env('DB_PATH', path.join(DATA_DIR, 'noliric.db'))),
  source: env('MUSIC_SOURCE', 'auto').toLowerCase(),
  itunesCountry: env('ITUNES_COUNTRY', 'us').toLowerCase(),
  albumsPerArtist: envInt('ALBUMS_PER_ARTIST', 15),
  answerSec: Math.min(600, Math.max(10, envInt('ANSWER_SECONDS', 30))),
  maxGames: envInt('MAX_ACTIVE_GAMES', 25),
  prefetch: Math.max(0, envInt('PREFETCH', 2)),
  prepConcurrency: Math.max(1, envInt('PREP_CONCURRENCY', 4)),
  points: env('LEVEL_POINTS', '100,60,30,0').split(',').map((n) => Math.max(0, parseInt(n, 10) || 0)),
  cacheMaxMb: envInt('CACHE_MAX_MB', 1024),
  emojiPack: env('EMOJI_PACK', 'random99_by_emsetbot'),
  rich: env('RICH_MESSAGES', '1') !== '0',
  logLevel: env('LOG_LEVEL', 'info'),
};
const DIRS = { clips: path.join(DATA_DIR, 'clips'), tmp: path.join(DATA_DIR, 'tmp') };

/* ═══════════════════════════ utils ═══════════════════════════ */

const LV = { debug: 10, info: 20, warn: 30, error: 40 };
const log = Object.fromEntries(Object.keys(LV).map((lvl) => [lvl, (...args) => {
  if (LV[lvl] < (LV[CFG.logLevel] ?? 20)) return;
  const out = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
  out(new Date().toISOString().slice(0, 19).replace('T', ' '), lvl.toUpperCase().padEnd(5), ...args);
}]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? a.slice(0, n - 1).join('').trimEnd() + '…' : a.join(''); };
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);
const isAdmin = (uid) => CFG.admins.has(Number(uid));
const chunk = (arr, n) => arr.reduce((acc, x, i) => (i % n ? acc[acc.length - 1].push(x) : acc.push([x]), acc), []);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ─────────── нормализация названий и проверка ответа ─────────── */

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
const translit = (s) => s.replace(/[а-яёіїєґ]/g, (ch) => TRANSLIT[ch] ?? ch);

/** Канонический вид: нижний регистр, транслит, без диакритики, пробелов и знаков. */
function canon(s) {
  return translit(String(s ?? '').toLowerCase())
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Убирает «(feat. …)», «- Remix», «[Sped Up]» и прочие хвосты версий. */
function baseTitle(t) {
  const src = String(t ?? '').trim();
  const s = src
    .replace(/\s*[([][^)\]]*\b(feat|ft|with|prod|remix|mix|version|edit|remaster(ed)?|live|sped|slowed|instrumental|acoustic|demo|bonus)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+[-–—]\s+[^-–—]*\b(remix|mix|version|edit|remaster(ed)?|live|sped up|slowed|instrumental|acoustic|demo)\b.*$/i, '')
    .replace(/\s+(feat|ft)\.?\s.+$/i, '')
    .trim();
  return s || src;
}

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
const similar = (a, b) => { const m = Math.max(a.length, b.length); return m ? 1 - lev(a, b) / m : 1; };

/** Hardcore: прощает регистр, транслит, пунктуацию, версии и 1–2 опечатки. */
function checkAnswer(input, track) {
  const A = canon(input).slice(0, 120);
  if (!A) return false;
  const targets = [...new Set([track.title, baseTitle(track.title), track.full, baseTitle(track.full)]
    .filter(Boolean).map(canon).filter(Boolean))];
  return targets.some((T) => {
    if (A === T) return true;
    if (T.length <= 3) return false;
    if (T.length <= 5 && A.length !== T.length) return false; // короткие — только опечатка, без обрезки
    if (similar(A, T) >= (T.length <= 6 ? 0.8 : 0.75)) return true;
    return A.length >= 6 && T.startsWith(A) && A.length / T.length >= 0.7;
  });
}

/* ═══════════════════════════ premium emoji ═══════════════════════════ */

// Проверенные ID (key → [custom_emoji_id, fallback])
const EMOJI = {
  settings: ['5870982283724328568', '⚙'],
  profile: ['5870994129244131212', '👤'],
  people: ['5870772616305839506', '👥'],
  stats: ['5870921681735781843', '📊'],
  growth: ['5870930636742595124', '📊'],
  home: ['5873147866364514353', '🏘'],
  megaphone: ['6039422865189638057', '📣'],
  check: ['5870633910337015697', '✅'],
  cross: ['5870657884844462243', '❌'],
  trash: ['5870875489362513438', '🗑'],
  info: ['6028435952299413210', 'ℹ'],
  bot: ['6030400221232501136', '🤖'],
  eye: ['6037397706505195857', '👁'],
  clock: ['5983150113483134607', '⏰'],
  timePassed: ['5775896410780079073', '🕓'],
  party: ['6041731551845159060', '🎉'],
  box: ['5884479287171485878', '📦'],
  media: ['6035128606563241721', '🖼'],
  lock: ['6037249452824072506', '🔒'],
  send: ['5963103826075456248', '⬆'],
  loading: ['5345906554510012647', '🔄'],
};

// Эмодзи из пака random99_by_emsetbot — по позиции в паке (сверено по скриншоту сетки).
// [индекс, alt, запасная иконка из EMOJI]
const PACK_SLOTS = {
  logo: [117, '🖤', 'bot'],        // чёрное сердце
  artist: [137, '👁', 'profile'],  // тёмный глаз
  album: [113, '💿', 'box'],       // светящийся диск
  hardcore: [120, '🕷', 'lock'],   // паук
  challenge: [85, '⭐', 'growth'], // серая звезда
};
const PACK = { ids: {}, alt: {}, stickers: [], loaded: false };

function emojiId(key) {
  if (PACK.ids[key]) return PACK.ids[key];
  if (EMOJI[key]) return EMOJI[key][0];
  const slot = PACK_SLOTS[key];
  return slot ? EMOJI[slot[2]]?.[0] : undefined;
}
function e(key) {
  if (PACK.ids[key]) return `<tg-emoji emoji-id="${PACK.ids[key]}">${PACK.alt[key]}</tg-emoji>`;
  const ref = EMOJI[key] || EMOJI[PACK_SLOTS[key]?.[2]];
  return ref ? `<tg-emoji emoji-id="${ref[0]}">${ref[1]}</tg-emoji>` : '';
}
/** Inline-кнопка: только премиум-иконка, без обычных эмодзи в тексте. */
function B(text, data, icon, style) {
  const b = { text, callback_data: data };
  const id = icon && emojiId(icon);
  if (id) b.icon_custom_emoji_id = id;
  if (style) b.style = style; // primary | success | danger
  return b;
}
const BACK = (data) => ({ text: '◁ Назад', callback_data: data });

async function loadEmojiPack() {
  try {
    const set = await tg('getStickerSet', { name: CFG.emojiPack });
    PACK.stickers = set.stickers || [];
    for (const [key, [idx, alt]] of Object.entries(PACK_SLOTS)) {
      const s = PACK.stickers[idx];
      if (s?.custom_emoji_id) { PACK.ids[key] = s.custom_emoji_id; PACK.alt[key] = s.emoji || alt; }
    }
    PACK.loaded = true;
    log.info(`emoji pack ${CFG.emojiPack}: ${PACK.stickers.length} шт., слотов ${Object.keys(PACK.ids).length}/${Object.keys(PACK_SLOTS).length}`);
  } catch (err) {
    log.warn(`emoji pack ${CFG.emojiPack}: ${err.message} — использую запасные ID`);
  }
}

/* ═══════════════════════════ Telegram Bot API ═══════════════════════════ */

const API = () => `https://api.telegram.org/bot${CFG.token}`;
class TgError extends Error {
  constructor(method, d) {
    super(`${method}: ${d.description || 'unknown error'}`);
    this.code = d.error_code; this.params = d.parameters;
  }
}

/** POST к Bot API; files: { field: { blob, name } } → multipart. 429/5xx — повтор. */
async function tg(method, params = {}, { files, retries = 3, timeout } = {}) {
  for (let attempt = 0; ; attempt++) {
    let body; let headers;
    if (files) {
      body = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      for (const [k, f] of Object.entries(files)) body.append(k, f.blob, f.name);
    } else {
      body = JSON.stringify(params);
      headers = { 'content-type': 'application/json' };
    }
    let data;
    try {
      const res = await fetch(`${API()}/${method}`, {
        method: 'POST', body, headers, signal: AbortSignal.timeout(timeout ?? (files ? 120e3 : 65e3)),
      });
      data = await res.json();
    } catch (err) {
      if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      throw err;
    }
    if (data.ok) return data.result;
    if (data.error_code === 429 && attempt < retries) { await sleep((data.parameters?.retry_after || 1) * 1000 + 300); continue; }
    if (data.error_code >= 500 && attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
    throw new TgError(method, data);
  }
}

const QUIET = /message is not modified|message to (edit|delete) not found|query is too old|message can't be (edited|deleted)/i;
const safe = (p) => p.catch((err) => { if (!QUIET.test(err.message)) log.warn(err.message); return null; });
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const kbd = (rows) => ({ inline_keyboard: rows || [] });

const send = (chat_id, text, rows, extra = {}) => tg('sendMessage', { chat_id, text, ...HTML, reply_markup: rows ? kbd(rows) : undefined, ...extra });

/** Редактирует карточку, а если нельзя — присылает новую. Возвращает message_id. */
async function card(chatId, msgId, text, rows) {
  if (msgId) {
    try {
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text, ...HTML, reply_markup: kbd(rows) });
      return msgId;
    } catch (err) {
      if (/not modified/i.test(err.message)) return msgId;
      if (err.code === 403) throw err;
    }
  }
  const m = await send(chatId, text, rows);
  return m.message_id;
}

async function sendAudioFile(chatId, clipInfo, performer, extra = {}) {
  const blob = await fs.openAsBlob(clipInfo.path, { type: 'audio/mpeg' });
  return tg('sendAudio', {
    chat_id: chatId, performer: cut(performer || 'noliric', 60), title: '???', duration: clipInfo.duration, ...extra,
  }, { files: { audio: { blob, name: 'noliric.mp3' } } });
}

async function sendQuiz(chatId, { question, options, correct, explanation, rows }) {
  const p = {
    chat_id: chatId, question: cut(question, 300), options: options.map((text) => ({ text })),
    type: 'quiz', is_anonymous: false, correct_option_ids: [correct], open_period: CFG.answerSec,
    explanation, explanation_parse_mode: 'HTML', reply_markup: kbd(rows),
  };
  try {
    return await tg('sendPoll', p);
  } catch (err) { // совместимость со старым Bot API Server (< 9.6)
    if (err.code === 400 && /correct_option/i.test(err.message)) {
      delete p.correct_option_ids; p.correct_option_id = correct;
      return tg('sendPoll', p);
    }
    throw err;
  }
}

/* ═══════════════════════════ SQLite ═══════════════════════════ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  games         INTEGER NOT NULL DEFAULT 0,
  score         INTEGER NOT NULL DEFAULT 0,
  correct       INTEGER NOT NULL DEFAULT 0,
  wrong         INTEGER NOT NULL DEFAULT 0,
  best_streak   INTEGER NOT NULL DEFAULT 0,
  best_hardcore INTEGER NOT NULL DEFAULT 0,
  blocked       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  mode        TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  source_name TEXT,
  rounds      INTEGER NOT NULL DEFAULT 0,
  played      INTEGER NOT NULL DEFAULT 0,
  score       INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  wrong       INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',
  end_reason  TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS rounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  track_key  TEXT NOT NULL,
  title      TEXT NOT NULL,
  answer     TEXT,
  correct    INTEGER NOT NULL DEFAULT 0,
  points     INTEGER NOT NULL DEFAULT 0,
  hint       INTEGER NOT NULL DEFAULT 0,
  level      INTEGER NOT NULL DEFAULT 0,
  ms         INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clip_files (
  track_key  TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clips (
  track_key  TEXT NOT NULL,
  level      INTEGER NOT NULL,
  file_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (track_key, level)
);
DROP TABLE IF EXISTS instrumentals;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_users_score  ON users(score DESC);
CREATE INDEX IF NOT EXISTS idx_users_streak ON users(best_streak DESC);
CREATE INDEX IF NOT EXISTS idx_games_user   ON games(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_rounds_game  ON rounds(game_id);
CREATE INDEX IF NOT EXISTS idx_files_used   ON clip_files(last_used);
`;

let db; let Q;
function initDb() {
  fs.mkdirSync(path.dirname(CFG.dbPath), { recursive: true });
  const Database = require('better-sqlite3');
  db = new Database(CFG.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(rounds)').all().some((c) => c.name === 'level')) db.exec('ALTER TABLE rounds ADD COLUMN level INTEGER NOT NULL DEFAULT 0');
  db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').run('schema_version', '1');
  Q = {
    upsertUser: db.prepare(`INSERT INTO users (id, username, first_name, created_at, last_seen)
      VALUES (@id, @username, @first_name, @now, @now)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
        last_seen = excluded.last_seen, blocked = 0`),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    rank: db.prepare('SELECT COUNT(*) + 1 AS r FROM users WHERE score > ?'),
    topScore: db.prepare('SELECT id, username, first_name, score AS v FROM users WHERE score > 0 ORDER BY score DESC, id LIMIT 10'),
    topStreak: db.prepare('SELECT id, username, first_name, best_streak AS v FROM users WHERE best_streak > 0 ORDER BY best_streak DESC, score DESC LIMIT 10'),
    gameNew: db.prepare(`INSERT INTO games (user_id, mode, source_type, source_id, source_name, rounds, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    gameEnd: db.prepare(`UPDATE games SET played = @played, score = @score, correct = @correct, wrong = @wrong,
      best_streak = @best, status = @status, end_reason = @reason, finished_at = @now WHERE id = @id`),
    roundAdd: db.prepare(`INSERT INTO rounds (game_id, idx, track_key, title, answer, correct, points, hint, level, ms, created_at)
      VALUES (@game, @idx, @key, @title, @answer, @correct, @points, @hint, @level, @ms, @now)`),
    userStats: db.prepare(`UPDATE users SET games = games + 1, score = score + @score, correct = correct + @correct,
      wrong = wrong + @wrong, best_streak = MAX(best_streak, @streak), best_hardcore = MAX(best_hardcore, @hardcore)
      WHERE id = @id`),
    abortStale: db.prepare(`UPDATE games SET status = 'aborted', end_reason = 'restart', finished_at = ? WHERE status = 'active'`),
    filesPut: db.prepare(`INSERT INTO clip_files (track_key, bytes, created_at, last_used) VALUES (@key, @bytes, @now, @now)
      ON CONFLICT(track_key) DO UPDATE SET bytes = excluded.bytes, last_used = excluded.last_used`),
    filesTouch: db.prepare('UPDATE clip_files SET last_used = ? WHERE track_key = ?'),
    filesDel: db.prepare('DELETE FROM clip_files WHERE track_key = ?'),
    filesStats: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM clip_files'),
    filesLru: db.prepare('SELECT track_key, bytes FROM clip_files ORDER BY last_used ASC LIMIT 300'),
    filesAll: db.prepare('SELECT track_key FROM clip_files'),
    clipsGet: db.prepare('SELECT level, file_id FROM clips WHERE track_key = ?'),
    clipPut: db.prepare('INSERT OR REPLACE INTO clips (track_key, level, file_id, created_at) VALUES (?, ?, ?, ?)'),
    clipDel: db.prepare('DELETE FROM clips WHERE track_key = ?'),
    clipStats: db.prepare('SELECT COUNT(DISTINCT track_key) AS n FROM clips'),
    stats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE last_seen > @day) AS users24,
      (SELECT COUNT(*) FROM users WHERE blocked = 1) AS blocked,
      (SELECT COUNT(*) FROM games) AS games,
      (SELECT COUNT(*) FROM games WHERE started_at > @day) AS games24,
      (SELECT COUNT(*) FROM rounds) AS rounds`),
    audience: db.prepare('SELECT id FROM users WHERE blocked = 0'),
    setBlocked: db.prepare('UPDATE users SET blocked = 1 WHERE id = ?'),
  };
  Q.finish = db.transaction((end, user) => { Q.gameEnd.run(end); if (user) Q.userStats.run(user); });
}

function touchUser(from) {
  if (!from || from.is_bot) return;
  Q.upsertUser.run({ id: from.id, username: from.username || null, first_name: from.first_name || null, now: now() });
}
const displayName = (u) => u.first_name || (u.username ? `@${u.username}` : 'игрок');

/* ═══════════════════════════ источники музыки ═══════════════════════════ */

function gate(gapMs) {
  let next = 0;
  return async () => {
    const t = now(); const wait = Math.max(0, next - t);
    next = Math.max(t, next) + gapMs;
    if (wait) await sleep(wait);
  };
}
const dzGate = gate(120); // Deezer: ≤ 50 запросов / 5 сек
const itGate = gate(350);

async function getJson(url, ms = 15e3) {
  const res = await fetch(url, {
    headers: { 'user-agent': `noliric-bot/1.0 (+https://t.me/${CFG.username})`, accept: 'application/json' },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const Deezer = {
  src: 'dz',
  async req(p) {
    await dzGate();
    const d = await getJson(`https://api.deezer.com${p}`);
    if (d?.error) throw new Error(`Deezer: ${d.error.message || d.error.type}`);
    return d;
  },
  track(t, al) {
    return {
      key: `dz:${t.id}`, src: 'dz', id: String(t.id), title: t.title_short || t.title, full: t.title,
      artist: t.artist?.name || al?.artist?.name || '', artistId: String(t.artist?.id || ''),
      album: t.album?.title || al?.title || '', albumId: String(t.album?.id || al?.id || ''),
      year: String(al?.release_date || '').slice(0, 4), pos: t.track_position || 0,
      preview: t.preview || '', ok: t.readable !== false && !!t.preview,
    };
  },
  async searchArtists(q) {
    const d = await this.req(`/search/artist?q=${encodeURIComponent(q)}&limit=6`);
    return (d.data || []).map((a) => ({ type: 'artist', src: 'dz', id: String(a.id), name: a.name }));
  },
  async searchAlbums(q) {
    const d = await this.req(`/search/album?q=${encodeURIComponent(q)}&limit=6`);
    return (d.data || []).map((a) => ({ type: 'album', src: 'dz', id: String(a.id), name: a.title, artist: a.artist?.name || '' }));
  },
  async albumTracks(id, meta) {
    const d = await this.req(`/album/${id}/tracks?limit=300`);
    return (d.data || []).map((t) => this.track(t, meta));
  },
  async artistPool(item) {
    const [top, albums] = await Promise.all([
      this.req(`/artist/${item.id}/top?limit=100`).catch(() => ({ data: [] })),
      this.req(`/artist/${item.id}/albums?limit=100`).catch(() => ({ data: [] })),
    ]);
    const list = (albums.data || []).slice(0, CFG.albumsPerArtist);
    const byId = new Map(list.map((a) => [String(a.id), a]));
    const lists = await mapLimit(list, 3, (a) => this.albumTracks(a.id, a).catch(() => []));
    const own = lists.flat().filter((t) => !t.artistId || t.artistId === item.id);
    const tops = (top.data || []).map((t) => this.track(t, byId.get(String(t.album?.id))));
    return { name: item.name, artist: item.name, tracks: [...tops, ...own] };
  },
  async albumPool(item) {
    const meta = await this.req(`/album/${item.id}`);
    const tracks = await this.albumTracks(item.id, meta);
    return {
      name: meta.title || item.name, artist: meta.artist?.name || item.artist,
      artistRef: meta.artist?.id ? { type: 'artist', src: 'dz', id: String(meta.artist.id), name: meta.artist.name } : null,
      year: String(meta.release_date || '').slice(0, 4), tracks,
    };
  },
  async freshPreview(t) { const d = await this.req(`/track/${t.id}`); return d.preview || null; },
};

const ITunes = {
  src: 'it',
  async req(p) { await itGate(); return getJson(`https://itunes.apple.com${p}&country=${CFG.itunesCountry}`); },
  track(t) {
    return {
      key: `it:${t.trackId}`, src: 'it', id: String(t.trackId), title: t.trackName, full: t.trackName,
      artist: t.artistName || '', artistId: String(t.artistId || ''), album: t.collectionName || '',
      albumId: String(t.collectionId || ''), year: String(t.releaseDate || '').slice(0, 4), pos: t.trackNumber || 0,
      preview: t.previewUrl || '', ok: !!t.previewUrl,
    };
  },
  async searchArtists(q) {
    const d = await this.req(`/search?term=${encodeURIComponent(q)}&entity=musicArtist&limit=6`);
    return (d.results || []).map((a) => ({ type: 'artist', src: 'it', id: String(a.artistId), name: a.artistName }));
  },
  async searchAlbums(q) {
    const d = await this.req(`/search?term=${encodeURIComponent(q)}&entity=album&limit=6`);
    return (d.results || []).map((a) => ({ type: 'album', src: 'it', id: String(a.collectionId), name: a.collectionName, artist: a.artistName || '' }));
  },
  async artistPool(item) {
    const d = await this.req(`/lookup?id=${item.id}&entity=song&limit=200`);
    return { name: item.name, artist: item.name, tracks: (d.results || []).filter((r) => r.wrapperType === 'track').map((t) => this.track(t)) };
  },
  async albumPool(item) {
    const d = await this.req(`/lookup?id=${item.id}&entity=song&limit=200`);
    const col = (d.results || []).find((r) => r.wrapperType === 'collection');
    return {
      name: col?.collectionName || item.name, artist: col?.artistName || item.artist,
      artistRef: col?.artistId ? { type: 'artist', src: 'it', id: String(col.artistId), name: col.artistName } : null,
      year: String(col?.releaseDate || '').slice(0, 4),
      tracks: (d.results || []).filter((r) => r.wrapperType === 'track').map((t) => this.track(t)),
    };
  },
  async freshPreview(t) { return t.preview || null; },
};

const PROVIDERS = { dz: Deezer, it: ITunes };
const ORDER = CFG.source === 'itunes' ? [ITunes] : CFG.source === 'deezer' ? [Deezer] : [Deezer, ITunes];

async function search(q, types) {
  for (const p of ORDER) {
    try {
      const parts = await Promise.all(types.map((t) => (t === 'artist' ? p.searchArtists(q) : p.searchAlbums(q))));
      const res = parts.flatMap((r) => r.slice(0, types.length > 1 ? 3 : 6));
      if (res.length) return res;
    } catch (err) { log.warn(`search[${p.src}] «${q}»: ${err.message}`); }
  }
  return [];
}

const poolCache = new Map();
async function loadPool(item) {
  const key = `${item.type}:${item.src}:${item.id}`;
  const hit = poolCache.get(key);
  if (hit && now() - hit.at < 30 * 60e3) return hit.pool;
  const P = PROVIDERS[item.src];
  const raw = item.type === 'artist' ? await P.artistPool(item) : await P.albumPool(item);
  const seen = new Set(); const tracks = [];
  for (const t of raw.tracks) {
    if (!t.ok) continue;
    const c = canon(baseTitle(t.title));
    if (!c || seen.has(c)) continue;
    seen.add(c); tracks.push(t);
  }
  let extra = [];
  if (item.type === 'album' && tracks.length < 8 && raw.artistRef) { // варианты ответа для коротких альбомов
    try { extra = (await P.artistPool(raw.artistRef)).tracks.filter((t) => !seen.has(canon(baseTitle(t.title)))); } catch { /* ok */ }
  }
  const pool = { key, type: item.type, name: raw.name, artist: raw.artist, year: raw.year, tracks, extra };
  poolCache.set(key, { at: now(), pool });
  if (poolCache.size > 300) poolCache.delete(poolCache.keys().next().value);
  return pool;
}
const itemName = (it) => (it.type === 'album' && it.artist ? `${it.name} — ${it.artist}` : it.name);

/* ═══════════════════════════ фрагменты ═══════════════════════════ */

// Уровни как в Heardle: 1 сек (начало + конец превью), первые 3, 5, 10 сек.
// Очки — за уровень, на котором дан ответ: чем длиннее фрагмент, тем меньше; на 10 сек — ноль.
const LEVELS = [
  { dur: 1, label: '1 сек', caption: '1 сек · начало и конец' },
  { dur: 3, label: '3 сек', caption: 'Первые 3 сек' },
  { dur: 5, label: '5 сек', caption: 'Первые 5 сек' },
  { dur: 10, label: '10 сек', caption: 'Первые 10 сек' },
].map((l, i) => ({ ...l, pts: CFG.points[i] ?? 0 }));

const PREP = { jobs: new Map(), queue: [], active: 0, bad: new Map(), errors: [], done: 0, failed: 0, totalMs: 0, broken: null, seq: 0 };
const STAGES = { download: 'превью', cut: 'ffmpeg', send: 'отправка' };
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const safeKey = (k) => k.replace(/[^a-z0-9_-]/gi, '_');
const clipDir = (key) => path.join(DIRS.clips, safeKey(key));
const clipPath = (key, i) => path.join(clipDir(key), `l${i}.mp3`);

function prepError(stage, track, message) {
  PREP.errors.unshift({ at: now(), stage, title: track?.title || '', message: cut(String(message), 300) });
  PREP.errors.length = Math.min(PREP.errors.length, 5);
}

/** Готовит 4 уровня трека: file_id из Telegram (мгновенно) → файлы на диске → превью + ffmpeg. */
function prepareTrack(track, priority = 5) {
  const ids = new Map(Q.clipsGet.all(track.key).map((r) => [r.level, r.file_id]));
  const onDisk = LEVELS.every((_, i) => fs.existsSync(clipPath(track.key, i)));
  if (ids.size === LEVELS.length || onDisk) {
    if (onDisk) Q.filesTouch.run(now(), track.key);
    return Promise.resolve({ track, levels: LEVELS.map((_, i) => ({ fileId: ids.get(i) || null, path: clipPath(track.key, i) })) });
  }
  const bad = PREP.bad.get(track.key);
  if (bad && now() - bad < 3600e3) return Promise.reject(new Error('превью трека недоступно'));
  if (PREP.broken) return Promise.reject(new Error(PREP.broken));
  let job = PREP.jobs.get(track.key);
  if (job) { if (priority < job.priority) job.priority = priority; return job.promise; }
  job = { key: track.key, track, priority, seq: ++PREP.seq };
  job.promise = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
  job.promise.then(() => PREP.jobs.delete(track.key), () => { PREP.jobs.delete(track.key); PREP.bad.set(track.key, now()); });
  PREP.jobs.set(track.key, job); PREP.queue.push(job); pumpPrep();
  return job.promise;
}

function pumpPrep() {
  while (PREP.active < CFG.prepConcurrency && PREP.queue.length) {
    PREP.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const job = PREP.queue.shift();
    PREP.active++;
    buildLevels(job.track)
      .then(() => job.resolve({ track: job.track, levels: LEVELS.map((_, i) => ({ fileId: null, path: clipPath(job.track.key, i) })) }), job.reject)
      .finally(() => { PREP.active--; setImmediate(pumpPrep); });
  }
}

async function buildLevels(t) {
  const started = now();
  const src = path.join(DIRS.tmp, `${safeKey(t.key)}_${crypto.randomBytes(3).toString('hex')}.src`);
  const dir = clipDir(t.key);
  let stage = 'download';
  try {
    await downloadPreview(t, src);
    stage = 'cut';
    await fsp.mkdir(dir, { recursive: true });
    await cutLevels(src, dir);
    const bytes = LEVELS.reduce((s, _, i) => s + fs.statSync(clipPath(t.key, i)).size, 0);
    Q.filesPut.run({ key: t.key, bytes, now: now() });
    PREP.done++; PREP.totalMs += now() - started;
    log.debug(`levels «${t.title}» in ${now() - started}ms`);
  } catch (err) {
    PREP.failed++; err.stage = stage;
    log.warn(`prepare ${t.key} «${t.title}» [${stage}]: ${err.message}`);
    prepError(stage, t, err.message);
    fs.rm(dir, { recursive: true, force: true }, () => {});
    throw err;
  } finally {
    fs.rm(src, { force: true }, () => {});
  }
}

/** Один проход ffmpeg → 4 файла. Тишину/фейд в начале и конце превью пропускаем. */
function cutLevels(src, dir) {
  const fmt = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
  const trim = 'silenceremove=start_periods=1:start_threshold=-30dB';
  const graph = [
    `[0:a]${fmt},${trim},asplit=5[a][b][c][d][e]`,
    '[a]atrim=0:1,asetpts=N/SR/TB,afade=t=out:st=0.85:d=0.15[s]',
    `[b]areverse,${trim},atrim=0:1,areverse,asetpts=N/SR/TB,afade=t=in:d=0.15[t]`,
    `aevalsrc=0:s=44100:d=0.45,${fmt}[g]`,
    '[s][g][t]concat=n=3:v=0:a=1[l0]',
    ...LEVELS.slice(1).map((L, k) => `[${'cde'[k]}]atrim=0:${L.dur},asetpts=N/SR/TB,afade=t=out:st=${(L.dur - 0.3).toFixed(2)}:d=0.3[l${k + 1}]`),
  ].join(';');
  const outs = LEVELS.flatMap((_, i) => ['-map', `[l${i}]`, '-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1', '-id3v2_version', '0', path.join(dir, `l${i}.mp3`)]);
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-filter_complex', graph, ...outs], { timeout: 30e3 });
}

async function fetchAudio(url, dst) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 noliric-bot' }, signal: AbortSignal.timeout(20e3) });
  if (!res.ok) throw new Error(`превью HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20_000) throw new Error('превью пустое');
  await fsp.writeFile(dst, buf);
}

/** Превью: исходная ссылка → свежая ссылка → тот же трек в iTunes (если Deezer CDN недоступен). */
async function downloadPreview(t, dst) {
  const errors = [];
  try { return await fetchAudio(t.preview, dst); } catch (err) { errors.push(err.message); }
  try {
    const fresh = await PROVIDERS[t.src].freshPreview(t);
    if (fresh && fresh !== t.preview) { t.preview = fresh; return await fetchAudio(fresh, dst); }
  } catch (err) { errors.push(err.message); }
  if (t.src !== 'it') {
    try {
      const d = await ITunes.req(`/search?term=${encodeURIComponent(`${t.artist} ${baseTitle(t.title)}`)}&entity=song&limit=10`);
      const want = canon(baseTitle(t.title));
      const hit = (d.results || []).find((r) => r.previewUrl && canon(baseTitle(r.trackName)) === want);
      if (hit) { await fetchAudio(hit.previewUrl, dst); log.info(`preview «${t.title}» взято из iTunes`); return; }
      errors.push('в iTunes не найден');
    } catch (err) { errors.push(`iTunes: ${err.message}`); }
  }
  throw new Error(errors.join(' · '));
}

function cleanCache() {
  const max = CFG.cacheMaxMb * 1048576;
  let { bytes } = Q.filesStats.get();
  if (bytes <= max) return;
  const busy = new Set(PREP.jobs.keys());
  for (const r of Q.filesLru.all()) {
    if (bytes <= max * 0.9) break;
    if (busy.has(r.track_key)) continue;
    fs.rmSync(clipDir(r.track_key), { recursive: true, force: true }); Q.filesDel.run(r.track_key); bytes -= r.bytes;
  }
  log.info(`cache trimmed to ${(bytes / 1048576).toFixed(0)} MB`);
}

/* ═══════════════════════════ ffmpeg ═══════════════════════════ */

function run(cmd, args, { timeout = 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e2) => { clearTimeout(timer); reject(e2); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${cut(err.trim(), 300)}`)); });
  });
}

/* ═══════════════════════════ режимы и игра ═══════════════════════════ */

const MODES = {
  artist: {
    key: 'artist', title: 'Artist Vol.', desc: 'треки из всей дискографии', source: ['artist'],
    answer: 'poll', hint: true, mult: 1, maxLevel: 3, prompt: 'Отправь имя исполнителя — например, <i>Kai Angel</i>',
  },
  album: {
    key: 'album', title: 'Album Vol.', desc: 'песни одного альбома', source: ['album'],
    answer: 'poll', hint: true, mult: 1, maxLevel: 3, prompt: 'Отправь название альбома — например, <i>Shh!</i>',
  },
  hardcore: {
    key: 'hardcore', title: 'Hardcore Vol.', desc: 'максимум 3 сек, название пишешь сам, ×2 очки', source: ['artist', 'album'],
    answer: 'text', hint: false, mult: 2, maxLevel: 1, prompt: 'Отправь исполнителя или альбом',
  },
  challenge: {
    key: 'challenge', title: 'Challenge Vol.', desc: 'подряд до первой ошибки', source: ['artist', 'album'],
    answer: 'poll', hint: false, mult: 1, maxLevel: 3, endless: true, prompt: 'Отправь исполнителя или альбом',
  },
};

const games = new Map();     // uid → Game
const pollIndex = new Map(); // poll_id → Game

function buildOptions(track, pool, n = 4) {
  const used = new Set([canon(baseTitle(track.title))]);
  const opts = [cut(track.title, 100)];
  for (const t of shuffle([...pool.tracks, ...(pool.extra || [])])) {
    if (opts.length >= n) break;
    const c = canon(baseTitle(t.title));
    if (!c || used.has(c)) continue;
    used.add(c); opts.push(cut(t.title, 100));
  }
  const order = shuffle(opts.map((_, i) => i));
  return { options: order.map((i) => opts[i]), correct: order.indexOf(0) };
}

function hintText(g) {
  const t = g.cur.track; const lines = [];
  if (g.pool.type !== 'album' && t.album) lines.push(`Альбом: ${t.album}${t.year ? ` (${t.year})` : ''}`);
  if (t.pos) lines.push(`Трек №${t.pos}${g.pool.type === 'album' ? ' в альбоме' : ''}`);
  if (g.pool.type === 'album' || !t.pos) lines.push(`Начинается на «${([...t.title.trim()][0] || '?').toUpperCase()}»`);
  lines.push('Очки за раунд ×0.5');
  return cut(lines.join('\n'), 190);
}

const ptsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'очко' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'очка' : 'очков');

class Game {
  constructor({ uid, chatId, mode, item, pool, rounds, cardId }) {
    Object.assign(this, {
      uid, chatId, item, pool, cardId, mode: MODES[mode],
      queue: shuffle(pool.tracks.slice()), wanted: MODES[mode].endless ? Infinity : rounds,
      score: 0, correct: 0, wrong: 0, streak: 0, bestStreak: 0, misses: 0, failRow: 0,
      history: [], i: 0, cur: null, stopped: false, reason: null, waiter: null,
    });
    this.performer = pool.artist || pool.name;
    this.title = pool.type === 'album' && pool.artist ? `${pool.name} — ${pool.artist}` : pool.name;
    this.stopP = new Promise((r) => { this.stopR = r; });
    this.id = Number(Q.gameNew.run(uid, mode, item.type, `${item.src}:${item.id}`, this.title,
      Number.isFinite(this.wanted) ? this.wanted : 0, now()).lastInsertRowid);
  }

  get total() { return Math.min(this.wanted, this.queue.length); }

  header(final = false) {
    const m = this.mode;
    const top = `${e(m.key)} <b>${m.title}</b> · ${esc(this.title)}`;
    if (final) return `${top}\nИгра завершена · <b>${fmt(this.score)}</b> ${ptsWord(this.score)}`;
    if (m.endless) return `${top}\nСерия <b>${this.streak}</b> · ${fmt(this.score)} ${ptsWord(this.score)}`;
    return `${top}\nРаунд ${Math.min(this.i + 1, this.total)}/${this.total} · <b>${fmt(this.score)}</b> ${ptsWord(this.score)}${this.streak > 1 ? ` · серия ${this.streak}` : ''}`;
  }

  async updateCard(final = false) {
    if (!this.cardId) return;
    const text = this.header(final);
    if (text === this.lastHeader) return;
    this.lastHeader = text;
    const rows = final ? [] : [[B('Завершить', 'g:stop', 'cross', 'danger')]];
    await safe(tg('editMessageText', { chat_id: this.chatId, message_id: this.cardId, text, ...HTML, reply_markup: kbd(rows) }));
  }

  async run() {
    try {
      await this.updateCard();
      while (!this.stopped && this.i < this.total) {
        const prep = await this.nextTrack();
        if (!prep || this.stopped) break;
        await this.updateCard();
        const res = await this.playRound(prep);
        if (this.stopped || res.stopped) break;
        this.i++;
        if (this.mode.endless && !res.correct) { this.reason = 'miss'; break; }
        if (res.timeout) { if (++this.misses >= 2) { this.reason = 'afk'; break; } } else this.misses = 0;
        await sleep(1200);
      }
      if (!this.reason) this.reason = this.stopped ? 'stop' : this.mode.endless ? 'cleared' : 'done';
    } catch (err) {
      if (err.code === 403) { this.reason = 'blocked'; Q.setBlocked.run(this.uid); } else {
        this.reason = this.reason || 'error'; this.error = err.message;
        log.error(`game ${this.id}: ${err.stack || err.message}`);
      }
    } finally {
      await this.finish().catch((err) => log.error(`game ${this.id} finish: ${err.message}`));
    }
  }

  async nextTrack() {
    while (!this.stopped && this.i < this.total) {
      const track = this.queue[this.i];
      const want = prepareTrack(track, 0);
      for (let k = 1; k <= CFG.prefetch; k++) {
        const nt = this.queue[this.i + k];
        if (nt && this.i + k < this.total) prepareTrack(nt, k).catch(() => {});
      }
      try {
        const prep = await this.waitReady(want);
        if (prep) this.failRow = 0;
        return prep;
      } catch (err) {
        if (PREP.broken) throw new Error(PREP.broken);
        log.warn(`game ${this.id}: skip ${track.key} — ${err.message}`);
        this.queue.splice(this.i, 1);
        if (++this.failRow >= 3) throw new Error(`3 трека подряд не загрузились. Причина: ${cut(err.message, 160)}`);
      }
    }
    return null;
  }

  async waitReady(promise) {
    const quick = await Promise.race([promise.then(() => true, () => true), sleep(600).then(() => false)]);
    if (quick) return promise;
    const action = () => safe(tg('sendChatAction', { chat_id: this.chatId, action: 'upload_voice' }, { retries: 0 }));
    action();
    const iv = setInterval(action, 4500);
    let to;
    const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('превью грузится слишком долго')), 90e3); });
    try { return await Promise.race([promise, timeout, this.stopP.then(() => null)]); } finally { clearInterval(iv); clearTimeout(to); }
  }

  caption(cur) {
    const L = LEVELS[cur.level];
    const pts = Math.round(L.pts * this.mode.mult * (cur.hint ? 0.5 : 1));
    let c = `<b>[${cur.tag}]</b> ${L.caption} · ${pts ? `${pts} ${ptsWord(pts)}` : 'без очков'}`;
    if (cur.kind === 'text') c += `\nНапиши название · ${e('clock')} <tg-time unix="${Math.floor(cur.deadline / 1000)}" format="r">${CFG.answerSec} сек</tg-time>`;
    return c;
  }

  rows(cur) {
    const row = [];
    if (cur.level < this.mode.maxLevel) row.push(B(LEVELS[cur.level + 1].label, 'g:more', 'clock'));
    if (cur.kind === 'poll' && this.mode.hint) row.push(B('Подсказка', 'g:hint', 'eye'));
    if (cur.kind === 'text') row.push(B('Пропустить', 'g:skip', 'timePassed'));
    row.push(B('Стоп', 'g:stop', 'cross'));
    return [row];
  }

  /** Отправка/замена аудио уровня: по file_id мгновенно, иначе загрузка файла (file_id запоминается). */
  async sendLevel(cur, { edit = false } = {}) {
    const lv = cur.prep.levels[cur.level];
    const key = cur.track.key;
    const extra = { caption: this.caption(cur), parse_mode: 'HTML' };
    const withKb = cur.kind === 'text' ? { reply_markup: kbd(this.rows(cur)) } : {};
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!lv.fileId && !fs.existsSync(lv.path)) await buildLevels(cur.track); // file_id протух, файлов нет — пересобрать
      const ref = lv.fileId || 'attach://clip';
      const files = lv.fileId ? undefined : { clip: { blob: await fs.openAsBlob(lv.path, { type: 'audio/mpeg' }), name: 'noliric.mp3' } };
      try {
        let msg;
        if (edit) {
          msg = await tg('editMessageMedia', {
            chat_id: this.chatId, message_id: cur.audioId,
            media: { type: 'audio', media: ref, performer: cut(this.performer, 60), title: '???', ...extra }, ...withKb,
          }, { files });
        } else {
          msg = await tg('sendAudio', { chat_id: this.chatId, audio: ref, performer: cut(this.performer, 60), title: '???', ...extra, ...withKb }, { files });
        }
        const fid = msg?.audio?.file_id;
        if (fid && !lv.fileId) { lv.fileId = fid; Q.clipPut.run(key, cur.level, fid, now()); }
        return msg;
      } catch (err) {
        if (lv.fileId && err.code === 400 && !/not modified/i.test(err.message) && attempt === 0) { Q.clipDel.run(key); lv.fileId = null; continue; }
        throw err;
      }
    }
    return null;
  }

  async levelUp() {
    const cur = this.cur;
    if (!cur || cur.done || cur.busy || cur.level >= this.mode.maxLevel) return false;
    cur.busy = true; cur.level++;
    try {
      await this.sendLevel(cur, { edit: true });
      if (cur.kind === 'poll') await safe(tg('editMessageReplyMarkup', { chat_id: this.chatId, message_id: cur.pollMsgId, reply_markup: kbd(this.rows(cur)) }));
      return true;
    } catch (err) {
      cur.level--; log.warn(`levelUp: ${err.message}`); return false;
    } finally { cur.busy = false; }
  }

  async playRound(prep) {
    const t = prep.track; const m = this.mode;
    const cur = {
      kind: m.answer, track: t, prep, level: 0, hint: false, done: false, busy: false,
      tag: m.endless ? `#${this.history.length + 1}` : `${this.i + 1}/${this.total}`,
      at: now(), deadline: now() + CFG.answerSec * 1000 + 1000,
    };
    this.cur = cur;
    const audio = await this.sendLevel(cur);
    cur.audioId = audio.message_id;
    if (cur.kind === 'poll') {
      const { options, correct } = buildOptions(t, this.pool);
      const album = t.album || this.pool.name;
      const poll = await sendQuiz(this.chatId, {
        question: `[${cur.tag}] Что это за трек?`, options, correct,
        explanation: `<b>${esc(cut(t.title, 80))}</b> · ${esc(cut(album, 70))}${t.year ? ` · ${t.year}` : ''}`,
        rows: this.rows(cur),
      });
      Object.assign(cur, { pollId: poll.poll.id, pollMsgId: poll.message_id, correct, options, at: now(), deadline: now() + CFG.answerSec * 1000 });
      pollIndex.set(cur.pollId, this);
    }

    const ans = await this.waitAnswer(cur.deadline - now() + 1500);
    cur.done = true;
    if (cur.pollId) pollIndex.delete(cur.pollId);
    const kbMsg = cur.kind === 'poll' ? cur.pollMsgId : cur.audioId;
    const stripKb = () => safe(tg('editMessageReplyMarkup', { chat_id: this.chatId, message_id: kbMsg, reply_markup: kbd([]) }));
    if (ans.type === 'stop') { await stripKb(); return { stopped: true }; }

    let ok = false; let answer = null;
    if (ans.type === 'answer') { ok = ans.option === cur.correct; answer = cur.options[ans.option] ?? null; }
    if (ans.type === 'text') { ok = checkAnswer(ans.text, t); answer = cut(ans.text, 120); }
    const L = LEVELS[cur.level];
    let pts = 0;
    if (ok) {
      pts = L.pts * m.mult;
      if (m.endless && pts) pts += 10 * this.streak;
      if (cur.hint) pts *= 0.5;
      pts = Math.round(pts);
      this.correct++; this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else { this.wrong++; this.streak = 0; }
    this.score += pts;
    const ms = ans.at ? ans.at - cur.at : null;
    this.history.push({ title: t.title, ok, pts, level: cur.level, type: ans.type });
    Q.roundAdd.run({ game: this.id, idx: this.history.length, key: t.key, title: t.title, answer, correct: ok ? 1 : 0, points: pts, hint: cur.hint ? 1 : 0, level: cur.level, ms, now: now() });

    if (cur.kind === 'text') {
      await safe(tg('editMessageCaption', { chat_id: this.chatId, message_id: cur.audioId, caption: `<b>[${cur.tag}]</b> ${esc(t.title)}`, parse_mode: 'HTML', reply_markup: kbd([]) }));
      const name = `<b>${esc(t.title)}</b>`;
      const line = ok ? `${e('check')} ${name} · ${L.label} · +${pts}`
        : ans.type === 'timeout' ? `${e('clock')} Время вышло — это ${name}`
          : ans.type === 'skip' ? `${e('timePassed')} Пропуск — это ${name}`
            : `${e('cross')} Мимо — это ${name}`;
      await send(this.chatId, line, null, ans.msgId ? { reply_parameters: { message_id: ans.msgId, allow_sending_without_reply: true } } : {});
    } else {
      await stripKb();
    }
    return { correct: ok, timeout: ans.type === 'timeout' };
  }

  waitAnswer(ms) {
    return new Promise((resolve) => {
      const done = (v) => { if (this.waiter !== done) return; this.waiter = null; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => done({ type: 'timeout' }), Math.max(1000, ms));
      this.waiter = done;
    });
  }

  answer(v) { if (this.waiter) this.waiter(v); }

  stop(reason = 'stop') {
    if (this.stopped) return;
    this.stopped = true; this.reason = reason;
    this.stopR(); this.answer({ type: 'stop' });
  }

  async finish() {
    games.delete(this.uid);
    if (this.cur?.pollId) pollIndex.delete(this.cur.pollId);
    const played = this.history.length;
    const before = Q.user.get(this.uid) || {};
    const status = this.reason === 'error' ? 'error' : this.reason === 'blocked' ? 'aborted' : 'finished';
    const isChallenge = !!this.mode.endless; const isHardcore = this.mode.key === 'hardcore';
    Q.finish(
      { id: this.id, played, score: this.score, correct: this.correct, wrong: this.wrong, best: this.bestStreak, status, reason: this.reason, now: now() },
      played ? { id: this.uid, score: this.score, correct: this.correct, wrong: this.wrong, streak: isChallenge ? this.bestStreak : 0, hardcore: isHardcore ? this.score : 0 } : null,
    );
    if (this.reason === 'blocked') return;
    await this.updateCard(true);
    if (!played) {
      const text = this.reason === 'stop'
        ? `${e('info')} Игра остановлена`
        : `${e('cross')} <b>Игра прервана</b>\n${esc(cut(this.error || 'не удалось загрузить треки — попробуй другой запрос', 200))}`;
      await safe(send(this.chatId, text, [[B('Ещё раз', 'g:again', 'party'), B('Меню', 'm:new', 'home')]]));
      return;
    }
    const record = (isChallenge && this.bestStreak > (before.best_streak || 0)) || (isHardcore && this.score > (before.best_hardcore || 0));
    await sendSummary(this, record);
  }
}

const REASONS = {
  done: 'Игра окончена', stop: 'Игра остановлена', afk: 'Игра остановлена — нет ответа',
  miss: 'Серия прервана', cleared: 'Ты угадал всё подряд', error: 'Игра прервана',
};

async function sendSummary(g, record) {
  const m = g.mode; const played = g.history.length;
  const reason = REASONS[g.reason] || REASONS.done;
  const stat = m.endless
    ? `Серия <b>${g.bestStreak}</b> · ${fmt(g.score)} ${ptsWord(g.score)}`
    : `<b>${fmt(g.score)}</b> ${ptsWord(g.score)} · ${g.correct}/${played} · серия ${g.bestStreak}`;
  const rows = [[B('Ещё раз', 'g:again', 'party', 'success'), B('Меню', 'm:new', 'home')]];
  const list = g.history.slice(0, 40);

  if (CFG.rich) {
    const html = [
      `<h2>${reason}</h2>`,
      `<p>${e(m.key)} <b>${m.title}</b> · ${esc(g.title)}</p>`,
      `<p>${stat}</p>`,
      record ? `<p>${e('party')} <b>Новый рекорд</b></p>` : '',
      '<table>',
      '<tr><td><b>#</b></td><td><b>Трек</b></td><td><b>Фрагмент</b></td><td><b>Очки</b></td></tr>',
      ...list.map((h, i) => `<tr><td>${i + 1}</td><td>${h.ok ? '✓' : '✗'} ${esc(cut(h.title, 50))}</td><td>${LEVELS[h.level].label}</td><td>${h.ok ? `+${h.pts}` : '—'}</td></tr>`),
      '</table>',
    ].join('');
    try {
      return await tg('sendRichMessage', { chat_id: g.chatId, rich_message: { html }, reply_markup: kbd(rows) }, { retries: 1 });
    } catch (err) {
      if (err.code === 400 || err.code === 404) { CFG.rich = false; log.warn(`rich messages off: ${err.message}`); }
    }
  }
  const lines = list.map((h, i) => `${i + 1}. ${h.ok ? '✓' : '✗'} ${esc(cut(h.title, 45))} · ${LEVELS[h.level].label}${h.ok ? ` · +${h.pts}` : ''}`).join('\n');
  const text = `${e('logo')} <b>${reason}</b>\n${e(m.key)} ${m.title} · ${esc(g.title)}\n\n${stat}${record ? `\n${e('party')} <b>Новый рекорд</b>` : ''}\n\n<blockquote expandable>${lines}</blockquote>`;
  return send(g.chatId, text, rows);
}

/* ═══════════════════════════ экраны ═══════════════════════════ */

const STATE = new Map();
const state = (uid) => { let s = STATE.get(uid); if (!s) STATE.set(uid, (s = { step: null })); return s; };

function homeScreen(uid) {
  const u = Q.user.get(uid) || {};
  const text = `${e('logo')} <b>noliric</b>\n\nУгадай трек по одной секунде. Не узнал — открой 3, 5 или 10 сек, но очков станет меньше.\nНапиши исполнителя или альбом — или выбери режим.\n\n<blockquote>${fmt(u.score)} очков · рекорд серии ${u.best_streak || 0}</blockquote>`;
  const rows = [
    [B('Играть', 'm:play', 'send', 'primary')],
    [B('Профиль', 'm:profile', 'profile'), B('Топ', 'm:top', 'stats')],
    [B('Как играть', 'm:help', 'info')],
  ];
  if (isAdmin(uid)) rows.push([B('Админ-панель', 'adm', 'settings')]);
  return { text, rows };
}

function modesScreen(pick) {
  const list = Object.values(MODES).filter((m) => !pick || m.source.includes(pick.type));
  const lines = list.map((m) => `${e(m.key)} <b>${m.title}</b> — ${m.desc}`).join('\n');
  const text = pick ? `<b>Выбери режим</b> · ${esc(itemName(pick))}\n\n${lines}` : `<b>Режимы</b>\n\n${lines}`;
  const btns = list.map((m) => B(m.title, pick ? `pm:${m.key}` : `mode:${m.key}`, m.key));
  return { text, rows: [...chunk(btns, 2), [BACK('m:home')]] };
}

function promptScreen(mode) {
  const m = MODES[mode];
  return { text: `${e(m.key)} <b>${m.title}</b>\n${m.prompt}`, rows: [[BACK('m:play')]] };
}

function resultsScreen(st, q) {
  const back = BACK(st.mode ? 'm:play' : 'm:home');
  if (!st.results.length) {
    return { text: `${e('cross')} По запросу «${esc(cut(q, 40))}» ничего нет. Попробуй написать иначе.`, rows: [[back]] };
  }
  const rows = st.results.map((r, i) => [B(cut(itemName(r), 60), `pick:${i}`, r.type === 'artist' ? 'profile' : 'box')]);
  return { text: `${e('eye')} <b>Нашёл</b> по запросу «${esc(cut(q, 40))}»`, rows: [...rows, [back]] };
}

function roundsScreen(mode, item) {
  const m = MODES[mode];
  return {
    text: `${e(m.key)} <b>${m.title}</b> · ${esc(itemName(item))}\nСколько раундов?`,
    rows: [[B('5', 'r:5'), B('10', 'r:10'), B('15', 'r:15')], [BACK('m:play')]],
  };
}

function profileScreen(uid) {
  const u = Q.user.get(uid) || {};
  const total = (u.correct || 0) + (u.wrong || 0);
  const rank = u.score ? `#${Q.rank.get(u.score).r}` : '—';
  return {
    text: `${e('profile')} <b>Профиль</b>\n\nОчки: <b>${fmt(u.score)}</b> · место ${rank}\nИгр: ${fmt(u.games)} · точность ${pct(u.correct, total)}%\nРекорд Challenge: <b>${u.best_streak || 0}</b> подряд\nЛучший Hardcore: <b>${fmt(u.best_hardcore)}</b>`,
    rows: [[B('Топ игроков', 'm:top', 'stats')], [BACK('m:home')]],
  };
}

function topScreen(uid, kind = 'score') {
  const list = (kind === 'streak' ? Q.topStreak : Q.topScore).all();
  const lines = list.map((r, i) => {
    const name = esc(cut(displayName(r), 24));
    return `${i + 1}. ${r.id === uid ? `<b>${name}</b>` : name} — ${fmt(r.v)}`;
  });
  return {
    text: `${e('stats')} <b>Топ</b> · ${kind === 'streak' ? 'серия Challenge' : 'очки'}\n\n${lines.join('\n') || 'Пока пусто — сыграй первым.'}`,
    rows: [
      [B('Очки', 'm:top:score', 'growth', kind === 'score' ? 'primary' : undefined), B('Серия', 'm:top:streak', 'challenge', kind === 'streak' ? 'primary' : undefined)],
      [BACK('m:home')],
    ],
  };
}

function helpScreen() {
  const modes = Object.values(MODES).map((m) => `${e(m.key)} <b>${m.title}</b> — ${m.desc}`).join('\n');
  return {
    text: `${e('info')} <b>Как играть</b>\n\nБот присылает 1 секунду начала и конца трека. Не узнал — жми «3 сек», «5 сек» или «10 сек». На ответ ${CFG.answerSec} сек.\n\n<blockquote>${LEVELS.map((L) => `${L.label} — ${L.pts ? `${L.pts} ${ptsWord(L.pts)}` : 'без очков'}`).join('\n')}</blockquote>\n\n${modes}\n\nПодсказка режет очки вдвое, в Hardcore очки ×2.`,
    rows: [[B('Играть', 'm:play', 'send', 'primary')], [BACK('m:home')]],
  };
}

function busyScreen(g) {
  return {
    text: `${e(g.mode.key)} <b>Игра уже идёт</b> · ${esc(g.title)}\nЗаверши её, чтобы начать новую.`,
    rows: [[B('Завершить', 'g:stop', 'cross', 'danger')], [BACK('m:home')]],
  };
}

/* ═══════════════════════════ запуск игры ═══════════════════════════ */

async function startGame({ uid, chatId, cardId, mode, item, rounds }) {
  const m = MODES[mode];
  if (games.has(uid)) { const s = busyScreen(games.get(uid)); return card(chatId, cardId, s.text, s.rows); }
  if (games.size >= CFG.maxGames) return card(chatId, cardId, `${e('clock')} Сейчас много игр — попробуй через минуту.`, [[BACK('m:home')]]);
  if (PREP.broken) return card(chatId, cardId, `${e('cross')} Бот временно не может резать фрагменты. Попробуй позже.`, [[BACK('m:home')]]);

  cardId = await card(chatId, cardId, `${e('loading')} <b>Собираю треки</b> · ${esc(itemName(item))}`, []);
  let pool;
  try { pool = await loadPool(item); } catch (err) {
    log.warn(`pool ${item.src}:${item.id}: ${err.message}`);
    return card(chatId, cardId, `${e('cross')} Не получилось загрузить треки. Попробуй позже.`, [[BACK('m:play')]]);
  }
  const distinct = new Set([...pool.tracks, ...pool.extra].map((t) => canon(baseTitle(t.title)))).size;
  const need = m.answer === 'poll' ? 4 : 3;
  if (pool.tracks.length < (m.answer === 'poll' ? 1 : need) || distinct < need) {
    return card(chatId, cardId, `${e('cross')} У «${esc(itemName(item))}» мало треков с превью — нужно хотя бы ${need}.`, [[BACK('m:play')]]);
  }
  const st = state(uid);
  Object.assign(st, { step: null, menuId: null, last: { mode, item, rounds } });
  const g = new Game({ uid, chatId, mode, item, pool, rounds, cardId });
  games.set(uid, g);
  log.info(`game ${g.id}: ${uid} · ${m.title} · ${g.title} · ${pool.tracks.length} tr.`);
  g.run();
  return cardId;
}

/* ═══════════════════════════ обработчики ═══════════════════════════ */

async function onMessage(msg) {
  if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const uid = msg.from.id; const chatId = msg.chat.id;
  touchUser(msg.from);
  const st = state(uid);
  const text = (msg.text || '').trim();
  const g = games.get(uid);

  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    const show = async (s) => { const m = await send(chatId, s.text, s.rows); st.menuId = m.message_id; };
    switch (cmd) {
      case 'start': st.step = null; st.mode = null; return show(homeScreen(uid));
      case 'play': st.step = null; return show(g ? busyScreen(g) : modesScreen());
      case 'profile': return show(profileScreen(uid));
      case 'top': return show(topScreen(uid));
      case 'help': return show(helpScreen());
      case 'stop': if (g) g.stop('stop'); else await send(chatId, `${e('info')} Сейчас нет активной игры.`); return;
      case 'admin': if (isAdmin(uid)) return show(adminScreen()); return;
      default: return;
    }
  }

  // Hardcore: ответ текстом
  if (g?.cur?.kind === 'text' && !g.cur.done) {
    if (text) g.answer({ type: 'text', text, at: now(), msgId: msg.message_id });
    return;
  }
  if (g) return; // в опросных раундах текст игнорируем

  if (st.step === 'bc_wait' && isAdmin(uid)) return broadcastPreview(msg, st);

  if (text) { // поиск: в выбранном режиме или «быстрый» с главного экрана
    const q = cut(text, 100);
    const mode = st.step === 'await_query' ? st.mode : null;
    if (!mode) st.mode = null;
    st.step = 'await_query';
    safe(tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }));
    const near = st.menuId && msg.message_id - st.menuId <= 2 ? st.menuId : null;
    st.menuId = await card(chatId, near, `${e('loading')} Ищу «${esc(cut(q, 40))}»…`, []);
    st.results = await search(q, mode ? MODES[mode].source : ['artist', 'album']);
    const s = resultsScreen(st, q);
    st.menuId = await card(chatId, st.menuId, s.text, s.rows);
  }
}

async function onCallback(cq) {
  const uid = cq.from.id; const chatId = cq.message?.chat?.id ?? uid; const msgId = cq.message?.message_id;
  touchUser(cq.from);
  const st = state(uid);
  let acked = false;
  const ack = (text, alert = false) => { if (acked) return null; acked = true; return safe(tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert })); };
  const show = async (s) => { await ack(); st.menuId = await card(chatId, msgId, s.text, s.rows); };
  const [a, b, c] = String(cq.data || '').split(':');

  try {
    switch (a) {
      case 'm': {
        if (b === 'new') { // из итогов игры — новое меню вниз чата
          await ack();
          safe(tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: kbd([]) }));
          st.step = null; const s = homeScreen(uid); st.menuId = (await send(chatId, s.text, s.rows)).message_id; return;
        }
        if (b === 'home') { st.step = null; st.mode = null; return show(homeScreen(uid)); }
        if (b === 'play') { st.step = null; st.mode = null; const g = games.get(uid); return show(g ? busyScreen(g) : modesScreen()); }
        if (b === 'profile') return show(profileScreen(uid));
        if (b === 'top') return show(topScreen(uid, c === 'streak' ? 'streak' : 'score'));
        if (b === 'help') return show(helpScreen());
        break;
      }
      case 'mode': {
        if (!MODES[b]) break;
        Object.assign(st, { step: 'await_query', mode: b, results: [] });
        return show(promptScreen(b));
      }
      case 'pick': {
        const item = st.results?.[Number(b)];
        if (!item) { await ack('Поиск устарел — повтори запрос'); return; }
        st.pick = item;
        if (!st.mode) return show(modesScreen(item));
        if (MODES[st.mode].endless) { await ack(); return startGame({ uid, chatId, cardId: msgId, mode: st.mode, item, rounds: 0 }); }
        return show(roundsScreen(st.mode, item));
      }
      case 'pm': {
        if (!MODES[b] || !st.pick) { await ack('Поиск устарел — повтори запрос'); return; }
        st.mode = b;
        if (MODES[b].endless) { await ack(); return startGame({ uid, chatId, cardId: msgId, mode: b, item: st.pick, rounds: 0 }); }
        return show(roundsScreen(b, st.pick));
      }
      case 'r': {
        if (!st.pick || !st.mode) { await ack('Поиск устарел — повтори запрос'); return; }
        await ack();
        return startGame({ uid, chatId, cardId: msgId, mode: st.mode, item: st.pick, rounds: Math.min(15, Math.max(1, Number(b) || 10)) });
      }
      case 'g': {
        const g = games.get(uid);
        if (b === 'again') {
          if (!st.last) { await ack('Начни игру из меню'); return; }
          await ack();
          safe(tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: kbd([]) }));
          return startGame({ uid, chatId, cardId: null, ...st.last });
        }
        if (!g) { await ack('Игра уже закончилась'); safe(tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: kbd([]) })); return; }
        if (b === 'stop') { g.stop('stop'); await ack('Игра остановлена'); return; }
        if (b === 'hint') {
          const cur = g.cur;
          if (!g.mode.hint || cur?.kind !== 'poll' || cur.done || cur.pollMsgId !== msgId) { await ack(); return; }
          if (cur.hint) { await ack(hintText(g), true); return; }
          cur.hint = true; await ack(hintText(g), true);
          await safe(tg('editMessageCaption', { chat_id: chatId, message_id: cur.audioId, caption: g.caption(cur), parse_mode: 'HTML' }));
          return;
        }
        if (b === 'more') {
          const cur = g.cur;
          if (!cur || cur.done || cur.busy || cur.level >= g.mode.maxLevel) { await ack(); return; }
          await ack(`Открываю ${LEVELS[cur.level + 1].label}`);
          await g.levelUp();
          return;
        }
        if (b === 'skip') {
          if (g.cur?.kind === 'text' && !g.cur.done) g.answer({ type: 'skip', at: now() });
          await ack(); return;
        }
        break;
      }
      case 'adm': {
        if (!isAdmin(uid)) { await ack('Нет доступа', true); return; }
        return onAdmin(cq, b, { chatId, msgId, st, ack, show });
      }
      default: break;
    }
  } finally {
    await ack();
  }
}

function onPollAnswer(pa) {
  const g = pollIndex.get(pa.poll_id);
  if (!g || g.uid !== pa.user?.id || g.cur?.pollId !== pa.poll_id || g.cur.done || !pa.option_ids?.length) return;
  g.answer({ type: 'answer', option: pa.option_ids[0], at: now() });
}

/* ═══════════════════════════ админка ═══════════════════════════ */

function adminScreen() {
  const s = Q.stats.get({ day: now() - 86400e3 }); const f = Q.filesStats.get(); const ids = Q.clipStats.get();
  const avg = PREP.done ? ` · ~${Math.round(PREP.totalMs / PREP.done)} мс/трек` : '';
  return {
    text: [
      `${e('settings')} <b>Админ-панель</b>`, '',
      `Пользователи: <b>${fmt(s.users)}</b> · за сутки ${fmt(s.users24)} · заблокировали ${fmt(s.blocked)}`,
      `Игры: <b>${fmt(s.games)}</b> · за сутки ${fmt(s.games24)} · сейчас ${games.size}`,
      `Фрагменты: готово ${fmt(PREP.done)} · ошибок ${fmt(PREP.failed)} · в работе ${PREP.active} · очередь ${PREP.queue.length}${avg}`,
      `Кэш: ${fmt(f.n)} треков · ${(f.bytes / 1048576).toFixed(0)} / ${fmt(CFG.cacheMaxMb)} МБ · в Telegram ${fmt(ids.n)}`,
      `Очки за уровни: ${LEVELS.map((L) => `${L.label} — ${L.pts}`).join(' · ')}`,
      PREP.broken ? `<b>Ошибка:</b> ${esc(PREP.broken)}` : null,
      PREP.errors.length ? `\n<b>Последние ошибки</b>\n<blockquote expandable>${PREP.errors.map((x) => `${mmss(now() - x.at)} назад · ${STAGES[x.stage] || x.stage}${x.title ? ` · «${esc(cut(x.title, 30))}»` : ''}\n${esc(x.message)}`).join('\n\n')}</blockquote>` : null,
      `Эмодзи-пак: ${PACK.loaded ? `${PACK.stickers.length} шт.` : 'не загружен'}`,
    ].filter((x) => x !== null).join('\n'),
    rows: [
      [B('Рассылка', 'adm:bc', 'megaphone')],
      [B('Эмодзи-пак', 'adm:emoji', 'media'), B('Очистить кэш', 'adm:cache', 'trash')],
      [B('Обновить', 'adm', 'loading')],
      [BACK('m:home')],
    ],
  };
}

async function onAdmin(cq, action, { chatId, msgId, st, ack, show }) {
  switch (action) {
    case undefined: case '': st.step = null; return show(adminScreen());
    case 'bc':
      st.step = 'bc_wait';
      return show({ text: `${e('megaphone')} <b>Рассылка</b>\nОтправь сообщение — текст, фото или видео. Перед отправкой покажу предпросмотр.`, rows: [[BACK('adm')]] });
    case 'bcgo': {
      if (!st.bc) { await ack('Нечего отправлять'); return; }
      const src = st.bc; st.bc = null; await ack('Рассылка запущена');
      runBroadcast(chatId, msgId, src).catch((err) => log.error(`broadcast: ${err.message}`));
      return;
    }
    case 'bcno': st.bc = null; st.step = null; return show(adminScreen());
    case 'emoji': {
      const lines = Object.entries(PACK_SLOTS).map(([k, [idx]]) => `${e(k)} ${k} · #${idx}${PACK.ids[k] ? '' : ' (запасной)'}`);
      return show({
        text: `${e('media')} <b>Эмодзи-пак</b> · <code>${esc(CFG.emojiPack)}</code>\n${PACK.loaded ? `${PACK.stickers.length} эмодзи` : 'не загружен — использую запасные ID'}\n\n${lines.join('\n')}`,
        rows: [[B('Показать весь пак', 'adm:emojiall', 'eye')], [BACK('adm')]],
      });
    }
    case 'emojiall': {
      await ack();
      if (!PACK.stickers.length) { await send(chatId, `${e('cross')} Пак не загружен.`); return; }
      const cells = PACK.stickers.map((s, i) => `<code>${String(i).padStart(3, ' ')}</code> <tg-emoji emoji-id="${s.custom_emoji_id}">${s.emoji || '•'}</tg-emoji>`);
      for (const part of chunk(chunk(cells, 5).map((r) => r.join('  ')), 8)) await send(chatId, part.join('\n'));
      return;
    }
    case 'cache':
      return show({ text: `${e('trash')} <b>Очистить кэш фрагментов на диске?</b>\nУже загруженные в Telegram останутся — они отправляются по file_id.`, rows: [[B('Очистить', 'adm:cachego', 'trash', 'danger')], [BACK('adm')]] });
    case 'cachego': {
      const busy = new Set(PREP.jobs.keys());
      let n = 0;
      for (const r of Q.filesAll.all()) { if (busy.has(r.track_key)) continue; fs.rmSync(clipDir(r.track_key), { recursive: true, force: true }); Q.filesDel.run(r.track_key); n++; }
      await ack(`Удалено: ${n}`);
      return show(adminScreen());
    }
    default: await ack(); return null;
  }
}

async function broadcastPreview(msg, st) {
  st.step = null;
  st.bc = { chatId: msg.chat.id, msgId: msg.message_id };
  const n = Q.audience.all().length;
  await send(msg.chat.id, `${e('megaphone')} Отправить это сообщение <b>${fmt(n)}</b> пользователям?`,
    [[B('Отправить', 'adm:bcgo', 'send', 'success')], [B('Отмена', 'adm:bcno', 'cross')]],
    { reply_parameters: { message_id: msg.message_id } });
}

async function runBroadcast(chatId, msgId, src) {
  const ids = Q.audience.all().map((r) => r.id);
  let ok = 0; let fail = 0; let lastEdit = 0;
  const status = (done) => `${e('megaphone')} <b>Рассылка${done ? ' завершена' : '…'}</b>\nДоставлено: ${fmt(ok)} · ошибок: ${fmt(fail)} · всего: ${fmt(ids.length)}`;
  await safe(card(chatId, msgId, status(false), []));
  for (const id of ids) {
    try { await tg('copyMessage', { chat_id: id, from_chat_id: src.chatId, message_id: src.msgId }, { retries: 2 }); ok++; } catch (err) {
      fail++;
      if (err.code === 403 || /chat not found|user is deactivated/i.test(err.message)) Q.setBlocked.run(id);
    }
    if (now() - lastEdit > 3000) { lastEdit = now(); await safe(card(chatId, msgId, status(false), [])); }
    await sleep(40);
  }
  await safe(card(chatId, msgId, status(true), [[BACK('adm')]]));
}

/* ═══════════════════════════ polling и запуск ═══════════════════════════ */

const chains = new Map();
function serial(uid, fn) {
  const next = (chains.get(uid) || Promise.resolve()).then(fn).catch((err) => log.error(`update ${uid}: ${err.stack || err.message}`));
  chains.set(uid, next);
  next.finally(() => { if (chains.get(uid) === next) chains.delete(uid); });
  return next;
}

function dispatch(u) {
  if (u.poll_answer) return onPollAnswer(u.poll_answer);
  const uid = u.message?.from?.id ?? u.callback_query?.from?.id;
  if (!uid) return null;
  return serial(uid, () => (u.message ? onMessage(u.message) : onCallback(u.callback_query)));
}

let stopping = false;
async function pollLoop() {
  let offset = 0;
  while (!stopping) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'poll_answer'] }, { retries: 0, timeout: 70e3 });
      for (const u of updates) { offset = u.update_id + 1; dispatch(u); }
    } catch (err) {
      if (stopping) break;
      log.warn(`getUpdates: ${err.message}${err.code === 409 ? ' — запущен второй экземпляр или webhook' : ''}`);
      await sleep(3000);
    }
  }
}

async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log.info(`${sig}: stopping…`);
  for (const g of games.values()) g.stop('stop');
  await sleep(1500);
  try { db?.close(); } catch { /* ok */ }
  process.exit(0);
}

async function main() {
  if (process.argv.includes('--init-db')) {
    initDb(); console.log(`SQLite готова: ${CFG.dbPath}`); db.close(); return;
  }
  if (!CFG.token) { console.error('BOT_TOKEN не задан (.env)'); process.exit(1); }
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
  fs.rmSync(DIRS.tmp, { recursive: true, force: true }); fs.mkdirSync(DIRS.tmp, { recursive: true });

  if (spawnSync('ffmpeg', ['-version']).error) { PREP.broken = 'ffmpeg не установлен'; log.error(PREP.broken); }
  for (const old of ['cache', 'models', 'separator_worker.py']) fs.rmSync(path.join(DATA_DIR, old), { recursive: true, force: true }); // от версии с нейросетью
  initDb();
  Q.abortStale.run(now());

  const me = await tg('getMe');
  log.info(`@${me.username} · id ${me.id} · админы: ${[...CFG.admins].join(', ') || '—'}`);
  await safe(tg('deleteWebhook', { drop_pending_updates: false }));
  await safe(tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Меню' },
      { command: 'play', description: 'Играть' },
      { command: 'profile', description: 'Профиль' },
      { command: 'top', description: 'Топ игроков' },
      { command: 'stop', description: 'Завершить игру' },
      { command: 'help', description: 'Как играть' },
    ],
  }));
  await loadEmojiPack();
  cleanCache();
  setInterval(() => { try { cleanCache(); } catch (err) { log.warn(`cache: ${err.message}`); } }, 30 * 60e3).unref();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('unhandled:', err?.stack || err));
  log.info(`polling · источник: ${ORDER.map((p) => p.src).join(' → ')} · очки: ${LEVELS.map((L) => L.pts).join('/')}`);
  await pollLoop();
}

if (require.main === module) {
  main().catch((err) => { log.error(err.stack || err.message); process.exit(1); });
} else {
  module.exports = {
    canon, baseTitle, checkAnswer, buildOptions, translit, similar, initDb, SCHEMA, CFG, DIRS, MODES, PREP, LEVELS, cutLevels,
    Game, games, pollIndex, onPollAnswer, homeScreen, modesScreen, profileScreen, topScreen, helpScreen, adminScreen, roundsScreen,
    resultsScreen, promptScreen, hintText, prepareTrack, get Q() { return Q; },
  };
}
