import { getFestivalEvents, type FestivalEvent } from './festival';
import { getEventPortraitImage, getEventPortraitStyle } from './media';

export type FestivalSlideDeckSlideKind = 'cover' | 'overview' | 'event-myth' | 'event-lecture' | 'site' | 'qr';

type FestivalSlideDeckBaseSlide = {
  slug: string;
  label: string;
  kind: FestivalSlideDeckSlideKind;
};

export type FestivalSlideDeckCoverSlide = FestivalSlideDeckBaseSlide & {
  kind: 'cover';
  period: string;
};

export type FestivalSlideDeckOverviewSlide = FestivalSlideDeckBaseSlide & {
  kind: 'overview';
  featuredCount: string;
  title: string;
  facts: string[];
  footer: string;
};

export type FestivalSlideDeckEventMythSlide = FestivalSlideDeckBaseSlide & {
  kind: 'event-myth';
  eyebrow: string;
  mythLabel: string;
  mythText: string;
  anchorTitle: string;
  eventImage?: string;
  align: 'left' | 'right';
};

export type FestivalSlideDeckEventLectureSlide = FestivalSlideDeckBaseSlide & {
  kind: 'event-lecture';
  eyebrow: string;
  displayTitle: string;
  fullTitle: string;
  support: string;
  speakerName: string;
  speakerRole: string;
  eventImage?: string;
  portraitImage?: string;
  portraitStyle?: string;
  textOnlySpeaker?: boolean;
  dateLabel: string;
  venue: string;
  accessLabel: string;
};

export type FestivalSlideDeckSiteSlide = FestivalSlideDeckBaseSlide & {
  kind: 'site';
  domain: string;
  period: string;
  subtitle: string;
};

export type FestivalSlideDeckQrSlide = FestivalSlideDeckBaseSlide & {
  kind: 'qr';
  platform: 'Telegram' | 'Max';
  title: string;
  subtitle: string;
  channelTitle: string;
  qrPath: string;
  href: string;
};

export type FestivalSlideDeckSlide =
  | FestivalSlideDeckCoverSlide
  | FestivalSlideDeckOverviewSlide
  | FestivalSlideDeckEventMythSlide
  | FestivalSlideDeckEventLectureSlide
  | FestivalSlideDeckSiteSlide
  | FestivalSlideDeckQrSlide;

type EventSlideSeed = {
  slug: string;
  eventMatch: string;
  displayTitle: string;
  mythText: string;
  support: string;
  accessLabel?: string;
  forceTextSpeaker?: boolean;
  portraitImageOverride?: string;
  portraitStyleOverride?: string;
};

const EVENT_SLIDE_SEEDS: EventSlideSeed[] = [
  {
    slug: 'nostalgia',
    eventMatch: 'Ностальгический разговор',
    displayTitle: 'НОСТАЛЬГИЧЕСКИЙ\nРАЗГОВОР',
    mythText: 'МОРОЖЕНОЕ БЫЛО СЛАЩЕ,\nА ТРАВА ЗЕЛЕНЕЕ',
    support: 'О памяти, частной жизни и Калининграде 1960–1970-х годов.',
  },
  {
    slug: 'ocean',
    eventMatch: 'География исследований Мирового океана',
    displayTitle: 'ГЕОГРАФИЯ\nИССЛЕДОВАНИЙ',
    mythText: 'КАЛИНИНГРАДСКИЕ\nОКЕАНОЛОГИ ИЗУЧАЛИ\nВ ОСНОВНОМ БАЛТИЙСКОЕ МОРЕ',
    support: 'Как калининградские учёные исследовали Мировой океан.',
    forceTextSpeaker: true,
  },
  {
    slug: 'amber',
    eventMatch: 'Восстановление янтарного карьера и Янтарный комбинат',
    displayTitle: 'ЯНТАРНЫЙ\nКОМБИНАТ',
    mythText: 'ЯНТАРНЫЙ ПРОМЫСЕЛ\nПРОСТО ДОСТАЛСЯ\nГОТОВЫМ',
    support: 'Как после войны восстанавливали карьер и зачем янтарь нужен не только ювелирам.',
  },
  {
    slug: 'future-city',
    eventMatch: 'Калининград 2125',
    displayTitle: 'КАЛИНИНГРАД 2125',
    mythText: 'КАЛИНИНГРАД —\nПЕРИФЕРИЯ БЕЗ\nБОЛЬШОГО БУДУЩЕГО',
    support: 'Каким может стать город через сто лет.',
    portraitImageOverride: '/generated/speaker-strip/sarnits-artur.webp',
    portraitStyleOverride:
      '--event-portrait-width-desktop: min(41%, 31rem); --event-portrait-size: 2.25; --event-portrait-shift-x: -12.5rem; --event-portrait-shift-y: 0rem;',
  },
  {
    slug: 'small-towns',
    eventMatch: 'История становления и развития малых городов',
    displayTitle: 'МАЛЫЕ\nГОРОДА',
    mythText: 'В МАЛЫХ ГОРОДАХ\nНЕТ БУДУЩЕГО\nДЛЯ МОЛОДЫХ',
    support: 'История и развитие малых городов на примере Железнодорожного.',
  },
  {
    slug: 'dreams',
    eventMatch: 'О чём мечтали в советском Калининграде',
    displayTitle: 'О ЧЁМ\nМЕЧТАЛИ',
    mythText: 'В СОВЕТСКОМ\nКАЛИНИНГРАДЕ\nЖИЗНЬ БЫЛА СКУЧНОЙ',
    support: 'Куда стремились и куда попали жители советского Калининграда.',
  },
  {
    slug: 'sailing',
    eventMatch: 'История парусного спорта',
    displayTitle: 'ИСТОРИЯ\nПАРУСНОГО СПОРТА',
    mythText: 'ПАРУСНЫЙ СПОРТ\nВ КАЛИНИНГРАДЕ —\nЭТО НЕ ИСТОРИЯ РЕГИОНА',
    support: 'Как в регионе складывалась традиция паруса.',
  },
  {
    slug: 'space',
    eventMatch: 'Космическая орбита Калининграда',
    displayTitle: 'КОСМИЧЕСКАЯ\nОРБИТА',
    mythText: 'КАЛИНИНГРАД ЖИВЁТ\nВ ОСНОВНОМ\nТУРИЗМОМ',
    support: 'Как промышленность, производство и космос связаны с регионом.',
  },
  {
    slug: 'soviet-architecture',
    eventMatch: 'Архитектура советского Калининграда',
    displayTitle: 'АРХИТЕКТУРА\nСОВЕТСКОГО\nКАЛИНИНГРАДА',
    mythText: 'МЕЖДУ СОВЕТСКОЙ\nИ НЕМЕЦКОЙ АРХИТЕКТУРОЙ\nБЫЛ НЕПРЕОДОЛИМЫЙ КОНФЛИКТ',
    support: 'Как город строился в 1946–1960 годах.',
  },
  {
    slug: 'chief-architect',
    eventMatch: 'Влияние планировочных решений на качество жизни',
    displayTitle: 'КАК ГОРОД\nВЛИЯЕТ НА ЖИЗНЬ',
    mythText: 'КАЛИНИНГРАДУ\nДОСТАТОЧНО ОБЩИХ\nСТРОИТЕЛЬНЫХ НОРМ',
    support: 'Лекция главного архитектора о качестве городской среды.',
  },
  {
    slug: 'demography',
    eventMatch: 'Демография первого десятилетия',
    displayTitle: 'ДЕМОГРАФИЯ\nПЕРВОГО\nДЕСЯТИЛЕТИЯ',
    mythText: 'МАССОВОЕ ЗАСЕЛЕНИЕ\nОБЛАСТИ НАЧАЛОСЬ\nЛИШЬ ЛЕТОМ 1946 ГОДА',
    support: 'Как формировалось население самой западной области России.',
    accessLabel: 'БЕСПЛАТНО · РЕГИСТРАЦИЯ СКОРО ОТКРОЕТСЯ',
  },
  {
    slug: 'zoo-monuments',
    eventMatch: 'Памятники искусства и истории в ландшафте Калининградского зоопарка',
    displayTitle: 'ПАМЯТНИКИ\nВ ЛАНДШАФТЕ\nЗООПАРКА',
    mythText: 'СКУЛЬПТУРЫ У ГЛАВНОГО\nВХОДА ОСТАЛИСЬ\nС ДОВОЕННОГО ВРЕМЕНИ',
    support: 'Почему зоопарк можно назвать музеем под открытым небом.',
  },
  {
    slug: 'baltic-spit',
    eventMatch: 'Мирная жизнь самой западной точки России',
    displayTitle: 'МИРНАЯ ЖИЗНЬ\nБАЛТИЙСКОЙ\nКОСЫ',
    mythText: 'БАЛТИЙСКАЯ КОСА —\nКРАЙ КАРТЫ БЕЗ\nСВОЕЙ МИРНОЙ ИСТОРИИ',
    support: 'О людях, которые строили и удерживали этот хрупкий край.',
  },
  {
    slug: 'new-homeland',
    eventMatch: 'Восприятие новой родины переселенцами',
    displayTitle: 'НОВАЯ РОДИНА\nПЕРЕСЕЛЕНЦЕВ',
    mythText: 'ПЕРЕСЕЛЕНЦЫ СРАЗУ\nВОСПРИНЯЛИ ВОСТОЧНУЮ\nПРУССИЮ КАК ГОТОВЫЙ ДОМ',
    support: 'Как люди жили, работали и осваивали новое пространство.',
  },
  {
    slug: 'bridge',
    eventMatch: 'Мост, который соединяет времена',
    displayTitle: 'МОСТЫ\nВРЕМЕНИ',
    mythText: 'ДВУХЪЯРУСНЫЙ МОСТ\nСПРОЕКТИРОВАЛ\nЭЙФЕЛЬ',
    support: 'Прошлое, настоящее и будущее Двухъярусного моста.',
    portraitImageOverride: '/generated/speaker-strip/mosienko-evgeniy.webp',
    portraitStyleOverride:
      '--event-portrait-width-desktop: min(36%, 28rem); --event-portrait-size: 1.73; --event-portrait-shift-x: -4.4rem; --event-portrait-shift-y: 0rem;',
  },
  {
    slug: 'cinema',
    eventMatch: 'Калининград и область как кинодекорация',
    displayTitle: 'КАЛИНИНГРАД\nВ КИНО',
    mythText: 'В КАЛИНИНГРАДЕ\nСНИМАЛИ ТОЛЬКО\nВОЕННЫЕ ФИЛЬМЫ',
    support: 'Как регион стал кинодекорацией для десятков художественных фильмов.',
  },
];

function findEvent(events: FestivalEvent[], match: string) {
  const event = events.find((item) => item.title.includes(match));
  if (!event) {
    throw new Error(`Slide deck event not found for match: ${match}`);
  }
  return event;
}

function createEventSlides(events: FestivalEvent[], seed: EventSlideSeed, index: number) {
  const event = findEvent(events, seed.eventMatch);
  const fallbackPortrait = event.speakerImages[0] ?? '';
  const portraitImage = seed.forceTextSpeaker
    ? ''
    : seed.portraitImageOverride ?? getEventPortraitImage(event.speakerLabel, fallbackPortrait, true);
  const portraitStyle = seed.forceTextSpeaker ? undefined : getEventPortraitStyle(event.speakerLabel, true);
  const align = index % 2 === 0 ? 'right' : 'left';

  const mythSlide: FestivalSlideDeckEventMythSlide = {
    slug: `${seed.slug}-myth`,
    label: `Миф / ${event.title}`,
    kind: 'event-myth',
    eyebrow: '',
    mythLabel: 'ПРАВДА ЛИ, ЧТО',
    mythText: seed.mythText,
    anchorTitle: seed.displayTitle.replace(/\n/g, ' '),
    eventImage: event.image,
    align,
  };

  const lectureSlide: FestivalSlideDeckEventLectureSlide = {
    slug: `${seed.slug}-lecture`,
    label: `Лекция / ${event.title}`,
    kind: 'event-lecture',
    eyebrow: 'ОБ ЭТОМ ВЫ УЗНАЕТЕ НА ЛЕКЦИИ',
    displayTitle: seed.displayTitle,
    fullTitle: event.title,
    support: seed.support,
    speakerName: event.speakerLabel,
    speakerRole: event.heroRole || event.affiliation,
    eventImage: event.image,
    portraitImage: portraitImage || undefined,
    portraitStyle: [portraitStyle, seed.portraitStyleOverride].filter(Boolean).join(' ') || undefined,
    textOnlySpeaker: !portraitImage,
    dateLabel: event.dateLabel,
    venue: event.venue,
    accessLabel: seed.accessLabel ?? 'БЕСПЛАТНО · РЕГИСТРАЦИЯ НА САЙТЕ',
  };

  return [mythSlide, lectureSlide] as const;
}

export function getFestivalSlideDeckSlides(): FestivalSlideDeckSlide[] {
  const events = getFestivalEvents();
  const slides: FestivalSlideDeckSlide[] = [
    {
      slug: 'cover',
      label: 'Cover',
      kind: 'cover',
      period: '28 марта – 19 июля 2026',
    },
    {
      slug: 'overview',
      label: 'Program Overview',
      kind: 'overview',
      featuredCount: '16',
      title: 'ЛЕКЦИЙ,\nКОТОРЫЕ\nСТОИТ ЗАПОМНИТЬ',
      facts: [
        'ВСЕ МЕРОПРИЯТИЯ БЕСПЛАТНЫЕ',
        'РЕГИСТРАЦИЯ НА KGD80.RU',
        'ОПЕРАТИВНЫЕ АНОНСЫ В TELEGRAM И MAX',
      ],
      footer: 'ПРОЕКТОРНАЯ ПОДБОРКА ДЛЯ БЫСТРОГО ПРОСМОТРА В ЗАЛЕ',
    },
  ];

  EVENT_SLIDE_SEEDS.forEach((seed, index) => {
    slides.push(...createEventSlides(events, seed, index));
  });

  slides.push(
    {
      slug: 'site',
      label: 'Site CTA',
      kind: 'site',
      domain: 'KGD80.RU',
      period: '28 марта – 19 июля 2026',
      subtitle: 'САЙТ ДЛЯ РЕГИСТРАЦИИ НА СОБЫТИЯ ФЕСТИВАЛЯ',
    },
    {
      slug: 'telegram',
      label: 'Telegram QR',
      kind: 'qr',
      platform: 'Telegram',
      title: 'ОПЕРАТИВНЫЕ АНОНСЫ\nПО ФЕСТИВАЛЮ',
      subtitle: 'ПОДПИСЫВАЙТЕСЬ И СКАНИРУЙТЕ QR',
      channelTitle: 'ПОЛЮБИТЬ КАЛИНИНГРАД АНОНСЫ',
      qrPath: '/generated/telegram/kenigevents-qr-stat.svg',
      href: 'https://t.me/+Jhg7TZBUTNc3ZmMy',
    },
    {
      slug: 'max',
      label: 'Max QR',
      kind: 'qr',
      platform: 'Max',
      title: 'ОПЕРАТИВНЫЕ АНОНСЫ\nПО ФЕСТИВАЛЮ',
      subtitle: 'ПОДПИСЫВАЙТЕСЬ И СКАНИРУЙТЕ QR',
      channelTitle: 'ПОЛЮБИТЬ КАЛИНИНГРАД АНОНСЫ',
      qrPath: '/generated/max/max-channel-qr.svg',
      href: 'https://max.ru/channel_kenigevents',
    },
  );

  return slides;
}

export function getFestivalSlideDeckSlide(slug: string) {
  return getFestivalSlideDeckSlides().find((slide) => slide.slug === slug);
}
