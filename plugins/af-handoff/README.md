# af-handoff

Передача контексту між сесіями для AI Foundation.

Handoff: збереження й відновлення стану роботи між сесіями, щоб нова сесія продовжувала з того місця, де зупинилася попередня. Дані зберігаються в ~/ai-foundation-data/, поза будь-яким git.

Плагін входить до маркетплейсу [AI Foundation](../../README.md). Встановлення:

```bash
claude plugin marketplace add GUSILLUS/ai-foundation
claude plugin install af-handoff@ai-foundation
```

Версія 0.1.0 — порожній каркас: компоненти з’являться в етапі 2. Кожна зміна — з тестом і записом у кореневому `CHANGELOG.md`.
