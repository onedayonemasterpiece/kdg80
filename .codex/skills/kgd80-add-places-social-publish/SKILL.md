---
name: kgd80-add-places-social-publish
description: Use for KDG80 / kgd80 / «80 историй о главном» tasks that add seats, add places, change registration overbooking, or reopen availability on regular festival events. Ensures production overbooking/seat changes are verified and then mandatory VK and Telegram announcement cards/posts are published, including triggers like “добавить места”, “+N% овербукинга”, “места на все события”, “пост в VK/Telegram”.
---

# KGD80 Add Places Social Publish

Use this workflow only in the `kdg80` project. Do not write into other project repositories.

## Production seat-change workflow

1. Read project `AGENTS.md`, `docs/README.md`, and the canonical registration docs before editing.
2. If the checkout is dirty or not a reproducible `origin/main` base, isolate prod-bound work in a clean linked worktree from `origin/main`.
3. Update regular-event overbooking in the registration source of truth:
   - Change the default overbooking percent for ordinary events.
   - Update explicit non-special overrides that intentionally track the new task.
   - Do **not** change Tretyakov Gallery overrides or special-event rules unless the user explicitly asks.
4. Update the canonical docs and E2E expectations that mention default overbooking/registration limits.
5. Run the relevant checks before release (`npm run check`, registration/social tests, and a catalog sync sanity check that prints percent distribution and representative limits).
6. Commit and push durable code/docs to `origin/main` before production deploy.
7. Deploy `znanie-kgd80-fest` from a clean worktree with `/home/dev/.fly/bin/flyctl` and the Fly release env.
8. Verify production, not local assumptions:
   - `/api/v1/health` is ok.
   - `https://kgd80.ru/tickets/registration/states.json` and `/api/v1/public/events/states` show the new overbooking distribution.
   - Tretyakov Gallery rows still have their protected override.
   - Include concrete examples of `capacity`, `overbookingPercent`, `registrationLimit`, `seatsTaken`, and `seatsLeft` in the release evidence.

## Mandatory social announcement after success

After a successful production add-place/overbooking change, publish the announcement. Do not stop at deploy.

1. Produce or refresh two square social cards for VK/Telegram.
   - Preserve the public phrase **«на все события фестиваля»** unless the user explicitly narrows it.
   - Do not expose internal percentages, quotas, or exception mechanics on public cards.
   - Use festival brand assets and Cygre where available.
   - First VK carousel card must include a visible `[листай]` cue with a right arrow.
2. Run visual QA before posting:
   - Inspect full-size cards and reduced social-feed previews.
   - Ensure text is readable, logos are clear, icons are optically centered, and no key text crosses a seam without protection.
   - For non-trivial card changes, get a Gemini/Opus art-direction pass and apply the useful fixes.
3. Publish VK first:
   - Target community: `kenigeventsofficial`, `owner_id=-231828790`, group id `231828790`.
   - Upload both cards, create one wall post from the group, and record the direct group post URL.
   - If the reference pattern is a personal repost (for example `wall868977531_*`), repost the group post from that account and record the repost URL too.
4. Publish Telegram:
   - Target channel: `@kenigevents` / “Полюбить Калининград | Анонсы”.
   - Send the same two cards as an album with a short caption and `https://kgd80.ru/`.
   - If the production bot is not a channel member, use the project-local Telethon bundle that is authorized for this channel; do not borrow sessions from other projects.
   - Record Telegram message IDs or public `https://t.me/kenigevents/<id>` links.
5. Captions should say that more places were added and point to `kgd80.ru`; avoid internal implementation details.

## Final report checklist

Report all of the following:

- Commit SHA pushed to `origin/main`.
- Fly release version, image tag/digest, and healthcheck result.
- Production manifest/API overbooking distribution and representative seat examples.
- VK group post URL and repost URL if created.
- Telegram channel message IDs/links.
- Card artifact paths used for publication.
- Skill path if the task also created or updated this skill.
