# af-metrics

Метрики використання агентів для AI Foundation.

Метрики: аналізатор історії сесій Claude Code для базової лінії (лише читання, лише агрегати) і подальший збір через вбудовану телеметрію. Результати — у ~/ai-foundation-data/metrics/, без вмісту транскриптів і клієнтського коду.

Плагін входить до маркетплейсу [AI Foundation](../../README.md). Встановлення:

```bash
claude plugin marketplace add GUSILLUS/ai-foundation
claude plugin install af-metrics@ai-foundation
```

## Аналізатор історії сесій

Лише читає транскрипти Claude Code (`<CLAUDE_CONFIG_DIR>/projects/**/*.jsonl`, за замовчуванням `~/.claude`). Визначення метрик — `docs/decisions/0002-metrics-baseline.md`.

```bash
npm run metrics:inventory
# або з установленої копії:
node <тека плагіна>/scripts/analyze-history.ts --inventory [--config-dir <тека Claude Code>] [--out <тека звіту>]
```

`--inventory` описує дані агрегатами й пише `inventory-<дата>.json` у `~/ai-foundation-data/metrics/`. Звіт не містить текстів, шляхів, команд і назв проєктів — його можна пересилати для аналізу схеми. Режим метрик з’явиться після інвентаризації.

Статус: етап 1 — каркас. Кожна зміна — з тестом і записом у кореневому `CHANGELOG.md`.
