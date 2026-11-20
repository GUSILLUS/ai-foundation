# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/), версії плагінів — [semver](https://semver.org/lang/uk/). Кожен плагін версіонується окремо; запис позначає, якого плагіна він стосується.

## [Unreleased]

### Додано

- Каркас репозиторію: маркетплейс `ai-foundation`, порожні плагіни `af-core`, `af-controls`, `af-handoff`, `af-metrics` (усі 0.1.0).
- `npm run validate`: власні перевірки маніфестів, скілів і хуків, `claude plugin validate --strict` для маркетплейсу й кожного плагіна, `tsc --noEmit`, сканер секретів, тести; `npm test`.
