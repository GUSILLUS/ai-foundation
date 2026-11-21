# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/), версії плагінів — [semver](https://semver.org/lang/uk/). Кожен плагін версіонується окремо; запис позначає, якого плагіна він стосується.

## [Unreleased]

### Додано (плагіни)

- `af-core` 0.2.0: хук SessionStart — глобальні правила (`context/global-rules.md`) і картка проєкту з `~/ai-foundation-data/projects/<клієнт>/<проєкт>/context.md`; проєкт визначається за реєстром `projects.json` (git remote, worktree, запасний варіант — шлях); деградація без блокування. Шаблон картки — `templates/context.md`.
- Спільна обв'язка хуків: результат `context` (additionalContext для SessionStart і UserPromptSubmit + рядок користувачу); копія тепер і в `af-core`.

### Змінено

- `af-controls` 0.1.1: причина відмови хука починається з його імені (`[af-controls/env-guard] …`) — аналізатор історії бачить, який бар'єр відмовив (урок L2 roadmap друга).
- `af-metrics` 0.1.1: відмови хуків розрізняються за іменем нашого хука (`hook / hook:PreToolUse / af-controls/env-guard`); відмови сторонніх хуків — як і раніше, `hook / hook:PreToolUse`.

### Додано

- Репозиторій: перевірка `skills` — `name` збігається з текою, посилання на файли скіла існують, блоки коду закриті.
- Репозиторій: перевірка `budget` — глобальні правила й шаблон картки проєкту вкладаються в бюджет SessionStart (попередження).
- Репозиторій: перевірка `versions` — змінений плагін (крім `tests/`) потребує нової версії; база — `--base` у CI або upstream гілки локально.
- Репозиторій: перевірка `names` — назви клієнтів і проєктів не потрапляють у публічний репо. Список лише локально, у репо — HMAC-відбитки `.private-names.json`; CI перевіряє з секретом `AF_NAMES_KEY`, нові коміти — за діапазоном. `npm run names:update`, git-хук `pre-push` (`npm run hooks:install`).

## [0.1.0] — 2026-11-20

Перший реліз усіх чотирьох плагінів (`af-core`, `af-controls`, `af-handoff`, `af-metrics` — 0.1.0). Етап 1 «каркас» завершено.

### Додано

- Каркас репозиторію: маркетплейс `ai-foundation`, порожні плагіни `af-core`, `af-controls`, `af-handoff`, `af-metrics` (усі 0.1.0).
- `npm run validate`: власні перевірки маніфестів, скілів і хуків, `claude plugin validate --strict` для маркетплейсу й кожного плагіна, `tsc --noEmit`, сканер секретів, тести; `npm test`.
- Спільний код: `shared/` + мапа `shared/sync.json`, копії в `plugins/<плагін>/lib/shared/`; `npm run sync` і `--check` (ловить змінені, відсутні й зайві копії).
- `shared/hook-runtime.ts`: обв'язка хуків — безпечна деградація (код 0 і повідомлення), блокування лише через JSON-рішення, вхід хука ніколи не виводиться.
- **af-controls:** хук `env-guard` (PreToolUse) блокує читання й редагування `.env`, `.env.*`, `*.env`, `.envrc`; дозволяє `.env.example`/`.sample`/`.template`/`.dist`.
- CI (GitHub Actions): `npm run validate` на Ubuntu і Windows з Node 22.18 і 24, Claude Code — закріплена версія з `package.json`; щотижневий не блокуючий прогін на Claude Code `@latest`.
- `validate`: перевірка фікстур за білим списком — лише заглушки `<fixture>`, шляхи під `/fixtures/`, короткі токени; e-mail, реальні шляхи й вільний текст — помилка.
- **af-metrics:** аналізатор історії сесій, режим `--inventory` (`npm run metrics:inventory`): опис транскриптів агрегатами — типи записів, ключі без значень, переліки, версії, розташування файлів; без текстів, шляхів і назв проєктів.
- **af-metrics:** режим метрик (`npm run metrics:baseline`): сесії, промпти людини й інші, відповіді й токени по моделях, вартість, активний час, інструменти (MCP — за сервером), скіли, субагенти, помилки інструментів, API й хуків, відмови з причиною, стиснення, ходи й раунди правок; розрізи по тижнях, проєктах і точках входу; `--since`, `--anonymize`. Звіт — `baseline-<дата>.json` і `.md` у `~/ai-foundation-data/metrics/`.
