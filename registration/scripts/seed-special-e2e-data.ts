import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createStoragePublisher } from '../src/lib/storage.js';
import { syncCatalog } from '../src/services/catalog.js';
import { createSpecialApplication } from '../src/services/special-applications.js';

const PHOTO_DIR = path.resolve(process.cwd(), '..', 'Исходные данные', 'Спецмероприятия');
const ETUDY_TOKEN = 'etudy-toy-vesny-debug-20260606';
const ZOO_TOKEN = 'zoo-excursion-e2e-debug-20260606';

const config = loadConfig();

if (!config.piiPublicKeyPemBase64 || !config.piiPrivateKeyPemBase64 || !config.piiFingerprintSecret) {
  throw new Error('PII_PUBLIC_KEY_PEM_B64, PII_PRIVATE_KEY_PEM_B64 and PII_FINGERPRINT_SECRET are required.');
}

const db = createDatabase(config.sqlitePath);
const storagePublisher = createStoragePublisher({
  driver: config.storageDriver,
  publicTicketBaseUrl: config.publicTicketBaseUrl,
  ticketsPrefix: config.ticketsPrefix,
  localPublicRoot: config.localPublicRoot,
  s3Bucket: config.s3Bucket,
  s3Endpoint: config.s3Endpoint,
  s3Region: config.s3Region,
  s3AccessKeyId: config.s3AccessKeyId,
  s3SecretAccessKey: config.s3SecretAccessKey,
  s3ForcePathStyle: config.s3ForcePathStyle,
});

runMigrations(db);
syncCatalog(db);

db.exec(`
  INSERT OR IGNORE INTO special_events(
    slug,
    title,
    format_label,
    venue_name,
    preview_token,
    public_state
  ) VALUES (
    'zoo-excursion-e2e',
    'Премьера новой тематической экскурсии по Калининградскому зоопарку',
    'экскурсия',
    'Калининградский зоопарк',
    '${ZOO_TOKEN}',
    'preview'
  );

  INSERT OR IGNORE INTO special_event_showings(
    special_event_id,
    slug,
    starts_at,
    display_label,
    time_is_final,
    physical_quota,
    reserved_seats,
    lottery_quota
  )
  SELECT id, '2026-06-22-test', '2026-06-22T18:00:00+02:00', '22 июня Калининградский зоопарк', 0, 30, 0, 30
  FROM special_events
  WHERE slug = 'zoo-excursion-e2e';
`);

const e2eUserId = process.env.TELEGRAM_E2E_USER_ID?.trim();
if (e2eUserId) {
  db.prepare(`
    INSERT INTO telegram_admins(telegram_user_id, role, display_name)
    VALUES (?, 'superadmin', 'Telethon E2E')
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      role = 'superadmin',
      display_name = 'Telethon E2E'
  `).run(e2eUserId);
}

function photoPayload(fileName: string) {
  const contentType = fileName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return {
    fileName,
    contentType,
    dataBase64: fs.readFileSync(path.join(PHOTO_DIR, fileName)).toString('base64'),
  };
}

const acceptedPhotos = [
  photoPayload('IMG_20260606_090451.webp'),
  photoPayload('IMG_20260606_090453.webp'),
];

async function seedApplication(options: {
  eventSlug: string;
  token: string;
  selectedShowingSlugs: string[];
  fullName: string;
  email: string;
  phone: string;
}) {
  try {
    const created = await createSpecialApplication({
      token: options.token,
      eventSlug: options.eventSlug,
      selectedShowingSlugs: options.selectedShowingSlugs,
      fullName: options.fullName,
      email: options.email,
      phone: options.phone,
      consentAccepted: true,
      photos: acceptedPhotos,
      website: '',
    }, {
      db,
      consentVersion: config.consentVersion,
      consentTextHash: config.consentTextHash,
      fingerprintSecret: config.piiFingerprintSecret!,
      publicKeyPemBase64: config.piiPublicKeyPemBase64!,
      privateKeyPemBase64: config.piiPrivateKeyPemBase64,
      storagePublisher,
      sourceIp: '127.0.0.1',
      userAgent: 'special-e2e-seed',
    });

    return {
      code: created.applicationCode,
      status: created.status,
      score: created.scoring.score,
      stampCount: created.scoring.stampCount,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('уже участвует')) {
      return {
        code: 'duplicate',
        status: 'duplicate',
        score: 0,
        stampCount: 0,
      };
    }

    throw error;
  }
}

const seeded = [];
seeded.push(await seedApplication({
  eventSlug: 'etudy-toy-vesny',
  token: ETUDY_TOKEN,
  selectedShowingSlugs: ['2026-06-11-1800', '2026-06-23', '2026-06-25'],
  fullName: 'ТЕСТ Победитель Один',
  email: 'winner-one@example.test',
  phone: '+79000000001',
}));
seeded.push(await seedApplication({
  eventSlug: 'etudy-toy-vesny',
  token: ETUDY_TOKEN,
  selectedShowingSlugs: ['2026-06-23', '2026-06-25'],
  fullName: 'ТЕСТ Победитель Два',
  email: 'winner-two@example.test',
  phone: '+79000000021',
}));
seeded.push(await seedApplication({
  eventSlug: 'etudy-toy-vesny',
  token: ETUDY_TOKEN,
  selectedShowingSlugs: ['2026-06-25'],
  fullName: 'ТЕСТ Победитель Три',
  email: 'winner-three@example.test',
  phone: '+79000000022',
}));
seeded.push(await seedApplication({
  eventSlug: 'zoo-excursion-e2e',
  token: ZOO_TOKEN,
  selectedShowingSlugs: ['2026-06-22-test'],
  fullName: 'ТЕСТ Победитель Один',
  email: 'winner-one@example.test',
  phone: '+79000000001',
}));
seeded.push(await seedApplication({
  eventSlug: 'zoo-excursion-e2e',
  token: ZOO_TOKEN,
  selectedShowingSlugs: ['2026-06-22-test'],
  fullName: 'ТЕСТ Зоопарк Второй',
  email: 'zoo-two@example.test',
  phone: '+79000000002',
}));

const showings = db.prepare(`
  SELECT e.slug AS event_slug, s.slug AS showing_slug, s.id, s.draw_status
  FROM special_event_showings s
  JOIN special_events e ON e.id = s.special_event_id
  ORDER BY e.id, s.id
`).all();

console.log(JSON.stringify({
  ok: true,
  adminSeeded: Boolean(e2eUserId),
  seeded,
  showings,
}, null, 2));
