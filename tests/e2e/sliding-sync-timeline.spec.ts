import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { createRoom, registerUser, sendText } from './fixtures/continuwuity';
import { wheelToBottomUntilVisible } from './fixtures/timelineOrder';
import { AppShell } from './pages/AppShell';

const PASSWORD = 'test-passw0rd';
const HISTORY_SIZE = 100;
const SEND_DELAYS_MS = [0, 150, 0, 400, 50];

type InjectedSession = {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  slidingSyncOptIn?: boolean;
};

async function homeserverBaseUrl(storageStatePath: string): Promise<string> {
  const state = JSON.parse(await readFile(storageStatePath, 'utf8')) as {
    origins: { localStorage: { name: string; value: string }[] }[];
  };
  const entry = state.origins[0]!.localStorage.find((item) => item.name === 'matrixSessions')!;
  return (JSON.parse(entry.value) as InjectedSession[])[0]!.baseUrl;
}

async function loginAsFreshUser(
  page: Page,
  baseUrl: string,
  name: string
): Promise<{ accessToken: string }> {
  const user = await registerUser(baseUrl, name, PASSWORD);
  const session: InjectedSession = {
    baseUrl,
    userId: user.userId,
    deviceId: user.deviceId,
    accessToken: user.accessToken,
    slidingSyncOptIn: true,
  };
  await page.addInitScript((injected: InjectedSession) => {
    localStorage.setItem('matrixSessions', JSON.stringify([injected]));
    localStorage.setItem('matrixActiveSession', JSON.stringify(injected.userId));
    localStorage.setItem('dismissNotice', 'true');
  }, session);
  return user;
}

let txnCounter = 1;

const nextTxnId = () => {
  txnCounter += 1;
  return txnCounter;
};

async function sendMessage(
  baseUrl: string,
  token: string,
  roomId: string,
  body: string
): Promise<void> {
  await sendText(baseUrl, token, roomId, body, nextTxnId());
}

async function sendHistory(
  baseUrl: string,
  token: string,
  roomId: string,
  prefix: string,
  bodies: string[]
): Promise<void> {
  for (let i = 0; i < bodies.length; i += 1) {
    await sendMessage(baseUrl, token, roomId, `${prefix}-${bodies[i]}`);
  }
}

async function wheelToTopUntilVisible(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -2400);
    expect(await page.getByText(text, { exact: true }).count()).toBeGreaterThan(0);
  }).toPass({ timeout: 120_000, intervals: [500] });
}

test.describe('sliding sync timeline', () => {
  test('paginates backwards through pre-subscription history after leaving and reopening a room', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop-focused');
    test.setTimeout(300_000);
    const storageStatePath = testInfo.project.use.storageState as string;
    const hsBaseUrl = await homeserverBaseUrl(storageStatePath);
    const tag = `hist-${process.pid}-${Date.now().toString(36)}`;
    const app = new AppShell(page);
    const user = await loginAsFreshUser(page, hsBaseUrl, `${tag}-u`);

    const room = await createRoom(hsBaseUrl, user.accessToken, {
      name: `${tag} History`,
      preset: 'private_chat',
    });
    const away = await createRoom(hsBaseUrl, user.accessToken, {
      name: `${tag} Away`,
      preset: 'private_chat',
    });

    const bodies = ['sentinel', ...Array.from({ length: HISTORY_SIZE - 1 }, (_, i) => `m${i}`)];
    const latest = `${tag}-m${HISTORY_SIZE - 2}`;
    const sentinel = `${tag}-sentinel`;
    await sendHistory(hsBaseUrl, user.accessToken, room, tag, bodies);
    await sendMessage(hsBaseUrl, user.accessToken, away, `${tag}-away-msg`);

    await page.goto('/');
    await expect(page.getByText(`${tag} History`).first()).toBeVisible({
      timeout: 180_000,
    });

    await app.openRoom(`${tag} History`);
    await expect(page.getByText(latest, { exact: true }).first()).toBeVisible({
      timeout: 180_000,
    });
    expect(await page.getByText(sentinel, { exact: true }).count()).toBe(0);

    await app.openRoom(`${tag} Away`);
    await expect(page.getByText(`${tag}-away-msg`, { exact: true })).toBeVisible({
      timeout: 120_000,
    });

    await app.openRoom(`${tag} History`);
    await expect(page.getByText(latest, { exact: true }).first()).toBeVisible({
      timeout: 120_000,
    });
    expect(await page.getByText(sentinel, { exact: true }).count()).toBe(0);

    await wheelToTopUntilVisible(page, sentinel);

    await wheelToBottomUntilVisible(page, latest);
  });

  test('renders messages received while the room was inactive exactly once, in order, after reopening', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop-focused');
    test.setTimeout(300_000);
    const storageStatePath = testInfo.project.use.storageState as string;
    const hsBaseUrl = await homeserverBaseUrl(storageStatePath);
    const tag = `live-${process.pid}-${Date.now().toString(36)}`;
    const app = new AppShell(page);
    const user = await loginAsFreshUser(page, hsBaseUrl, `${tag}-u`);

    const room = await createRoom(hsBaseUrl, user.accessToken, {
      name: `${tag} Home`,
      preset: 'private_chat',
    });
    const away = await createRoom(hsBaseUrl, user.accessToken, {
      name: `${tag} Away`,
      preset: 'private_chat',
    });

    await sendMessage(hsBaseUrl, user.accessToken, room, `${tag}-seed`);
    await sendMessage(hsBaseUrl, user.accessToken, away, `${tag}-away-msg`);

    await page.goto('/');
    await expect(page.getByText(`${tag} Home`).first()).toBeVisible({
      timeout: 180_000,
    });

    await app.openRoom(`${tag} Home`);
    await expect(page.getByText(`${tag}-seed`, { exact: true })).toBeVisible({
      timeout: 180_000,
    });

    await app.openRoom(`${tag} Away`);
    await expect(page.getByText(`${tag}-away-msg`, { exact: true })).toBeVisible({
      timeout: 120_000,
    });

    for (let i = 0; i < SEND_DELAYS_MS.length; i += 1) {
      if (SEND_DELAYS_MS[i]! > 0) await page.waitForTimeout(SEND_DELAYS_MS[i]!);
      await sendMessage(hsBaseUrl, user.accessToken, room, `${tag}-live-${i + 1}`);
    }

    await app.openRoom(`${tag} Home`);
    await expect(page.getByText(`${tag}-seed`, { exact: true })).toBeVisible({
      timeout: 120_000,
    });

    for (let i = 0; i < SEND_DELAYS_MS.length; i += 1) {
      await expect(page.getByText(`${tag}-live-${i + 1}`, { exact: true })).toHaveCount(1, {
        timeout: 120_000,
      });
      await expect(page.getByText(`${tag}-live-${i + 1}`, { exact: true })).toBeVisible();
    }

    const domOrder = await page.getByText(new RegExp(`^${tag}-live-\\d+$`)).allTextContents();
    expect(domOrder).toEqual(SEND_DELAYS_MS.map((_, i) => `${tag}-live-${i + 1}`));
  });
});
