import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { Bot, type Context, InlineKeyboard, InputFile, Keyboard, webhookCallback } from 'grammy';
import {
  claimFirstSuperadmin,
  createOrRefreshOperatorRequest,
  grantOperatorFromRequest,
  getTelegramAdminByUserId,
  listTelegramAdmins,
  listTelegramOperatorRequests,
  revokeOperator,
  type TelegramAdminRole,
} from './telegram-admins';
import {
  getTelegramEventById,
  getTelegramEventBySlug,
  listTelegramEvents,
  setTelegramEventRegistrationState,
  type TelegramEventListFilter,
  type TelegramEventView,
} from './telegram-events';
import {
  buildRegistrationsXlsxBuffer,
  buildEventXlsxBuffer,
  formatMaskedEventReport,
  listAllRegistrationsForExport,
  listRegistrationsForEvent,
} from './registration-exports';
import { cleanupTestRun, createSqliteBackup } from './admin-maintenance';
import { formatAdminDiagnostics } from './admin-diagnostics';
import { searchRegistrationsByFullName } from './registration-search';
import {
  buildSpecialDrawXlsxBuffer,
  formatSpecialDrawResult,
  formatSpecialEventPanel,
  formatSpecialEventsPanel,
  formatSpecialShowingApplicants,
  formatSpecialShowingPanel,
  getLatestSpecialDrawResult,
  getSpecialEventForTelegram,
  getSpecialShowingForTelegram,
  listSpecialApplicationPhotos,
  listSpecialEventsForTelegram,
  runSpecialDraw,
  type SpecialDrawResult,
} from './special-draws';
import {
  formatSpecialWinnerVkNotificationSummary,
  sendSpecialDrawWinnerVkMessages,
} from './special-winner-vk-notifications';
import type { StoragePublisher } from '../lib/storage';

type TelegramBotDeps = {
  db: Database.Database;
  token: string;
  webhookSecret: string;
  appBaseUrl: string;
  webhookPath: string;
  privateKeyPemBase64: string | null;
  vkAuthToken: string | null;
  storagePublisher: StoragePublisher;
  syncPublicStateManifest: (reason: string) => Promise<boolean>;
  skipWebhook?: boolean;
};

const EVENTS_PER_PAGE = 6;

function formatDisplayName(from: {
  first_name?: string;
  last_name?: string;
  username?: string;
}) {
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (fullName) {
    return fullName;
  }

  return from.username ? `@${from.username}` : null;
}

function buildMainKeyboard(role: TelegramAdminRole) {
  const keyboard = new Keyboard()
    .text('События')
    .text('Спецмероприятия')
    .text('Поиск')
    .text('Экспорт')
    .row();

  if (role === 'superadmin') {
    keyboard.text('Открыть регистрацию').text('Закрыть регистрацию').text('Операторы').row();
    keyboard.text('Диагностика').row();
  }

  keyboard.text('Помощь').resized();
  return keyboard;
}

function formatHelp(role: TelegramAdminRole) {
  const lines = [
    'Доступные команды:',
    '/start — открыть главное меню.',
    '/help — показать список команд.',
    '',
    'Кнопки:',
    'События — список событий и карточки событий.',
    'Спецмероприятия — розыгрыши спецпоказов, XLSX и фото для сверки.',
    'Поиск — поиск регистрации по ФИО.',
  ];

  if (role === 'superadmin') {
    lines.push('/operators — список администраторов.');
    lines.push('/registration_open <slug> — открыть регистрацию на событие.');
    lines.push('/registration_close <slug> — закрыть регистрацию на событие.');
    lines.push('/export_all — общий XLSX по всем событиям.');
    lines.push('/spec — спецмероприятия, черновой и опубликованный розыгрыш.');
    lines.push('/health — диагностика очередей OCR/LLM и Telegram outbox.');
    lines.push('/backup_sqlite — резервная копия SQLite.');
    lines.push('/cleanup_test_run <run_id> — удалить тестовые регистрации конкретного прогона.');
    lines.push('');
    lines.push('Открыть регистрацию — список будущих событий, доступных для открытия.');
    lines.push('Закрыть регистрацию — список открытых событий.');
    lines.push('Операторы — текущие роли и состав администраторов.');
    lines.push('Экспорт — сводный XLSX и резервная копия.');
  }

  return lines.join('\n');
}

async function applyRegistrationStateFromCommand(
  ctx: Context,
  db: Database.Database,
  telegramUserId: string,
  commandText: string,
  commandName: 'registration_open' | 'registration_close',
  syncPublicStateManifest: (reason: string) => Promise<boolean>,
) {
  const admin = getTelegramAdminByUserId(db, telegramUserId);
  if (!admin || admin.role !== 'superadmin') {
    await ctx.reply('Менять статус регистрации может только суперадмин.');
    return;
  }

  const slug = commandText.replace(new RegExp(`^/${commandName}(?:@\\w+)?`, 'u'), '').trim();
  if (!slug) {
    await ctx.reply(`Укажите slug события: /${commandName} <slug>`, {
      reply_markup: buildMainKeyboard(admin.role),
    });
    return;
  }

  const event = getTelegramEventBySlug(db, slug);
  if (!event) {
    await ctx.reply('Событие с таким slug не найдено.', {
      reply_markup: buildMainKeyboard(admin.role),
    });
    return;
  }

  const nextState = commandName === 'registration_open' ? 'open' : 'closed';
  const updated = setTelegramEventRegistrationState(db, event.id, nextState);
  if (!updated) {
    await ctx.reply('Не удалось обновить статус регистрации.', {
      reply_markup: buildMainKeyboard(admin.role),
    });
    return;
  }

  const manifestUpdated = await syncPublicStateManifest(`${commandName}:${updated.slug}`);

  await ctx.reply(
    `${commandName === 'registration_open' ? 'Регистрация открыта' : 'Регистрация закрыта'} для события «${updated.title}».`,
    {
      reply_markup: buildMainKeyboard(admin.role),
    },
  );

  if (!manifestUpdated) {
    await ctx.reply('Состояние в базе обновлено, но не удалось сразу обновить публичный state-file для сайта.');
  }
}

function formatEventDate(isoValue: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Kaliningrad',
  }).format(new Date(isoValue));
}

function eventStateLabel(event: TelegramEventView) {
  switch (event.publicState) {
    case 'registration_open':
      return 'Открыта';
    case 'registration_closed':
      return 'Закрыта';
    case 'registration_soon':
      return 'Скоро откроется';
    case 'sold_out':
      return 'Мест нет';
    case 'past':
      return 'Событие прошло';
    default:
      return 'Неизвестно';
  }
}

function truncateLabel(value: string, maxLength = 42) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatEventCard(event: TelegramEventView) {
  return [
    event.title,
    '',
    `Статус: ${eventStateLabel(event)}`,
    `Дата и время: ${formatEventDate(event.startsAt)}`,
    `Площадка: ${event.venueName}`,
    `Зал: ${event.hallName}`,
    `Адрес: ${event.address}`,
    `Вместимость зала: ${event.capacity}`,
    `Квота регистрации: ${event.registrationLimit} (${event.registrationLimitPercent}%)`,
    `Занято регистраций: ${event.seatsTaken} из ${event.registrationLimit}`,
    `Осталось регистрационных мест: ${event.seatsLeft}`,
  ].join('\n');
}

function formatSearchResults(results: ReturnType<typeof searchRegistrationsByFullName>) {
  return results.map((item, index) => [
    `${index + 1}. ${item.fullName}`,
    `Событие: ${item.eventTitle}`,
    `Дата: ${formatEventDate(item.startsAt)}`,
    `Email: ${item.emailMasked}`,
    `Телефон: ${item.phoneMasked}`,
    item.ticketUrl ? `Билет: ${item.ticketUrl}` : 'Билет: будет доступен после публикации',
  ].join('\n')).join('\n\n');
}

function formatOperatorsPanel(
  admins: ReturnType<typeof listTelegramAdmins>,
  requests: ReturnType<typeof listTelegramOperatorRequests>,
) {
  const adminLines = admins.length
    ? admins.map((item, index) => `${index + 1}. ${item.displayName ?? item.telegramUserId} — ${item.role}`).join('\n')
    : 'Администраторы пока не назначены.';

  const requestLines = requests.length
    ? requests.map((item, index) => `${index + 1}. ${item.displayName ?? item.telegramUserId}`).join('\n')
    : 'Нет ожидающих запросов.';

  return [
    'Операторы и доступы',
    '',
    'Текущие администраторы:',
    adminLines,
    '',
    'Ожидающие запросы:',
    requestLines,
    '',
    'Новые пользователи могут нажать /start, после чего их запрос появится здесь.',
  ].join('\n');
}

function listHeading(filter: TelegramEventListFilter) {
  if (filter === 'open') {
    return 'Открытые регистрации';
  }

  if (filter === 'closed') {
    return 'События, где можно открыть регистрацию';
  }

  return 'События фестиваля';
}

function buildListKeyboard(items: TelegramEventView[], filter: TelegramEventListFilter, page: number) {
  const keyboard = new InlineKeyboard();

  for (const item of items) {
    keyboard.text(truncateLabel(item.title), `e:${item.id}:${filter}:${page}`).row();
  }

  if (page > 1) {
    keyboard.text('‹ Назад', `l:${filter}:${page - 1}`);
  }

  if (items.length === EVENTS_PER_PAGE) {
    keyboard.text('Дальше ›', `l:${filter}:${page + 1}`);
  }

  return keyboard;
}

function buildEventKeyboard(event: TelegramEventView, role: TelegramAdminRole, filter: TelegramEventListFilter, page: number) {
  const keyboard = new InlineKeyboard();

  if (role === 'superadmin') {
    if (event.publicState === 'registration_open') {
      keyboard.text('Закрыть регистрацию', `s:${event.id}:c:${filter}:${page}`).row();
    } else if (event.publicState !== 'past' && event.publicState !== 'sold_out') {
      keyboard.text('Открыть регистрацию', `s:${event.id}:o:${filter}:${page}`).row();
    }
  }

  keyboard.text('Остаток мест', `m:${event.id}:${filter}:${page}`);
  keyboard.text('Отчёт', `r:${event.id}:${filter}:${page}`);
  keyboard.text('XLSX', `x:${event.id}:${filter}:${page}`).row();
  keyboard.text('Назад к списку', `l:${filter}:${page}`);
  return keyboard;
}

function buildOperatorsKeyboard(
  admins: ReturnType<typeof listTelegramAdmins>,
  requests: ReturnType<typeof listTelegramOperatorRequests>,
) {
  const keyboard = new InlineKeyboard();

  for (const request of requests.slice(0, 8)) {
    keyboard.text(`Выдать: ${truncateLabel(request.displayName ?? request.telegramUserId, 24)}`, `oga:${request.id}`).row();
  }

  for (const admin of admins.filter((item) => item.role === 'operator').slice(0, 8)) {
    keyboard.text(`Снять: ${truncateLabel(admin.displayName ?? admin.telegramUserId, 24)}`, `ord:${admin.id}`).row();
  }

  return keyboard;
}

function buildExportKeyboard() {
  return new InlineKeyboard()
    .text('Сводный XLSX', 'exp:all').row()
    .text('SQLite backup', 'exp:backup');
}

function buildSpecialEventsKeyboard(items: ReturnType<typeof listSpecialEventsForTelegram>) {
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    keyboard.text(truncateLabel(item.event.title), `spe:${item.event.id}`).row();
  }
  keyboard.text('Диагностика', 'sphl').row();
  return keyboard;
}

function buildSpecialEventKeyboard(item: NonNullable<ReturnType<typeof getSpecialEventForTelegram>>) {
  const keyboard = new InlineKeyboard();
  for (const showing of item.showings) {
    keyboard.text(truncateLabel(showing.display_label), `sps:${showing.id}`).row();
  }
  keyboard.text('Назад к спецмероприятиям', 'spl');
  return keyboard;
}

function buildSpecialShowingKeyboard(
  eventId: number,
  showingId: number,
  role: TelegramAdminRole,
  latestPublished: SpecialDrawResult | null,
) {
  const keyboard = new InlineKeyboard();

  if (role === 'superadmin') {
    keyboard.text('Черновой розыгрыш', `spd:${showingId}`);
    keyboard.text('Опубликовать розыгрыш', `spp:${showingId}`).row();
  }

  keyboard.text('Заявители', `spa:${showingId}`).row();

  if (latestPublished) {
    keyboard.text('XLSX победителей', `spx:${showingId}`).row();
    if (role === 'superadmin') {
      keyboard.text('VK победителям', `spv:${showingId}`).row();
    }
    for (const winner of latestPublished.winners.slice(0, 10)) {
      keyboard.text(`Фото: ${truncateLabel(winner.fullName, 28)}`, `sph:${winner.applicationId}`).row();
    }
  }

  keyboard.text('Назад к спецмероприятию', `spe:${eventId}`);
  keyboard.text('К списку', 'spl');
  return keyboard;
}

function safeXlsxName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '') || 'special-draw';
}

function safePhotoFileName(value: string, fallback: string) {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '') || fallback;
}

function paginate<T>(items: T[], page: number, perPage: number) {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

async function sendEventList(
  ctx: Context,
  db: Database.Database,
  _role: TelegramAdminRole,
  filter: TelegramEventListFilter,
  page: number,
  editCurrentMessage = false,
) {
  const allItems = listTelegramEvents(db, filter);
  const items = paginate(allItems, page, EVENTS_PER_PAGE);
  const text = items.length
    ? `${listHeading(filter)}\n\nВыберите событие ниже.`
    : `${listHeading(filter)}\n\nСейчас подходящих событий нет.`;
  const keyboard = items.length ? buildListKeyboard(items, filter, page) : undefined;

  if (editCurrentMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
    });
    return;
  }

  await ctx.reply(text, {
    reply_markup: keyboard,
  });
}

async function sendEventCard(
  ctx: Context,
  db: Database.Database,
  role: TelegramAdminRole,
  eventId: number,
  filter: TelegramEventListFilter,
  page: number,
) {
  const event = getTelegramEventById(db, eventId);
  if (!event) {
    await ctx.answerCallbackQuery({
      text: 'Событие не найдено.',
      show_alert: true,
    });
    return;
  }

  await ctx.editMessageText(formatEventCard(event), {
    reply_markup: buildEventKeyboard(event, role, filter, page),
  });
}

async function sendOperatorsPanel(
  ctx: Context,
  db: Database.Database,
  editCurrentMessage = false,
) {
  const admins = listTelegramAdmins(db);
  const requests = listTelegramOperatorRequests(db);
  const text = formatOperatorsPanel(admins, requests);
  const keyboard = buildOperatorsKeyboard(admins, requests);
  const replyMarkup = keyboard.inline_keyboard.length ? keyboard : undefined;

  if (editCurrentMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      reply_markup: replyMarkup,
    });
    return;
  }

  await ctx.reply(text, {
    reply_markup: replyMarkup,
  });
}

async function sendSpecialEventsPanel(
  ctx: Context,
  db: Database.Database,
  editCurrentMessage = false,
) {
  const items = listSpecialEventsForTelegram(db);
  const text = formatSpecialEventsPanel(items);
  const keyboard = items.length ? buildSpecialEventsKeyboard(items) : undefined;

  if (editCurrentMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
    });
    return;
  }

  await ctx.reply(text, {
    reply_markup: keyboard,
  });
}

async function sendSpecialEventPanel(
  ctx: Context,
  db: Database.Database,
  eventId: number,
  editCurrentMessage = false,
) {
  const item = getSpecialEventForTelegram(db, eventId);
  if (!item) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: 'Спецмероприятие не найдено.',
        show_alert: true,
      });
      return;
    }

    await ctx.reply('Спецмероприятие не найдено.');
    return;
  }

  const text = formatSpecialEventPanel(item);
  const keyboard = buildSpecialEventKeyboard(item);

  if (editCurrentMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
    });
    return;
  }

  await ctx.reply(text, {
    reply_markup: keyboard,
  });
}

async function sendSpecialShowingPanel(
  ctx: Context,
  db: Database.Database,
  role: TelegramAdminRole,
  showingId: number,
  privateKeyPemBase64: string | null,
  editCurrentMessage = false,
) {
  const item = getSpecialShowingForTelegram(db, showingId, privateKeyPemBase64);
  if (!item) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: 'Показ не найден.',
        show_alert: true,
      });
      return;
    }

    await ctx.reply('Показ не найден.');
    return;
  }

  const latestPublished = privateKeyPemBase64
    ? getLatestSpecialDrawResult(db, showingId, 'published', privateKeyPemBase64)
    : null;
  const keyboard = buildSpecialShowingKeyboard(item.event.id, showingId, role, latestPublished);
  const text = formatSpecialShowingPanel(item);

  if (editCurrentMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
    });
    return;
  }

  await ctx.reply(text, {
    reply_markup: keyboard,
  });
}

export function registerTelegramBot(app: FastifyInstance, deps: TelegramBotDeps) {
  const bot = new Bot(deps.token);
  const pendingFindPrompts = new Map<string, number>();

  const requireAdminRole = (telegramUserId: string) => getTelegramAdminByUserId(deps.db, telegramUserId);

  bot.catch((error) => {
    app.log.error({ err: error.error }, 'telegram_bot_error');
  });

  bot.command('start', async (ctx) => {
    const telegramUserId = String(ctx.from?.id ?? '');
    if (!telegramUserId) {
      return;
    }

    const claimed = claimFirstSuperadmin(deps.db, {
      telegramUserId,
      displayName: formatDisplayName(ctx.from ?? {}),
    });

    const admin = claimed ?? requireAdminRole(telegramUserId);
    if (!admin) {
      createOrRefreshOperatorRequest(deps.db, {
        telegramUserId,
        displayName: formatDisplayName(ctx.from ?? {}),
      });

      await ctx.reply(
        'Суперадмин уже назначен. Я отправил запрос на операторский доступ. Когда суперадмин подтвердит его, снова нажмите /start.',
      );
      return;
    }

    const greeting = claimed
      ? 'Вы стали суперадмином бота. Ниже доступна кнопочная навигация.'
      : 'Главное меню открыто. Используйте кнопки ниже.';

    await ctx.reply(greeting, {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  bot.command('help', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.reply('Доступ к боту ограничен администраторами.');
      return;
    }

    await ctx.reply(formatHelp(admin.role), {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  bot.command('events', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.reply('Доступ к боту ограничен администраторами.');
      return;
    }

    await sendEventList(ctx, deps.db, admin.role, 'all', 1);
  });

  bot.command('spec', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.reply('Доступ к боту ограничен администраторами.');
      return;
    }

    await sendSpecialEventsPanel(ctx, deps.db);
  });

  bot.command('health', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.reply('Диагностика доступна только суперадмину.');
      return;
    }

    await ctx.reply(formatAdminDiagnostics(deps.db), {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  bot.command('registration_open', async (ctx) => {
    await applyRegistrationStateFromCommand(
      ctx,
      deps.db,
      String(ctx.from?.id ?? ''),
      ctx.message?.text ?? '',
      'registration_open',
      deps.syncPublicStateManifest,
    );
  });

  bot.command('registration_close', async (ctx) => {
    await applyRegistrationStateFromCommand(
      ctx,
      deps.db,
      String(ctx.from?.id ?? ''),
      ctx.message?.text ?? '',
      'registration_close',
      deps.syncPublicStateManifest,
    );
  });

  bot.command('find', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.reply('Доступ к боту ограничен администраторами.');
      return;
    }

    if (!deps.privateKeyPemBase64) {
      await ctx.reply('Поиск пока недоступен: на сервере не настроен приватный ключ для расшифровки ПДн.');
      return;
    }

    const commandText = ctx.message?.text ?? '';
    const query = commandText.replace(/^\/find(@\w+)?/u, '').trim();

    if (!query) {
      pendingFindPrompts.set(String(ctx.from?.id ?? ''), Date.now());
      await ctx.reply('Пришлите ФИО следующим сообщением, и я покажу последние совпадения.', {
        reply_markup: buildMainKeyboard(admin.role),
      });
      return;
    }

    const results = searchRegistrationsByFullName(deps.db, deps.privateKeyPemBase64, query);
    if (!results.length) {
      await ctx.reply('Совпадений не найдено.', {
        reply_markup: buildMainKeyboard(admin.role),
      });
      return;
    }

    await ctx.reply(formatSearchResults(results), {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  bot.command('export_all', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.reply('Общий экспорт доступен только суперадмину.');
      return;
    }

    if (!deps.privateKeyPemBase64) {
      await ctx.reply('Нужен приватный ключ, чтобы подготовить общий экспорт.');
      return;
    }

    const rows = listAllRegistrationsForExport(deps.db, deps.privateKeyPemBase64);
    const buffer = await buildRegistrationsXlsxBuffer(rows);
    await ctx.replyWithDocument(
      new InputFile(buffer, 'registrations-all.xlsx'),
      {
        caption: 'Сводный XLSX по всем событиям.',
      },
    );
  });

  bot.command('backup_sqlite', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.reply('Резервная копия базы доступна только суперадмину.');
      return;
    }

    const buffer = await createSqliteBackup(deps.db, 'registration-backup');
    await ctx.replyWithDocument(
      new InputFile(buffer, 'registration-backup.sqlite'),
      {
        caption: 'Резервная копия SQLite.',
      },
    );
  });

  bot.command('cleanup_test_run', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.reply('Очистка тестовых прогонов доступна только суперадмину.');
      return;
    }

    const commandText = ctx.message?.text ?? '';
    const runId = commandText.replace(/^\/cleanup_test_run(@\w+)?/u, '').trim();
    if (!runId) {
      await ctx.reply('Укажите run_id: /cleanup_test_run <run_id>');
      return;
    }

    const result = await cleanupTestRun(deps.db, {
      testRunId: runId,
      storagePublisher: deps.storagePublisher,
    });

    if (!result.removedRegistrations) {
      await ctx.reply('Для этого run_id тестовых регистраций не найдено.');
      return;
    }

    const manifestUpdated = await deps.syncPublicStateManifest(`cleanup:${runId}`);

    if (result.artifactDeleteFailures) {
      app.log.warn({
        testRunId: runId,
        failedArtifactHashes: result.failedArtifactHashes,
      }, 'cleanup_test_run_partial_storage_delete_failure');

      await ctx.reply(
        `Тестовый прогон очищен в БД. Удалено регистраций: ${result.removedRegistrations}. `
        + `Затронуто событий: ${result.affectedEvents}. `
        + `Но не удалось удалить ${result.artifactDeleteFailures} ticket artifacts из storage. `
        + 'Проверьте права DeleteObject/DeleteObjects на tickets/*.'
        + `${manifestUpdated ? '' : ' Публичный state-file для сайта тоже не обновился автоматически.'}`,
      );
      return;
    }

    await ctx.reply(
      `Тестовый прогон очищен. Удалено регистраций: ${result.removedRegistrations}. Затронуто событий: ${result.affectedEvents}.`
      + `${manifestUpdated ? '' : ' Но публичный state-file для сайта пока не обновился автоматически.'}`,
    );
  });

  bot.command('operators', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.reply('Доступ к боту ограничен администраторами.');
      return;
    }

    if (admin.role !== 'superadmin') {
      await ctx.reply('Список операторов доступен только суперадмину.', {
        reply_markup: buildMainKeyboard(admin.role),
      });
      return;
    }

    await sendOperatorsPanel(ctx, deps.db);
  });

  bot.hears('События', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      return;
    }

    await sendEventList(ctx, deps.db, admin.role, 'all', 1);
  });

  bot.hears('Спецмероприятия', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      return;
    }

    await sendSpecialEventsPanel(ctx, deps.db);
  });

  bot.hears('Диагностика', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      return;
    }

    await ctx.reply(formatAdminDiagnostics(deps.db), {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  bot.hears('Открыть регистрацию', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      return;
    }

    await sendEventList(ctx, deps.db, admin.role, 'closed', 1);
  });

  bot.hears('Закрыть регистрацию', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      return;
    }

    await sendEventList(ctx, deps.db, admin.role, 'open', 1);
  });

  bot.hears('Помощь', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      return;
    }

    await ctx.reply(formatHelp(admin.role), {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  bot.hears(['Поиск', 'Экспорт'], async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      return;
    }

    if (ctx.message?.text === 'Поиск') {
      if (!deps.privateKeyPemBase64) {
        await ctx.reply('Поиск пока недоступен: на сервере не настроен приватный ключ.', {
          reply_markup: buildMainKeyboard(admin.role),
        });
        return;
      }

      pendingFindPrompts.set(String(ctx.from?.id ?? ''), Date.now());
      await ctx.reply('Пришлите ФИО следующим сообщением. Я покажу до 10 последних совпадений.', {
        reply_markup: buildMainKeyboard(admin.role),
      });
      return;
    }

    if (admin.role !== 'superadmin') {
      await ctx.reply('Для оператора доступны event-level выгрузки внутри карточек событий. Откройте раздел «События» и выберите нужное событие.', {
        reply_markup: buildMainKeyboard(admin.role),
      });
      await sendEventList(ctx, deps.db, admin.role, 'all', 1);
      return;
    }

    await ctx.reply('Экспорт и резервное копирование:', {
      reply_markup: buildExportKeyboard(),
    });
  });

  bot.callbackQuery(/^exp:(all|backup)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.answerCallbackQuery({
        text: 'Раздел экспорта доступен только суперадмину.',
        show_alert: true,
      });
      return;
    }

    const [, action] = ctx.match;

    if (action === 'all') {
      if (!deps.privateKeyPemBase64) {
        await ctx.answerCallbackQuery({
          text: 'Нужен приватный ключ, чтобы подготовить общий экспорт.',
          show_alert: true,
        });
        return;
      }

      const rows = listAllRegistrationsForExport(deps.db, deps.privateKeyPemBase64);
      await ctx.answerCallbackQuery({
        text: rows.length ? 'Готовлю сводный XLSX.' : 'Регистраций пока нет.',
      });

      const buffer = await buildRegistrationsXlsxBuffer(rows);
      await ctx.replyWithDocument(
        new InputFile(buffer, 'registrations-all.xlsx'),
        {
          caption: 'Сводный XLSX по всем событиям.',
          reply_markup: buildMainKeyboard(admin.role),
        },
      );
      return;
    }

    await ctx.answerCallbackQuery({
      text: 'Готовлю резервную копию SQLite.',
    });

    const buffer = await createSqliteBackup(deps.db, 'registration-backup');
    await ctx.replyWithDocument(
      new InputFile(buffer, 'registration-backup.sqlite'),
      {
        caption: 'Резервная копия SQLite.',
        reply_markup: buildMainKeyboard(admin.role),
      },
    );
  });

  bot.callbackQuery(/^spl$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await sendSpecialEventsPanel(ctx, deps.db, true);
  });

  bot.callbackQuery(/^sphl$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: 'Проверяю очереди.',
    });
    await ctx.reply(formatAdminDiagnostics(deps.db), {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  bot.callbackQuery(/^spe:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    const [, eventIdRaw] = ctx.match;
    await ctx.answerCallbackQuery();
    await sendSpecialEventPanel(ctx, deps.db, Number(eventIdRaw), true);
  });

  bot.callbackQuery(/^sps:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    const [, showingIdRaw] = ctx.match;
    await ctx.answerCallbackQuery();
    await sendSpecialShowingPanel(ctx, deps.db, admin.role, Number(showingIdRaw), deps.privateKeyPemBase64, true);
  });

  bot.callbackQuery(/^spa:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    if (!deps.privateKeyPemBase64) {
      await ctx.answerCallbackQuery({
        text: 'Нужен приватный ключ, чтобы показать ФИО заявителей.',
        show_alert: true,
      });
      return;
    }

    const [, showingIdRaw] = ctx.match;
    const showingId = Number(showingIdRaw);
    const item = getSpecialShowingForTelegram(deps.db, showingId, deps.privateKeyPemBase64);
    if (!item) {
      await ctx.answerCallbackQuery({
        text: 'Показ не найден.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: 'Показываю заявителей.',
    });
    await ctx.reply(formatSpecialShowingApplicants(item));
  });

  bot.callbackQuery(/^(spd|spp):(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.answerCallbackQuery({
        text: 'Розыгрыш может запускать только суперадмин.',
        show_alert: true,
      });
      return;
    }

    if (!deps.privateKeyPemBase64) {
      await ctx.answerCallbackQuery({
        text: 'Нужен приватный ключ, чтобы подготовить розыгрыш.',
        show_alert: true,
      });
      return;
    }

    const [, action, showingIdRaw] = ctx.match;
    const runType = action === 'spd' ? 'draft' : 'published';
    const showingId = Number(showingIdRaw);
    await ctx.answerCallbackQuery({
      text: runType === 'draft' ? 'Считаю черновой розыгрыш.' : 'Публикую розыгрыш.',
    });

    try {
      const result = runSpecialDraw(deps.db, showingId, runType, deps.privateKeyPemBase64);
      await ctx.reply(formatSpecialDrawResult(result));

      if (runType === 'published') {
        const vkNotificationSummary = await sendSpecialDrawWinnerVkMessages({
          db: deps.db,
          result,
          vkToken: deps.vkAuthToken,
          logger: app.log,
        });
        await ctx.reply(formatSpecialWinnerVkNotificationSummary(vkNotificationSummary));

        const buffer = await buildSpecialDrawXlsxBuffer(result);
        await ctx.replyWithDocument(
          new InputFile(buffer, `${safeXlsxName(result.event.slug)}-${safeXlsxName(result.showing.slug)}-winners.xlsx`),
          {
            caption: `XLSX победителей: ${result.event.title}, ${result.showing.display_label}`,
          },
        );
      }

      await sendSpecialShowingPanel(ctx, deps.db, admin.role, showingId, deps.privateKeyPemBase64);
    } catch (error) {
      app.log.error({ err: error, showingId, runType }, 'special_draw_failed');
      await ctx.reply('Не удалось выполнить розыгрыш. Ошибка записана в лог сервера.');
    }
  });

  bot.callbackQuery(/^spx:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    if (!deps.privateKeyPemBase64) {
      await ctx.answerCallbackQuery({
        text: 'Нужен приватный ключ, чтобы подготовить XLSX.',
        show_alert: true,
      });
      return;
    }

    const [, showingIdRaw] = ctx.match;
    const showingId = Number(showingIdRaw);
    const result = getLatestSpecialDrawResult(deps.db, showingId, 'published', deps.privateKeyPemBase64);
    if (!result) {
      await ctx.answerCallbackQuery({
        text: 'Опубликованного результата пока нет.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: 'Готовлю XLSX победителей.',
    });
    const buffer = await buildSpecialDrawXlsxBuffer(result);
    await ctx.replyWithDocument(
      new InputFile(buffer, `${safeXlsxName(result.event.slug)}-${safeXlsxName(result.showing.slug)}-winners.xlsx`),
      {
        caption: `XLSX победителей: ${result.event.title}, ${result.showing.display_label}`,
      },
    );
  });

  bot.callbackQuery(/^spv:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.answerCallbackQuery({
        text: 'VK-уведомления может запускать только суперадмин.',
        show_alert: true,
      });
      return;
    }

    if (!deps.privateKeyPemBase64) {
      await ctx.answerCallbackQuery({
        text: 'Нужен приватный ключ, чтобы прочитать опубликованный розыгрыш.',
        show_alert: true,
      });
      return;
    }

    const [, showingIdRaw] = ctx.match;
    const showingId = Number(showingIdRaw);
    const result = getLatestSpecialDrawResult(deps.db, showingId, 'published', deps.privateKeyPemBase64);
    if (!result) {
      await ctx.answerCallbackQuery({
        text: 'Опубликованного результата пока нет.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: 'Отправляю VK-сообщения победителям.',
    });
    const chatId = ctx.chat?.id;
    await ctx.reply('Запустил повторную отправку VK-сообщений по опубликованному розыгрышу. Уже отправленные сообщения не дублируются.');

    setImmediate(() => {
      void (async () => {
        const vkNotificationSummary = await sendSpecialDrawWinnerVkMessages({
          db: deps.db,
          result,
          vkToken: deps.vkAuthToken,
          logger: app.log,
        });
        if (chatId) {
          await bot.api.sendMessage(chatId, formatSpecialWinnerVkNotificationSummary(vkNotificationSummary));
        }
      })().catch((error) => {
        app.log.error({ err: error, showingId }, 'special_winner_vk_resend_failed');
        if (chatId) {
          void bot.api.sendMessage(chatId, 'Не удалось завершить повторную отправку VK-сообщений победителям. Ошибка записана в лог сервера.').catch((sendError: unknown) => {
            app.log.error({ err: sendError, showingId }, 'special_winner_vk_resend_failure_report_failed');
          });
        }
      });
    });
  });

  bot.callbackQuery(/^sph:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    const [, applicationIdRaw] = ctx.match;
    const applicationId = Number(applicationIdRaw);
    const photos = listSpecialApplicationPhotos(deps.db, applicationId);
    if (!photos.length) {
      await ctx.answerCallbackQuery({
        text: 'Фото для этой заявки не найдены.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: `Отправляю фото: ${photos.length}`,
    });

    for (const [index, photo] of photos.entries()) {
      try {
        const buffer = await deps.storagePublisher.readPrivateAsset(photo.storage_key);
        const fileName = safePhotoFileName(photo.original_filename, `special-photo-${applicationId}-${index + 1}`);
        await ctx.replyWithDocument(
          new InputFile(buffer, fileName),
          {
            caption: [
              `Фото ${index + 1} из ${photos.length}`,
              `Заявка ID: ${applicationId}`,
              `Штампы на фото: ${photo.stamp_count}`,
              `Зачтено: ${photo.accepted ? 'да' : 'нет'}`,
              photo.duplicate_of_sha256 ? 'Точный дубль: да' : null,
            ].filter(Boolean).join('\n'),
          },
        );
      } catch (error) {
        app.log.error({ err: error, applicationId, storageKey: photo.storage_key }, 'special_photo_send_failed');
        await ctx.reply(`Не удалось отправить фото ${index + 1}: ошибка чтения private storage.`);
      }
    }
  });

  bot.hears('Операторы', async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      return;
    }

    if (admin.role !== 'superadmin') {
      await ctx.reply('Раздел операторов доступен только суперадмину.', {
        reply_markup: buildMainKeyboard(admin.role),
      });
      return;
    }

    await sendOperatorsPanel(ctx, deps.db);
  });

  bot.callbackQuery(/^l:(all|open|closed):(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    const [, filter, pageRaw] = ctx.match;
    await ctx.answerCallbackQuery();
    await sendEventList(ctx, deps.db, admin.role, filter as TelegramEventListFilter, Number(pageRaw), true);
  });

  bot.callbackQuery(/^e:(\d+):(all|open|closed):(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    const [, eventIdRaw, filter, pageRaw] = ctx.match;
    await ctx.answerCallbackQuery();
    await sendEventCard(ctx, deps.db, admin.role, Number(eventIdRaw), filter as TelegramEventListFilter, Number(pageRaw));
  });

  bot.callbackQuery(/^s:(\d+):(o|c):(all|open|closed):(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.answerCallbackQuery({
        text: 'Только суперадмин может менять статус регистрации.',
        show_alert: true,
      });
      return;
    }

    const [, eventIdRaw, action, filter, pageRaw] = ctx.match;
    const nextState = action === 'o' ? 'open' : 'closed';
    const updated = setTelegramEventRegistrationState(deps.db, Number(eventIdRaw), nextState);
    const manifestUpdated = updated
      ? await deps.syncPublicStateManifest(`inline:${updated.slug}:${action}`)
      : false;

    await ctx.answerCallbackQuery({
      text: updated
        ? `${action === 'o' ? 'Регистрация открыта.' : 'Регистрация закрыта.'}${manifestUpdated ? '' : ' State-file не обновился.'}`
        : 'Событие не найдено.',
    });

    if (!updated) {
      return;
    }

    await ctx.editMessageText(formatEventCard(updated), {
      reply_markup: buildEventKeyboard(updated, admin.role, filter as TelegramEventListFilter, Number(pageRaw)),
    });
  });

  bot.callbackQuery(/^m:(\d+):(all|open|closed):(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    const [, eventIdRaw] = ctx.match;
    const event = getTelegramEventById(deps.db, Number(eventIdRaw));
    await ctx.answerCallbackQuery({
      text: event
        ? `Осталось регистрационных мест: ${event.seatsLeft} из ${event.registrationLimit}`
        : 'Событие не найдено.',
      show_alert: true,
    });
  });

  bot.callbackQuery(/^(r|x):(\d+):(all|open|closed):(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await ctx.answerCallbackQuery({
        text: 'Недостаточно прав.',
        show_alert: true,
      });
      return;
    }

    if (!deps.privateKeyPemBase64) {
      await ctx.answerCallbackQuery({
        text: 'Нужен приватный ключ, чтобы подготовить отчёт.',
        show_alert: true,
      });
      return;
    }

    const [, action, eventIdRaw] = ctx.match;
    const event = getTelegramEventById(deps.db, Number(eventIdRaw));

    if (!event) {
      await ctx.answerCallbackQuery({
        text: 'Событие не найдено.',
        show_alert: true,
      });
      return;
    }

    const rows = listRegistrationsForEvent(deps.db, deps.privateKeyPemBase64, event.id);

    if (action === 'r') {
      await ctx.answerCallbackQuery({
        text: rows.length ? 'Готовлю masked preview.' : 'Для этого события пока нет регистраций.',
      });

      await ctx.reply(formatMaskedEventReport(event, rows));
      return;
    }

    await ctx.answerCallbackQuery({
      text: rows.length ? 'Готовлю XLSX.' : 'Для этого события пока нет регистраций.',
    });

    if (!rows.length) {
      return;
    }

    const buffer = await buildEventXlsxBuffer(rows);
    await ctx.replyWithDocument(
      new InputFile(buffer, `registrations-${event.slug}.xlsx`),
      {
        caption: `XLSX по событию «${event.title}»`,
      },
    );
  });

  bot.callbackQuery(/^oga:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.answerCallbackQuery({
        text: 'Только суперадмин может назначать операторов.',
        show_alert: true,
      });
      return;
    }

    const [, requestIdRaw] = ctx.match;
    const granted = grantOperatorFromRequest(deps.db, Number(requestIdRaw));
    await ctx.answerCallbackQuery({
      text: granted ? 'Оператор назначен.' : 'Запрос уже не актуален.',
    });

    if (granted) {
      try {
        await bot.api.sendMessage(granted.telegramUserId, 'Операторский доступ выдан. Нажмите /start, чтобы открыть меню.');
      } catch (error) {
        app.log.warn({ err: error }, 'telegram_operator_grant_notify_failed');
      }
    }

    await sendOperatorsPanel(ctx, deps.db, true);
  });

  bot.callbackQuery(/^ord:(\d+)$/u, async (ctx) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin || admin.role !== 'superadmin') {
      await ctx.answerCallbackQuery({
        text: 'Только суперадмин может отзывать операторов.',
        show_alert: true,
      });
      return;
    }

    const [, adminIdRaw] = ctx.match;
    const revoked = revokeOperator(deps.db, Number(adminIdRaw));
    await ctx.answerCallbackQuery({
      text: revoked ? 'Операторский доступ отозван.' : 'Снять можно только роль оператора.',
    });

    if (revoked) {
      try {
        await bot.api.sendMessage(revoked.telegramUserId, 'Операторский доступ отозван. Если это ошибка, попросите суперадмина выдать его снова.');
      } catch (error) {
        app.log.warn({ err: error }, 'telegram_operator_revoke_notify_failed');
      }
    }

    await sendOperatorsPanel(ctx, deps.db, true);
  });

  bot.on('message:text', async (ctx, next) => {
    const admin = requireAdminRole(String(ctx.from?.id ?? ''));
    if (!admin) {
      await next();
      return;
    }

    const userId = String(ctx.from?.id ?? '');
    const pendingAt = pendingFindPrompts.get(userId);
    const text = ctx.message.text.trim();
    const reservedLabels = new Set([
      'События',
      'Спецмероприятия',
      'Поиск',
      'Экспорт',
      'Открыть регистрацию',
      'Закрыть регистрацию',
      'Операторы',
      'Диагностика',
      'Помощь',
    ]);

    if (!pendingAt || !deps.privateKeyPemBase64 || text.startsWith('/') || reservedLabels.has(text)) {
      await next();
      return;
    }

    pendingFindPrompts.delete(userId);
    const results = searchRegistrationsByFullName(deps.db, deps.privateKeyPemBase64, text);
    if (!results.length) {
      await ctx.reply('Совпадений не найдено.', {
        reply_markup: buildMainKeyboard(admin.role),
      });
      return;
    }

    await ctx.reply(formatSearchResults(results), {
      reply_markup: buildMainKeyboard(admin.role),
    });
  });

  if (!deps.skipWebhook) {
    const webhookHandler = webhookCallback(bot, 'fastify');

    app.post(deps.webhookPath, async (request, reply) => {
      const secret = request.headers['x-telegram-bot-api-secret-token'];
      if (secret !== deps.webhookSecret) {
        reply.code(401);
        return {
          error: 'telegram_secret_mismatch',
        };
      }

      return webhookHandler(request, reply);
    });
  }

  return {
    bot,
    async ensureWebhook() {
      const webhookUrl = `${deps.appBaseUrl.replace(/\/+$/u, '')}${deps.webhookPath}`;
      const webhookInfo = await bot.api.getWebhookInfo();
      const allowedUpdates = ['message', 'callback_query'] as const;
      const hasExpectedUrl = webhookInfo.url === webhookUrl;
      const existingUpdates = webhookInfo.allowed_updates ?? [];
      const hasExpectedUpdates = allowedUpdates.every((item) => existingUpdates.includes(item));

      if (hasExpectedUrl && hasExpectedUpdates) {
        app.log.info({ webhookUrl }, 'telegram_webhook_already_configured');
        return webhookInfo;
      }

      await bot.api.setWebhook(webhookUrl, {
        secret_token: deps.webhookSecret,
        allowed_updates: allowedUpdates,
      });

      app.log.info({ webhookUrl }, 'telegram_webhook_updated');
      return bot.api.getWebhookInfo();
    },
  };
}
