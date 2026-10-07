import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import childProcess from 'node:child_process';
import { Effect, Scope, Exit } from 'effect';

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
  const observed = { listeners: 0, clients: 0, children: 0, inference: 0, acquired: 0, released: 0, streamScopeReleased: 0, npmCalls: 0, pacoteLoads: 0, pacoteCalls: 0, fetchLoads: 0, fetchCalls: 0, cacheLoads: 0, cacheConstructs: 0, legacyHandlers: 0, externalModules: 0 };
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
      if (mode === 'provider-runtime:cohere' || mode === 'provider-runtime:perplexity') return new Response(JSON.stringify({ message: 'SYNTHETIC error' }), { status: 400, headers: { 'content-type': 'application/json' } });
      if (mode === 'provider-runtime:muse') {
        assert.equal(new Headers(init?.headers ?? input?.headers).get('authorization'), 'Bearer SYNTHETIC-NONSECRET-OPENCODE');
        const item = { id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic Muse response', annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id: 'synthetic-response', status: 'in_progress' } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Synthetic Muse response' },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'synthetic-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
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

  if (mode === 'provider-runtime:inherited') wellKnownConfig.providers['wellknown-legacy'] = { ...customProvider('wellknown-legacy')['wellknown-legacy'], package: 'aisdk:@ai-sdk/cohere' };
  if (mode === 'provision' || mode === 'provider-runtime:inherited') {
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
    if (mode === 'provision') { console.log(JSON.stringify({ provisioned: true, synthetic: true })); return; }
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
      for (const name of ['model', 'model-resolver']) if (specifier === `@opencode/core/${name}` && context.parentURL !== `kerbsflow:observe-${name}`) return { url: `kerbsflow:observe-${name}`, shortCircuit: true };
      if (specifier === '@modelcontextprotocol/client' && context.parentURL !== 'kerbsflow:observe-mcp') return { url: 'kerbsflow:observe-mcp', shortCircuit: true };
      if (driftMode === 'source' && specifier === '@opencode/core/config/plugin/source') return { url: 'kerbsflow:missing-source', shortCircuit: true };
      if (driftMode === 'mcp' && specifier === '@opencode/core/config/plugin/mcp') return { url: 'kerbsflow:missing-mcp', shortCircuit: true };
      return next(specifier, context.parentURL?.startsWith("kerbsflow:") ? { ...context, parentURL: import.meta.url } : context);
    },
    load(url, context, next) {
      if (url === 'kerbsflow:missing-effect') return { format: 'module', source: "export { Effect, Context, Scope, Stream, Exit, Cause, Pull } from 'effect';", shortCircuit: true };
      if (url === 'kerbsflow:missing-source') return { format: 'module', source: 'export const ConfigPluginSource = { node: {} };', shortCircuit: true };
      if (url === 'kerbsflow:missing-mcp') return { format: 'module', source: 'export const ConfigMcpPlugin = { Plugin: {} };', shortCircuit: true };
      if (url === 'kerbsflow:observe-model' || url === 'kerbsflow:observe-model-resolver') {
        const name = url.slice('kerbsflow:observe-'.length);
        return { format: 'module', shortCircuit: true, source: `
          export * from '@opencode/core/${name}';
          import { node as original, Service } from '@opencode/core/${name}';
          import { Context, Effect, Layer } from 'effect';
          export const node = {
            replace: replacement => original.replace(replacement),
            mapLayer: decorate => original.mapLayer(layer => Layer.tap(decorate(layer), context => Effect.sync(() => {
              globalThis.__opencodeObservation[${JSON.stringify(name)}] = Context.get(context, Service);
            }))),
          };
        ` };
      }
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
            if (state.mode === 'failed-normal-stream-finalizer') host.sessions.log = () => Stream.ensuring(Stream.empty, Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => state.observed.streamScopeReleased++));
              return yield* Effect.die(new Error('synthetic normal-completion finalizer failure'));
            }));
            if (state.driftMode === 'host') host.sessions.wait = undefined;
            if (state.driftMode === 'result') host.provider.list = () => Effect.succeed({ data: [{ id: 'fixture', activation: 'bad' }] });
          }));
        } };
      ` };
      const loaded = next(url, context);
      let source = String(loaded.source);
      if (/\/@ai-sdk\/provider-utils\/dist\/index\.(mjs|js)$/.test(url)) source = source.replaceAll('const responseBody = await response.text();', 'globalThis.__opencodeObservation.observed.legacyHandlers++; const responseBody = await response.text();');
      if (url === pathToFileURL(join(root, 'arbitrary-provider.mjs')).href) source = 'globalThis.__opencodeObservation.observed.externalModules++;' + source;
      if (url.endsWith('/@opencode/util/dist/npm.js')) {
        for (const name of ['add', 'resolve', 'check', 'update', 'which']) {
          const start = source.indexOf(`const ${name} = Effect.fn("Npm.${name}")(function* (`);
          assert.ok(start >= 0, `missing pinned Npm.${name} observer point`);
          const brace = source.indexOf('{', start);
          source = source.slice(0, brace + 1) + 'globalThis.__opencodeObservation.observed.npmCalls++;' + source.slice(brace + 1);
        }
      }
      if (url.endsWith('/pacote/lib/index.js')) {
        source = 'globalThis.__opencodeObservation.observed.pacoteLoads++;' + source;
        source += `; for (const key of ['resolve', 'extract', 'manifest', 'packument']) {
          const original = module.exports[key];
          module.exports[key] = (...args) => { globalThis.__opencodeObservation.observed.pacoteCalls++; return original(...args); };
        }`;
      }
      if (url.endsWith('/make-fetch-happen/lib/index.js')) {
        source = 'globalThis.__opencodeObservation.observed.fetchLoads++;' + source;
        assert.ok(source.includes('const makeFetchHappen = (url, opts) => {'), 'missing pinned fetch observer point');
        source = source.replace('const makeFetchHappen = (url, opts) => {', 'const makeFetchHappen = (url, opts) => { globalThis.__opencodeObservation.observed.fetchCalls++;');
      }
      if (url.endsWith('/http-cache-semantics/index.js')) {
        source = 'globalThis.__opencodeObservation.observed.cacheLoads++;' + source;
        source += '; module.exports = new Proxy(module.exports, { construct(target, args) { globalThis.__opencodeObservation.observed.cacheConstructs++; return Reflect.construct(target, args); } });';
      }
      return source === String(loaded.source) ? loaded : { ...loaded, source };
    },
  });

  const { createOpenCodeHost } = await import('../../dist/src/opencode-compat.js');
  const { OpenCodeAdapter, openCodeHostConfiguration, OPENCODE_EXECUTOR_PERMISSIONS, OPENCODE_AGENT } = await import('../../dist/src/opencode.js');
  const hostOptions = { app: { name: 'kerbsflow-fixture', version: '2.0.13' }, database: { path: database }, events: { persist: true }, config: { project: false, content: JSON.stringify({ ...openCodeHostConfiguration(), ...(mode === 'lifecycle' ? { providers: customProvider('synthetic') } : {}), models: { fetch: false } }) }, fs: { filewatcher: false } };
  const effectCall = (group, name, input) => Effect.runPromise(globalThis.__opencodeObservation.host[group][name](input));

  if (mode.startsWith('provider-runtime:')) {
    const kind = mode.slice('provider-runtime:'.length);
    const providers = customProvider('synthetic');
    if (kind === 'muse') providers.opencode = { activation: 'enabled', settings: { baseURL: 'https://inference.synthetic.invalid/v1' } };
    const selectedRef = kind === 'muse' ? { providerID: 'opencode', id: 'muse-spark-1.3-contributor-free' } : { providerID: 'synthetic', id: 'fixture' };
    if (kind === 'inherited') {
      providers.synthetic.package = 'aisdk:@ai-sdk/cohere';
      const hostile = name => ({ ...customProvider(name)[name], package: 'aisdk:@ai-sdk/cohere' });
      writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({ providers: { 'global-legacy': hostile('global-legacy') } }));
      writeFileSync(join(worktree, 'opencode.json'), JSON.stringify({ providers: { 'project-legacy': hostile('project-legacy') } }));
      wellKnownConfig.providers['wellknown-legacy'] = hostile('wellknown-legacy');
    }
    if (kind === 'cohere' || kind === 'perplexity') providers.synthetic.package = `aisdk:@ai-sdk/${kind}`;
    if (kind.startsWith('legacy:')) providers.synthetic.package = `aisdk:${kind.slice(7)}`;
    if (kind === 'installed') providers.synthetic.package = '@ai-sdk/cohere';
    if (kind === 'git') providers.synthetic.package = 'aisdk:git+https://git.synthetic.invalid/provider.git';
    if (kind === 'unknown') providers.synthetic.package = '@opencode/ai/providers/openai-options';
    if (kind === 'file') {
      const file = join(root, 'arbitrary-provider.mjs');
      writeFileSync(file, 'throw new Error("Arbitrary synthetic module executed"); export function model() {}');
      providers.synthetic.package = pathToFileURL(file).href;
    }
    if (kind === 'custom') providers.synthetic.package = '@kerbsflow/synthetic-uninstalled-provider';
    if (kind === 'model') providers.synthetic.models.fixture.package = '@kerbsflow/synthetic-uninstalled-model';
    if (kind === 'catalog') {
      const file = join(root, 'hostile-models.json');
      writeFileSync(file, JSON.stringify({ synthetic: {
        id: 'synthetic', name: 'Synthetic catalog', env: [], npm: '@kerbsflow/synthetic-uninstalled-catalog',
        models: { fixture: { id: 'fixture', name: 'Synthetic model', tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 1000000, output: 1024 } } },
      } }));
      hostOptions.models = { file, fetch: false };
      delete providers.synthetic.package;
    }
    hostOptions.config.content = JSON.stringify({ ...openCodeHostConfiguration(), models: { fetch: false }, providers });
    const host = await createOpenCodeHost(hostOptions);
    let result;
    const mutationScope = Effect.runSync(Scope.make());
    try {
      await effectCall('integration', 'list', { location });
      if (kind === 'changed') {
        assert.ok((await host.model.list({ location })).data.some(model => model.providerID === 'synthetic' && model.id === 'fixture'));
        await Effect.runPromise(Effect.provideService(globalThis.__opencodeObservation.model.transform(editor => editor.update('synthetic', 'fixture', model => { model.package = 'aisdk:@ai-sdk/cohere'; })), Scope.Scope, mutationScope));
        providers.synthetic.package = 'aisdk:@ai-sdk/cohere';
      }
      if (kind === 'muse') {
        await Effect.runPromise(globalThis.__opencodeObservation.host.integration.connect.key({ integrationID: 'opencode', key: 'SYNTHETIC-NONSECRET-OPENCODE', location }));
        const integration = await effectCall('integration', 'get', { integrationID: 'opencode', location });
        assert.ok(integration.data.connections.some(connection => connection.type === 'credential' && connection.method === 'key'));
      }
      const providerList = await host.provider.list({ location });
      const modelList = await host.model.list({ location });
      const effectiveModels = await Effect.runPromise(globalThis.__opencodeObservation.model.all());
      if (kind === 'inherited') {
        assert.ok(providerList.data.some(provider => provider.id === 'global-legacy'));
        assert.ok(providerList.data.some(provider => provider.id === 'wellknown-legacy'));
        assert.ok(!modelList.data.some(model => ['global-legacy', 'wellknown-legacy', 'project-legacy'].includes(model.providerID)));
        const resolver = globalThis.__opencodeObservation['model-resolver'];
        for (const providerID of ['global-legacy', 'wellknown-legacy']) await assert.rejects(Effect.runPromise(resolver.resolve({ providerID, id: 'fixture' })), { code: 'OPENCODE_PROVIDER_RUNTIME_UNSUPPORTED' });
        assert.equal(await Effect.runPromise(resolver.resolve({ providerID: 'project-legacy', id: 'fixture' })), undefined);
      }
      if (kind !== 'normal' && kind !== 'muse') {
        const resolver = globalThis.__opencodeObservation['model-resolver'];
        assert.ok(resolver, 'actual protected public resolver was observed');
        const selected = { ...providers.synthetic.models.fixture, id: 'fixture', providerID: 'synthetic', package: providers.synthetic.package ?? '@kerbsflow/synthetic-uninstalled-catalog' };
        if (kind === 'model') selected.package = providers.synthetic.models.fixture.package;
        if (kind === 'changed') {
          const mutable = { ...selected, package: '@opencode/ai/providers/openai-compatible' };
          const deferred = resolver.resolveModel(mutable);
          mutable.package = 'aisdk:@ai-sdk/cohere';
          await assert.rejects(Effect.runPromise(deferred), { code: 'OPENCODE_PROVIDER_RUNTIME_UNSUPPORTED' });
        }
        await assert.rejects(Effect.runPromise(resolver.resolveModel(selected)), { code: 'OPENCODE_PROVIDER_RUNTIME_UNSUPPORTED' });
        await assert.rejects(Effect.runPromise(resolver.resolve({ providerID: 'synthetic', id: 'fixture' })), { code: 'OPENCODE_PROVIDER_RUNTIME_UNSUPPORTED' });
      }
      const session = await host.sessions.create({ title: 'runtime-install boundary', agent: OPENCODE_AGENT, location, model: selectedRef, metadata: {}, permissions: OPENCODE_EXECUTOR_PERMISSIONS });
      await host.sessions.prompt({ sessionID: session.id, text: 'Return one synthetic response' });
      await host.sessions.wait({ sessionID: session.id });
      const snapshot = await host.sessions.get({ sessionID: session.id });
      const events = await Array.fromAsync(host.sessions.log({ sessionID: session.id, follow: false }));
      result = { mode, providerIDs: providerList.data.map(item => item.id), modelIDs: modelList.data.map(item => item.id), outcome: snapshot.outcome, implementations: effectiveModels.map(({providerID,id,package:implementation}) => ({providerID,id,implementation})), events };
      if (kind === 'normal' || kind === 'muse') {
        assert.equal(snapshot.outcome, 'succeeded', JSON.stringify(events.filter(event => event.data?.error).map(event => event.data.error)));
        assert.ok(providerList.data.some(item => item.id === 'opencode'));
        assert.ok(modelList.data.some(item => item.id === 'muse-spark-1.3-contributor-free'));
        assert.equal(observed.inference, 1);
        assert.ok(effectiveModels.find(model => model.providerID === selectedRef.providerID && model.id === selectedRef.id)?.package.startsWith('@opencode/ai/providers/'));
      } else {
        assert.equal(snapshot.outcome, 'failed');
        const failure = events.find(event => event.type === 'session.execution.failed');
        assert.equal(failure?.data.error.type, 'provider.no-route');
        assert.equal(failure?.data.error.message, 'Model unavailable: synthetic/fixture');
        assert.ok(!modelList.data.some(item => item.providerID === 'synthetic' && item.id === 'fixture'));
        assert.equal(observed.inference, 0);
      }
      if (kind === 'cohere') {
        const input = { title: 'direct generated API', agent: OPENCODE_AGENT, location, model: selectedRef, metadata: {}, permissions: OPENCODE_EXECUTOR_PERMISSIONS };
        const direct = await effectCall('session', 'create', input);
        await effectCall('session', 'prompt', { sessionID: direct.id, text: 'Reject this unsupported model' });
        await host.sessions.wait({ sessionID: direct.id });
        assert.equal((await host.sessions.get({ sessionID: direct.id })).outcome, 'failed');
        const { RoutingDiscovery, PolicyRouter } = await import('../../dist/src/routing.js');
        const { createPhase2PlanningDecision } = await import('../../dist/src/planning.js');
        const adapter = new OpenCodeAdapter({ runtimeRoot: join(root, 'routing-runtime'), createHost: async () => host });
        const codex = { probe: () => ({ schemaVersion: 'kerbsflow.adapter-descriptor/v1', adapter: 'codex', provider: 'openai', adapterVersion: 'synthetic', capabilities: { eventTransport: 'jsonl', finalJsonSchema: true, modelSelection: true, reasoningEffort: ['max'], agentSelection: false, filesystemEnforcement: 'enforced', network: { providerControlPlane: 'provider_owned', workload: 'enforced' }, cancellation: 'process_only', resumableSession: true, authentication: { owner: 'provider', mode: 'synthetic' }, healthProbe: true } }) };
        const planningDecision = createPhase2PlanningDecision({ decisionId: 'decision_native_scope', runId: 'run_native_scope', taskId: 'task_native_scope', objective: 'synthetic native scope route', acceptance: ['unsupported route cannot execute'], positiveScope: ['src/example.ts'], negativeScope: ['secrets'], model: 'placeholder', canonicalContext: 'synthetic native scope' });
        const models = [{ adapter: 'opencode', provider: 'synthetic', model: 'synthetic/fixture', family: 'muse' }, { adapter: 'codex', provider: 'openai', model: 'openai/luna-synthetic', family: 'luna', reasoning: 'max' }];
        const registered = [{ adapter: 'opencode', implementation: adapter }, { adapter: 'codex', implementation: codex }];
        const discovery = await new RoutingDiscovery(registered).discover({ workingDirectory: worktree, models });
        const routed = new PolicyRouter().route({ planningDecision, classification: 'normal', discovery });
        assert.equal(routed.planningDecision.route.adapter, 'codex');
        assert.match(routed.routingDecision.fallbackReason, /not discovered/i);
        const unavailable = await new RoutingDiscovery(registered.slice(0, 1)).discover({ workingDirectory: worktree, models });
        assert.throws(() => new PolicyRouter().route({ planningDecision, classification: 'normal', discovery: unavailable }), /no Phase 4 route/i);
        result.routing = { selected: routed.planningDecision.route, unavailable: 'gate', codex: 'synthetic descriptor only; no execution' };
        await adapter.close();
      }
      assert.equal(existsSync(join(root, 'cache/opencode/npm')), false);
    } finally { await Effect.runPromise(Scope.close(mutationScope, Exit.void)); await host.close(); }
    for (const key of ['npmCalls', 'pacoteLoads', 'pacoteCalls', 'fetchLoads', 'fetchCalls', 'cacheLoads', 'cacheConstructs', 'clients', 'listeners', 'legacyHandlers', 'externalModules']) assert.equal(observed[key], 0, key);
    assert.equal(observed.released, 1);
    console.log(JSON.stringify({ ...result, ...observed }));
    return;
  }

  if (mode === 'failed-create' || mode === 'stalled-close' || mode === 'failed-stream-close' || mode === 'failed-normal-stream-finalizer' || driftMode) {
    if (mode === 'failed-stream-close') {
      const host = await createOpenCodeHost(hostOptions);
      const abort = new AbortController();
      const iterator = host.sessions.log({ sessionID: 'synthetic' }, { signal: abort.signal })[Symbol.asyncIterator]();
      const pull = assert.rejects(iterator.next());
      await new Promise(resolve => setImmediate(resolve));
      abort.abort(); await pull;
      await assert.rejects(host.close(), { code: 'OPENCODE_STREAM_CLOSE_FAILED' });
      assert.equal(observed.released, 1);
    } else if (mode === 'failed-normal-stream-finalizer') {
      const host = await createOpenCodeHost(hostOptions);
      const iterator = host.sessions.log({ sessionID: 'synthetic' })[Symbol.asyncIterator]();
      const capture = async (operation) => {
        try { return { status: 'fulfilled', value: await operation }; }
        catch (error) { return { status: 'rejected', code: error?.code, message: error?.message }; }
      };
      const next = await capture(iterator.next());
      const streamScopeReleased = observed.streamScopeReleased;
      const closing = host.close();
      const closeSame = host.close() === closing;
      const close = await capture(closing);
      console.log(JSON.stringify({ mode, next, streamScopeReleased, close, closeSame, hostScopeReleased: observed.released }));
      return;
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
