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
npm run metrics:baseline              # базова лінія: baseline-<дата>.md і .json
npm run metrics:baseline -- --since 2026-11-01 --anonymize
npm run metrics:inventory             # опис даних для аналізу схеми
# або з установленої копії:
node <тека плагіна>/scripts/analyze-history.ts [--inventory] [--since YYYY-MM-DD] [--anonymize] [--config-dir <тека Claude Code>] [--out <тека звіту>]
```

Звіти пишуться в `~/ai-foundation-data/metrics/`.

- **Базова лінія** містить лише агрегати: лічильники, токени, вартість, назви інструментів, скілів, субагентів і моделей. Текстів промптів і відповідей, шляхів файлів і команд у ній немає. Назви проєктів — справжні (остання частина робочої теки); `--anonymize` замінює їх на `project-1`, `project-2`, … — для звіту, яким треба поділитися.
- **Інвентаризація** описує структуру транскриптів: типи записів, ключі без значень, переліки, версії. Назв проєктів не містить — її можна пересилати для аналізу схеми після оновлення Claude Code.

Версія 0.1.0. Кожна зміна — з тестом і записом у кореневому `CHANGELOG.md`.
