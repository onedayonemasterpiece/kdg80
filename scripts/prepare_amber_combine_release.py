#!/usr/bin/env python3
"""Apply the small remaining integration changes for the 11 August amber event.

The main event page, migration and /special/ card already live in the feature branch.
This script deliberately touches only:
- the homepage special hero;
- the canonical special-event requirements appendix;
- the two prepared WebP assets, when source paths are supplied.

It is safe to run more than once.
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOMEPAGE = ROOT / "site/src/pages/index.astro"
REQUIREMENTS = ROOT / "Исходные данные/Спецмероприятия/specialregistration.md"
PUBLIC_SPECIAL = ROOT / "site/public/generated/special"

HERO_BLOCK = """const amberCombineHeroVariant: HeroMythVariant = {
  id: 'special-amber-combine-jewelry-excursion',
  kind: 'myth',
  className: 'hero-showcase--special-event',
  prompt: 'Спецмероприятие по итогам фестиваля',
  label: 'Спецмероприятие по итогам фестиваля',
  title: 'Как янтарь становится украшением',
  body: 'Редкий визит на действующее ювелирное производство Калининградского янтарного комбината Ростеха — для активных участников фестиваля «80 историй о главном». 11 августа · 11:00.',
  eventHref: '/special/amber-combine-jewelry-excursion/',
  backdropImage: AMBER_COMBINE_HERO_IMAGE,
  ctaLabel: 'Подать заявку',
  specialRegistration: {
    apiBaseUrl: SPECIAL_API_BASE_URL,
    eventSlug: AMBER_COMBINE_EVENT_SLUG,
    token: AMBER_COMBINE_EVENT_TOKEN,
    availableLabel: 'Подать заявку',
    closedLabel: 'Заявки закрыты',
  },
  priority: 1005,
  fixedFirst: true,
};"""

REQUIREMENTS_SECTION = """

## Спецмероприятие `Экскурсия на ювелирное производство Калининградского янтарного комбината`

- Каноническое название: `Экскурсия на ювелирное производство Калининградского янтарного комбината`. — Статус: `Не подтверждено пользователем`
- Формат: редкий производственный визит в действующее ювелирное производство Калининградского янтарного комбината; событие не является посещением музея, «Янтарной палаты», карьера или обычной музейной экспозиции. — Статус: `Не подтверждено пользователем`
- Публичная площадка: `Калининградский янтарный комбинат, посёлок Янтарный`. — Статус: `Не подтверждено пользователем`
- Дата и время: `11 августа 2026 года, 11:00`. — Статус: `Не подтверждено пользователем`
- Событие предназначено для активных участников фестиваля `80 историй о главном`. — Статус: `Не подтверждено пользователем`
- Для допуска к заявке нужно не менее `5` подтверждённых штампов в Паспорте участника фестиваля. — Статус: `Не подтверждено пользователем`
- Внутренняя физическая квота и квота розыгрыша составляют `6` мест; резерв организаторов — `0`. — Статус: `Не подтверждено пользователем`
- На публичной странице, в карточке, hero, форме, метаданных и Schema.org количество победителей не указывается; используется формулировка `Количество мест ограничено · победителей определит розыгрыш`. — Статус: `Не подтверждено пользователем`
- Розыгрыш автоматически проводится за сутки до экскурсии — `10 августа 2026 года`. — Статус: `Не подтверждено пользователем`
- Заявка не является билетом; участие возможно только после персонального подтверждения победы организатором. — Статус: `Не подтверждено пользователем`
- Точная точка сбора, требования пропускного режима, безопасности и одежды направляются победителям персонально после согласования с площадкой. — Статус: `Не подтверждено пользователем`
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-image",
        type=Path,
        help="Prepared 1200x900 amber-combine-jewelry-production.webp",
    )
    parser.add_argument(
        "--source-og",
        type=Path,
        help="Prepared 1200x630 amber-combine-jewelry-production-og.webp",
    )
    return parser.parse_args()


def replace_required(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"Cannot find expected {label}; stop instead of guessing.")
    return text.replace(old, new, 1)


def update_homepage() -> bool:
    original = HOMEPAGE.read_text(encoding="utf-8")
    text = original

    text = replace_required(
        text,
        "const YANTAR_HERO_IMAGE = '/generated/special/yantar-excursion.webp';",
        "const AMBER_COMBINE_HERO_IMAGE = '/generated/special/amber-combine-jewelry-production.webp';",
        "YANTAR_HERO_IMAGE constant",
    )
    text = replace_required(
        text,
        "const YANTAR_EVENT_SLUG = 'yantar-excursion';",
        "const AMBER_COMBINE_EVENT_SLUG = 'amber-combine-jewelry-excursion';",
        "YANTAR_EVENT_SLUG constant",
    )
    text = replace_required(
        text,
        "const YANTAR_EVENT_TOKEN = 'yantar-excursion-20260716';",
        "const AMBER_COMBINE_EVENT_TOKEN = 'amber-combine-jewelry-20260811';",
        "YANTAR_EVENT_TOKEN constant",
    )

    if "const amberCombineHeroVariant: HeroMythVariant" not in text:
        pattern = re.compile(
            r"const yantarHeroVariant: HeroMythVariant = \{.*?\n\};\n(?=const zooHeroVariant: HeroMythVariant)",
            re.DOTALL,
        )
        text, count = pattern.subn(f"{HERO_BLOCK}\n", text, count=1)
        if count != 1:
            raise RuntimeError("Cannot replace the existing shipyard hero block safely.")

    text = replace_required(
        text,
        "const heroStoryVariants = [zooHeroVariant, yantarHeroVariant, specialHeroVariant, ...(heroVariants.length ? heroVariants : [fallbackHeroVariant])];",
        "const heroStoryVariants = [amberCombineHeroVariant, zooHeroVariant, specialHeroVariant, ...(heroVariants.length ? heroVariants : [fallbackHeroVariant])];",
        "heroStoryVariants list",
    )

    if text == original:
        return False
    HOMEPAGE.write_text(text, encoding="utf-8")
    return True


def update_requirements() -> bool:
    original = REQUIREMENTS.read_text(encoding="utf-8")
    heading = "## Спецмероприятие `Экскурсия на ювелирное производство Калининградского янтарного комбината`"
    if heading in original:
        return False
    separator = "" if original.endswith("\n") else "\n"
    REQUIREMENTS.write_text(original + separator + REQUIREMENTS_SECTION.lstrip("\n"), encoding="utf-8")
    return True


def copy_asset(source: Path | None, target_name: str) -> bool:
    target = PUBLIC_SPECIAL / target_name
    if source is None:
        if target.exists():
            return False
        raise RuntimeError(
            f"Missing {target}. Supply its source path with the appropriate command-line option."
        )
    source = source.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if source.suffix.lower() != ".webp":
        raise RuntimeError(f"Expected a WebP file, got {source.name}")
    PUBLIC_SPECIAL.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() == source.read_bytes():
        return False
    shutil.copy2(source, target)
    return True


def verify_public_copy() -> None:
    paths = [
        ROOT / "site/src/pages/special/amber-combine-jewelry-excursion.astro",
        ROOT / "site/src/pages/special/index.astro",
        HOMEPAGE,
    ]
    forbidden = ("6 мест", "6 победител", "шесть мест", "шесть победител")
    for path in paths:
        text = path.read_text(encoding="utf-8").lower()
        for phrase in forbidden:
            if phrase in text:
                raise RuntimeError(f"Public quota leak in {path}: {phrase!r}")


def main() -> int:
    args = parse_args()
    changed: list[str] = []

    if update_homepage():
        changed.append(str(HOMEPAGE.relative_to(ROOT)))
    if update_requirements():
        changed.append(str(REQUIREMENTS.relative_to(ROOT)))
    if copy_asset(args.source_image, "amber-combine-jewelry-production.webp"):
        changed.append("site/public/generated/special/amber-combine-jewelry-production.webp")
    if copy_asset(args.source_og, "amber-combine-jewelry-production-og.webp"):
        changed.append("site/public/generated/special/amber-combine-jewelry-production-og.webp")

    verify_public_copy()

    if changed:
        print("Prepared amber-combine release files:")
        for path in changed:
            print(f"- {path}")
    else:
        print("Amber-combine release integration is already up to date.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
