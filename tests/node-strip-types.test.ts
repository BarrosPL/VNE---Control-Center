import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Os scripts (migrate/seed/demo/inventario) importam modulos TypeScript de src/ diretamente pelo Node
// ("type stripping"). Sintaxe que exige transformacao (enum, namespace, parameter properties, decorators)
// NAO e suportada la, mas funciona no Next/Vitest — entao o erro so aparece ao rodar o script. Este teste
// falha antes: importa sob o Node cada modulo puro usado pelos scripts.
const root = join(__dirname, '..');
const DIRS = ['src/domain', 'src/server/auth', 'src/server/registry', 'src/server/catalog', 'src/server/telemetry', 'src/lib'];
const files = DIRS.flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.ts')).map((f) => join(d, f)));

describe('modulos usados por scripts sao compativeis com o type stripping do Node', () => {
  it('lista nao vazia de modulos', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('todos importam sem erro sob o Node (sem enum/namespace/parameter properties)', () => {
    const imports = files.map((f) => `await import(${JSON.stringify(pathToFileURL(join(root, f)).href)})`).join(';\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', imports], { encoding: 'utf8', cwd: root });
    expect(r.stderr.replace(/\(node:\d+\)[^\n]*\n?/g, '').replace(/\(Use `node[^\n]*\n?/g, '').trim(), r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('nenhum desses modulos usa sintaxe TS nao suportada pelo strip-only (verificacao estatica)', () => {
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, `${relative(root, join(root, f))}: enum`).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
      expect(src, `${f}: namespace`).not.toMatch(/^\s*(export\s+)?(declare\s+)?namespace\s/m);
      expect(src, `${f}: parameter property`).not.toMatch(/constructor\s*\([^)]*\b(readonly|private|public|protected)\s+\w+/);
    }
  });
});
