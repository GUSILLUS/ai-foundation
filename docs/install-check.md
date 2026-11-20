# Перевірка встановлення з маркетплейсу

Пункт етапу 1: «Плагіни встановлюються з маркетплейсу на іншу машину чи в чистий профіль». Повторювати після змін у маніфестах, структурі плагінів чи спільному коді — і перед кожним релізом.

Чистий профіль — тимчасовий `CLAUDE_CONFIG_DIR`: Claude Code не бачить ваших налаштувань, установлених плагінів і логіну. Для `plugin marketplace add/install/list/details` логін не потрібен. Сесію в чистому профілі не запускаємо — вона попросила б увійти заново; роботу хука перевіряємо прямим запуском встановленої копії.

## Windows (PowerShell)

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:TEMP\af-clean-profile"
claude plugin marketplace add GUSILLUS/ai-foundation
foreach ($p in 'af-core', 'af-controls', 'af-handoff', 'af-metrics') { claude plugin install "$p@ai-foundation" }
claude plugin list
claude plugin details af-controls@ai-foundation

# Хук із встановленої копії (кеш), вхід — синтетична фікстура з репозиторію
$hook = "$env:CLAUDE_CONFIG_DIR\plugins\cache\ai-foundation\af-controls\0.1.0\hooks\env-guard.ts"
Get-Content "D:\Pet Projects\ai-foundations\plugins\af-controls\tests\fixtures\read-env.json" | node $hook
Get-Content "D:\Pet Projects\ai-foundations\plugins\af-controls\tests\fixtures\read-normal.json" | node $hook

# Прибрати за собою
Remove-Item -Recurse -Force $env:CLAUDE_CONFIG_DIR
Remove-Item Env:CLAUDE_CONFIG_DIR
```

## Linux (bash)

```bash
export CLAUDE_CONFIG_DIR="$(mktemp -d)/.claude"
claude plugin marketplace add GUSILLUS/ai-foundation
for p in af-core af-controls af-handoff af-metrics; do claude plugin install "$p@ai-foundation"; done
claude plugin list
claude plugin details af-controls@ai-foundation

hook="$CLAUDE_CONFIG_DIR/plugins/cache/ai-foundation/af-controls/0.1.0/hooks/env-guard.ts"
node "$hook" < plugins/af-controls/tests/fixtures/read-env.json
node "$hook" < plugins/af-controls/tests/fixtures/read-normal.json

rm -rf "$(dirname "$CLAUDE_CONFIG_DIR")"; unset CLAUDE_CONFIG_DIR
```

Без SSH-ключа GitHub додайте `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`, щоб Claude Code одразу клонував через HTTPS.

## Очікуваний результат

- `marketplace add` — `Successfully added marketplace: ai-foundation`.
- Кожен `install` — `Successfully installed plugin: <плагін>@ai-foundation (scope: user)`.
- `plugin list` — чотири плагіни, `Version: 0.1.0`, `Status: ✔ enabled`.
- `plugin details af-controls@ai-foundation` — `Hooks (1) PreToolUse`.
- Хук на `read-env.json` — JSON з `"permissionDecision":"deny"`; на `read-normal.json` — порожній вивід. Обидва з кодом 0.

## Журнал перевірок

| Дата | ОС | Claude Code | Коміт | Результат |
| --- | --- | --- | --- | --- |
| 2026-11-20 | Linux (Ubuntu, Node 22.23) | 2.1.321 | `b740d2b` | ✔ усе як очікується; хук з кешу: deny на `.env`, тиша на звичайному файлі, деградація на зламаному JSON |
