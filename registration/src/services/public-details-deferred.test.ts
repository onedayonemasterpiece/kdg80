import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStoragePublisher } from '../lib/storage';
import { renderRegistrationEmail } from './email-notifications';
import { publishTicketArtifacts } from './ticket-artifacts';

const PRIVATE_DATE = '30 июля 2026';
const PRIVATE_VENUE = 'ИЦАЭ, КГТУ';
const PRIVATE_ADDRESS = 'Советский проспект, 1';
const PUBLIC_COPY = 'Дата и место будут опубликованы позже.';

test('deferred registration email omits preliminary date, place, and calendar link', () => {
  const email = renderRegistrationEmail({
    eventSlug: 'stendap-prezentatsiya-sayta-anonsov-sobytiy',
    eventTitle: 'Стендап - Презентация сайта анонсов событий',
    startsAt: '2026-07-30T16:30:00.000Z',
    venueName: PRIVATE_VENUE,
    hallName: 'Зал, 2 этаж',
    address: PRIVATE_ADDRESS,
    fullName: 'ТЕСТ Тестов Тестович',
    email: 'test@example.com',
    shortTicketId: 'TEST-120',
    ticketUrl: 'https://kgd80.ru/tickets/test/',
    pdfUrl: 'https://kgd80.ru/tickets/test/ticket.pdf',
    icsUrl: 'https://kgd80.ru/tickets/test/event.ics',
    publicDetailsDeferred: true,
  }, 'Europe/Kaliningrad');

  for (const body of [email.text, email.html]) {
    assert.match(body, new RegExp(PUBLIC_COPY));
    assert.doesNotMatch(body, new RegExp(PRIVATE_DATE));
    assert.doesNotMatch(body, new RegExp(PRIVATE_VENUE));
    assert.doesNotMatch(body, new RegExp(PRIVATE_ADDRESS));
    assert.doesNotMatch(body, /event\.ics/u);
  }
});

test('deferred ticket HTML and calendar artifact do not expose preliminary details', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kgd80-ticket-deferred-'));
  const publisher = createStoragePublisher({
    driver: 'local',
    publicTicketBaseUrl: 'https://kgd80.ru',
    ticketsPrefix: 'tickets',
    localPublicRoot: root,
    s3Bucket: null,
    s3Endpoint: null,
    s3Region: null,
    s3AccessKeyId: null,
    s3SecretAccessKey: null,
    s3ForcePathStyle: true,
  });

  try {
    await publishTicketArtifacts(publisher, {
      publicHash: 'deferred-test',
      eventSlug: 'stendap-prezentatsiya-sayta-anonsov-sobytiy',
      shortTicketId: 'TEST-120',
      ticketBaseUrl: 'https://kgd80.ru',
      ticketsPrefix: 'tickets',
      fullName: 'ТЕСТ Тестов Тестович',
      email: 'test@example.com',
      phone: '+74012345678',
      title: 'Стендап - Презентация сайта анонсов событий',
      startsAt: '2026-07-30T16:30:00.000Z',
      venueName: PRIVATE_VENUE,
      hallName: 'Зал, 2 этаж',
      address: PRIVATE_ADDRESS,
      publicDetailsDeferred: true,
    });

    const html = fs.readFileSync(path.join(root, 'tickets/deferred-test/index.html'), 'utf8');
    const ics = fs.readFileSync(path.join(root, 'tickets/deferred-test/event.ics'), 'utf8');

    assert.match(html, new RegExp(PUBLIC_COPY));
    assert.doesNotMatch(html, new RegExp(PRIVATE_DATE));
    assert.doesNotMatch(html, new RegExp(PRIVATE_VENUE));
    assert.doesNotMatch(html, new RegExp(PRIVATE_ADDRESS));
    assert.doesNotMatch(html, /Google<\/a>/u);
    assert.doesNotMatch(ics, /DTSTART|LOCATION|VEVENT/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
