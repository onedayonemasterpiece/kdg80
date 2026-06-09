type LlmLimitedRunOptions = {
  consumer: string;
  provider: string;
  model: string;
  minIntervalMs?: number;
  maxRetries?: number;
};

export type LlmLimiterTrace = {
  consumer: string;
  provider: string;
  model: string;
  limited: true;
  attempts: number;
  queuedMs: number;
  minIntervalMs: number;
  maxRetries: number;
};

export class LlmProviderError extends Error {
  statusCode: number;
  retryAfterMs: number | null;

  constructor(message: string, statusCode: number, retryAfterMs: number | null = null) {
    super(message);
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

let queueTail: Promise<void> = Promise.resolve();
let lastStartedAt = 0;
let queuedCount = 0;
let activeCount = 0;
let lastEnqueuedAt: string | null = null;
let lastRunStartedAt: string | null = null;
let lastSucceededAt: string | null = null;
let lastFailedAt: string | null = null;
let lastError: string | null = null;

export function getLlmLimiterSnapshot() {
  return {
    queuedCount,
    activeCount,
    lastEnqueuedAt,
    lastRunStartedAt,
    lastSucceededAt,
    lastFailedAt,
    lastError,
    lastStartedAt,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRetryable(error: unknown) {
  if (!(error instanceof LlmProviderError)) {
    return false;
  }

  return error.statusCode === 429 || error.statusCode === 408 || error.statusCode >= 500;
}

function retryDelayMs(error: unknown, attempt: number) {
  if (error instanceof LlmProviderError && error.retryAfterMs !== null) {
    return Math.min(Math.max(error.retryAfterMs, 0), 30_000);
  }

  const base = 750 * 2 ** Math.max(attempt - 1, 0);
  const jitter = randomInt(250);
  return Math.min(base + jitter, 15_000);
}

async function runWithRetries<T>(task: () => Promise<T>, maxRetries: number) {
  let attempts = 0;
  let lastError: unknown;

  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      return {
        value: await task(),
        attempts,
      };
    } catch (error) {
      lastError = error;
      if (attempts > maxRetries || !isRetryable(error)) {
        break;
      }

      await sleep(retryDelayMs(error, attempts));
    }
  }

  throw lastError;
}

export async function runLlmLimited<T>(
  task: () => Promise<T>,
  options: LlmLimitedRunOptions,
) {
  const maxQueueSize = readPositiveInteger(
    process.env.SPECIAL_OCR_LLM_MAX_QUEUE,
    12,
  );
  const minIntervalMs = options.minIntervalMs ?? readPositiveInteger(
    process.env.SPECIAL_OCR_LLM_MIN_INTERVAL_MS,
    1_200,
  );
  const maxRetries = options.maxRetries ?? readPositiveInteger(
    process.env.SPECIAL_OCR_LLM_MAX_RETRIES,
    3,
  );
  if (maxQueueSize > 0 && queuedCount + activeCount >= maxQueueSize) {
    const error = new LlmProviderError('OCR queue is temporarily overloaded', 503, 30_000);
    lastFailedAt = new Date().toISOString();
    lastError = error.message;
    throw error;
  }

  const enqueuedAt = Date.now();
  lastEnqueuedAt = new Date(enqueuedAt).toISOString();
  queuedCount += 1;

  const previous = queueTail;
  let releaseCurrent: () => void;
  queueTail = new Promise((resolve) => {
    releaseCurrent = resolve;
  });

  await previous.catch(() => undefined);
  queuedCount = Math.max(0, queuedCount - 1);
  activeCount += 1;

  try {
    const waitMs = Math.max(0, lastStartedAt + minIntervalMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    lastStartedAt = Date.now();
    lastRunStartedAt = new Date(lastStartedAt).toISOString();
    const result = await runWithRetries(task, maxRetries);
    lastSucceededAt = new Date().toISOString();
    lastError = null;
    return {
      value: result.value,
      trace: {
        consumer: options.consumer,
        provider: options.provider,
        model: options.model,
        limited: true,
        attempts: result.attempts,
        queuedMs: Math.max(0, lastStartedAt - enqueuedAt),
        minIntervalMs,
        maxRetries,
      } satisfies LlmLimiterTrace,
    };
  } catch (error) {
    lastFailedAt = new Date().toISOString();
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    activeCount = Math.max(0, activeCount - 1);
    releaseCurrent!();
  }
}
import { randomInt } from 'node:crypto';
