import 'dotenv/config';
import { Bot, InlineKeyboard, Keyboard, session } from 'grammy';
import { handleAgentText } from './agent.js';
import db, {
  getOrCreatePlayerByTelegram,
  listOtherPlayers,
  getPlayerByTelegram,
  getPlayerById,
  upsertPlayerRating,
  createMatchPending,
  setMatchStatus,
} from './db.js';
import { makePlayer, updateTwoPlayers, scoreToOutcome } from './rating.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set in environment');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Export bot instance for use in server.js
export { bot };

// simple in-memory session (per chat)
bot.use(session({ initial: () => ({ step: null, opponentTgId: null }) }));

// Level selection config
// const LEVEL_DOC_LINK = 'https://docs.google.com/spreadsheets/d/1HO6hpO5zOoJgUpUcZefDZudXeZ-dPLDCF_LORwltFVo/htmlview#';
const INITIAL_BY_LEVEL = {
  Beginner: { rating: 1200, rd: 300 },
  C: { rating: 1500, rd: 200 },
  B: { rating: 1800, rd: 100 },
};

function buildLevelKeyboard() {
  return new InlineKeyboard()
    .text('Beginner', 'level:Beginner')
    .text('C', 'level:C')
    .row()
    .text('B', 'level:B');
}

// First-time user gate: ask for level and set initial rating/RD
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  // Allow level selection callbacks to pass through
  const isLevelSelectionCb = Boolean(ctx.callbackQuery?.data?.startsWith('level:'));

  const existing = getPlayerByTelegram(ctx.from.id);
  const notExists = !existing;
  const looksUninitialized =
    !!existing &&
    existing.rating === 1500 &&
    existing.rd === 350 &&
    existing.vol === 0.06 &&
    existing.created_at === existing.updated_at;

  if (notExists || looksUninitialized) {
    if (notExists) {
      // Create a placeholder record with DB defaults; will be overwritten after level selection
      getOrCreatePlayerByTelegram(ctx.from);
    }

    if (!isLevelSelectionCb) {
      if (ctx.session.step !== 'await_level') {
        ctx.session.step = 'await_level';
        await ctx.reply(
          `Выберите ваш уровень: Beginner, C или B.`,
          { reply_markup: buildLevelKeyboard() },
        );
      } else if (ctx.message?.text) {
        await ctx.reply('Пожалуйста, выберите уровень кнопками выше.');
      }
      return; // Block other handlers until level is chosen
    }
  }

  await next();
});

// Persistent reply keyboard
const mainKeyboard = new Keyboard()
  .text('Зарегистрировать игру')
  .row()
  .text('Рейтинг')
  .text('Таблица')
  .row()
  .text('Помощь')
  .resized();

// Opponents list & pagination
const OPPONENTS_PER_PAGE = 10;
function formatOpponentButtonTitle(p) {
  const parts = [];
  if (p.first_name) parts.push(p.first_name);
  if (p.last_name) parts.push(p.last_name);
  if (p.username) parts.push('@' + p.username);
  const title = parts.join(' ').trim();
  return title || `ID ${p.telegram_id}`;
}

function buildOpponentsKeyboard(players, page, pageCbPrefix = 'opponents:page') {
  const totalPages = Math.max(1, Math.ceil(players.length / OPPONENTS_PER_PAGE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * OPPONENTS_PER_PAGE;
  const slice = players.slice(start, start + OPPONENTS_PER_PAGE);

  const kb = new InlineKeyboard();
  for (const p of slice) kb.text(formatOpponentButtonTitle(p), `opponent:${p.telegram_id}`).row();

  if (totalPages > 1) {
    const prevPage = (safePage - 1 + totalPages) % totalPages;
    const nextPage = (safePage + 1) % totalPages;
    kb.text('◀️', `${pageCbPrefix}:${prevPage}`)
      .text(`${safePage + 1}/${totalPages}`, 'noop')
      .text('▶️', `${pageCbPrefix}:${nextPage}`);
  }
  return kb;
}

async function sendOpponentsPage(ctx, page = 0, edit = false) {
  const others = listOtherPlayers(ctx.from.id);
  if (others.length === 0) return ctx.reply('Нет доступных соперников. Позовите друзей зарегистрироваться /start');
  const kb = buildOpponentsKeyboard(others, page);
  if (edit) return ctx.editMessageText('Выберите соперника:', { reply_markup: kb });
  return ctx.reply('Выберите соперника:', { reply_markup: kb });
}

bot.callbackQuery(/^opponents:page:(\d+)$/, async (ctx) => {
  const page = Number(ctx.match[1]);
  try {
    await sendOpponentsPage(ctx, page, true);
  } catch (e) {
    // If message text can't be edited (older message), send a new one
    await sendOpponentsPage(ctx, page, false);
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^noop$/, async (ctx) => ctx.answerCallbackQuery());

// Opponent selection mode (list vs search)
function buildOpponentModeKeyboard() {
  return new InlineKeyboard().text('Показать список', 'opponents:mode:list').text('Поиск', 'opponents:mode:search');
}

async function askOpponentSelectionMode(ctx, edit = false) {
  const kb = buildOpponentModeKeyboard();
  const text = 'Как выбрать соперника?';
  if (edit) return ctx.editMessageText(text, { reply_markup: kb });
  return ctx.reply(text, { reply_markup: kb });
}

bot.callbackQuery(/^opponents:mode:list$/, async (ctx) => {
  try {
    await sendOpponentsPage(ctx, 0, true);
  } catch {
    await sendOpponentsPage(ctx, 0, false);
  }
  ctx.session.step = null;
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^opponents:mode:search$/, async (ctx) => {
  ctx.session.step = 'await_opponent_search';
  ctx.session.opponentSearchQ = '';
  await ctx.editMessageText('Введите имя/фамилию/ник соперника для поиска');
  await ctx.answerCallbackQuery();
});

function normalize(s) { return String(s || '').toLowerCase(); }
function filterPlayersByQuery(players, q) {
  const qn = normalize(q).replace(/^@/, '');
  if (!qn) return [];
  return players.filter((p) => [p.username, p.first_name, p.last_name].map(normalize).some((v) => v.includes(qn)));
}

async function sendSearchResultsPage(ctx, page = 0, edit = false) {
  const all = listOtherPlayers(ctx.from.id);
  const q = ctx.session.opponentSearchQ || '';
  const results = filterPlayersByQuery(all, q);
  if (results.length === 0) {
    return edit
      ? ctx.editMessageText('Ничего не найдено. Введите другой запрос')
      : ctx.reply('Ничего не найдено. Введите другой запрос');
  }
  const kb = buildOpponentsKeyboard(results, page, 'opponents:search:page');
  const text = `Результаты поиска: ${q}`;
  if (edit) return ctx.editMessageText(text, { reply_markup: kb });
  return ctx.reply(text, { reply_markup: kb });
}

bot.callbackQuery(/^opponents:search:page:(\d+)$/, async (ctx) => {
  const page = Number(ctx.match[1]);
  try {
    await sendSearchResultsPage(ctx, page, true);
  } catch {
    await sendSearchResultsPage(ctx, page, false);
  }
  await ctx.answerCallbackQuery();
});

// Handle level selection
bot.callbackQuery(/^level:(Beginner|C|B)$/, async (ctx) => {
  const level = ctx.match[1];
  const init = INITIAL_BY_LEVEL[level];
  const me = getOrCreatePlayerByTelegram(ctx.from);

  upsertPlayerRating(me.id, { rating: init.rating, rd: init.rd, vol: me.vol });
  ctx.session.step = null;

  try {
    await ctx.editMessageText(`Уровень выбран: ${level}. Стартовый рейтинг ${init.rating} (RD ${init.rd}).`);
  } catch {}

  await ctx.answerCallbackQuery({ text: `Выбран ${level}` });
  await ctx.reply(
    `Готово. Вы зарегистрированы. Текущий рейтинг: ${init.rating.toFixed(2)} (RD ${init.rd.toFixed(1)})`,
    { reply_markup: mainKeyboard },
  );
});

// Set commands visible in Telegram menu (ASCII-only as per Telegram rules)
bot.api
  .setMyCommands([
    { command: 'start', description: 'Регистрация' },
    { command: 'register', description: 'Начать регистрацию игры' },
    { command: 'rating', description: 'Показать ваш рейтинг' },
    { command: 'leaders', description: 'Топ игроков' },
    { command: 'help', description: 'Помощь' },
    { command: 'menu', description: 'Показать кнопки' },
  ])
  .catch(console.error);

// Commands help
bot.command('help', async (ctx) => {
  return ctx.reply(
    'Команды:\n/start — регистрация\n/register — нач. регистрацию игры\n/rating — ваш рейтинг\n/leaders — топ игроков\n\nИли используйте кнопки ниже.',
    { reply_markup: mainKeyboard },
  );
});

// Register user on first contact
bot.command(['start', 'старт'], async (ctx) => {
  const player = getOrCreatePlayerByTelegram(ctx.from);
  await ctx.reply(
    `Готово. Вы зарегистрированы. Текущий рейтинг: ${player.rating.toFixed(2)} (RD ${player.rd.toFixed(
      1,
    )})`,
    { reply_markup: mainKeyboard },
  );
});

// Show menu (keyboard) explicitly
bot.command(['menu', 'меню'], async (ctx) => {
  await ctx.reply('Выберите действие:', { reply_markup: mainKeyboard });
});

// Show rating
bot.command(['rating', 'рейтинг'], async (ctx) => {
  const player = getPlayerByTelegram(ctx.from.id);
  if (!player) return ctx.reply('Вы не зарегистрированы. Нажмите /start');
  return ctx.reply(
    `Ваш рейтинг: ${player.rating.toFixed(2)} (RD ${player.rd.toFixed(1)}, vol ${player.vol.toFixed(3)})`,
  );
});

// Plain text rating trigger
bot.hears(/^рейтинг$/i, async (ctx) => {
  const player = getPlayerByTelegram(ctx.from.id);
  if (!player) return ctx.reply('Вы не зарегистрированы. Нажмите /start');
  return ctx.reply(
    `Ваш рейтинг: ${player.rating.toFixed(2)} (RD ${player.rd.toFixed(1)}, vol ${player.vol.toFixed(3)})`,
  );
});

// Plain text help trigger
bot.hears(/^помощь$/i, async (ctx) => {
  return ctx.reply(
    'Команды:\n/start — регистрация\n/register — нач. регистрацию игры\n/rating — ваш рейтинг\n/таблица — топ игроков\n\nИли используйте кнопки ниже.',
    { reply_markup: mainKeyboard },
  );
});

// Start register game flow
bot.command(['register', 'Зарегистрировать_игру', 'register_game', 'зарегистрировать_игру', 'Зарегестрировать_игру', 'зарегестрировать_игру'], async (ctx) => {
  getOrCreatePlayerByTelegram(ctx.from);
  await askOpponentSelectionMode(ctx, false);
});

// Plain text triggers without slash
bot.hears(/^(зарегистрировать игру|зарегистрировать_игру|зарегестрировать игру|зарегестрировать_игру)$/i, async (ctx) => {
  getOrCreatePlayerByTelegram(ctx.from);
  await askOpponentSelectionMode(ctx, false);
});

// Leaderboard
bot.command(['leaders', 'leaderboard', 'таблица', 'топ'], async (ctx) => {
  const top = db
    .prepare('SELECT username, first_name, last_name, telegram_id, rating, rd FROM players ORDER BY rating DESC, id ASC LIMIT 10')
    .all();
  if (top.length === 0) return ctx.reply('Пока нет игроков. Нажмите /start');
  const lines = top.map((p, i) => `${i + 1}. ${formatOpponentButtonTitle(p)} ${p.rating.toFixed(1)} (RD ${p.rd.toFixed(0)})`);
  return ctx.reply('Топ игроков:\n' + lines.join('\n'));
});

// Leaderboard plain text triggers
bot.hears(/^(таблица|топ)$/i, async (ctx) => {
  const top = db
    .prepare('SELECT username, first_name, last_name, telegram_id, rating, rd FROM players ORDER BY rating DESC, id ASC LIMIT 10')
    .all();
  if (top.length === 0) return ctx.reply('Пока нет игроков. Нажмите /start');
  const lines = top.map((p, i) => `${i + 1}. ${formatOpponentButtonTitle(p)} ${p.rating.toFixed(1)} (RD ${p.rd.toFixed(0)})`);
  return ctx.reply('Топ игроков:\n' + lines.join('\n'));
});

// Mini App open
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:3000/app';
bot.command(['app', 'приложение'], async (ctx) => {
  const kb = new InlineKeyboard().webApp('Открыть мини‑приложение', WEB_APP_URL);
  await ctx.reply('Откройте мини‑приложение:', { reply_markup: kb });
});

bot.callbackQuery(/^opponent:(\d+)$/, async (ctx) => {
  const opponentTgId = Number(ctx.match[1]);
  const opponent = getPlayerByTelegram(opponentTgId);
  if (!opponent) return ctx.answerCallbackQuery({ text: 'Соперник не найден', show_alert: true });

  ctx.session.opponentTgId = opponentTgId;
  ctx.session.step = 'await_score';
  await ctx.editMessageText(`Соперник: ${opponent.username || opponent.telegram_id}. Введите счёт в формате 3:1 (первая цифра — ваша).`);
});

// Parse a score like 1:2
const parseScore = (text) => {
  const m = text.trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!m) return null;
  return { a: Number(m[1]), b: Number(m[2]) };
};

bot.on('message:text', async (ctx) => {
  // Search flow: capture query and show results
  if (ctx.session.step === 'await_opponent_search') {
    const q = (ctx.message.text || '').trim();
    ctx.session.opponentSearchQ = q;
    await sendSearchResultsPage(ctx, 0, false);
    return;
  }

  // If we're awaiting score, handle score; otherwise route to AI agent
  if (ctx.session.step === 'await_score' && ctx.session.opponentTgId) {
    const parsed = parseScore(ctx.message.text);
    if (!parsed) return ctx.reply('Неверный формат. Пример: 2:1');

    const me = getPlayerByTelegram(ctx.from.id);
    const opponent = getPlayerByTelegram(ctx.session.opponentTgId);
    if (!me || !opponent) return ctx.reply('Игрок не найден');

    const created = createMatchPending({
      authorPlayerId: me.id,
      opponentPlayerId: opponent.id,
      authorScore: parsed.a,
      opponentScore: parsed.b,
    });

    ctx.session.step = null;
    ctx.session.opponentTgId = null;

    await ctx.reply('Заявка отправлена сопернику. Ожидаем подтверждения.');

    const kb = new InlineKeyboard()
      .text('Подтвердить', `confirm:${created.id}`)
      .text('Отклонить', `reject:${created.id}`);

    await ctx.api.sendMessage(
      opponent.telegram_id,
      `Игрок ${me.username || me.telegram_id} зарегистрировал игру со счётом ${created.author_score}:${created.opponent_score}. Подтвердить?`,
      { reply_markup: kb },
    );
    return;
  }

  // AI agent fallback for free text
  await handleAgentText(ctx, ctx.message.text);
});

// Confirm / Reject
bot.callbackQuery(/^confirm:(\d+)$/, async (ctx) => {
  const matchId = Number(ctx.match[1]);
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!row) return ctx.answerCallbackQuery({ text: 'Игра не найдена', show_alert: true });
  if (row.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Игра уже обработана' });

  // Only opponent can confirm
  const actingPlayer = getPlayerByTelegram(ctx.from.id);
  if (!actingPlayer || actingPlayer.id !== row.opponent_player_id)
    return ctx.answerCallbackQuery({ text: 'Только соперник может подтвердить', show_alert: true });

  // Calculate outcome for author
  const author = getPlayerById(row.author_player_id);
  const opponent = getPlayerById(row.opponent_player_id);
  const authorP = makePlayer({ rating: author.rating, rd: author.rd, vol: author.vol });
  const opponentP = makePlayer({ rating: opponent.rating, rd: opponent.rd, vol: opponent.vol });
  const scoreA = scoreToOutcome(row.author_score, row.opponent_score);
  const updated = updateTwoPlayers(authorP, opponentP, scoreA);

  // persist
  upsertPlayerRating(author.id, updated.a);
  upsertPlayerRating(opponent.id, updated.b);
  setMatchStatus(matchId, 'confirmed');

  await ctx.editMessageText('Игра подтверждена ✅ Рейтинги обновлены.');

  const notify = async (p, delta) =>
    ctx.api.sendMessage(
      p.telegram_id,
      `Игра подтверждена. Новый рейтинг: ${delta.rating.toFixed(2)} (RD ${delta.rd.toFixed(1)})`,
    );
  await notify(author, updated.a);
  await notify(opponent, updated.b);
});

bot.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
  const matchId = Number(ctx.match[1]);
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!row) return ctx.answerCallbackQuery({ text: 'Игра не найдена', show_alert: true });
  if (row.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Игра уже обработана' });

  const actingPlayer = getPlayerByTelegram(ctx.from.id);
  if (!actingPlayer || actingPlayer.id !== row.opponent_player_id)
    return ctx.answerCallbackQuery({ text: 'Только соперник может отклонить', show_alert: true });

  setMatchStatus(matchId, 'rejected');
  await ctx.editMessageText('Игра отклонена ❌');

  const author = getPlayerById(row.author_player_id);
  await ctx.api.sendMessage(author.telegram_id, 'Соперник отклонил вашу игру.');
});

// Graceful start
bot.start();

console.log('Bot started');

// Global error handler for bot
bot.catch((err) => {
  console.error('Bot error:', err);
});


