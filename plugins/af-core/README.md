# af-core

Контекст проєкту, init, шаблони й робочий ланцюг для AI Foundation.

Ядро AI Foundation: агент отримує контекст проєкту з першого повідомлення, а init аналізує стек і готує контекст поза клієнтським репозиторієм. Ядро ні від кого не залежить.

Плагін входить до маркетплейсу [AI Foundation](../../README.md). Встановлення:

```bash
claude plugin marketplace add GUSILLUS/ai-foundation
claude plugin install af-core@ai-foundation
```

Версія 0.1.0 — порожній каркас: компоненти з’являться в етапі 2. Кожна зміна — з тестом і записом у кореневому `CHANGELOG.md`.
