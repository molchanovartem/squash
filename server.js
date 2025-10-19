import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { InlineKeyboard } from 'grammy';

import db, {
  getOrCreatePlayerByTelegram,
  getPlayerByTelegram,
  listOtherPlayers,
  getPlayerById,
  upsertPlayerRating,
  createMatchPending,
  setMatchStatus,
} from './db.js';
import { makePlayer, scoreToOutcome, updateTwoPlayers } from './rating.js';
import { bot } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Static assets for mini app
app.use('/app', express.static(path.join(__dirname, 'webapp')));

// Verification per Telegram docs: HMAC-SHA256 with secret_key = sha256("WebAppData", bot_token)
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}
const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();

function verifyInitData(initData) {
  // initData as URLSearchParams string from Telegram WebApp
  const url = new URLSearchParams(initData);
  const hash = url.get('hash');
  if (!hash) return false;
  url.delete('hash');
  const dataCheckString = Array.from(url.entries())
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return hmac === hash;
}

function getTelegramUser(initData) {
  const params = new URLSearchParams(initData);
  const userJson = params.get('user');
  if (!userJson) return null;
  try { return JSON.parse(userJson); } catch { return null; }
}

// Auth middleware
function requireTgAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.query.initData || req.body.initData;
  if (!initData || !verifyInitData(initData)) return res.status(401).json({ error: 'unauthorized' });
  const tgUser = getTelegramUser(initData);
  if (!tgUser) return res.status(401).json({ error: 'no_user' });
  req.tgUser = tgUser;
  next();
}

// API routes
app.get('/api/me', requireTgAuth, (req, res) => {
  const player = getOrCreatePlayerByTelegram(req.tgUser);
  res.json({ player });
});

app.get('/api/players', requireTgAuth, (req, res) => {
  const players = listOtherPlayers(req.tgUser.id);
  res.json({ players });
});

app.get('/api/leaders', requireTgAuth, (req, res) => {
  const top = db
    .prepare(
      'SELECT username, first_name, last_name, telegram_id, rating, rd FROM players ORDER BY rating DESC, id ASC LIMIT 20'
    )
    .all();
  res.json({ leaders: top });
});

app.post('/api/matches', requireTgAuth, async (req, res) => {
  const { opponentTelegramId, score } = req.body;
  const me = getOrCreatePlayerByTelegram(req.tgUser);
  const opponent = getPlayerByTelegram(opponentTelegramId);
  if (!opponent) return res.status(400).json({ error: 'opponent_not_found' });
  const m = String(score).match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!m) return res.status(400).json({ error: 'bad_score' });
  const created = createMatchPending({
    authorPlayerId: me.id,
    opponentPlayerId: opponent.id,
    authorScore: Number(m[1]),
    opponentScore: Number(m[2]),
  });

  // Send notification to opponent in Telegram
  const kb = new InlineKeyboard()
    .text('Подтвердить', `confirm:${created.id}`)
    .text('Отклонить', `reject:${created.id}`);

  try {
    await bot.api.sendMessage(
      opponent.telegram_id,
      `Игрок ${me.username || me.telegram_id} зарегистрировал игру со счётом ${created.author_score}:${created.opponent_score}. Подтвердить?`,
      { reply_markup: kb },
    );
  } catch (err) {
    console.error('Failed to send notification to opponent:', err);
  }

  res.json({ match: created });
});

// Confirmation from opponent via API (optional)
app.post('/api/matches/:id/confirm', requireTgAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const acting = getOrCreatePlayerByTelegram(req.tgUser);
  if (acting.id !== row.opponent_player_id) return res.status(403).json({ error: 'forbidden' });

  const author = getPlayerById(row.author_player_id);
  const opponent = getPlayerById(row.opponent_player_id);
  const authorP = makePlayer({ rating: author.rating, rd: author.rd, vol: author.vol });
  const opponentP = makePlayer({ rating: opponent.rating, rd: opponent.rd, vol: opponent.vol });
  const scoreA = scoreToOutcome(row.author_score, row.opponent_score);
  const updated = updateTwoPlayers(authorP, opponentP, scoreA);
  upsertPlayerRating(author.id, updated.a);
  upsertPlayerRating(opponent.id, updated.b);
  setMatchStatus(id, 'confirmed');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mini App server listening on http://localhost:${PORT}`));


