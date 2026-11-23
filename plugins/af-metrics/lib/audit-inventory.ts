import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Що встановлено в Claude Code: плагіни, особисті скіли, агенти й команди, MCP-сервери.
 * Лише імена, версії, описи (для оцінки довжини) і події хуків. Значення `env`, `headers`,
 * `args` MCP-серверів і шляхи проєктів з `~/.claude.json` не читаються далі ключів і не виводяться.
 */

/** Ліміт Claude Code на description + when_to_use у списку скілів (ADR 0001, п. 7). */
export const LISTING_LIMIT = 1536;
const SAFE = /^[\w.:+@-]{1,100}$/;
const SUBAGENT_HINT = /\b(sub-?agents?|Task tool|Agent tool|dispatch(?:ing)? (?:an? )?(?:\w+ )?agents?|parallel agents)\b/i;

export interface Component {
  name: string;
  /** Символи, які елемент додає до списку на старті сесії (оцінка за описом). */
  listingChars: number;
  /** Інструкції згадують субагентів (евристика). */
  mentionsSubagents?: boolean;
}

export interface HookInfo {
  event: string;
  matcher: string;
}

export interface Source {
  /** `plugin` — плагін; `personal` — ~/.claude/skills|agents|commands; `mcp` — окремий MCP-сервер. */
  kind: 'plugin' | 'personal' | 'mcp';
  /** Для плагіна — `name@marketplace`, для MCP — назва сервера, для personal — `personal`. */
  id: string;
  name: string;
  version: string | null;
  enabled: boolean | null;
  scope: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
  skills: Component[];
  agents: Component[];
  commands: Component[];
  hooks: HookInfo[];
  mcpServers: string[];
  /** Що не вдалося прочитати — без вмісту. */
  problems: string[];
}

export interface Installed {
  sources: Source[];
  /** Які джерела знайдено: шлях замінено на опис. */
  found: Record<string, boolean>;
  problems: string[];
}

export interface InventoryPaths {
  configDir: string;
  /** `~/.claude.json` — MCP-сервери рівнів user і local. */
  claudeJson: string;
}

export function collectInstalled(p: InventoryPaths): Installed {
  const out: Installed = { sources: [], found: {}, problems: [] };
  const settings = readJson(path.join(p.configDir, 'settings.json'), out, 'settings.json');
  const enabledMap = isObj(settings) && isObj(settings.enabledPlugins) ? (settings.enabledPlugins as Record<string, unknown>) : {};

  const installedFile = path.join(p.configDir, 'plugins', 'installed_plugins.json');
  const installed = readJson(installedFile, out, 'plugins/installed_plugins.json');
  if (isObj(installed) && isObj(installed.plugins)) {
    for (const [key, raw] of Object.entries(installed.plugins as Record<string, unknown>)) {
      if (!SAFE.test(key)) {
        out.problems.push('installed_plugins.json: ключ плагіна з недопустимими символами пропущено');
        continue;
      }
      const entries = Array.isArray(raw) ? raw : [raw];
      // Кілька записів — різні scope (user/project/local); беремо user, інакше перший.
      const entry = (entries.find((e) => isObj(e) && e.scope === 'user') ?? entries[0]) as Record<string, unknown> | undefined;
      if (!isObj(entry)) continue;
      const src = emptySource('plugin', key, key.split('@')[0] as string);
      src.version = str(entry.version);
      src.scope = str(entry.scope);
      src.installedAt = str(entry.installedAt);
      src.lastUpdated = str(entry.lastUpdated);
      src.enabled = key in enabledMap ? enabledMap[key] === true : null;
      const dir = typeof entry.installPath === 'string' ? entry.installPath : null; // лише для читання, не виводиться
      if (dir && existsSync(dir)) readPluginDir(dir, src);
      else src.problems.push('тека встановлення не знайдена');
      out.sources.push(src);
    }
  }

  const personal = emptySource('personal', 'personal', 'особисті (~/.claude)');
  personal.enabled = true;
  readComponents(p.configDir, {}, personal);
  if (personal.skills.length + personal.agents.length + personal.commands.length > 0) out.sources.push(personal);

  const cj = readJson(p.claudeJson, out, '~/.claude.json');
  if (isObj(cj)) {
    const seen = new Map<string, Source>();
    const add = (name: string, scope: string) => {
      if (!SAFE.test(name)) return;
      const existing = seen.get(name);
      if (existing) {
        if (!existing.scope?.split(',').includes(scope)) existing.scope = `${existing.scope},${scope}`;
        return;
      }
      const s = emptySource('mcp', name, name);
      s.scope = scope;
      s.enabled = true;
      s.mcpServers = [name];
      seen.set(name, s);
      out.sources.push(s);
    };
    if (isObj(cj.mcpServers)) for (const name of Object.keys(cj.mcpServers)) add(name, 'user');
    // Шляхи проєктів (ключі) містять назви клієнтів — не зберігаємо їх, лише рахуємо.
    if (isObj(cj.projects)) {
      for (const proj of Object.values(cj.projects as Record<string, unknown>)) {
        if (isObj(proj) && isObj(proj.mcpServers)) for (const name of Object.keys(proj.mcpServers)) add(name, 'local');
      }
    }
  }
  return out;
}

function emptySource(kind: Source['kind'], id: string, name: string): Source {
  return { kind, id, name, version: null, enabled: null, scope: null, installedAt: null, lastUpdated: null, skills: [], agents: [], commands: [], hooks: [], mcpServers: [], problems: [] };
}

/** Тека плагіна: маніфест, стандартні теки компонентів і шляхи з маніфесту. */
export function readPluginDir(dir: string, src: Source): void {
  const manifestFile = path.join(dir, '.claude-plugin', 'plugin.json');
  let manifest: Record<string, unknown> = {};
  if (existsSync(manifestFile)) {
    try {
      const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown;
      if (isObj(m)) manifest = m;
    } catch {
      src.problems.push('plugin.json не розбирається');
    }
  }
  if (!src.version && typeof manifest.version === 'string' && SAFE.test(manifest.version)) src.version = manifest.version;
  readComponents(dir, manifest, src);

  // Хуки: hooks/hooks.json і manifest.hooks (об'єкт або шлях).
  const hookSources: unknown[] = [];
  const std = path.join(dir, 'hooks', 'hooks.json');
  if (existsSync(std)) hookSources.push(readJsonQuiet(std, src, 'hooks.json'));
  for (const h of toList(manifest.hooks)) {
    if (typeof h === 'string') hookSources.push(readJsonQuiet(path.join(dir, h), src, 'hooks (manifest)'));
    else hookSources.push(h);
  }
  for (const h of hookSources) collectHooks(h, src);

  // MCP: .mcp.json і manifest.mcpServers (об'єкт або шлях). Лише імена серверів.
  const mcpSources: unknown[] = [];
  const mcpStd = path.join(dir, '.mcp.json');
  if (existsSync(mcpStd)) mcpSources.push(readJsonQuiet(mcpStd, src, '.mcp.json'));
  for (const m of toList(manifest.mcpServers)) {
    if (typeof m === 'string') mcpSources.push(readJsonQuiet(path.join(dir, m), src, 'mcpServers (manifest)'));
    else mcpSources.push(m);
  }
  for (const m of mcpSources) {
    if (!isObj(m)) continue;
    const servers = isObj(m.mcpServers) ? m.mcpServers : m;
    for (const name of Object.keys(servers)) if (SAFE.test(name) && !src.mcpServers.includes(name)) src.mcpServers.push(name);
  }
}

function collectHooks(value: unknown, src: Source): void {
  if (!isObj(value)) return;
  const events = isObj(value.hooks) ? value.hooks : value;
  for (const [event, groups] of Object.entries(events)) {
    if (!SAFE.test(event) || !Array.isArray(groups)) continue;
    for (const g of groups) {
      const matcher = isObj(g) && typeof g.matcher === 'string' ? g.matcher.slice(0, 100) : '*';
      src.hooks.push({ event, matcher: matcher || '*' });
    }
  }
}

/** skills/<name>/SKILL.md, agents/*.md, commands/**\/*.md — у корені теки й за шляхами з маніфесту. */
function readComponents(dir: string, manifest: Record<string, unknown>, src: Source): void {
  const dirsFor = (key: string) => [path.join(dir, key), ...toList(manifest[key]).filter((v): v is string => typeof v === 'string').map((v) => path.join(dir, v))];

  for (const base of unique(dirsFor('skills'))) {
    if (!isDir(base)) continue;
    for (const entry of safeReaddir(base)) {
      const file = path.join(base, entry, 'SKILL.md');
      if (!existsSync(file)) continue;
      const c = readComponent(file, entry, 'skill', src);
      if (c && !src.skills.some((s) => s.name === c.name)) src.skills.push(c);
    }
  }
  for (const base of unique(dirsFor('agents'))) {
    for (const file of mdFiles(base, false)) {
      const c = readComponent(file, path.basename(file, '.md'), 'agent', src);
      if (c && !src.agents.some((s) => s.name === c.name)) src.agents.push(c);
    }
  }
  for (const base of unique(dirsFor('commands'))) {
    for (const file of mdFiles(base, true)) {
      const relName = path.relative(base, file).replace(/\.md$/, '').split(path.sep).join(':');
      const c = readComponent(file, relName, 'command', src);
      if (c && !src.commands.some((s) => s.name === c.name)) src.commands.push(c);
    }
  }
}

function readComponent(file: string, fallbackName: string, kind: 'skill' | 'agent' | 'command', src: Source): Component | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    src.problems.push(`${kind}: файл не читається`);
    return null;
  }
  const fm = parseYamlFrontmatter(text);
  const name = typeof fm.name === 'string' && SAFE.test(fm.name) ? fm.name : SAFE.test(fallbackName) ? fallbackName : null;
  if (!name) {
    src.problems.push(`${kind}: недопустима назва`);
    return null;
  }
  // disable-model-invocation прибирає елемент зі списку для моделі; user-invocable — лише з меню.
  const hidden = fm['disable-model-invocation'] === 'true';
  const desc = [fm.description, fm.when_to_use].filter((v) => typeof v === 'string' && v).join(' ');
  // Список: «- name: опис» — опис обрізається Claude Code до ліміту.
  const listingChars = hidden ? 0 : name.length + 4 + Math.min(desc.length, LISTING_LIMIT);
  const c: Component = { name, listingChars };
  if (SUBAGENT_HINT.test(text)) c.mentionsSubagents = true;
  return c;
}

/**
 * Frontmatter сторонніх файлів: `key: value`, лапки, блокові скаляри `|` і `>`.
 * Повертає лише рядкові значення верхнього рівня.
 */
export function parseYamlFrontmatter(text: string): Record<string, string> {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const out: Record<string, string> = {};
  if (lines[0]?.trim() !== '---') return out;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return out;
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(body[i] as string);
    if (!m) continue;
    const key = m[1] as string;
    const raw = (m[2] ?? '').trim();
    if (/^[|>][+-]?$/.test(raw)) {
      const block: string[] = [];
      while (i + 1 < body.length && (/^\s+\S/.test(body[i + 1] as string) || (body[i + 1] as string).trim() === '')) block.push((body[++i] as string).trim());
      out[key] = (raw.startsWith('>') ? block.join(' ') : block.join('\n')).trim();
    } else if (raw === '') {
      // Багаторядкове звичайне значення з відступом.
      const block: string[] = [];
      while (i + 1 < body.length && /^\s+\S/.test(body[i + 1] as string) && !/^\s+-\s/.test(body[i + 1] as string)) block.push((body[++i] as string).trim());
      if (block.length) out[key] = block.join(' ');
    } else {
      out[key] = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
    }
  }
  return out;
}

function mdFiles(base: string, recursive: boolean): string[] {
  if (!isDir(base)) return [];
  const out: string[] = [];
  for (const entry of safeReaddir(base)) {
    const full = path.join(base, entry);
    if (isDir(full)) {
      if (recursive) out.push(...mdFiles(full, true));
    } else if (entry.endsWith('.md') && entry.toLowerCase() !== 'readme.md') out.push(full);
  }
  return out.sort();
}

function readJson(file: string, out: Installed, label: string): unknown {
  out.found[label] = existsSync(file);
  if (!out.found[label]) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    out.problems.push(`${label}: не розбирається як JSON`);
    return undefined;
  }
}

function readJsonQuiet(file: string, src: Source, label: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    src.problems.push(`${label}: не розбирається як JSON`);
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function toList(v: unknown): unknown[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function unique(v: string[]): string[] {
  return [...new Set(v.map((p) => path.resolve(p)))];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && SAFE.test(v) ? v : null;
}
