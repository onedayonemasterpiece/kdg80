import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { decryptPii } from '../src/lib/crypto.js';
import { createStoragePublisher } from '../src/lib/storage.js';
import { publishTicketArtifacts } from '../src/services/ticket-artifacts.js';

type Args = {
  dbPath: string;
  publicHash?: string;
  eventSlug?: string;
};

function parseArgs(argv: string[]): Args {
  let dbPath = '';
  let publicHash = '';
  let eventSlug = '';

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--db' && next) {
      dbPath = next;
      index += 1;
      continue;
    }

    if (current === '--public-hash' && next) {
      publicHash = next;
      index += 1;
      continue;
    }

    if (current === '--event-slug' && next) {
      eventSlug = next;
      index += 1;
      continue;
    }
  }

  if (!dbPath || (!publicHash && !eventSlug) || (publicHash && eventSlug)) {
    throw new Error('Usage: npx tsx registration/scripts/republish-ticket-artifacts.ts --db /path/to/registration.sqlite (--public-hash <hash> | --event-slug <slug>)');
  }

  return {
    dbPath,
    publicHash: publicHash || undefined,
    eventSlug: eventSlug || undefined,
  };
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

if (!config.piiPrivateKeyPemBase64) {
  throw new Error('PII_PRIVATE_KEY_PEM_B64 must be set to republish a ticket.');
}

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

const db = new Database(args.dbPath, { readonly: true });

type TicketRow = {
  publicHash: string;
  shortTicketId: string;
  eventSlug: string;
  title: string;
  startsAt: string;
  venueName: string;
  hallName: string;
  address: string;
  piiCiphertext: Buffer;
  piiWrappedKey: Buffer;
  piiIv: Buffer;
  piiAlg: string;
};

const ticketSelectSql = `
  SELECT
    t.public_hash AS publicHash,
    t.short_ticket_id AS shortTicketId,
    e.slug AS eventSlug,
    e.title AS title,
    e.starts_at AS startsAt,
    e.venue_name AS venueName,
    e.hall_name AS hallName,
    e.address AS address,
    r.pii_ciphertext AS piiCiphertext,
    r.pii_wrapped_key AS piiWrappedKey,
    r.pii_iv AS piiIv,
    r.pii_alg AS piiAlg
  FROM tickets t
  JOIN registrations r ON r.id = t.registration_id
  JOIN events e ON e.id = r.event_id
`;

function readTicketRows() {
  if (args.publicHash) {
    const row = db.prepare(`${ticketSelectSql} WHERE t.public_hash = ? LIMIT 1`).get(args.publicHash) as TicketRow | undefined;

    if (!row) {
      throw new Error(`Ticket with public hash ${args.publicHash} was not found in ${args.dbPath}`);
    }

    return [row];
  }

  if (!args.eventSlug) {
    throw new Error('event slug is required when public hash is not provided');
  }

  return db.prepare(`${ticketSelectSql} WHERE e.slug = ? ORDER BY t.created_at ASC`).all(args.eventSlug) as TicketRow[];
}

async function republishTicket(row: TicketRow) {
  const pii = decryptPii(config.piiPrivateKeyPemBase64, {
    piiCiphertext: row.piiCiphertext,
    piiWrappedKey: row.piiWrappedKey,
    piiIv: row.piiIv,
    piiAlg: row.piiAlg,
  });

  const artifacts = await publishTicketArtifacts(storagePublisher, {
    publicHash: row.publicHash,
    eventSlug: row.eventSlug,
    shortTicketId: row.shortTicketId,
    ticketBaseUrl: config.publicTicketBaseUrl,
    ticketsPrefix: config.ticketsPrefix,
    fullName: pii.fullName ?? '',
    email: pii.email ?? '',
    phone: pii.phone ?? '',
    title: row.title,
    startsAt: row.startsAt,
    venueName: row.venueName,
    hallName: row.hallName,
    address: row.address,
  });

  return {
    publicHash: row.publicHash,
    shortTicketId: row.shortTicketId,
    eventSlug: row.eventSlug,
    ...artifacts,
  };
}

const rows = readTicketRows();
const results: Awaited<ReturnType<typeof republishTicket>>[] = [];

for (const row of rows) {
  results.push(await republishTicket(row));
}

db.close();

console.log(JSON.stringify({
  ok: true,
  mode: args.publicHash ? 'public-hash' : 'event-slug',
  eventSlug: args.eventSlug,
  total: results.length,
  items: results,
}, null, 2));
