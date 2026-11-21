# af-core

Контекст проєкту, init, шаблони й робочий ланцюг для AI Foundation.

Ядро AI Foundation: агент отримує контекст проєкту з першого повідомлення, а init аналізує стек і готує контекст поза клієнтським репозиторієм. Ядро ні від кого не залежить.

Плагін входить до маркетплейсу [AI Foundation](../../README.md). Встановлення:

```bash
claude plugin marketplace add GUSILLUS/ai-foundation
claude plugin install af-core@ai-foundation
```

## Що є (0.2.0)

**Хук SessionStart** (`hooks/session-start.ts`) на кожному старті, `/clear`, відновленні й стисненні додає агенту:

1. глобальні правила — `context/global-rules.md` (до 2 000 символів);
2. картку проєкту — `~/ai-foundation-data/projects/<клієнт>/<проєкт>/context.md` (до 6 000 символів, довша обрізається по розділу) і шляхи до бази знань проєкту й спільних знань клієнта.

Проєкт визначається лише за реєстром `~/ai-foundation-data/projects.json` — за git remote (працює й у worktree), запасний варіант — за шляхом:

```json
{
  "version": 1,
  "projects": [
    { "client": "acme", "project": "portal", "remotes": ["github.com/acme/portal"], "paths": [] }
  ]
}
```

`client` і `project` — slug (a-z, 0-9, `-`, `_`). Незареєстрована тека отримує лише правила: вгадувати проєкт за назвою теки не можна (ізоляція клієнтів). Збій (зламаний реєстр, неоднозначний remote) — правила без картки й один рядок користувачу; сесія не блокується. Тека даних перевизначається змінною `AF_DATA_DIR`.

Шаблон картки — `templates/context.md`. Рішення — ADR 0004. Кожна зміна — з тестом і записом у кореневому `CHANGELOG.md`.
