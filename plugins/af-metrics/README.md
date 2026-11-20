# af-metrics

Метрики використання агентів для AI Foundation.

Метрики: аналізатор історії сесій Claude Code для базової лінії (лише читання, лише агрегати) і подальший збір через вбудовану телеметрію. Результати — у ~/ai-foundation-data/metrics/, без вмісту транскриптів і клієнтського коду.

Плагін входить до маркетплейсу [AI Foundation](../../README.md). Встановлення:

```bash
claude plugin marketplace add GUSILLUS/ai-foundation
claude plugin install af-metrics@ai-foundation
```

Статус: етап 1 — каркас. Плагін поки не містить компонентів; функціональність додаватиметься поступово, кожна зміна — з тестом і записом у кореневому `CHANGELOG.md`.
