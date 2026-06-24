# Agent Instructions

- `Opus` always means `Claude Opus`, never a generic quality level, mode name, or informal nickname.
- The aliases `Opus`, `Опус`, `Claude Opus`, and `Claude Opus latest` all mean: run Claude with the `opus` model alias.
- Antigravity CLI (`agy`) may be used in this workspace as a consultation model runner for implementation planning, code review, debugging, second opinions, and strategy checks.
- Prefer Antigravity-hosted Gemini for routine consultations and quick external validation more often than Opus. Use it proactively for ordinary consulting passes unless the user explicitly asks for Opus or there is a clear reason to escalate beyond Gemini.
- If the user asks to "use Opus", "launch Opus", "run Opus", "call Opus", or uses the Russian equivalents, interpret that as a concrete instruction to use the Claude model alias `opus`.
- In this workspace, when the user references `Opus`, prefer `claude --model opus --effort high` or an equivalent default configuration that resolves to the latest available Claude Opus model.
- When a command, script, or workflow needs an explicit Gemini consultation invocation, prefer headless Antigravity CLI via `a-gemini "<prompt>"` (wrapper for `agy --model "Gemini 3.1 Pro (High)" -p ...`) for routine Gemini consultations in this workspace.
- Do not rely on the Antigravity CLI default model for headless consultations unless you have just verified it is healthy in the current session.
- Do not downgrade to Gemini 2.5 or switch to a Flash model unless the user explicitly approves that downgrade.
- Use another Gemini 3 model alias only when the user explicitly asks for it or when you have just validated that the alias is available and behaving correctly in the installed Antigravity CLI (`agy models`).
- Do not guess Antigravity model names from UI copy alone; use the exact names returned by `agy models`.
- Keep Gemini prompts compact. Summarize repository context instead of pasting large raw documents by default.
- For large context, prefer piping via stdin or using a temporary file/heredoc over building very large inline shell strings.
- For website work, use Claude Opus with high effort as a consulting and support model for interface design, UX decisions, frontend implementation, and code-level problem solving.
- Treat Opus as the specialist assistant for site UI review, interface improvement work, deeper UX validation, and website-specific implementation consultation when the user asks for Opus or when a Gemini pass is not enough.
- For general-purpose consultation, second opinions, implementation validation, and non-visual code strategy, prefer Gemini first and use Opus as a follow-up when the user requests it or Gemini's answer is insufficient.
- When a command, script, or workflow needs an explicit Claude invocation for site-related UI or code tasks, prefer `claude --model opus --effort high`.
- If the user explicitly asks for Antigravity-hosted Opus, `a-opus`, or `Antigravity Opus`, use `a-opus "<prompt>"` (wrapper for `agy --model "Claude Opus 4.6 (Thinking)" -p ...`). Keep this separate from plain `Opus`, which still means Claude Code / `claude --model opus`.
- If the user asks for OSS / open-weight model consultation, use `a-oss "<prompt>"` (wrapper for `agy --model "GPT-OSS 120B (Medium)" -p ...`) after a quick health check when possible.
- Available local Antigravity wrappers:
  - `a-gemini` → `Gemini 3.1 Pro (High)` via Antigravity CLI.
  - `a-opus` → `Claude Opus 4.6 (Thinking)` via Antigravity CLI; intentionally not the same as plain `Opus`.
  - `a-sonnet` → `Claude Sonnet 4.6 (Thinking)` via Antigravity CLI.
  - `a-oss` → `GPT-OSS 120B (Medium)` via Antigravity CLI.
  - `a-agy-model "Exact Model Name" "<prompt>"` → arbitrary model from `agy models`.
- Do not ask the user to clarify what `Opus` means unless they explicitly contrast it with another model.
- If a tool, script, or agent needs a model name, map `Opus` directly to `opus`.

## Opus Consultation Wait Policy

- When the user explicitly asks to use `Opus` for consultation, do not use short exploratory timeouts that are likely to cut off a valid response.
- Default to a generous wait budget for `Claude Opus` consultations. Prefer a single well-scoped request with a timeout in the several-minutes range rather than repeated short retries.
- For substantial site, UX, frontend, or strategy consultations, prefer waiting up to `10 minutes` before treating the run as stalled, unless the user asked for a faster cut-off.
- Do not retry `Opus` with a shorter timeout after an earlier timeout. If a rerun is needed, keep or increase the wait budget and improve the prompt instead of shrinking the limit.
- Avoid repeated paid consultation attempts that are unlikely to finish. Make one deliberate request, wait properly, and only launch another run if the previous result is clearly unusable or the user asks for another angle.
- If `Opus` appears blocked or unhealthy, report that transparently to the user, including the actual timeout used, instead of silently replacing the consultation with the agent's own opinion.

## Antigravity / Gemini Consultation Wait Policy

- When the user asks to use `Gemini` for consultation, do not use short exploratory timeouts that are likely to cut off a valid answer.
- Prefer a single deliberate headless request over multiple quick retries. Improve the prompt before rerunning; do not spam Gemini with repeated partial attempts.
- For lightweight validation or second-opinion checks, allow enough time for Antigravity CLI initialization and response generation instead of treating the first silent seconds as failure.
- For substantial implementation, debugging, code review, or strategy consultations, prefer a wait budget in the several-minutes range before treating the run as stalled.
- Treat `MODEL_CAPACITY_EXHAUSTED` or `No capacity available for model ...` as a model-availability problem first, not as evidence that the prompt was too large.
- If a Gemini 3.1 Pro request fails on the Antigravity route, retry only with another validated Gemini 3.1/3 model alias for this installed CLI, not with Flash or 2.5 unless the user explicitly approves.
- If prompt size might still matter, test that hypothesis separately with the same task on a working Gemini 3 Pro route instead of inferring it from a preview-model 429.
- When the prompt is large, pass it through stdin or a temp file and trim it to the minimum context needed before retrying.
- If Antigravity/Gemini fails because of auth, model selection, CLI initialization, or environment issues, report the actual command pattern and the concrete error instead of silently replacing the consultation with the agent's own opinion.


## Skill Usage Policy

- For any interface, frontend, layout, visual, UX, landing page, or design-related work, always use the `ui-ux-pro-max` skill.
- For any interface or website work that can affect discoverability, page structure, content presentation, metadata, internal linking, or search performance, also use the `seo` skill.
- For any interface or website work, also use the `seo-geo` skill to account for AI search visibility, AI Overviews, ChatGPT web search, and Perplexity-style citation patterns.
- If the task is explicitly about GEO, AI visibility, AI citations, LLM discoverability, `llms.txt`, crawler access, or structured discoverability for AI systems, additionally use the `geo` skill.
- Default workflow for site UI tasks: use `ui-ux-pro-max` + `seo` + `seo-geo`; add `geo` whenever the task touches AI-search readiness or GEO outcomes.

## Registration Production Rules

- После перевода registration-системы в production любые новые тестовые регистрации на живом контуре допускаются только по отдельной необходимости и должны создаваться с именем `ТЕСТ`.
- Без явной команды владельца проекта не менять доступность регистрации на события: не открывать, не закрывать, не переводить в `registration_soon`, не выполнять иные mutating-переключения availability-state.
- Для любых запросов на список регистраций, экспорт, отчёт или нормализованную таблицу по участникам источником истины считать только свежие данные с production.
- Не подменять production-данные локальными кэшами, историческими `outputs/*.xlsx` или вручную сохранёнными файлами, если пользователь явно не просит именно исторический snapshot.
- Если актуальный production-export недоступен, сообщать об этом явно и не выдавать локальную устаревшую выгрузку как свежую.

## Fly Production Access

- Registration production Fly app: `znanie-kgd80-fest`.
- Eventsbot production Fly app: `events-bot-new-wngqia`.
- Fly CLI is installed at `/home/dev/.fly/bin/flyctl`.
- Plain `flyctl auth whoami` can report `no access token available` even when a usable token exists locally. First check `/home/dev/.config/fly/release.env`; if it exists, source it with `set -a && . /home/dev/.config/fly/release.env && set +a` before running Fly commands.
- If `/home/dev/.config/fly/release.env` is absent, then check `/home/dev/.fly/config.yml`.
- The usable Fly token is the full `access_token:` YAML value from `/home/dev/.fly/config.yml`; it is a composite token and can contain commas plus `+`, `/`, and `=` characters. Do not extract it with a narrow regex that only captures `fm2_...` or `fo1_...` fragments.
- Use it by exporting/passing `FLY_API_TOKEN` for each command, for example:
  `FLY_API_TOKEN="$(python3 -c 'from pathlib import Path; import re; print(re.search(r"^access_token:\\s*(.+)$", Path("/home/dev/.fly/config.yml").read_text(), re.M).group(1).strip())')" /home/dev/.fly/bin/flyctl secrets list -a znanie-kgd80-fest`
- When copying secrets between Fly apps, never print secret values. Read runtime env through `flyctl ssh console -a <source> -C 'sh -lc ...'` and pass captured values directly to `flyctl secrets set -a <target> KEY=value`.
- `flyctl ssh console -C` does not run commands through a shell by default. Wrap compound commands, pipes, heredocs, and env extraction in `sh -lc`.
- As of 2026-06-06, `SUPABASE_URL` and `SUPABASE_KEY` were copied from `events-bot-new-wngqia` runtime to `znanie-kgd80-fest` Fly secrets.

## Visual Verification Policy

- For any website, frontend, layout, or visual task, do not mark the work complete until you have done a visual verification pass through Playwright CLI or an equivalent Playwright command-line workflow.
- Always verify both desktop and mobile views for visual tasks before saying the issue is fixed.
- The verification pass must check the actual rendered result, not only the code or static CSS diff.
- When the user reports a visual defect, re-open the affected screens in Playwright, capture fresh screenshots, and compare the result against the reported problem before closing the task.
- For `video-preview` animation work, re-check the testing memo before closing:
  - canonical doc: `/workspaces/kdg80/docs/video-preview-animation-testing.md`
  - routes: `/video-preview/animation-testing/` and `/video-preview/testing/`

## Hero Reference Pack

- For any hero-related work on this festival site, treat these files as the primary visual references and re-check them before closing the task:
- `/workspaces/kdg80/Исходные данные/Идеи/Desctop.png`
- `/workspaces/kdg80/Исходные данные/Идеи/Mobile 1.png`
- `/workspaces/kdg80/Исходные данные/Идеи/Mobile 2.png`
- Desktop and mobile hero placement must be treated as two different composition systems. Do not assume one placement formula can be scaled down to the other.
- For desktop, the speaker should visually live on the split seam between the white and red panels.
- For mobile, the speaker should be bottom-anchored, editorially oversized, and may partially exit the right edge when that improves the composition.

## Requirements Governance Policy

- Before implementing a task, first check the relevant requirements documents and verify that the requested work does not contradict the currently fixed requirements.
- Before proposing any requirement change, re-read the current canonical requirement document itself, not only the latest user message or bug report.
- A requirement-change proposal must be based on an explicit document diff against the current canonical text.
- When the user asks to update, clarify, or confirm requirements, first analyze the existing requirement document and separate the findings into three buckets:
- `Already present` — the requirement already exists in the document and should not be proposed as a new addition.
- `Needs clarification` — the requirement exists but is too vague, incomplete, or missing an important constraint.
- `Missing` — the requirement is genuinely absent from the document and should be proposed as a new addition.
- When proposing requirement edits, cite the relevant existing clauses or sections from the current document before suggesting the change.
- Do not restate the user's latest wording as if it were a newly discovered missing requirement without first proving that it is absent or insufficient in the canonical document.
- The confirmation stage must present a real delta against the current requirement document so the user can approve only the actual changes, not re-read their own previous wording.
- If the task appears to conflict with the current requirements, stop before implementation and do not proceed directly to code changes.
- In that case, present the conflict explicitly to the user and propose the exact requirement changes needed first.
- The proposal must name the requirement document(s) to be changed and list the concrete edits the agent wants to make to those requirements.
- Only after the user confirms the requirement changes may the implementation work begin.
- The goal is to keep the requirements documentation current and prevent important approved behavior from being accidentally lost during later iterations.
- Maintain explicit status markers in the canonical requirements documents for requirement readiness and confirmation state.
- After the user reports a defect or asks for a correction, update the affected requirement items to `Not done` or `Not confirmed by user` in the requirement document instead of leaving them implicitly green.
- Do not mark a requirement item as fully done based only on internal checks. Internal validation may justify `Not confirmed by user`, but explicit user confirmation after manual testing is required before the requirement is marked done.

## Git / Push Policy

- Keep the cloud/remote repository reasonably up to date during normal work.
- After every second user request, stage, commit, and push all durable project changes so the remote repository stays current.
- Exclude temporary artifacts, cache files, build output that is not part of the shipped product, local debug files, machine-specific files, and other non-durable working artifacts from those pushes.
- By default, stage, commit, and push only files directly related to the current user request.
- Never include unrelated modified files in a push, even if they are already dirty in the worktree.
- Never push secrets or local-only files such as `.env`, local credentials, machine-specific config, or ad hoc debug files.
- Treat deployment, verification, and infrastructure-adjacent files as push-blocked unless the user explicitly asks for them in the current task. This includes files such as `deploy-to-yc.sh`, `robots.txt`, `sitemap.xml`, `llms.txt`, `llms-full.txt`, verification HTML files, and similar operational/SEO artifacts.
- Generated assets may be pushed only when they are required for the requested feature and are actually referenced by the shipped code.
- Before any push, review `git status` and stage files explicitly; do not use broad staging that can sweep in unrelated changes.
- If there is any ambiguity about whether a file belongs in the push, do not push it by default.

## GitHub 403 Recovery

- In this workspace, if `git push` to GitHub returns `403`, do not keep retrying with the default Codespaces `GITHUB_TOKEN`.
- First check `gh auth status`. If `gh` has a real user token with `repo` scope, prefer that over the Codespaces token.
- Read the persistent `gho_...` token from `/home/codespace/.config/gh/hosts.yml` and use it for `fetch`/`push` via `git -c credential.helper= -c core.askPass= -c http.https://github.com/.extraheader="AUTHORIZATION: basic ..."` so git stops using the wrong token.
- If push then fails with `non-fast-forward`, fetch `origin`, create a clean `worktree` from `origin/main`, replay only the intended durable commits there, drop accidentally staged files, and push from that clean worktree instead of forcing from the dirty main worktree.
- Never stop at “403” as the final state if a valid `gh` user token is available locally; recover the correct auth path and finish the sync.
