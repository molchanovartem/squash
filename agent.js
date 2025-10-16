import { generateText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { InlineKeyboard } from 'grammy';

import db, {
  getPlayerByTelegram,
  getOrCreatePlayerByTelegram,
  listOtherPlayers,
} from './db.js';

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? createOpenAI({ apiKey }) : null;
const model = openai ? openai('gpt-4o-mini') : null;

function formatOpponentTitle(p) {
  return `${p.username ? '@' + p.username : 'ID ' + p.telegram_id} · ${Math.round(p.rating)}`;
}

export async function handleAgentText(ctx, text) {
  // Lightweight fallback if no LLM key provided
  if (!model) {
    const t = text.toLowerCase();
    if (/(мой\s+)?рейтинг/.test(t)) {
      const player = getPlayerByTelegram(ctx.from.id) || getOrCreatePlayerByTelegram(ctx.from);
      await ctx.reply(`Ваш рейтинг: ${player.rating.toFixed(2)} (RD ${player.rd.toFixed(1)})`);
      return;
    }
    if (/таблица|топ/.test(t)) {
      const top = db
        .prepare('SELECT username, telegram_id, rating, rd FROM players ORDER BY rating DESC, id ASC LIMIT 10')
        .all();
      if (top.length === 0) return void ctx.reply('Пока нет игроков. Нажмите /start');
      const lines = top.map(
        (p, i) => `${i + 1}. ${(p.username ? '@' + p.username : 'ID ' + p.telegram_id).padEnd(18)} ${p.rating.toFixed(1)} (RD ${p.rd.toFixed(0)})`,
      );
      await ctx.reply('Топ игроков:\n' + lines.join('\n'));
      return;
    }
    if (/зарегистриру(й|йте)|зарегистрировать\s+игру|игру\s+зарегистриру/.test(t)) {
      const players = listOtherPlayers(ctx.from.id);
      if (players.length === 0) return void ctx.reply('Нет доступных соперников. Позовите друзей зарегистрироваться /start');
      const kb = new InlineKeyboard();
      for (const p of players) kb.text(formatOpponentTitle(p), `opponent:${p.telegram_id}`).row();
      await ctx.reply('Выберите соперника:', { reply_markup: kb });
      return;
    }
    await ctx.reply('Я помогаю по сквошу: могу зарегистрировать игру, показать рейтинг и таблицу.');
    return;
  }
  const tools = {
    show_rating: tool({
      description: 'Показать рейтинг текущего пользователя.',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        const player = getPlayerByTelegram(ctx.from.id) || getOrCreatePlayerByTelegram(ctx.from);
        await ctx.reply(`Ваш рейтинг: ${player.rating.toFixed(2)} (RD ${player.rd.toFixed(1)})`);
        return { ok: true };
      },
    }),
    list_opponents: tool({
      description: 'Показать список соперников для выбора.',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        const players = listOtherPlayers(ctx.from.id);
        if (players.length === 0) {
          await ctx.reply('Нет доступных соперников. Позовите друзей зарегистрироваться /start');
          return { players: [] };
        }
        const kb = new InlineKeyboard();
        for (const p of players) kb.text(formatOpponentTitle(p), `opponent:${p.telegram_id}`).row();
        await ctx.reply('Выберите соперника:', { reply_markup: kb });
        return { players: players.map((p) => ({ telegram_id: p.telegram_id, rating: p.rating })) };
      },
    }),
    start_register_game: tool({
      description: 'Начать регистрацию игры: показать список соперников и ждать счёт после выбора.',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        const me = getOrCreatePlayerByTelegram(ctx.from);
        const players = listOtherPlayers(ctx.from.id);
        if (players.length === 0) {
          await ctx.reply('Нет доступных соперников. Позовите друзей зарегистрироваться /start');
          return { ok: false };
        }
        const kb = new InlineKeyboard();
        for (const p of players) kb.text(formatOpponentTitle(p), `opponent:${p.telegram_id}`).row();
        await ctx.reply('Выберите соперника:', { reply_markup: kb });
        return { ok: true };
      },
    }),
    show_leaders: tool({
      description: 'Показать таблицу лидеров (топ-10).',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        const top = db
          .prepare('SELECT username, telegram_id, rating, rd FROM players ORDER BY rating DESC, id ASC LIMIT 10')
          .all();
        if (top.length === 0) {
          await ctx.reply('Пока нет игроков. Нажмите /start');
          return { leaders: [] };
        }
        const lines = top.map(
          (p, i) => `${i + 1}. ${(p.username ? '@' + p.username : 'ID ' + p.telegram_id).padEnd(18)} ${p.rating.toFixed(1)} (RD ${p.rd.toFixed(0)})`,
        );
        await ctx.reply('Топ игроков:\n' + lines.join('\n'));
        return { leaders: top };
      },
    }),
    help: tool({
      description: 'Показать помощь и доступные действия.',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        await ctx.reply('Я могу: зарегистрировать игру, показать рейтинг и таблицу. Скажите: «зарегистрируй игру», «мой рейтинг», «таблица».');
        return { ok: true };
      },
    }),
  };

  const system = [
    'Ты — Telegram-агент русскоязычного бота для сквоша. Всегда пиши кратко.',
    'Если запрос о действиях (зарегистрируй игру, покажи рейтинг, таблица), используй соответствующие инструменты.',
    'Отвечай на вопросы про сквош (правила, тактика, ракетки, тренировки).',
    'Если вопрос не про сквош и не про функции бота — вежливо скажи, что ты помогаешь по сквошу и функциям бота.',
  ].join('\n');

  const { text: answer } = await generateText({ model, system, prompt: text, tools });
  if (answer && answer.trim().length > 0) {
    await ctx.reply(answer.trim());
  }
}


