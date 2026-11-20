# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/), версії плагінів — [semver](https://semver.org/lang/uk/). Кожен плагін версіонується окремо; запис позначає, якого плагіна він стосується.

## [Unreleased]

### Додано

- Каркас репозиторію: маркетплейс `ai-foundation`, порожні плагіни `af-core`, `af-controls`, `af-handoff`, `af-metrics` (усі 0.1.0).
- `npm run validate`: власні перевірки маніфестів, скілів і хуків, `claude plugin validate --strict` для маркетплейсу й кожного плагіна, `tsc --noEmit`, сканер секретів, тести; `npm test`.
- Спільний код: `shared/` + мапа `shared/sync.json`, копії в `plugins/<плагін>/lib/shared/`; `npm run sync` і `--check` (ловить змінені, відсутні й зайві копії).
- `shared/hook-runtime.ts`: обв'язка хуків — безпечна деградація (код 0 і повідомлення), блокування лише через JSON-рішення, вхід хука ніколи не виводиться.
- **af-controls:** хук `env-guard` (PreToolUse) блокує читання й редагування `.env`, `.env.*`, `*.env`, `.envrc`; дозволяє `.env.example`/`.sample`/`.template`/`.dist`.
- CI (GitHub Actions): `npm run validate` на Ubuntu і Windows з Node 22.18 і 24, Claude Code — закріплена версія з `package.json`; щотижневий не блокуючий прогін на Claude Code `@latest`.
