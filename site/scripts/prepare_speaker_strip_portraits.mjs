import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(siteRoot, '..');
const speakersRoot = path.join(workspaceRoot, 'Исходные данные', 'Фотографии', 'спикеры');
const speakerCutoutsRoot = path.join(speakersRoot, 'Обрезанный фон');
const speakerStripOut = path.join(siteRoot, 'public', 'generated', 'speaker-strip');
const portraitBoundsOut = path.join(siteRoot, 'src', 'data', 'portrait-bounds.json');

const imageSuffixes = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const correctedSuffixes = ['исправлено'];
const targetHeight = 1500;
const topPadding = 24;
const sidePadding = 24;
const webpQuality = 92;
const portraitSlices = {
  head: 0.22,
  shoulder: 0.34,
  chest: 0.48,
  waist: 0.62,
};

const translit = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const speakerStripPresets = {
  'Алексей Соколов.png': {
    source: 'Алексей Соколов.png',
    face: [378, 687, 397, 397],
  },
  'Долотова Инга.png': {
    source: 'Долотова Инга.png',
    face: [465, 327, 403, 403],
  },
  'Жадобко Сергей.png': {
    source: 'Жадобко Сергей.png',
    face: [676, 214, 430, 430],
  },
  'Илюшкина Екатерина.png': {
    source: 'Илюшкина Екатерина.png',
    face: [724, 381, 389, 389],
  },
  'Машинская Екатерина.png': {
    source: 'Машинская Екатерина.png',
    face: [679, 316, 420, 420],
  },
  'Мосиенко Евгений.png': {
    source: 'Мосиенко Евгений.png',
    face: [625, 262, 340, 340],
  },
  'Надымова Валерия.png': {
    source: 'Надымова Валерия.png',
    face: [487, 229, 502, 502],
  },
  'Нижегородцева Евгения.png': {
    source: 'Нижегородцева Евгения.png',
    face: [690, 282, 395, 395],
  },
  'Попадин Александр.png': {
    source: 'Попадин Александр.png',
    face: [485, 372, 319, 319],
  },
  'Скребцова Анастасия.png': {
    source: 'Скребцова Анастасия.png',
    face: [759, 332, 395, 395],
  },
  'Татьяна Конюхова.png': {
    source: 'Татьяна Конюхова.png',
    face: [451, 316, 335, 335],
  },
  'Удовенко Татьяна.png': {
    source: 'Удовенко Татьяна.png',
    face: [528, 348, 341, 341],
  },
  'Ярцев Андрей - 3.png': {
    source: 'Ярцев Андрей - 3.png',
    face: [623, 378, 324, 324],
  },
};

function slugify(value) {
  const lowered = value.toLowerCase();
  const transliterated = [...lowered].map((char) => translit[char] ?? char).join('');
  return transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function resolveSpeakerKey(sourcePath) {
  const stem = path.parse(sourcePath).name;
  const cleaned = stem.replace(/\s+\([^)]*\)$/u, '');
  return cleaned.split(' - ')[0];
}

function resolveSpeakerSlugSeed(sourcePath) {
  return path.parse(sourcePath).name;
}

function isCorrectedVariant(sourcePath) {
  const stem = path.parse(sourcePath).name.toLowerCase();
  return correctedSuffixes.some((suffix) => stem.includes(suffix));
}

function dedupeSpeakerSources(sources) {
  const correctedKeys = new Set(
    sources
      .filter((sourcePath) => isCorrectedVariant(sourcePath))
      .map((sourcePath) => resolveSpeakerKey(sourcePath)),
  );

  return sources.filter((sourcePath) => {
    const key = resolveSpeakerKey(sourcePath);
    const stem = path.parse(sourcePath).name;
    const shouldSkipOriginal = correctedKeys.has(key)
      && !isCorrectedVariant(sourcePath)
      && stem === key;
    return !shouldSkipOriginal;
  });
}

function parseTrimBox(value) {
  const match = value.trim().match(/^(?<width>\d+)x(?<height>\d+)\+(?<left>-?\d+)\+(?<top>-?\d+)$/u);
  if (!match?.groups) {
    throw new Error(`Could not parse trim box: ${value}`);
  }

  return {
    width: Number.parseInt(match.groups.width, 10),
    height: Number.parseInt(match.groups.height, 10),
    left: Number.parseInt(match.groups.left, 10),
    top: Number.parseInt(match.groups.top, 10),
  };
}

async function readTrimBox(sourcePath) {
  const { stdout } = await execFileAsync('identify', ['-format', '%@', sourcePath], {
    cwd: workspaceRoot,
  });
  return parseTrimBox(stdout);
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

function buildSpeakerStripGeometry(trimBox, faceBox) {
  const scale = targetHeight / trimBox.height;
  const scaledWidth = Math.round(trimBox.width * scale);
  const faceCenterX = faceBox
    ? (faceBox[0] - trimBox.left + faceBox[2] / 2) * scale
    : scaledWidth / 2;
  const halfSpan = Math.max(faceCenterX, scaledWidth - faceCenterX);
  const canvasWidth = Math.ceil(Math.max(scaledWidth, halfSpan * 2) + sidePadding * 2);

  return {
    crop: trimBox,
    canvasWidth,
    canvasHeight: targetHeight + topPadding,
    offsetX: Math.round(canvasWidth / 2 - faceCenterX),
    offsetY: topPadding,
  };
}

async function renderSpeakerStripPortrait(sourcePath, targetPath, geometry) {
  await execFileAsync(
    'convert',
    [
      '-size',
      `${geometry.canvasWidth}x${geometry.canvasHeight}`,
      'xc:none',
      '(',
      sourcePath,
      '-alpha',
      'on',
      '-crop',
      `${geometry.crop.width}x${geometry.crop.height}+${geometry.crop.left}+${geometry.crop.top}`,
      '+repage',
      '-filter',
      'LanczosSharp',
      '-define',
      'filter:blur=0.96',
      '-resize',
      `x${targetHeight}`,
      ')',
      '-geometry',
      `+${geometry.offsetX}+${geometry.offsetY}`,
      '-compose',
      'over',
      '-composite',
      '-strip',
      '-quality',
      String(webpQuality),
      targetPath,
    ],
    { cwd: workspaceRoot },
  );
}

function roundMetric(value) {
  return Number.parseFloat(value.toFixed(4));
}

async function collectOutputBounds(targetPath) {
  const { stdout } = await execFileAsync('identify', ['-format', '%wx%h %@', targetPath], {
    cwd: workspaceRoot,
  });
  const [geometry, trim] = stdout.trim().split(/\s+/u);
  const [widthText, heightText] = geometry.split('x');
  const bounds = parseTrimBox(trim);
  const width = Number.parseInt(widthText, 10);
  const height = Number.parseInt(heightText, 10);

  return {
    ...await collectSliceBounds(targetPath, width, height),
    width,
    height,
    visibleLeft: roundMetric(bounds.left / width),
    visibleTop: roundMetric(bounds.top / height),
    visibleRight: roundMetric((bounds.left + bounds.width) / width),
    visibleBottom: roundMetric((bounds.top + bounds.height) / height),
  };
}

async function collectSliceBounds(targetPath, width, height) {
  const slices = {};

  for (const [key, ratio] of Object.entries(portraitSlices)) {
    const y = Math.max(0, Math.min(height - 1, Math.round(height * ratio)));
    const { stdout } = await execFileAsync(
      'convert',
      [
        targetPath,
        '-alpha',
        'extract',
        '-crop',
        `${width}x1+0+${y}`,
        'txt:-',
      ],
      {
        cwd: workspaceRoot,
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    let first = -1;
    let last = -1;

    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\d+),0: .* gray\((\d+)\)$/u);
      if (!match) {
        continue;
      }

      const alpha = Number.parseInt(match[2], 10);
      if (alpha <= 0) {
        continue;
      }

      const x = Number.parseInt(match[1], 10);
      if (first < 0) {
        first = x;
      }
      last = x;
    }

    if (first < 0 || last < 0) {
      continue;
    }

    slices[key] = {
      y: roundMetric(y / height),
      visibleLeft: roundMetric(first / width),
      visibleRight: roundMetric(last / width),
      coverage: roundMetric((last - first) / width),
    };
  }

  return { slices };
}

async function listSpeakerCutouts() {
  const entries = await fs.readdir(speakerCutoutsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && imageSuffixes.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(speakerCutoutsRoot, entry.name))
    .sort((left, right) => left.localeCompare(right, 'ru'));
}

export async function prepareSpeakerStripPortraits() {
  await ensureDir(speakerStripOut);

  const sources = dedupeSpeakerSources(await listSpeakerCutouts());
  const boundsManifest = {};

  for (const sourcePath of sources) {
    const sourceName = path.basename(sourcePath);
    const preset = speakerStripPresets[sourceName];
    const actualSourcePath = preset ? path.join(speakerCutoutsRoot, preset.source) : sourcePath;
    const trimBox = await readTrimBox(actualSourcePath);
    const geometry = buildSpeakerStripGeometry(trimBox, preset?.face);
    const slug = slugify(resolveSpeakerSlugSeed(sourcePath));
    const targetPath = path.join(speakerStripOut, `${slug}.webp`);

    await renderSpeakerStripPortrait(actualSourcePath, targetPath, geometry);

    boundsManifest[`/generated/speaker-strip/${slug}.webp`] = await collectOutputBounds(targetPath);
  }

  await ensureDir(path.dirname(portraitBoundsOut));
  await fs.writeFile(
    portraitBoundsOut,
    JSON.stringify(boundsManifest, null, 2),
    'utf-8',
  );

  return boundsManifest;
}
