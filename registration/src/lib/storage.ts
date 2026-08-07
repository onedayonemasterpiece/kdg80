import fs from 'node:fs';
import path from 'node:path';
import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { TicketArtifacts } from '../types';

type StorageConfig = {
  driver: 'local' | 's3';
  publicTicketBaseUrl: string;
  ticketsPrefix: string;
  localPublicRoot: string;
  s3Bucket: string | null;
  s3Endpoint: string | null;
  s3Region: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
  s3ForcePathStyle: boolean;
};

type TicketArtifactFile = {
  key: string;
  body: Buffer | string;
  contentType: string;
  cacheControl: string;
};

export type PublicStorageFile = {
  key: string;
  body: Buffer | string;
  contentType: string;
  cacheControl: string;
};

export type PrivateStorageFile = {
  key: string;
  body: Buffer | string;
  contentType: string;
  cacheControl?: string;
};

export type TicketArtifactBundle = {
  publicHash: string;
  files: TicketArtifactFile[];
};

export type StoragePublisher = {
  driver: 'local' | 's3';
  publishTicketArtifacts(bundle: TicketArtifactBundle): Promise<TicketArtifacts>;
  deleteTicketArtifacts(publicHash: string): Promise<void>;
  publishPublicAsset(file: PublicStorageFile): Promise<void>;
  publishPrivateAsset(file: PrivateStorageFile): Promise<void>;
  readPrivateAsset(key: string): Promise<Buffer>;
  deletePrivateAsset(key: string): Promise<void>;
};

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/gu, '');
}

function createTicketUrls(baseUrl: string, ticketsPrefix: string, publicHash: string): TicketArtifacts {
  const ticketUrl = `${baseUrl}/${trimSlashes(ticketsPrefix)}/${publicHash}/`;

  return {
    ticketUrl,
    pdfUrl: `${ticketUrl}ticket.pdf`,
    icsUrl: `${ticketUrl}event.ics`,
  };
}

function createTicketArtifactKeys(ticketsPrefix: string, publicHash: string) {
  const prefix = trimSlashes(ticketsPrefix);
  return [
    `${prefix}/${publicHash}/index.html`,
    `${prefix}/${publicHash}/ticket.pdf`,
    `${prefix}/${publicHash}/event.ics`,
  ];
}

function createS3Publisher(config: StorageConfig): StoragePublisher {
  if (!config.s3Bucket || !config.s3Endpoint || !config.s3Region || !config.s3AccessKeyId || !config.s3SecretAccessKey) {
    throw new Error('S3 publisher requires bucket, endpoint, region and credentials.');
  }

  const client = new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
  });

  return {
    driver: 's3',
    async publishPublicAsset(file) {
      await client.send(new PutObjectCommand({
        Bucket: config.s3Bucket!,
        Key: file.key,
        Body: file.body,
        ContentType: file.contentType,
        CacheControl: file.cacheControl,
      }));
    },
    async publishPrivateAsset(file) {
      await client.send(new PutObjectCommand({
        Bucket: config.s3Bucket!,
        Key: file.key,
        Body: file.body,
        ContentType: file.contentType,
        CacheControl: file.cacheControl ?? 'private, max-age=0, no-store',
      }));
    },
    async readPrivateAsset(key) {
      const response = await client.send(new GetObjectCommand({
        Bucket: config.s3Bucket!,
        Key: key,
      }));
      const body = response.Body as unknown as {
        transformToByteArray?: () => Promise<Uint8Array>;
      } | undefined;

      if (!body?.transformToByteArray) {
        throw new Error(`Unable to read private asset: ${key}`);
      }

      return Buffer.from(await body.transformToByteArray());
    },
    async deletePrivateAsset(key) {
      await client.send(new DeleteObjectCommand({
        Bucket: config.s3Bucket!,
        Key: key,
      }));
    },
    async publishTicketArtifacts(bundle) {
      for (const file of bundle.files) {
        await this.publishPublicAsset(file);
      }

      return createTicketUrls(config.publicTicketBaseUrl, config.ticketsPrefix, bundle.publicHash);
    },
    async deleteTicketArtifacts(publicHash) {
      const keys = createTicketArtifactKeys(config.ticketsPrefix, publicHash);
      for (const key of keys) {
        await client.send(new DeleteObjectCommand({
          Bucket: config.s3Bucket!,
          Key: key,
        }));
      }
    },
  };
}

function createLocalPublisher(config: StorageConfig): StoragePublisher {
  fs.mkdirSync(config.localPublicRoot, { recursive: true });

  return {
    driver: 'local',
    async publishPublicAsset(file) {
      const targetPath = path.join(config.localPublicRoot, file.key);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, file.body);
    },
    async publishPrivateAsset(file) {
      const targetPath = path.join(config.localPublicRoot, file.key);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, file.body);
    },
    async readPrivateAsset(key) {
      return fs.readFileSync(path.join(config.localPublicRoot, key));
    },
    async deletePrivateAsset(key) {
      fs.rmSync(path.join(config.localPublicRoot, key), { force: true });
    },
    async publishTicketArtifacts(bundle) {
      for (const file of bundle.files) {
        await this.publishPublicAsset(file);
      }

      return createTicketUrls(config.publicTicketBaseUrl, config.ticketsPrefix, bundle.publicHash);
    },
    async deleteTicketArtifacts(publicHash) {
      const ticketDir = path.join(config.localPublicRoot, trimSlashes(config.ticketsPrefix), publicHash);
      fs.rmSync(ticketDir, { recursive: true, force: true });
    },
  };
}

export function createStoragePublisher(config: StorageConfig): StoragePublisher {
  if (config.driver === 's3') {
    return createS3Publisher(config);
  }

  return createLocalPublisher(config);
}
