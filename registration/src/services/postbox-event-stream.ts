import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  GetRecordsCommand,
  GetShardIteratorCommand,
  KinesisClient,
  ListShardsCommand,
  type Shard,
} from '@aws-sdk/client-kinesis';
import { recordPostboxEvent } from './email-stats';

export type PostboxEventStreamConfig = {
  enabled: boolean;
  endpoint: string;
  region: string;
  streamName: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  pollIntervalMs: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeRecordData(data: Uint8Array | undefined) {
  if (!data) {
    return null;
  }
  const text = Buffer.from(data).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function pollShard(params: {
  client: KinesisClient;
  db: Database.Database;
  logger: FastifyBaseLogger;
  streamName: string;
  shard: Shard;
  pollIntervalMs: number;
}) {
  const shardId = params.shard.ShardId;
  if (!shardId) {
    return;
  }

  let iterator = (await params.client.send(new GetShardIteratorCommand({
    StreamName: params.streamName,
    ShardId: shardId,
    ShardIteratorType: 'LATEST',
  }))).ShardIterator;

  params.logger.info({ shardId }, 'postbox_event_stream_shard_started');

  while (iterator) {
    try {
      const response = await params.client.send(new GetRecordsCommand({
        ShardIterator: iterator,
        Limit: 100,
      }));
      iterator = response.NextShardIterator;
      let recorded = 0;
      let ignored = 0;
      for (const record of response.Records ?? []) {
        const event = decodeRecordData(record.Data);
        if (!event) {
          ignored += 1;
          continue;
        }
        const result = recordPostboxEvent(params.db, event as Record<string, unknown>);
        if (result.recorded) {
          recorded += 1;
        } else {
          ignored += 1;
        }
      }
      if (recorded || ignored) {
        params.logger.info({ shardId, recorded, ignored }, 'postbox_event_stream_records_processed');
      }
    } catch (error) {
      params.logger.error({ err: error, shardId }, 'postbox_event_stream_poll_failed');
      await sleep(Math.max(params.pollIntervalMs, 5_000));
    }

    await sleep(params.pollIntervalMs);
  }
}

export async function startPostboxEventStreamConsumer(config: PostboxEventStreamConfig, deps: {
  db: Database.Database;
  logger: FastifyBaseLogger;
}) {
  if (!config.enabled) {
    deps.logger.info('postbox_event_stream_disabled');
    return;
  }
  if (!config.accessKeyId || !config.secretAccessKey || !config.endpoint || !config.streamName) {
    deps.logger.warn('postbox_event_stream_not_configured');
    return;
  }

  const client = new KinesisClient({
    endpoint: config.endpoint,
    region: config.region,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 20_000,
    }),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  try {
    const shards = (await client.send(new ListShardsCommand({ StreamName: config.streamName }))).Shards ?? [];
    deps.logger.info({ streamName: config.streamName, shardCount: shards.length }, 'postbox_event_stream_consumer_started');
    for (const shard of shards) {
      void pollShard({
        client,
        db: deps.db,
        logger: deps.logger,
        streamName: config.streamName,
        shard,
        pollIntervalMs: config.pollIntervalMs,
      });
    }
  } catch (error) {
    deps.logger.error({ err: error }, 'postbox_event_stream_start_failed');
  }
}
