# AI Foundation

[![CI](https://github.com/GUSILLUS/ai-foundation/actions/workflows/ci.yml/badge.svg)](https://github.com/GUSILLUS/ai-foundation/actions/workflows/ci.yml)

Набір плагінів [Claude Code](https://code.claude.com/docs) для комерційної розробки й самонавчання: контекст проєкту, контроль і перевірки, handoff між сесіями, метрики використання.

Інструмент особистий, але професійного рівня. Етап 1 «каркас» завершено (реліз 0.1.0): одна команда перевірки, CI на Windows і Linux, хук захисту `.env` і аналізатор історії сесій. Решта функціональності з’являтиметься етапами.

## Плагіни

| Плагін | Призначення |
| --- | --- |
| `af-core` | Контекст проєкту, init, шаблони, робочий ланцюг |
| `af-controls` | Бар’єри безпеки й бібліотека хуків; зараз — хук `env-guard` проти читання `.env` |
| `af-handoff` | Передача контексту між сесіями |
| `af-metrics` | Метрики використання агентів; зараз — аналізатор історії сесій і базова лінія |

## Вимоги

- Claude Code ≥ 2.1.321
- Node.js ≥ 22.18 (хуки й скрипти — TypeScript, Node запускає `.ts` без збірки)
- git
- Windows або Linux

## Встановлення

```bash
claude plugin marketplace add GUSILLUS/ai-foundation
claude plugin install af-core@ai-foundation
```

Решта плагінів встановлюється так само. Оновлення: `claude plugin marketplace update ai-foundation`, потім `/reload-plugins` у сесії.

## Розробка

```bash
npm ci
claude --plugin-dir ./plugins   # сесія з локальними копіями всіх плагінів
```

Після змін у хуках чи агентах — `/reload-plugins` у сесії.

Команди:

| Команда | Що робить |
| --- | --- |
| `npm run validate` | Уся перевірка (запускати перед кожним комітом); `-- --only <id>` / `--skip <id>` — вибірково |
| `npm test` | Лише тести |
| `npm run sync` | Оновити копії спільного коду з `shared/` |
| `npm run metrics:baseline` | Базова лінія метрик з історії сесій (`-- --since YYYY-MM-DD`, `--anonymize`) |
| `npm run metrics:inventory` | Опис структури транскриптів для аналізу схеми |

Перед кожним комітом — `npm run validate`. Потрібен Claude Code CLI у `PATH` (інший шлях можна задати змінною `AF_CLAUDE_BIN`).

## Дані

Плагіни не зберігають жодних даних у цьому репозиторії й у клієнтських проєктах. Контексти, специфікації, handoff і метрики живуть у `~/ai-foundation-data/` на кожній машині, поза будь-яким git.

## Документація

- [`docs/vision.md`](docs/vision.md) — що і навіщо
- [`docs/tech-start.md`](docs/tech-start.md) — технічні рішення й критерій готовності етапу 1
- [`docs/decisions/`](docs/decisions/) — рішення з поясненням «чому»

## Ліцензія

[MIT](LICENSE)
