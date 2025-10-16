import Database from 'better-sqlite3';

const db = new Database('./squash.db');

db.pragma('journal_mode = WAL');

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  rating REAL NOT NULL DEFAULT 1500,
  rd REAL NOT NULL DEFAULT 350,
  vol REAL NOT NULL DEFAULT 0.06,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_player_id INTEGER NOT NULL,
  opponent_player_id INTEGER NOT NULL,
  author_score INTEGER NOT NULL,
  opponent_score INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(author_player_id) REFERENCES players(id),
  FOREIGN KEY(opponent_player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_players_telegram_id ON players(telegram_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
`);

// helpers
export const getOrCreatePlayerByTelegram = (tgUser) => {
  const existing = db.prepare('SELECT * FROM players WHERE telegram_id = ?').get(tgUser.id);
  if (existing) return existing;

  const info = db
    .prepare(
      `INSERT INTO players (telegram_id, username, first_name, last_name)
       VALUES (@id, @username, @first_name, @last_name)`
    )
    .run({
      id: tgUser.id,
      username: tgUser.username ?? null,
      first_name: tgUser.first_name ?? null,
      last_name: tgUser.last_name ?? null,
    });
  return db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
};

export const listOtherPlayers = (telegramId) => {
  return db
    .prepare('SELECT * FROM players WHERE telegram_id != ? ORDER BY rating DESC, id ASC')
    .all(telegramId);
};

export const getPlayerByTelegram = (telegramId) => {
  return db.prepare('SELECT * FROM players WHERE telegram_id = ?').get(telegramId);
};

export const getPlayerById = (id) => db.prepare('SELECT * FROM players WHERE id = ?').get(id);

export const upsertPlayerRating = (playerId, { rating, rd, vol }) => {
  db.prepare(
    `UPDATE players
     SET rating = ?, rd = ?, vol = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(rating, rd, vol, playerId);
};

export const createMatchPending = ({ authorPlayerId, opponentPlayerId, authorScore, opponentScore }) => {
  const stmt = db.prepare(
    `INSERT INTO matches (author_player_id, opponent_player_id, author_score, opponent_score, status)
     VALUES (?, ?, ?, ?, 'pending')`
  );
  const info = stmt.run(authorPlayerId, opponentPlayerId, authorScore, opponentScore);
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(info.lastInsertRowid);
};

export const getPendingMatchBetween = (authorPlayerId, opponentPlayerId) => {
  return db
    .prepare(
      `SELECT * FROM matches
       WHERE author_player_id = ? AND opponent_player_id = ? AND status = 'pending'
       ORDER BY id DESC LIMIT 1`
    )
    .get(authorPlayerId, opponentPlayerId);
};

export const setMatchStatus = (matchId, status) => {
  db.prepare(`UPDATE matches SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, matchId);
};

export default db;


