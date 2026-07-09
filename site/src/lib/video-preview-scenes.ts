import { getFestivalEvents, type FestivalEvent } from './festival';
import {
  getDialoguePortraitImage,
  getDialoguePortraitStyle,
  getEventPortraitImage,
  getEventPortraitStyle,
  getSpeakerCaption,
} from './media';
import registrationManifest from '../data/registration-state-manifest.json';
import videoProgramConfig from '../data/video-preview-program.json';

export type VideoPreviewSceneKind = 'cold-open' | 'act-title' | 'boost' | 'dialogue' | 'cascade' | 'site' | 'qr' | 'sequence';

type VideoPreviewBaseScene = {
  slug: string;
  label: string;
  kind: VideoPreviewSceneKind;
  durationMs: number;
};

export type VideoPreviewColdOpenScene = VideoPreviewBaseScene & {
  kind: 'cold-open';
  tagline: string[];
  supportLine: string;
  period: string;
};

export type VideoPreviewActTitleScene = VideoPreviewBaseScene & {
  kind: 'act-title';
  kicker?: string;
  title: string;
  subtitle?: string;
};

export type VideoPreviewBoostScene = VideoPreviewBaseScene & {
  kind: 'boost';
  eyebrow: string;
  shortTitle: string;
  hook?: string;
  mythLabel?: string;
  mythText?: string;
  detailLabel: string;
  detailLines: string[];
  detailAttribution?: string;
  titleStyle?: string;
  speakerName: string;
  speakerRole: string;
  portraitImage: string;
  portraitStyle?: string;
  posterImage?: string;
  dateLabel: string;
  venue: string;
  accessLabel?: string;
  availabilityLabel?: string;
  availabilityTone?: 'available' | 'low' | 'soon';
};

export type VideoPreviewDialogueScene = VideoPreviewBaseScene & {
  kind: 'dialogue';
  variant: 'bottom-strip' | 'side-strip' | 'split-strip';
  eyebrow: string;
  titleLines: string[];
  subtitle: string;
  supportLine: string;
  participants: Array<{
    name: string;
    role: string;
    image: string;
    imageStyle?: string;
    monogram: string;
  }>;
  dateLabel: string;
  venue: string;
  accessLabel?: string;
  availabilityLabel?: string;
  availabilityTone?: 'available' | 'low' | 'soon';
};

export type VideoPreviewCascadeScene = VideoPreviewBaseScene & {
  kind: 'cascade';
  eyebrow?: string;
  routeLabel: string;
  cards: Array<{
    title: string;
    date: string;
  }>;
};

export type VideoPreviewSiteScene = VideoPreviewBaseScene & {
  kind: 'site';
  domain: string;
  title: string;
  period: string;
  subtitle: string;
};

export type VideoPreviewQrScene = VideoPreviewBaseScene & {
  kind: 'qr';
  platform: 'Telegram' | 'Max';
  title: string;
  subtitle: string;
  secondary: string;
  qrPath: string;
  href: string;
};

export type VideoPreviewSequenceScene = VideoPreviewBaseScene & {
  kind: 'sequence';
  title: string;
};

export type VideoPreviewScene =
  | VideoPreviewColdOpenScene
  | VideoPreviewActTitleScene
  | VideoPreviewBoostScene
  | VideoPreviewDialogueScene
  | VideoPreviewCascadeScene
  | VideoPreviewSiteScene
  | VideoPreviewQrScene
  | VideoPreviewSequenceScene;

type BoostSceneSeed = {
  slug: string;
  label: string;
  eventMatch: string;
  eyebrow: string;
  shortTitle: string;
  hook?: string;
  mythText?: string;
  detailLabel: string;
  detailLines: string[];
  detailAttribution?: string;
  durationMs?: number;
  portraitStyle?: string;
};

type DialogueSceneSeed = {
  slug: string;
  label: string;
  eventMatch: string;
  variant: VideoPreviewDialogueScene['variant'];
  eyebrow: string;
  titleLines: string[];
  subtitle: string;
  supportLine: string;
  durationMs?: number;
};

type ActTitleSceneSeed = {
  slug: string;
  label: string;
  title: string;
  kicker?: string;
  subtitle?: string;
  durationMs?: number;
};

type CascadeSceneSeed = {
  slug: string;
  label: string;
  eyebrow?: string;
  routeLabel: string;
  durationMs?: number;
  cards: Array<{
    eventMatch: string;
    title: string;
  }>;
};

type LectureBeatSceneSeed = {
  sceneSlug: string;
  eventSlug: string;
  shortTitle: string;
  mythText?: string;
  durationMs?: number;
  portraitStyle?: string;
};

type VideoPreviewProgramConfig = {
  acts: Array<{
    id: string;
    sceneSlug: string;
    sceneSlugs: string[];
  }>;
  lectureBeatScenes: LectureBeatSceneSeed[];
};

const videoProgram = videoProgramConfig as VideoPreviewProgramConfig;
const actSceneCountBySlug = new Map(videoProgram.acts.map((act) => [act.sceneSlug, act.sceneSlugs.length] as const));

function normalizeDialogueVenueLabel(value?: string) {
  const venue = value?.trim() ?? '';
  if (!venue || venue.toUpperCase() === 'ПЛОЩАДКА УТОЧНЯЕТСЯ') {
    return '';
  }
  return venue;
}

const DIALOGUE_SCENE_PARTICIPANT_STYLE_OVERRIDES: Record<string, Array<{ match: string; style: string }>> = {
  'dialogue-opening-side': [
    { match: 'Ярцев', style: '--dialogue-portrait-scale-side: 0.64; --dialogue-portrait-x-side: 12px; --dialogue-portrait-y-side: 8px;' },
    { match: 'Левченков', style: '--dialogue-portrait-scale-side: 0.64; --dialogue-portrait-x-side: 10px; --dialogue-portrait-y-side: 8px;' },
  ],
  'dialogue-tourists-side': [
    { match: 'Удовенко', style: '--dialogue-portrait-scale-side: 0.65; --dialogue-portrait-x-side: 10px; --dialogue-portrait-y-side: 6px;' },
    { match: 'Селин', style: '--dialogue-portrait-scale-side: 0.65; --dialogue-portrait-x-side: -4px; --dialogue-portrait-y-side: 2px;' },
  ],
  'dialogue-habits-side': [
    { match: 'Долотова', style: '--dialogue-portrait-scale-side: 0.65; --dialogue-portrait-x-side: 4px; --dialogue-portrait-y-side: -4px;' },
    { match: 'Ярцев', style: '--dialogue-portrait-scale-side: 0.66; --dialogue-portrait-x-side: 6px; --dialogue-portrait-y-side: 4px;' },
    { match: 'Попадин', style: '--dialogue-portrait-scale-side: 0.66; --dialogue-portrait-x-side: 2px; --dialogue-portrait-y-side: 10px;' },
    { match: 'Литвинович', style: '--dialogue-portrait-scale-side: 0.65; --dialogue-portrait-x-side: -10px; --dialogue-portrait-y-side: 2px;' },
  ],
  'dialogue-soviet-side': [
    { match: 'Марковец', style: '--dialogue-portrait-scale-side: 0.64; --dialogue-portrait-x-side: -4px; --dialogue-portrait-y-side: 14px;' },
    { match: 'Литвинович', style: '--dialogue-portrait-scale-side: 0.63; --dialogue-portrait-x-side: -8px; --dialogue-portrait-y-side: 6px;' },
    { match: 'Бойко', style: '--dialogue-portrait-scale-side: 0.64; --dialogue-portrait-x-side: 8px; --dialogue-portrait-y-side: 14px;' },
    { match: 'Никитин', style: '--dialogue-portrait-scale-side: 0.62; --dialogue-portrait-x-side: 10px; --dialogue-portrait-y-side: 0px;' },
  ],
  'dialogue-city-garden-side': [
    { match: 'Надымова', style: '--dialogue-portrait-scale-side: 0.67; --dialogue-portrait-x-side: -18px; --dialogue-portrait-y-side: 12px;' },
    { match: 'Анисимов', style: '--dialogue-portrait-scale-side: 0.67; --dialogue-portrait-x-side: 2px; --dialogue-portrait-y-side: 16px;' },
    { match: 'Сарниц', style: '--dialogue-portrait-scale-side: 0.65; --dialogue-portrait-x-side: 118px; --dialogue-portrait-y-side: 2px;' },
    { match: 'Марковец', style: '--dialogue-portrait-scale-side: 0.67; --dialogue-portrait-x-side: -8px; --dialogue-portrait-y-side: 16px;' },
    { match: 'Селин', style: '--dialogue-portrait-scale-side: 0.67; --dialogue-portrait-x-side: 8px; --dialogue-portrait-y-side: 16px;' },
  ],
};

const DIALOGUE_SCENE_PARTICIPANT_IMAGE_OVERRIDES: Record<string, Array<{ match: string; image: string }>> = {
  'dialogue-opening-side': [
    { match: 'Ярцев', image: '/generated/speaker-strip/yartsev-andrey-3.webp' },
  ],
};

type RegistrationManifestItem = {
  slug: string;
  capacity?: number;
  overbookingPercent?: number;
  registrationLimit?: number;
  registrationLimitPercent?: number;
  seatsTaken?: number;
  seatsLeft?: number;
  publicState?: string;
  registrationPublicState?: string;
  ctaLabel?: string;
};

type RegistrationManifest = {
  generatedAt?: string | null;
  items?: RegistrationManifestItem[];
};

const registrationStateBySlug = new Map(
  ((registrationManifest as RegistrationManifest).items ?? []).map((item) => [item.slug, item] as const),
);

const BOOST_SCENE_SEEDS: BoostSceneSeed[] = [
  {
    slug: 'dreams',
    label: 'Boost / О чём мечтали',
    eventMatch: 'О чём мечтали в советском Калининграде',
    eyebrow: 'ЛЕКЦИЯ · БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    shortTitle: 'О ЧЁМ МЕЧТАЛИ',
    hook: 'КУДА СТРЕМИЛИСЬ И КУДА ПОПАЛИ',
    mythText: 'В СОВЕТСКОМ КАЛИНИНГРАДЕ ЖИЗНЬ БЫЛА СКУЧНОЙ',
    detailLabel: 'ЛЕКТОР ОТВЕТИТ',
    detailLines: [
      'ПОЧЕМУ КАЛИНИНГРАД СТАЛ ГОРОДОМ СУМАСШЕДШИХ ВОЗМОЖНОСТЕЙ?',
    ],
    durationMs: 9200,
  },
  {
    slug: 'ocean',
    label: 'Boost / Океанологи',
    eventMatch: 'География исследований Мирового океана',
    eyebrow: 'ЛЕКЦИЯ · БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    shortTitle: 'ОКЕАНОЛОГИ КАЛИНИНГРАДА',
    hook: 'КАК КАЛИНИНГРАД ИЗУЧАЛ МИРОВОЙ ОКЕАН',
    mythText: 'КАЛИНИНГРАДСКИЕ УЧЁНЫЕ ИЗУЧАЛИ ОКЕАН ТОЛЬКО РАДИ РЫБЫ',
    detailLabel: 'ЦИТАТА',
    detailLines: [
      'ОКЕАН - ЭТО ХРАНИТЕЛЬ ИСТОРИИ, ДЫХАНИЕ ТЕКУЩЕГО МОМЕНТА,',
      'ВЕЧНЫЙ ЗОВ И НАДЕЖДА БУДУЩЕГО ЧЕЛОВЕЧЕСТВА.',
    ],
    detailAttribution: 'Владимир Андреевич Чечко',
    durationMs: 8600,
  },
  {
    slug: 'bridge',
    label: 'Boost / Мосты времени',
    eventMatch: 'Мост, который соединяет времена',
    eyebrow: 'ЛЕКЦИЯ · БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    shortTitle: 'МОСТЫ ВРЕМЕНИ',
    hook: 'ПРОШЛОЕ, НАСТОЯЩЕЕ, БУДУЩЕЕ',
    mythText: 'ДВУХЪЯРУСНЫЙ МОСТ СПРОЕКТИРОВАЛ ЭЙФЕЛЬ',
    detailLabel: 'ЛЕКТОР ОТВЕТИТ',
    detailLines: [
      'ПОЧЕМУ МОСТ ПОСТРОЕН В ДВА ЯРУСА?',
      'ЧТО В НЁМ НЕМЕЦКОЕ, А ЧТО ДОСТРОИЛИ СОВЕТСКИЕ ИНЖЕНЕРЫ?',
    ],
    durationMs: 9000,
    portraitStyle: '--event-portrait-size: 1.46; --event-portrait-shift-x: -0.18rem; --event-portrait-shift-y: 0.18rem; --event-portrait-width: min(45%, 37rem);',
  },
  {
    slug: 'future-city',
    label: 'Boost / Калининград 2125',
    eventMatch: 'Калининград 2125',
    eyebrow: 'ЛЕКЦИЯ · БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    shortTitle: 'КАЛИНИНГРАД 2125',
    hook: 'КАКИМ МОЖЕТ СТАТЬ ГОРОД ЧЕРЕЗ СТО ЛЕТ',
    mythText: 'КАЛИНИНГРАД - ПЕРИФЕРИЙНЫЙ ГОРОД БЕЗ БОЛЬШОГО БУДУЩЕГО',
    detailLabel: 'ЦИТАТА',
    detailLines: [
      'ЧЕРЕЗ СТО ЛЕТ ГОРОД БУДЕТ ТАКИМ,',
      'КАКИМ МЫ РЕШИМ СДЕЛАТЬ ЕГО СЕГОДНЯ.',
    ],
    detailAttribution: 'Артур Артурович Сарниц',
    portraitStyle: '--event-portrait-size: 1.82; --event-portrait-shift-x: -3.05rem; --event-portrait-shift-y: 0.14rem; --event-portrait-width: min(48.5%, 39.5rem);',
    durationMs: 9000,
  },
  {
    slug: 'zoo-right',
    label: 'Boost / Зачем городу зоопарк',
    eventMatch: 'Право на существование: зоопарки в современном мире',
    eyebrow: 'ЛЕКЦИЯ · БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    shortTitle: 'ЗАЧЕМ ГОРОДУ ЗООПАРК',
    hook: 'ПРАВО НА СУЩЕСТВОВАНИЕ И БУДУЩЕЕ ЗООПАРКА',
    detailLabel: 'ЛЕКЦИЯ ОТВЕЧАЕТ',
    detailLines: [
      'ПОЧЕМУ СОВРЕМЕННОМУ ГОРОДУ НУЖЕН ЗООПАРК?',
      'КАКОЕ БУДУЩЕЕ ВОЗМОЖНО ДЛЯ КАЛИНИНГРАДСКОГО ЗООПАРКА?',
    ],
    durationMs: 8600,
  },
  {
    slug: 'cinema',
    label: 'Boost / Калининград в кино',
    eventMatch: 'Калининград и область как кинодекорация',
    eyebrow: 'ЛЕКЦИЯ · БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    shortTitle: 'КАЛИНИНГРАД В КИНО',
    hook: 'ГДЕ В РЕГИОНЕ СНИМАЛИ ХУДОЖЕСТВЕННЫЕ ФИЛЬМЫ',
    mythText: 'В КАЛИНИНГРАДЕ СНИМАЛИ ТОЛЬКО ВОЕННЫЕ ФИЛЬМЫ',
    detailLabel: 'ЛЕКЦИЯ ОТВЕЧАЕТ',
    detailLines: [
      'ПОЧЕМУ РЕЖИССЁРЫ ДЕСЯТИЛЕТИЯМИ ВОЗВРАЩАЛИСЬ ИМЕННО СЮДА?',
      'КАК КИНО ПОКАЗЫВАЕТ ИСЧЕЗНУВШИЙ КАЛИНИНГРАД?',
    ],
    durationMs: 8600,
  },
];

const DIALOGUE_SCENE_SEEDS: DialogueSceneSeed[] = [
  {
    slug: 'public-talk-slat',
    label: 'Public Talk / Bottom Strip',
    eventMatch: 'Как говорить о советском Калининграде без ностальгического тумана и без стыда',
    variant: 'bottom-strip',
    eyebrow: '4 УЧАСТНИКА',
    titleLines: ['Как говорить', 'о советском', 'Калининграде', 'без ностальгического', 'тумана и без стыда'],
    subtitle: '',
    supportLine: '',
    durationMs: 7600,
  },
  {
    slug: 'public-talk-cutout',
    label: 'Public Talk / Side Strip',
    eventMatch: 'Как говорить о советском Калининграде без ностальгического тумана и без стыда',
    variant: 'side-strip',
    eyebrow: '4 УЧАСТНИКА',
    titleLines: ['Как говорить', 'о советском', 'Калининграде', 'без ностальгического', 'тумана и без стыда'],
    subtitle: '',
    supportLine: '',
    durationMs: 7600,
  },
  {
    slug: 'public-talk-wall',
    label: 'Public Talk / Split Strip',
    eventMatch: 'Как говорить о советском Калининграде без ностальгического тумана и без стыда',
    variant: 'split-strip',
    eyebrow: '4 УЧАСТНИКА',
    titleLines: ['Как говорить', 'о советском', 'Калининграде', 'без ностальгического', 'тумана и без стыда'],
    subtitle: '',
    supportLine: '',
    durationMs: 7600,
  },
  {
    slug: 'dialogue-opening-side',
    label: 'Dialogue / Opening / Side Strip',
    eventMatch: 'Открытие фестиваля «80 историй о главном»',
    variant: 'side-strip',
    eyebrow: 'ОТКРЫТИЕ ФЕСТИВАЛЯ · 2 УЧАСТНИКА',
    titleLines: ['Открытие', 'фестиваля', '«80 историй', 'о главном»'],
    subtitle: '',
    supportLine: '',
    durationMs: 7600,
  },
  {
    slug: 'dialogue-tourists-side',
    label: 'Dialogue / Tourists / Side Strip',
    eventMatch: 'Калининградская область глазами туристов: тогда и сейчас',
    variant: 'side-strip',
    eyebrow: '3 УЧАСТНИКА',
    titleLines: ['Калининградская', 'область глазами', 'туристов:', 'тогда и сейчас'],
    subtitle: '',
    supportLine: '',
    durationMs: 7600,
  },
  {
    slug: 'dialogue-sea-side',
    label: 'Dialogue / Sea / Side Strip',
    eventMatch: 'Разговоры о море',
    variant: 'side-strip',
    eyebrow: '3 УЧАСТНИКА',
    titleLines: ['Разговоры', 'о море'],
    subtitle: '',
    supportLine: 'Море здесь не фон, а образ жизни, профессия и характер города.',
    durationMs: 7600,
  },
  {
    slug: 'dialogue-habits-side',
    label: 'Dialogue / Habits / Side Strip',
    eventMatch: 'Привычки калининградцев / Ты настоящий калининградец, если... / Калининградцы глазами гостей',
    variant: 'side-strip',
    eyebrow: '4 УЧАСТНИКА',
    titleLines: ['Привычки', 'калининградцев /', 'Ты настоящий', 'калининградец, если... /', 'Калининградцы глазами', 'гостей'],
    subtitle: '',
    supportLine: '',
    durationMs: 7600,
  },
  {
    slug: 'dialogue-soviet-side',
    label: 'Dialogue / Soviet / Side Strip',
    eventMatch: 'Как говорить о советском Калининграде без ностальгического тумана и без стыда',
    variant: 'side-strip',
    eyebrow: '4 УЧАСТНИКА',
    titleLines: ['Как говорить', 'о советском', 'Калининграде', 'без ностальгического', 'тумана и без стыда'],
    subtitle: '',
    supportLine: 'Четыре участника о прошлом региона без ностальгии, стыда и удобных крайностей.',
    durationMs: 7600,
  },
  {
    slug: 'dialogue-city-garden-side',
    label: 'Dialogue / City Garden / Side Strip',
    eventMatch: 'Калининград город сад или микрорайон для проживания у моря',
    variant: 'side-strip',
    eyebrow: '5 УЧАСТНИКОВ',
    titleLines: ['Калининград', 'город сад', 'или микрорайон', 'для проживания у моря'],
    subtitle: '',
    supportLine: '',
    durationMs: 7600,
  },
];

const ACT_TITLE_SCENE_SEEDS: ActTitleSceneSeed[] = [
  {
    slug: 'act-settlement',
    label: 'Act Title / Как область стала домом',
    kicker: 'АКТ 1',
    title: 'КАК ОБЛАСТЬ\nСТАЛА ДОМОМ',
    subtitle: `${actSceneCountBySlug.get('act-settlement') ?? 0} АКТУАЛЬНЫХ ЛЕКЦИЙ`,
    durationMs: 1700,
  },
  {
    slug: 'act-sea',
    label: 'Act Title / Море и территория',
    kicker: 'АКТ 2',
    title: 'МОРЕ\nИ ТЕРРИТОРИЯ',
    subtitle: `${actSceneCountBySlug.get('act-sea') ?? 0} АКТУАЛЬНЫХ ЛЕКЦИЙ`,
    durationMs: 1700,
  },
  {
    slug: 'act-city',
    label: 'Act Title / Город, архитектура, среда',
    kicker: 'АКТ 3',
    title: 'ГОРОД,\nАРХИТЕКТУРА,\nСРЕДА',
    subtitle: `${actSceneCountBySlug.get('act-city') ?? 0} АКТУАЛЬНЫХ ЛЕКЦИЙ`,
    durationMs: 1700,
  },
  {
    slug: 'act-everyday',
    label: 'Act Title / Быт, память, культурные образы',
    kicker: 'АКТ 4',
    title: 'БЫТ,\nПАМЯТЬ,\nКУЛЬТУРНЫЕ ОБРАЗЫ',
    subtitle: `${actSceneCountBySlug.get('act-everyday') ?? 0} АКТУАЛЬНЫХ ЛЕКЦИЙ`,
    durationMs: 1700,
  },
  {
    slug: 'act-people',
    label: 'Act Title / Люди, профессии, институции',
    kicker: 'АКТ 5',
    title: 'ЛЮДИ,\nПРОФЕССИИ,\nИНСТИТУЦИИ',
    subtitle: `${actSceneCountBySlug.get('act-people') ?? 0} АКТУАЛЬНЫХ ЛЕКЦИЙ`,
    durationMs: 1700,
  },
  {
    slug: 'act-dialogues',
    label: 'Act Title / Открытые диалоги',
    kicker: 'АКТ 6',
    title: 'ОТКРЫТЫЕ\nДИАЛОГИ',
    subtitle: `${actSceneCountBySlug.get('act-dialogues') ?? 0} АКТУАЛЬНЫХ ПАБЛИК-ТОКОВ`,
    durationMs: 1700,
  },
];

const CASCADE_SCENE_SEEDS: CascadeSceneSeed[] = [
  {
    slug: 'cascade',
    label: 'Cascade / Названия событий',
    eyebrow: 'ROUGH CUT',
    routeLabel: 'ЧТО ЕЩЁ МОЖНО УСПЕТЬ',
    durationMs: 5600,
    cards: [
      { eventMatch: 'История становления и развития малых городов', title: 'МАЛЫЕ ГОРОДА' },
      { eventMatch: 'О чём мечтали в советском Калининграде', title: 'О ЧЁМ МЕЧТАЛИ' },
      { eventMatch: 'История Светлогорска в семейном альбоме', title: 'СВЕТЛОГОРСК В СЕМЕЙНОМ АЛЬБОМЕ' },
      { eventMatch: 'Право на существование: зоопарки', title: 'ЗАЧЕМ ГОРОДУ ЗООПАРК' },
      { eventMatch: 'Калининград 2125', title: 'КАЛИНИНГРАД 2125' },
      { eventMatch: 'Калининград и область как кинодекорация', title: 'КАЛИНИНГРАД В КИНО' },
    ],
  },
  {
    slug: 'settlement-cascade',
    label: 'Cascade / Как область стала домом',
    eyebrow: 'АКТ 1 · 6 СОБЫТИЙ',
    routeLabel: 'КАК ОБЛАСТЬ СТАЛА ДОМОМ',
    durationMs: 6200,
    cards: [
      { eventMatch: 'История становления и развития малых городов', title: 'МАЛЫЕ ГОРОДА' },
      { eventMatch: 'Демография первого десятилетия', title: 'ДЕМОГРАФИЯ ПЕРВОГО ДЕСЯТИЛЕТИЯ' },
      { eventMatch: 'История Светлогорска в семейном альбоме', title: 'СВЕТЛОГОРСК В СЕМЕЙНОМ АЛЬБОМЕ' },
      { eventMatch: 'Восприятие новой родины переселенцами', title: 'НОВАЯ РОДИНА ПЕРЕСЕЛЕНЦЕВ' },
      { eventMatch: 'Советский Гусев — время созиданий', title: 'СОВЕТСКИЙ ГУСЕВ' },
      { eventMatch: 'Приморский (Зеленоградский) район', title: 'ПРИМОРСКИЙ РАЙОН' },
    ],
  },
  {
    slug: 'sea-cascade',
    label: 'Cascade / Море и территория',
    eyebrow: 'АКТ 2 · 4 СОБЫТИЯ',
    routeLabel: 'МОРЕ И ТЕРРИТОРИЯ',
    durationMs: 6200,
    cards: [
      { eventMatch: 'История парусного спорта', title: 'ИСТОРИЯ ПАРУСНОГО СПОРТА' },
      { eventMatch: 'Первые на косе', title: 'ПЕРВЫЕ НА КОСЕ' },
      { eventMatch: 'Мирная жизнь самой западной точки России', title: 'МИРНАЯ ЖИЗНЬ БАЛТИЙСКОЙ КОСЫ' },
      { eventMatch: 'История образования и развития национального парка', title: 'НАЦПАРК «КУРШСКАЯ КОСА»' },
    ],
  },
  {
    slug: 'city-cascade',
    label: 'Cascade / Город, архитектура, среда',
    eyebrow: 'АКТ 3 · 5 СОБЫТИЙ',
    routeLabel: 'ГОРОД, АРХИТЕКТУРА, СРЕДА',
    durationMs: 6200,
    cards: [
      { eventMatch: 'Влияние планировочных решений на качество жизни', title: 'КАК ГОРОД ВЛИЯЕТ НА ЖИЗНЬ' },
      { eventMatch: 'Архитектура советского Калининграда', title: 'АРХИТЕКТУРА СОВЕТСКОГО КАЛИНИНГРАДА' },
      { eventMatch: 'Голубые ладони города К.', title: 'ГОЛУБЫЕ ЛАДОНИ ГОРОДА' },
      { eventMatch: 'Памятники искусства и истории в ландшафте Калининградского зоопарка', title: 'ПАМЯТНИКИ В ЛАНДШАФТЕ ЗООПАРКА' },
      { eventMatch: 'Зелёная память: история Ботанического сада', title: 'ЗЕЛЁНАЯ ПАМЯТЬ' },
    ],
  },
  {
    slug: 'everyday-cascade',
    label: 'Cascade / Быт, память, культурные образы',
    eyebrow: 'АКТ 4 · 4 СОБЫТИЯ',
    routeLabel: 'БЫТ, ПАМЯТЬ, КУЛЬТУРНЫЕ ОБРАЗЫ',
    durationMs: 6200,
    cards: [
      { eventMatch: 'Природа чемодана', title: 'ПРИРОДА ЧЕМОДАНА' },
      { eventMatch: 'Калининградская область — вдохновение для писателей', title: 'ВДОХНОВЕНИЕ ДЛЯ ПИСАТЕЛЕЙ' },
      { eventMatch: 'Денежное обращение в послевоенный период', title: 'ДЕНЕЖНОЕ ОБРАЩЕНИЕ 1945-1947' },
      { eventMatch: 'Привычки калининградцев, юмор, суеверия', title: 'ПРИВЫЧКИ И ЛЕГЕНДЫ' },
    ],
  },
  {
    slug: 'people-cascade',
    label: 'Cascade / Люди, профессии, институции',
    eyebrow: 'АКТ 5 · 5 СОБЫТИЙ',
    routeLabel: 'ЛЮДИ, ПРОФЕССИИ, ИНСТИТУЦИИ',
    durationMs: 6200,
    cards: [
      { eventMatch: 'Курсанты с крылышками', title: 'КУРСАНТЫ С КРЫЛЫШКАМИ' },
      { eventMatch: 'Калининградское здравоохранение', title: 'ЗДРАВООХРАНЕНИЕ ОБЛАСТИ' },
      { eventMatch: 'Зоопарку — быть!', title: 'ЗООПАРКУ - БЫТЬ!' },
      { eventMatch: 'Великие учителя', title: 'ВЕЛИКИЕ УЧИТЕЛЯ' },
      { eventMatch: 'Калининградский морской торговый порт', title: 'МОРСКОЙ ТОРГОВЫЙ ПОРТ' },
    ],
  },
];

function findEvent(events: FestivalEvent[], match: string) {
  const event = events.find((item) => item.title.includes(match));
  if (!event) {
    throw new Error(`Video preview event not found for match: ${match}`);
  }
  return event;
}

function findEventBySlug(events: FestivalEvent[], slug: string) {
  const event = events.find((item) => item.slug === slug);
  if (!event) {
    throw new Error(`Video preview event not found for slug: ${slug}`);
  }
  return event;
}

function isLecture(formatLabel: string) {
  return formatLabel.toLowerCase().includes('лекц');
}

function resolveAvailabilityState(event: FestivalEvent) {
  const registrationState = registrationStateBySlug.get(event.slug);

  if (registrationState?.publicState === 'registration_soon' || event.publicRegistrationStateOverride === 'registration_soon') {
    return {
      label: 'РЕГИСТРАЦИЯ СКОРО',
      tone: 'soon' as const,
    };
  }

  if (registrationState?.publicState !== 'registration_open') {
    return undefined;
  }

  const capacity = registrationState.registrationLimit ?? registrationState.capacity ?? 0;
  const seatsLeft = registrationState.seatsLeft ?? 0;
  const ratio = capacity > 0 ? seatsLeft / capacity : 1;

  if (ratio < 0.1) {
    return {
      label: 'МАЛО МЕСТ',
      tone: 'low' as const,
    };
  }

  return {
    label: 'ЕСТЬ МЕСТА',
    tone: 'available' as const,
  };
}

function getBoostTitleStyle(shortTitle: string) {
  const plainLength = shortTitle.replace(/\s+/g, '').length;
  const titleSize = plainLength >= 30 ? 4.45 : plainLength >= 24 ? 4.88 : plainLength >= 18 ? 5.42 : plainLength >= 13 ? 5.94 : 6.6;
  const titleMax = plainLength >= 30 ? '12.5ch' : plainLength >= 24 ? '11.1ch' : plainLength >= 18 ? '9.8ch' : plainLength >= 13 ? '8.4ch' : '7ch';

  return `--boost-title-size:${titleSize}rem; --boost-title-max:${titleMax};`;
}

function wrapBoostDetailLines(text: string, maxLineLength = 34, maxLines = 3) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= maxLineLength || !currentLine) {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')];
}

function getDialogueMonogram(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase() ?? '')
    .join('');
}

function getDialogueSceneParticipantStyle(sceneSlug: string, participantName: string) {
  return DIALOGUE_SCENE_PARTICIPANT_STYLE_OVERRIDES[sceneSlug]
    ?.find((entry) => participantName.includes(entry.match))
    ?.style;
}

function getDialogueSceneParticipantImage(sceneSlug: string, participantName: string, fallbackImage: string) {
  return DIALOGUE_SCENE_PARTICIPANT_IMAGE_OVERRIDES[sceneSlug]
    ?.find((entry) => participantName.includes(entry.match))
    ?.image ?? fallbackImage;
}

function createBoostScene(events: FestivalEvent[], seed: BoostSceneSeed): VideoPreviewBoostScene {
  const event = findEvent(events, seed.eventMatch);
  const fallbackPortrait = event.speakerImages[0] ?? '';
  const portraitImage = fallbackPortrait
    ? getEventPortraitImage(event.speakerLabel, fallbackPortrait, isLecture(event.formatLabel))
    : '';
  const availabilityState = resolveAvailabilityState(event);

  return {
    slug: seed.slug,
    label: seed.label,
    kind: 'boost',
    durationMs: seed.durationMs ?? 5600,
    eyebrow: seed.eyebrow,
    shortTitle: seed.shortTitle,
    hook: seed.hook,
    mythLabel: seed.mythText ? 'ПРАВДА ЛИ, ЧТО' : undefined,
    mythText: seed.mythText,
    detailLabel: seed.detailLabel,
    detailLines: seed.detailLines,
    detailAttribution: seed.detailAttribution,
    titleStyle: undefined,
    speakerName: event.speakerLabel,
    speakerRole: event.affiliation,
    portraitImage,
    portraitStyle: [
      getEventPortraitStyle(event.speakerLabel, isLecture(event.formatLabel)),
      seed.portraitStyle,
    ]
      .filter(Boolean)
      .join(' '),
    posterImage: event.image,
    dateLabel: event.dateLabel,
    venue: event.venue,
    accessLabel: 'БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    availabilityLabel: availabilityState?.label,
    availabilityTone: availabilityState?.tone,
  };
}

function createLectureBeatScene(events: FestivalEvent[], seed: LectureBeatSceneSeed): VideoPreviewBoostScene {
  const event = findEventBySlug(events, seed.eventSlug);
  const fallbackPortrait = event.speakerImages[0] ?? '';
  const portraitImage = fallbackPortrait
    ? getEventPortraitImage(event.speakerLabel, fallbackPortrait, isLecture(event.formatLabel))
    : '';
  const availabilityState = resolveAvailabilityState(event);

  return {
    slug: seed.sceneSlug,
    label: `Lecture Beat / ${seed.shortTitle}`,
    kind: 'boost',
    durationMs: seed.durationMs ?? 7600,
    eyebrow: 'ЛЕКЦИЯ',
    shortTitle: seed.shortTitle,
    mythLabel: seed.mythText ? 'ПРАВДА ЛИ, ЧТО' : undefined,
    mythText: seed.mythText,
    detailLabel: 'СОБЫТИЕ',
    detailLines: wrapBoostDetailLines(event.title.toLocaleUpperCase('ru-RU')),
    speakerName: event.speakerLabel,
    speakerRole: event.affiliation,
    titleStyle: getBoostTitleStyle(seed.shortTitle),
    portraitImage,
    portraitStyle: [
      getEventPortraitStyle(event.speakerLabel, isLecture(event.formatLabel)),
      seed.portraitStyle,
    ]
      .filter(Boolean)
      .join(' '),
    posterImage: event.image,
    dateLabel: event.dateLabel,
    venue: event.venue,
    accessLabel: 'БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    availabilityLabel: availabilityState?.label,
    availabilityTone: availabilityState?.tone,
  };
}

function createDialogueScene(events: FestivalEvent[], seed: DialogueSceneSeed): VideoPreviewDialogueScene {
  const event = findEvent(events, seed.eventMatch);
  const availabilityState = resolveAvailabilityState(event);

  return {
    slug: seed.slug,
    label: seed.label,
    kind: 'dialogue',
    variant: seed.variant,
    durationMs: seed.durationMs ?? 5600,
    eyebrow: seed.eyebrow,
    titleLines: seed.titleLines,
    subtitle: seed.subtitle,
    supportLine: seed.supportLine,
    participants: event.dialogueParticipants
      .map((participant) => ({
        name: participant.name,
        role: getSpeakerCaption(participant.affiliation),
        image: participant.images[0]
          ? getDialogueSceneParticipantImage(
              seed.slug,
              participant.name,
              getDialoguePortraitImage(participant.name, participant.images[0]),
            )
          : '',
        imageStyle: [
          getDialoguePortraitStyle(participant.name),
          getDialogueSceneParticipantStyle(seed.slug, participant.name),
        ]
          .filter(Boolean)
          .join(' ') || undefined,
        monogram: getDialogueMonogram(participant.name),
      })),
    dateLabel: event.dateLabel,
    venue: normalizeDialogueVenueLabel(event.venue),
    accessLabel: 'БЕСПЛАТНО ПО РЕГИСТРАЦИИ',
    availabilityLabel: availabilityState?.label,
    availabilityTone: availabilityState?.tone,
  };
}

function createActTitleScene(seed: ActTitleSceneSeed): VideoPreviewActTitleScene {
  return {
    slug: seed.slug,
    label: seed.label,
    kind: 'act-title',
    durationMs: seed.durationMs ?? 1700,
    kicker: seed.kicker,
    title: seed.title,
    subtitle: seed.subtitle,
  };
}

function createCascadeScene(events: FestivalEvent[], seed: CascadeSceneSeed): VideoPreviewCascadeScene {
  return {
    slug: seed.slug,
    label: seed.label,
    kind: 'cascade',
    durationMs: seed.durationMs ?? 5600,
    eyebrow: seed.eyebrow,
    routeLabel: seed.routeLabel,
    cards: seed.cards.map((card) => {
      const event = findEvent(events, card.eventMatch);
      return {
        title: card.title,
        date: event.dateLabel,
      };
    }),
  };
}

export const VIDEO_PREVIEW_ROUGH_CUT_SCENE_SLUGS = [
  'cold-open',
  ...videoProgram.acts.flatMap((act) => [act.sceneSlug, ...act.sceneSlugs]),
  'telegram',
  'max',
] as const;

export function getVideoPreviewScenes(): VideoPreviewScene[] {
  const events = getFestivalEvents({ includeHidden: true });

  return [
    {
      slug: 'cold-open',
      label: 'Cold Open',
      kind: 'cold-open',
      durationMs: 3800,
      tagline: ['НЕ ТОЛЬКО', 'О ПРОШЛОМ'],
      supportLine: '43 СПИКЕРА · 50+ СОБЫТИЙ · БЕСПЛАТНО',
      period: '28 МАРТА - 19 ИЮЛЯ 2026',
    },
    ...ACT_TITLE_SCENE_SEEDS.map((seed) => createActTitleScene(seed)),
    ...BOOST_SCENE_SEEDS.map((seed) => createBoostScene(events, seed)),
    ...videoProgram.lectureBeatScenes.map((seed) => createLectureBeatScene(events, seed)),
    ...DIALOGUE_SCENE_SEEDS.map((seed) => createDialogueScene(events, seed)),
    ...CASCADE_SCENE_SEEDS.map((seed) => createCascadeScene(events, seed)),
    {
      slug: 'festival-flow',
      label: 'Sequence / Общий ролик',
      kind: 'sequence',
      durationMs: 16000,
      title: 'ОБЩИЙ РОЛИК',
    },
    {
      slug: 'site',
      label: 'Site CTA',
      kind: 'site',
      durationMs: 4400,
      domain: 'KGD80.RU',
      title: '80 ИСТОРИЙ О ГЛАВНОМ',
      period: '28 МАРТА - 19 ИЮЛЯ 2026',
      subtitle: 'РЕГИСТРАЦИЯ НА САЙТЕ',
    },
    {
      slug: 'telegram',
      label: 'QR / Telegram',
      kind: 'qr',
      durationMs: 10000,
      platform: 'Telegram',
      title: 'ПОЛЮБИТЬ КАЛИНИНГРАД АНОНСЫ',
      subtitle: '@kenigevents',
      secondary: 'ОПЕРАТИВНЫЕ АНОНСЫ ПО ФЕСТИВАЛЮ',
      qrPath: '/generated/telegram/kenigevents-qr-stat.svg',
      href: 'https://t.me/+Jhg7TZBUTNc3ZmMy',
    },
    {
      slug: 'max',
      label: 'QR / Max',
      kind: 'qr',
      durationMs: 10000,
      platform: 'Max',
      title: 'ПОЛЮБИТЬ КАЛИНИНГРАД АНОНСЫ',
      subtitle: 'max.ru',
      secondary: 'ОПЕРАТИВНЫЕ АНОНСЫ ПО ФЕСТИВАЛЮ',
      qrPath: '/generated/max/max-channel-qr.svg',
      href: 'https://max.ru/channel_kenigevents',
    },
  ];
}

export function getVideoPreviewScene(slug: string) {
  return getVideoPreviewScenes().find((scene) => scene.slug === slug);
}

export function getVideoPreviewRoughCutSceneSlugs() {
  return [...VIDEO_PREVIEW_ROUGH_CUT_SCENE_SLUGS];
}
