import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import childProcess from 'node:child_process';
import { Effect } from 'effect';

async function main() {
  process.umask(0o077);
  const [mode, root] = process.argv.slice(2);
  const worktree = join(root, 'worktree');
  const database = join(root, 'runtime/opencode/sessions.sqlite');
  const location = { directory: worktree };
  const marker = join(root, 'plugin-executed');
  const processMarker = join(root, 'mcp-started');
  const configDir = join(root, 'config/opencode');
  for (const directory of [worktree, configDir, join(root, 'owned-config'), join(root, 'runtime/opencode')]) mkdirSync(directory, { recursive: true });
  const phase = mode;
  let inferenceMode = 'complete';
  let inferenceStarted;
  let inferenceCancelled = 0;
  const observed = { listeners: 0, clients: 0, children: 0, inference: 0, acquired: 0, released: 0 };
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) { observed.listeners++; return originalListen.apply(this, args); };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (...args) { if (phase === 'boundary') observed.children++; return originalSpawn.apply(this, args); };
  syncBuiltinESMExports();

  const customProvider = (name) => ({ [name]: {
    activation: 'enabled', package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'https://inference.synthetic.invalid/v1', apiKey: 'SYNTHETIC-NONSECRET-KEY' },
    models: { fixture: { name: 'Synthetic fixture', limit: { context: 1000000, output: 1024 } } },
  } });
  const plugin = (name) => {
    const directory = join(root, 'plugins', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `synthetic-${name}`, type: 'module', main: './index.js' }));
    writeFileSync(join(directory, 'index.js'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + '\n')}); export default async () => ({});`);
    return pathToFileURL(directory).href;
  };
  const wellKnownConfig = { providers: customProvider('wellknown-fixture'), plugins: [pathToFileURL(join(root, 'plugins/wellknown')).href], mcp: { servers: { 'wellknown-mcp': { type: 'remote', url: 'https://mcp.synthetic.invalid/mcp', disabled: true } } } };
  // Synthetic transport only. No account, registry, OAuth server, MCP or inference
  // service is contacted; the parent also denies network at the OS boundary.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url === 'https://wellknown.synthetic.invalid/.well-known/opencode') return new Response(JSON.stringify({
      auth: { command: [process.execPath, '-e', 'process.stdout.write("SYNTHETIC-NONSECRET-WELLKNOWN")'], env: 'SYNTHETIC_WELLKNOWN_KEY' }, config: wellKnownConfig,
    }), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://inference.synthetic.invalid/')) {
      observed.inference++;
      if (inferenceMode === 'pending') {
        inferenceStarted();
        return new Response(new ReadableStream({ cancel() { inferenceCancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const events = [
        { id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic response' }, finish_reason: null }] },
        { id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error('Synthetic fixture denies external network');
  };

  if (mode === 'provision') {
    const { OpenCode } = await import('@opencode/sdk');
    const host = await OpenCode.create({ database: { path: database }, models: { fetch: false }, config: { directory: join(root, 'owned-config'), project: false, content: '{}' }, fs: { filewatcher: false } });
    try {
      await host.integration.list({ location });
      await host.integration.connect.key({ integrationID: 'openai', key: 'SYNTHETIC-NONSECRET-OPENAI', location });
      await host.integration.wellknown.add({ url: 'https://wellknown.synthetic.invalid', location });
      await host.integration.list({ location });
      const connection = await host.integration.command.connect({ integrationID: 'https://wellknown.synthetic.invalid', methodID: 'login', location });
      let status;
      for (let attempt = 0; attempt < 50; attempt++) {
        status = await host.integration.command.status({ integrationID: 'https://wellknown.synthetic.invalid', attemptID: connection.data.attemptID, location });
        if (status.data.status !== 'pending') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(status.data.status, 'complete');
    } finally { await host.close(); }
    console.log(JSON.stringify({ provisioned: true, synthetic: true }));
    return;
  }

  const driftMode = mode.startsWith('drift:') ? mode.slice(6) : undefined;
  // Observer forwards the public create export and captures its result; it never
  // alters the replacement, options, methods, registration or connection behavior.
  // Fault modes below are separate lifecycle/shape controls, never security proof.
  globalThis.__opencodeObservation = { observed, driftMode, mode };
  registerHooks({
    resolve(specifier, context, next) {
      if (driftMode === 'effect' && specifier === 'effect' && context.parentURL?.endsWith('/dist/src/opencode-compat.js')) return { url: 'kerbsflow:missing-effect', shortCircuit: true };
      if (specifier === '@opencode/sdk/effect' && context.parentURL !== 'kerbsflow:observe-sdk') return { url: 'kerbsflow:observe-sdk', shortCircuit: true };
      if (specifier === '@modelcontextprotocol/client' && context.parentURL !== 'kerbsflow:observe-mcp') return { url: 'kerbsflow:observe-mcp', shortCircuit: true };
      if (driftMode === 'source' && specifier === '@opencode/core/config/plugin/source') return { url: 'kerbsflow:missing-source', shortCircuit: true };
      if (driftMode === 'mcp' && specifier === '@opencode/core/config/plugin/mcp') return { url: 'kerbsflow:missing-mcp', shortCircuit: true };
      return next(specifier, context.parentURL?.startsWith("kerbsflow:") ? { ...context, parentURL: import.meta.url } : context);
    },
    load(url, context, next) {
      if (url === 'kerbsflow:missing-effect') return { format: 'module', source: "export { Effect, Context, Scope, Stream, Exit, Cause, Pull } from 'effect';", shortCircuit: true };
      if (url === 'kerbsflow:missing-source') return { format: 'module', source: 'export const ConfigPluginSource = { node: {} };', shortCircuit: true };
      if (url === 'kerbsflow:missing-mcp') return { format: 'module', source: 'export const ConfigMcpPlugin = { Plugin: {} };', shortCircuit: true };
      if (url === 'kerbsflow:observe-mcp') return { format: 'module', shortCircuit: true, source: `
        export * from '@modelcontextprotocol/client';
        import { Client as Original } from '@modelcontextprotocol/client';
        export class Client extends Original { constructor(...args) { globalThis.__opencodeObservation.observed.clients++; super(...args); } }
      ` };
      if (url === 'kerbsflow:observe-sdk') return { format: 'module', shortCircuit: true, source: `
        import { OpenCode as Original } from '@opencode/sdk/effect';
        import { Effect, Stream } from 'effect';
        const state = globalThis.__opencodeObservation;
        export const OpenCode = state.driftMode === 'create' ? {} : { ...Original, create: (...args) => {
          if (state.mode === 'failed-create') return Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.sync(() => state.observed.acquired++), () => Effect.sync(() => state.observed.released++));
            return yield* Effect.fail(new Error('synthetic acquisition failure'));
          });
          if (state.mode === 'stalled-close') return Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.sync(() => state.observed.acquired++), () => Effect.promise(async () => {
              await new Promise(resolve => setTimeout(resolve, 10_200)); state.observed.released++;
            }));
            return { server: { info: () => Effect.succeed({ version: '2.0.13', pid: 1, urls: [], paths: { tmp: 'synthetic' } }) }, sessions: Object.fromEntries(['create','prompt','wait','get','list','context','log','interrupt'].map(name => [name, () => Effect.void])), permission: { create: () => Effect.void }, provider: { list: () => Effect.void }, model: { list: () => Effect.void } };
          });
          return Effect.tap(Original.create(...args), host => Effect.gen(function* () {
            state.observed.acquired++;
            yield* Effect.addFinalizer(() => Effect.sync(() => state.observed.released++));
            state.host = host;
            if (state.mode === 'failed-stream-close') host.sessions.log = () => Stream.ensuring(Stream.never, Effect.die(new Error('synthetic stream finalizer failure')));
            if (state.driftMode === 'host') host.sessions.wait = undefined;
            if (state.driftMode === 'result') host.provider.list = () => Effect.succeed({ data: [{ id: 'fixture', activation: 'bad' }] });
          }));
        } };
      ` };
      return next(url, context);
    },
  });

  const { createOpenCodeHost } = await import('../../dist/src/opencode-compat.js');
  const { OpenCodeAdapter, openCodeHostConfiguration, OPENCODE_EXECUTOR_PERMISSIONS, OPENCODE_AGENT } = await import('../../dist/src/opencode.js');
  const hostOptions = { app: { name: 'kerbsflow-fixture', version: '2.0.13' }, database: { path: database }, events: { persist: true }, config: { project: false, content: JSON.stringify({ ...openCodeHostConfiguration(), ...(mode === 'lifecycle' ? { providers: customProvider('synthetic') } : {}), models: { fetch: false } }) }, fs: { filewatcher: false } };
  const effectCall = (group, name, input) => Effect.runPromise(globalThis.__opencodeObservation.host[group][name](input));

  if (mode === 'failed-create' || mode === 'stalled-close' || mode === 'failed-stream-close' || driftMode) {
    if (mode === 'failed-stream-close') {
      const host = await createOpenCodeHost(hostOptions);
      const abort = new AbortController();
      const iterator = host.sessions.log({ sessionID: 'synthetic' }, { signal: abort.signal })[Symbol.asyncIterator]();
      const pull = assert.rejects(iterator.next());
      await new Promise(resolve => setImmediate(resolve));
      abort.abort(); await pull;
      await assert.rejects(host.close(), { code: 'OPENCODE_STREAM_CLOSE_FAILED' });
      assert.equal(observed.released, 1);
    } else if (mode === 'stalled-close') {
      const host = await createOpenCodeHost(hostOptions);
      const closing = host.close();
      const started = Date.now();
      await assert.rejects(closing, { code: 'OPENCODE_CLOSE_UNCERTAIN' });
      assert.ok(Date.now() - started < 11_000, 'close must report the deadline without waiting for late cleanup');
      assert.equal(host.close(), closing);
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(observed.released, 1);
      await assert.rejects(host.close(), { code: 'OPENCODE_CLOSE_UNCERTAIN' });
    } else if (mode === 'failed-create') {
      await assert.rejects(createOpenCodeHost(hostOptions), /synthetic acquisition failure/);
      assert.equal(observed.acquired, 1); assert.equal(observed.released, 1);
    } else if (driftMode === 'result') {
      const host = await createOpenCodeHost(hostOptions);
      try { await assert.rejects(host.provider.list(), { code: 'OPENCODE_RUNTIME_SHAPE_INVALID' }); } finally { await host.close(); }
    } else {
      await assert.rejects(createOpenCodeHost(hostOptions), { code: 'OPENCODE_RUNTIME_SHAPE_INVALID' });
    }
    console.log(JSON.stringify({ mode, ...observed }));
    return;
  }

  if (mode === 'boundary' || mode === 'control') {
    if (mode === 'boundary') rmSync(marker, { force: true });
    const globalPlugin = plugin('global'); plugin('wellknown'); const projectPlugin = plugin('project');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writeFileSync(join(configDir, 'plugins/scanned.js'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'scanned\\n'); export default async () => ({});`);
    const mcp = { servers: {
      'global-mcp': { type: 'remote', url: 'https://mcp.synthetic.invalid/mcp', disabled: true },
      'local-mcp': { type: 'local', command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(processMarker)}, 'started')`], disabled: true },
    } };
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({ models: { fetch: false }, plugins: [globalPlugin], mcp, providers: customProvider('global-fixture'), permissions: [{ action: '*', resource: '*', effect: 'allow' }] }));
    writeFileSync(join(worktree, 'opencode.json'), JSON.stringify({ plugins: [projectPlugin], providers: customProvider('project-excluded'), mcp: { servers: { 'project-mcp': mcp.servers['global-mcp'] } } }));
    let host;
    let adapter;
    let result;
    try {
      if (mode === 'control') {
        const { OpenCode } = await import('@opencode/sdk');
        host = await OpenCode.create({ ...hostOptions, models: { fetch: false } });
      } else {
        adapter = new OpenCodeAdapter({ runtimeRoot: join(root, 'runtime') });
        const readiness = await adapter.readiness(worktree);
        assert.equal(readiness.ready, true);
        assert.ok(readiness.models.some((model) => model.providerID === 'openai' && model.enabled));
        assert.ok(!readiness.models.some((model) => model.providerID === 'project-excluded'));
        assert.ok(globalThis.__opencodeObservation.host);
      }
      const native = mode === 'control' ? host : null;
      const call = native ? (group, name, input) => native[group][name](input) : effectCall;
      await call('integration', 'list', { location });
      const mcpEntries = await call('mcp', 'list', { location });
      const providers = await call('provider', 'list', { location });
      assert.ok(providers.data.some((provider) => provider.id === 'global-fixture'));
      const models = await call('model', 'list', { location });
      assert.ok(models.data.some((model) => model.providerID === 'global-fixture'));
      assert.ok(models.data.some((model) => model.providerID === 'wellknown-fixture'));
      assert.ok(!models.data.some((model) => model.providerID === 'project-excluded'));
      const metadata = models.data.map(({ id, providerID, enabled, status }) => ({ id, providerID, enabled, status })).sort((a, b) => (a.providerID + a.id).localeCompare(b.providerID + b.id));
      if (mode === 'control') writeFileSync(join(root, 'control-models.json'), JSON.stringify(metadata));
      else assert.deepEqual(metadata, JSON.parse(readFileSync(join(root, 'control-models.json'), 'utf8')));
      const integration = await call('integration', 'get', { integrationID: 'openai', location });
      assert.ok(integration.data.connections.some((connection) => connection.type === "credential" && connection.method === "key"), 'synthetic provider-owned same-database auth is still available');
      const plugins = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
      if (mode === 'control') {
        assert.ok(plugins.includes('global')); assert.ok(plugins.includes('wellknown')); assert.ok(plugins.includes('scanned'));
        assert.ok(!plugins.includes('project'));
        assert.ok(mcpEntries.data.length > 0);
      } else {
        assert.deepEqual(plugins, []);
        assert.deepEqual(mcpEntries.data, []);
        const integrations = await call('integration', 'list', { location });
        assert.deepEqual(integrations.data.filter((item) => item.metadata?.source === 'mcp' || item.id.startsWith('mcp_')), []);
        for (const server of ['global-mcp', 'wellknown-mcp', 'local-mcp', 'project-mcp']) await assert.rejects(call('mcp', 'connect', { server, location }), /not found/i);
        const session = await call('sessions', 'create', { title: 'boundary', agent: OPENCODE_AGENT, location, model: { providerID: 'global-fixture', id: 'fixture' }, permissions: OPENCODE_EXECUTOR_PERMISSIONS, metadata: {} });
        for (const action of ['shell', 'webfetch', 'websearch', 'external_directory', 'subagent', 'skill', 'question', 'execute', 'unknown_mcp_tool']) assert.equal((await call('permission', 'create', { sessionID: session.id, action, resources: ['*'] })).effect, 'deny');
        assert.equal((await call('permission', 'create', { sessionID: session.id, action: 'read', resources: ['.env'] })).effect, 'deny');
        assert.equal((await call('permission', 'create', { sessionID: session.id, action: 'read', resources: ['synthetic.txt'] })).effect, 'allow');
        assert.deepEqual((await call('server', 'info')).urls, []);
        assert.equal(observed.clients, 0); assert.equal(observed.children, 0); assert.equal(observed.listeners, 0);
        assert.equal(existsSync(processMarker), false);
      }
      result = { mode, plugins, mcpCount: mcpEntries.data.length, modelCount: metadata.length, authPreserved: true };
    } finally { if (adapter) await adapter.close(); else await host?.close(); }
    if (adapter) assert.equal(observed.released, 1);
    console.log(JSON.stringify({ ...result, ...observed, closed: true }));
    return;
  }

  const host = await createOpenCodeHost(hostOptions);
  try {
    const session = await host.sessions.create({ title: 'lifecycle', agent: OPENCODE_AGENT, location, model: { providerID: 'synthetic', id: 'fixture' }, metadata: {}, permissions: OPENCODE_EXECUTOR_PERMISSIONS });
    assert.equal((await host.sessions.get({ sessionID: session.id })).id, session.id);
    assert.ok((await host.sessions.list()).data.some((value) => value.id === session.id));
    assert.ok(Array.isArray(await host.sessions.context({ sessionID: session.id })));
    const stream = host.sessions.log({ sessionID: session.id, follow: true })[Symbol.asyncIterator]();
    const first = stream.next();
    await stream.return(); await first;
    const abort = new AbortController();
    const aborted = host.sessions.log({ sessionID: session.id, follow: true, after: 999999 }, { signal: abort.signal })[Symbol.asyncIterator]();
    const pull = assert.rejects(aborted.next());
    abort.abort(); await pull; await aborted.return();
    const alreadyAborted = AbortSignal.abort();
    await assert.rejects(host.sessions.get({ sessionID: session.id }, { signal: alreadyAborted }));
    await host.sessions.prompt({ sessionID: session.id, text: 'Return one synthetic response' });
    await host.sessions.wait({ sessionID: session.id });
    assert.equal((await host.sessions.get({ sessionID: session.id })).outcome, 'succeeded', JSON.stringify(await Array.fromAsync(host.sessions.log({ sessionID: session.id, follow: false }))));
    assert.ok(JSON.stringify(await host.sessions.context({ sessionID: session.id })).includes('Synthetic response'));
    assert.equal(observed.inference, 1);
    // Abort a wait while a synthetic provider stream is pending, then use native
    // interrupt to prove terminal cancellation rather than assuming success.
    inferenceMode = 'pending';
    const started = new Promise(resolve => { inferenceStarted = resolve; });
    const cancellable = await host.sessions.create({ title: 'cancel', agent: OPENCODE_AGENT, location, model: { providerID: 'synthetic', id: 'fixture' }, metadata: {}, permissions: OPENCODE_EXECUTOR_PERMISSIONS });
    await assert.rejects(host.sessions.prompt({ sessionID: cancellable.id, text: 'must not dispatch' }, { signal: alreadyAborted }));
    assert.equal(observed.inference, 1);
    await host.sessions.prompt({ sessionID: cancellable.id, text: 'synthetic pending response' });
    await started;
    const waitAbort = new AbortController();
    const waiting = assert.rejects(host.sessions.wait({ sessionID: cancellable.id }, { signal: waitAbort.signal }));
    waitAbort.abort(); await waiting;
    assert.equal((await host.sessions.interrupt({ sessionID: cancellable.id })).interrupted, true);
    await host.sessions.wait({ sessionID: cancellable.id });
    assert.equal((await host.sessions.get({ sessionID: cancellable.id })).outcome, 'interrupted');
    assert.ok(inferenceCancelled > 0, 'provider stream must be released by interrupt');
    assert.equal(typeof (await host.sessions.interrupt({ sessionID: session.id })).interrupted, 'boolean');
    const active = host.sessions.log({ sessionID: session.id, follow: true, after: 999999 })[Symbol.asyncIterator]();
    const activePull = assert.rejects(active.next());
    const closing = host.close();
    assert.equal(host.close(), closing);
    await closing; await activePull;
    await assert.rejects(host.server.info());
    console.log(JSON.stringify({ mode, ...observed }));
  } finally { await host.close(); }

}
await main();
