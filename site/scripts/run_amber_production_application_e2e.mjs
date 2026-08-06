#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const pageUrl = process.env.AMBER_E2E_URL
  || 'https://kgd80.ru/special/amber-combine-jewelry-excursion/';
const fixturePath = path.resolve(
  process.env.AMBER_E2E_FIXTURE
    || '../.codex-artifacts/vk-passport-sanitized/fixtures/passport-test-01.jpg',
);
const artifactDir = path.resolve(
  process.env.AMBER_E2E_ARTIFACT_DIR
    || '../.codex-artifacts/amber-combine-production-application-e2e',
);
const headless = process.env.HEADLESS !== '0';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function randomDigits(length) {
  let value = '';
  while (value.length < length) {
    value += Math.floor(Math.random() * 10);
  }
  return value;
}

function isApplicationResponse(response) {
  const url = new URL(response.url());
  return response.request().method() === 'POST'
    && /\/api\/v1\/special\/applications(?:-multipart)?$/u.test(url.pathname);
}

async function jsonOrNull(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function cleanupApplication({ apiOrigin, applicationCode, cleanupToken }) {
  const response = await fetch(
    `${apiOrigin}/api/v1/special/test-applications/${encodeURIComponent(applicationCode)}`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cleanupToken }),
    },
  );
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function main() {
  assert(fs.existsSync(fixturePath), `Sanitized Passport fixture is missing: ${fixturePath}`);
  fs.mkdirSync(artifactDir, { recursive: true });

  const runSuffix = `${Date.now()}-${randomDigits(4)}`;
  const formData = {
    fullName: 'ТЕСТ ЯНТАРНЫЙ КОМБИНАТ 01',
    email: `amber-e2e-${runSuffix}@example.com`,
    phone: `+7999${randomDigits(7)}`,
  };

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Kaliningrad',
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });

  let applicationCode = null;
  let cleanupToken = null;
  let apiOrigin = null;
  let cleanupCompleted = false;

  try {
    const initialResponse = await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 90_000 });
    assert(initialResponse?.ok(), `Event page returned HTTP ${initialResponse?.status() ?? 'unknown'}`);

    await page.locator('[data-special-form]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('input[name="selectedShowingSlugs"]:not([disabled])').waitFor({
      state: 'attached',
      timeout: 45_000,
    });

    const dateCopy = await page.locator('[data-special-dates]').innerText();
    assert(dateCopy.includes('11 августа 11:00'), `Unexpected showing label: ${dateCopy}`);
    assert(!/Всего мест|в розыгрыше|бронь|6 мест|6 победител/iu.test(dateCopy), 'Quota leaked in date card');

    await page.locator('input[name="fullName"]').fill(formData.fullName);
    await page.locator('input[name="email"]').fill(formData.email);
    await page.locator('input[name="phone"]').fill(formData.phone);

    await page.locator('input[name="photos"]').setInputFiles(fixturePath);

    await page.waitForFunction(() => {
      const precheck = document.querySelector('[data-special-precheck]');
      const submit = document.querySelector('[data-special-submit]');
      return precheck
        && !precheck.hasAttribute('hidden')
        && /Штампы\s*5|Штампы\s*[6-9]|Штампы\s*\d{2,}/u.test(precheck.textContent || '')
        && submit instanceof HTMLButtonElement
        && !submit.disabled
        && /Отправить заявку/u.test(submit.textContent || '');
    }, null, { timeout: 150_000 });

    const precheckText = await page.locator('[data-special-precheck]').innerText();
    const stampMatch = precheckText.match(/Штампы\s*(\d+)/u);
    const precheckStampCount = Number(stampMatch?.[1] || 0);
    assert(precheckStampCount >= 5, `Precheck accepted fewer than 5 stamps: ${precheckStampCount}`);

    await page.locator('input[name="consentAccepted"]').check();
    await page.screenshot({
      path: path.join(artifactDir, '01-precheck-ready.png'),
      fullPage: true,
    });

    const applicationResponsePromise = page.waitForResponse(isApplicationResponse, { timeout: 180_000 });
    await page.locator('[data-special-submit]').click();
    const applicationResponse = await applicationResponsePromise;
    const applicationBody = await jsonOrNull(applicationResponse);

    // Capture cleanup credentials before validating the accepted response. A TEST
    // application must still be removed if a later assertion fails.
    apiOrigin = new URL(applicationResponse.url()).origin;
    applicationCode = typeof applicationBody?.applicationCode === 'string'
      ? applicationBody.applicationCode
      : null;
    cleanupToken = typeof applicationBody?.testCleanupToken === 'string'
      ? applicationBody.testCleanupToken
      : null;

    assert(applicationResponse.status() === 201, `Application HTTP ${applicationResponse.status()}: ${JSON.stringify(applicationBody)}`);
    assert(applicationBody?.status === 'accepted', `Application was not accepted: ${JSON.stringify(applicationBody)}`);
    assert(Number(applicationBody?.scoring?.stampCount || 0) >= 5, 'Accepted application has fewer than 5 stamps');
    assert(applicationBody?.testApplication === true, 'Server did not classify the submission as a TEST application');
    assert(applicationCode?.startsWith('TEST-'), 'TEST application code does not use the TEST- prefix');
    assert(cleanupToken, 'Application response did not include testCleanupToken');
    assert(applicationBody?.emailNotification?.sent === false, 'TEST application unexpectedly sent an email');
    assert(applicationBody?.emailNotification?.reason === 'test_application_suppressed', 'TEST email suppression reason is missing');

    await page.locator('[data-special-status][data-kind="success"]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const successCopy = await page.locator('[data-special-status]').innerText();
    assert(successCopy.includes('Заявка принята к розыгрышу'), `Unexpected success UI: ${successCopy}`);
    await page.screenshot({
      path: path.join(artifactDir, '02-application-accepted.png'),
      fullPage: true,
    });

    const cleanup = await cleanupApplication({ apiOrigin, applicationCode, cleanupToken });
    assert(cleanup.response.status === 200, `Cleanup HTTP ${cleanup.response.status}: ${JSON.stringify(cleanup.body)}`);
    assert(cleanup.body?.status === 'deleted', `Cleanup did not report deleted: ${JSON.stringify(cleanup.body)}`);
    assert(cleanup.body?.removedApplication === 1, 'Cleanup did not remove exactly one application');
    assert(cleanup.body?.removedProfile === 1, 'Cleanup did not remove the orphan TEST profile');
    assert(Number(cleanup.body?.removedPrivateAssets || 0) >= 1, 'Cleanup did not remove private photo assets');
    assert(Number(cleanup.body?.removedTelegramOutboxRows || 0) === 0, 'A Telegram outbox row was created for the TEST application');
    assert(Number(cleanup.body?.removedEmailNotifications || 0) === 0, 'An email notification row was created for the TEST application');
    cleanupCompleted = true;

    const secondCleanup = await cleanupApplication({ apiOrigin, applicationCode, cleanupToken });
    assert(secondCleanup.response.status === 404, `Repeated cleanup should return 404, got ${secondCleanup.response.status}`);

    assert(browserErrors.length === 0, `Browser errors detected: ${browserErrors.join(' | ')}`);

    const report = {
      status: 'passed',
      pageUrl,
      fixture: path.basename(fixturePath),
      precheckStampCount,
      applicationHttpStatus: applicationResponse.status(),
      applicationStatus: applicationBody.status,
      responseStampCount: applicationBody.scoring.stampCount,
      emailSuppressed: applicationBody.emailNotification.reason === 'test_application_suppressed',
      cleanupHttpStatus: cleanup.response.status,
      cleanupStatus: cleanup.body.status,
      removedApplication: cleanup.body.removedApplication,
      removedProfile: cleanup.body.removedProfile,
      removedPrivateAssets: cleanup.body.removedPrivateAssets,
      removedTelegramOutboxRows: cleanup.body.removedTelegramOutboxRows,
      removedEmailNotifications: cleanup.body.removedEmailNotifications,
      repeatedCleanupStatus: secondCleanup.response.status,
      browserErrors,
      completedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(artifactDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (applicationCode && cleanupToken && apiOrigin && !cleanupCompleted) {
      try {
        const emergencyCleanup = await cleanupApplication({ apiOrigin, applicationCode, cleanupToken });
        console.error(`Emergency cleanup HTTP ${emergencyCleanup.response.status}`);
      } catch (error) {
        console.error(`Emergency cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
