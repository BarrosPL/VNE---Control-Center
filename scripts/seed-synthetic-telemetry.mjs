// Gera telemetria SINTETICA (demonstracao/testes de UI). Uso:
//   node --env-file=.env.local scripts/seed-synthetic-telemetry.mjs [--runs=40] [--seed=1] [--leads=1001,1004]
// SEGURANCA: recusa qualquer destino que nao seja localhost/127.0.0.1 (sem flag de override). Todo dado
// gerado usa source='synthetic' e e exibido como "Sintetico" na interface. Nunca escreve em tabelas vne_*.
// Usa o mesmo servico de ingestao do contrato real (ingestTelemetry), entao exercita o caminho de producao.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { parseTelemetry } from '../src/domain/telemetry.ts';
import { ingestTelemetry } from '../src/server/telemetry/ingest.ts';
import { assertTargetAllowed, parseArgs } from './lib/migrations.mjs';

/** PRNG deterministico (mulberry32): mesma seed => mesma telemetria. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function generateSynthetic(client, { runs = 40, seed = 1, leads = ['1001', '1004'], organization = 'vne' } = {}) {
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const agents = (await client.query(
    `SELECT a.id::text AS id, a.slug, v.config_hash,
            COALESCE((SELECT array_agg(x.code ORDER BY x.code) FROM acc_agent_tools t JOIN acc_tools x ON x.id = t.tool_id
                       WHERE t.agent_id = a.id AND t.observed_state = 'present'), '{}') AS tools
       FROM acc_agents a JOIN acc_organizations o ON o.id = a.organization_id
       LEFT JOIN acc_agent_versions v ON v.agent_id = a.id AND v.status = 'active' AND v.environment = 'production'
      WHERE o.slug = $1 AND a.status <> 'archived' ORDER BY a.slug`, [organization],
  )).rows;
  const summary = { agents: agents.length, runs: 0, events: 0, failed: 0 };
  const now = Date.now();
  for (const a of agents) {
    for (let i = 0; i < runs; i++) {
      const startedAt = new Date(now - Math.floor(rand() * 24 * 3600_000));
      const dur = 800 + Math.floor(rand() * 45_000);
      const roll = rand();
      const status = roll < 0.82 ? 'succeeded' : roll < 0.94 ? 'failed' : roll < 0.97 ? 'cancelled' : 'running';
      const completed = status === 'running' ? null : new Date(startedAt.getTime() + dur);
      const lead = pick(leads);
      const tools = a.tools.length ? Array.from({ length: Math.floor(rand() * 4) }, () => pick(a.tools)) : [];
      const t0 = startedAt.getTime();
      const events = [{ type: 'MESSAGE_RECEIVED', occurred_at: new Date(t0 + 50).toISOString(), payload: { message_ref: 100000 + Math.floor(rand() * 900000), chars: 20 + Math.floor(rand() * 200) } }];
      tools.forEach((code, k) => {
        const failed = rand() < 0.1;
        events.push({ type: 'TOOL_CALLED', occurred_at: new Date(t0 + 300 + k * 400).toISOString(), tool: { code }, key: `t${k}c` });
        events.push(failed
          ? { type: 'TOOL_FAILED', occurred_at: new Date(t0 + 500 + k * 400).toISOString(), tool: { code }, key: `t${k}f`, payload: { error_code: 'TIMEOUT' } }
          : { type: 'TOOL_SUCCEEDED', occurred_at: new Date(t0 + 500 + k * 400).toISOString(), tool: { code }, key: `t${k}s` });
      });
      if (status === 'failed' && rand() < 0.4) events.push({ type: 'HUMAN_REQUESTED', occurred_at: new Date(t0 + dur - 100).toISOString(), payload: { reason_code: 'needs_review' } });
      if (status === 'succeeded') events.push({ type: 'MESSAGE_SENT', occurred_at: new Date(t0 + dur - 100).toISOString(), payload: { chars: 40 + Math.floor(rand() * 300) } });
      const env = parseTelemetry({
        schema_version: 1, organization, source: 'synthetic', agent: a.slug,
        version: a.config_hash ? { config_hash: a.config_hash } : undefined,
        correlation_id: `synthetic-${seed}-${a.slug}-${i}`,
        entity: { type: 'lead', id: lead, lead_id: lead }, session: { start: true },
        run: {
          key: `synthetic:${seed}:${a.slug}:${i}`, trigger_type: pick(['message', 'message', 'message', 'schedule', 'webhook']),
          started_at: startedAt.toISOString(),
          ...(completed ? { completed_at: completed.toISOString(), status } : {}),
          model_provider: 'openai', model_name: 'modelo-sintetico',
          usage: completed ? { input_tokens: 200 + Math.floor(rand() * 2000), output_tokens: 50 + Math.floor(rand() * 400), estimated_cost: Number((rand() * 0.01).toFixed(6)) } : undefined,
          ...(status === 'failed' ? { error: { code: pick(['TOOL_ERROR', 'MODEL_TIMEOUT', 'BAD_RESPONSE']) } } : {}),
          metadata: { synthetic: true },
        },
        events,
      });
      await client.query('BEGIN');
      try {
        const r = await ingestTelemetry(client, env);
        await client.query('COMMIT');
        summary.runs += r.runCreated ? 1 : 0;
        summary.events += r.eventsInserted;
        if (status === 'failed') summary.failed++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  }
  return summary;
}

// execucao direta (CLI)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags } = parseArgs(process.argv.slice(2));
  const log = (level, msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
  try {
    const url = process.env.ACC_APP_DATABASE_URL;
    if (!url) throw new Error('Defina ACC_APP_DATABASE_URL (banco LOCAL).');
    const { host, remote } = assertTargetAllowed(url, undefined); // sem --confirm-host: remoto lanca erro
    if (remote) throw new Error('Telemetria sintetica so pode ser gerada em banco local.');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const leads = typeof flags.leads === 'string' ? flags.leads.split(',') : undefined;
      const summary = await generateSynthetic(client, { runs: Number(flags.runs) || 40, seed: Number(flags.seed) || 1, ...(leads ? { leads } : {}) });
      log('info', 'synthetic_generated', { host, ...summary });
    } finally {
      await client.end();
    }
  } catch (err) {
    log('error', 'failed', { message: err.message });
    process.exit(1);
  }
}
