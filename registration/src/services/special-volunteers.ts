import fs from 'node:fs';
import path from 'node:path';
import { normalizeFullName } from '../lib/normalize';

export type SpecialVolunteerMatch = {
  matched: boolean;
  bonusPoints: number;
  matchedName: string | null;
  matchType: 'none' | 'exact' | 'tokens' | 'typo';
  distance: number | null;
};

const DEFAULT_VOLUNTEERS_PATH = path.resolve(process.cwd(), '..', 'Исходные данные', 'vlunteers.md');
const VOLUNTEER_BONUS_POINTS = 10;

let cachedSourceKey: string | null = null;
let cachedNames: string[] = [];

function normalizeNameForMatching(value: string) {
  return normalizeFullName(value)
    .toLowerCase()
    .replace(/ё/gu, 'е');
}

function nameTokens(value: string) {
  return normalizeNameForMatching(value)
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseVolunteerNames(value: string) {
  return value
    .split(/\r?\n|;|,/u)
    .map((line) => line.replace(/^\s*\d+[\).\s-]+/u, '').trim())
    .filter(Boolean)
    .map((line) => normalizeFullName(line))
    .filter(Boolean);
}

function readVolunteerSource() {
  const inline = process.env.SPECIAL_VOLUNTEER_NAMES?.trim();
  if (inline) {
    return {
      sourceKey: `env:${inline}`,
      content: inline,
    };
  }

  const filePath = process.env.SPECIAL_VOLUNTEERS_FILE?.trim()
    || process.env.SPECIAL_VOLUNTEER_NAMES_PATH?.trim()
    || DEFAULT_VOLUNTEERS_PATH;
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      sourceKey: `missing:${filePath}`,
      content: '',
    };
  }

  return {
    sourceKey: `file:${filePath}:${fs.statSync(filePath).mtimeMs}`,
    content: fs.readFileSync(filePath, 'utf-8'),
  };
}

function getVolunteerNames() {
  const source = readVolunteerSource();
  if (source.sourceKey !== cachedSourceKey) {
    cachedSourceKey = source.sourceKey;
    cachedNames = parseVolunteerNames(source.content);
  }

  return cachedNames;
}

function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_item, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}

function tokenPairDistance(leftTokens: string[], rightTokens: string[]) {
  if (leftTokens.length < 2 || rightTokens.length < 2) {
    return null;
  }

  let distance = 0;
  for (const index of [0, 1]) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (!leftToken || !rightToken) {
      return null;
    }

    if (leftToken === rightToken) {
      continue;
    }

    distance += levenshtein(leftToken, rightToken);
  }

  return distance;
}

function isSameSurnameName(leftTokens: string[], rightTokens: string[]) {
  if (leftTokens.length < 2 || rightTokens.length < 2) {
    return false;
  }

  return leftTokens[0] === rightTokens[0] && leftTokens[1] === rightTokens[1];
}

export function findSpecialVolunteerMatch(fullName: string): SpecialVolunteerMatch {
  const normalized = normalizeNameForMatching(fullName);
  const tokens = nameTokens(fullName);
  let bestTypoMatch: { name: string; distance: number } | null = null;

  for (const volunteerName of getVolunteerNames()) {
    const volunteerNormalized = normalizeNameForMatching(volunteerName);
    if (normalized === volunteerNormalized) {
      return {
        matched: true,
        bonusPoints: VOLUNTEER_BONUS_POINTS,
        matchedName: volunteerName,
        matchType: 'exact',
        distance: 0,
      };
    }

    const volunteerTokens = nameTokens(volunteerName);
    if (isSameSurnameName(tokens, volunteerTokens)) {
      return {
        matched: true,
        bonusPoints: VOLUNTEER_BONUS_POINTS,
        matchedName: volunteerName,
        matchType: 'tokens',
        distance: 0,
      };
    }

    const distance = tokenPairDistance(tokens, volunteerTokens);
    if (distance !== null && distance <= 2 && (!bestTypoMatch || distance < bestTypoMatch.distance)) {
      bestTypoMatch = {
        name: volunteerName,
        distance,
      };
    }
  }

  if (bestTypoMatch) {
    return {
      matched: true,
      bonusPoints: VOLUNTEER_BONUS_POINTS,
      matchedName: bestTypoMatch.name,
      matchType: 'typo',
      distance: bestTypoMatch.distance,
    };
  }

  return {
    matched: false,
    bonusPoints: 0,
    matchedName: null,
    matchType: 'none',
    distance: null,
  };
}
