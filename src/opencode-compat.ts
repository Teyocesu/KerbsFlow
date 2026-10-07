import * as Runtime from "effect";


import { KerbsFlowError } from "./errors.js";
import type { OpenCodeHostBoundary, OpenCodeHostFactory } from "./opencode.js";

const { Cause, Context, Effect, Exit, Layer, Pull, Result, Scope, Stream } = Runtime;

// These are public runtime exports. Non-literal imports keep the pinned SDK's
// incompatible declarations inside this runtime-validated compatibility boundary.
const SDK = "@opencode/sdk/effect";
const SOURCE = "@opencode/core/config/plugin/source";
const MCP = "@opencode/core/config/plugin/mcp";
const NPM = "@opencode/util/npm";
const MODEL = "@opencode/core/model";
const RESOLVER = "@opencode/core/model-resolver";
const NATIVE = "@opencode/core/aisdk-native";
const LIFECYCLE_TIMEOUT_MS = 10_000;

type RuntimeCall = (...args: unknown[]) => unknown;
type Session = Awaited<ReturnType<OpenCodeHostBoundary["sessions"]["get"]>>;

export const createOpenCodeHost: OpenCodeHostFactory = async (options) => {
  for (const name of ["Cause", "Context", "Effect", "Exit", "Layer", "Pull", "Result", "Scope", "Stream"] as const) record(Runtime[name], `effect.${name}`);
  for (const [name, operation] of Object.entries({
    "Layer.succeed": Layer.succeed, "Layer.effect": Layer.effect, "Layer.provide": Layer.provide, "Layer.isLayer": Layer.isLayer,
    "Effect.map": Effect.map, "Effect.flatMap": Effect.flatMap, "Effect.suspend": Effect.suspend, "Scope.make": Scope.make, "Scope.close": Scope.close, "Scope.fork": Scope.fork,
    "Context.isKey": Context.isKey, "Effect.isEffect": Effect.isEffect, "Effect.succeed": Effect.succeed,
    "Effect.runSync": Effect.runSync, "Effect.runPromise": Effect.runPromise, "Effect.runPromiseExit": Effect.runPromiseExit, "Effect.fail": Effect.fail,
    "Effect.provideService": Effect.provideService, "Stream.isStream": Stream.isStream, "Stream.toPull": Stream.toPull,
    "Cause.hasInterruptsOnly": Cause.hasInterruptsOnly, "Cause.squash": Cause.squash,
    "Pull.filterDone": Pull.filterDone, "Pull.isDoneCause": Pull.isDoneCause, "Result.isFailure": Result.isFailure,
    "Exit.isFailure": Exit.isFailure, "Exit.isExit": Exit.isExit,
  })) callable(operation, name);
  if (!Exit.isExit(Exit.void)) throw drift("Exit.void");
  if (!Stream.isStream(Stream.never)) throw drift("Stream.never");
  const [sdk, sourceModule, mcpModule, npmModule, modelModule, resolverModule, nativeModule]: unknown[] = await Promise.all([import(SDK), import(SOURCE), import(MCP), import(NPM), import(MODEL), import(RESOLVER), import(NATIVE)]).catch(() => {
    throw new KerbsFlowError("OPENCODE_RUNTIME_UNAVAILABLE", "Pinned OpenCode public runtime exports could not be loaded");
  });
  const create = callable(record(record(sdk, SDK).OpenCode, "OpenCode").create, "OpenCode.create");
  const source = record(record(sourceModule, SOURCE).ConfigPluginSource, "ConfigPluginSource");
  const node = record(source.node, "ConfigPluginSource.node");
  const replace = callable(node.replace, "ConfigPluginSource.node.replace");
  if (!Context.isKey(source.Service)) throw drift("ConfigPluginSource.Service");
  const service: Runtime.Context.Key<unknown, unknown> = source.Service;
  const plugin = record(record(record(mcpModule, MCP).ConfigMcpPlugin, "ConfigMcpPlugin").Plugin, "ConfigMcpPlugin.Plugin");
  const mcpID = string(plugin.id, "ConfigMcpPlugin.Plugin.id");
  if (mcpID.length === 0) throw drift("ConfigMcpPlugin.Plugin.id");
  const replacement = replace.call(node, Layer.succeed(service, {
    operations: () => Effect.succeed([{ type: "remove", target: mcpID }]),
    changes: () => Stream.never,
  }));
  if (typeof replacement !== "object" || replacement === null) throw drift("ConfigPluginSource replacement");
  const npm = record(npmModule, NPM);
  if (!Context.isKey(npm.Service)) throw drift("Npm.Service");
  const npmService: Runtime.Context.Key<unknown, unknown> = npm.Service;
  const npmNode = record(npm.node, "Npm.node");
  const replaceNpm = callable(npmNode.replace, "Npm.node.replace");
  const denyPackageManagement = () => Effect.fail(new KerbsFlowError("OPENCODE_RUNTIME_INSTALL_DENIED", "OpenCode runtime package management is unavailable; use a bundled native provider"));
  const npmReplacement = replaceNpm.call(npmNode, Layer.succeed(npmService, {
    add: denyPackageManagement, resolve: denyPackageManagement, check: denyPackageManagement,
    update: denyPackageManagement, which: denyPackageManagement,
  }));
  if (typeof npmReplacement !== "object" || npmReplacement === null) throw drift("Npm replacement");

  const rewriteNative = callable(record(nativeModule, NATIVE).rewrite, "AISDKNative.rewrite");
  const isNative = (value: unknown): boolean => {
    if (value === undefined) return false;
    const model = record(value, "model provenance");
    if (typeof model.package !== "string" || !model.package.startsWith("@opencode/ai/providers/")) return false;
    // Public rewrite leaves unknown packages untouched; a blank target distinguishes them.
    const target = { package: "" };
    rewriteNative(target, { specifier: model.package, providerID: model.providerID, modelID: model.modelID ?? model.id });
    return target.package.startsWith("@opencode/ai/providers/");
  };
  const model = record(modelModule, MODEL);
  if (!Context.isKey(model.Service)) throw drift("Model.Service");
  const modelService: Runtime.Context.Key<unknown, unknown> = model.Service;
  const modelReplacement = constrainNode(model, "Model", original => {
    const result = { ...original };
    for (const name of ["all", "available", "default", "small"]) {
      const operation = callable(original[name], `Model.${name}`);
      result[name] = (...args: unknown[]) => Effect.map(runtimeEffect(operation(...args)), value =>
        name === "all" || name === "available" ? array(value, "model catalog").filter(isNative) : isNative(value) ? value : undefined);
    }
    return Effect.succeed(result);
  });
  const resolverReplacement = constrainNode(record(resolverModule, RESOLVER), "ModelResolver", original => Effect.map(modelService, value => {
    const models = record(value, "Model service");
    const get = callable(models.get, "Model.get");
    const defaultModel = callable(models.default, "Model.default");
    const available = callable(models.available, "Model.available");
    const resolveOriginal = callable(original.resolveModel, "ModelResolver.resolveModel");
    const resolveModel = (selected: unknown, variant?: unknown) => Effect.suspend(() => {
      const snapshot = { ...record(selected, "model provenance") };
      return isNative(snapshot)
        ? runtimeEffect(resolveOriginal(snapshot, variant))
        : Effect.fail(new KerbsFlowError("OPENCODE_PROVIDER_RUNTIME_UNSUPPORTED", "OpenCode v0.1 supports only bundled native provider implementations"));
    });
    return {
      resolveModel,
      resolve: (requested?: unknown) => {
        const ref = requested === undefined ? undefined : record(requested, "model reference");
        const selection = ref === undefined
          ? Effect.flatMap(runtimeEffect(defaultModel()), selected => selected === undefined
            ? Effect.map(runtimeEffect(available()), value => array(value, "available models")[0]) : Effect.succeed(selected))
          : runtimeEffect(get(ref.providerID, ref.id));
        return Effect.flatMap(selection, selected =>
          selected === undefined ? Effect.succeed(undefined) : resolveModel(selected, ref?.variant));
      },
    };
  }));

  const scope = Effect.runSync(Scope.make());
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const iterators = new Set<AsyncIterator<unknown>>();
  let streamCloseFailed = false;
  let closing: Promise<void> | undefined;

  const run = (value: unknown, signal?: AbortSignal): Promise<unknown> => {
    lifetime.signal.throwIfAborted();
    const combined = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal]);
    combined.throwIfAborted();
    const operation = Effect.runPromise(Effect.provideService(runtimeEffect(value), Runtime.Scope.Scope, scope), { signal: combined });
    pending.add(operation);
    // The caller retains the operation's rejection; this branch only retires
    // bookkeeping and must not create an unhandled duplicate rejection.
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
    return operation;
  };
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    lifetime.abort(new KerbsFlowError("OPENCODE_HOST_CLOSED", "OpenCode host lifetime ended"));
    const cleanup = (async () => {
      // Retain ownership until all pulls/calls settle, then release the host graph.
      try {
        await Promise.allSettled([...iterators].map((iterator) => iterator.return?.()));
        await Promise.allSettled([...pending]);
        if (streamCloseFailed) throw new KerbsFlowError("OPENCODE_STREAM_CLOSE_FAILED", "OpenCode stream termination failed");
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    })();
    closing = bounded(cleanup, "host close");
    return closing;
  };

  try {
    const creationSignal = AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS);
    const raw = record(await run(create(options, { overrides: [replacement, npmReplacement, modelReplacement, resolverReplacement] }), creationSignal), "OpenCode host");
    const methods = new Map<string, RuntimeCall>();
    for (const [group, names] of Object.entries({
      server: ["info"], sessions: ["create", "prompt", "wait", "get", "list", "context", "log", "interrupt"],
      permission: ["create"], provider: ["list"], model: ["list"],
    })) {
      const target = record(raw[group], group);
      for (const name of names) methods.set(`${group}.${name}`, callable(target[name], `${group}.${name}`).bind(target));
    }
    const invoke = (name: string, input?: unknown, signal?: AbortSignal): Promise<unknown> => {
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      return run(methods.get(name)!(input), signal);
    };
    const host: OpenCodeHostBoundary = {
      server: { info: async (request) => {
        const value = record(await invoke("server.info", undefined, request?.signal), "server.info result");
        const paths = record(value.paths, "server.info paths");
        return { version: string(value.version, "server version"), pid: integer(value.pid, "server pid"), urls: array(value.urls, "server urls").map((url) => string(url, "server url")), paths: { tmp: string(paths.tmp, "server tmp") } };
      } },
      sessions: {
        create: async (input, request) => session(await invoke("sessions.create", input, request?.signal)),
        prompt: async (input, request) => payload(await invoke("sessions.prompt", input, request?.signal)),
        wait: async (input, request) => { await invoke("sessions.wait", input, request?.signal); },
        get: async (input, request) => session(await invoke("sessions.get", input, request?.signal)),
        list: async (input, request) => {
          const value = record(await invoke("sessions.list", input, request?.signal), "sessions.list result");
          const data = array(value.data, "sessions data").map(session);
          if (value.cursor === undefined) return { data };
          const cursor = record(value.cursor, "session cursor");
          return { data, cursor: { ...(cursor.previous === undefined ? {} : { previous: string(cursor.previous, "previous cursor") }), ...(cursor.next === undefined ? {} : { next: string(cursor.next, "next cursor") }) } };
        },
        context: async (input, request) => array(await invoke("sessions.context", input, request?.signal), "session context").map((value) => payload(value)),
        log: (input, request) => ({ [Symbol.asyncIterator]() {
          lifetime.signal.throwIfAborted();
          request?.signal?.throwIfAborted();
          const value = methods.get("sessions.log")!(input);
          if (!Stream.isStream(value)) throw drift("sessions.log Stream");
          // Only Scope is supplied by this boundary; the public SDK binds its
          // own host runtime into each operation/stream.
          const stream = value as Runtime.Stream.Stream<unknown, unknown, Runtime.Scope.Scope>;
          // Use public pulls so interruption cannot discard finalizer failures.
          // Each subscription's child Scope is owned by the host Scope.
          const streamScope = Effect.runSync(Scope.fork(scope));
          const stop = new AbortController();
          const signal = AbortSignal.any([lifetime.signal, stop.signal, ...(request?.signal === undefined ? [] : [request.signal])]);
          let pull: Runtime.Effect.Effect<readonly unknown[], unknown> | undefined;
          let buffer: Iterator<unknown> | undefined;
          let tail: Promise<void> = Promise.resolve();
          let returned: Promise<IteratorResult<unknown>> | undefined;
          const done: IteratorResult<unknown> = { done: true, value: undefined };
          const failure = (cause: Runtime.Cause.Cause<unknown>): IteratorResult<unknown> => {
            const completion = Pull.filterDone(cause);
            if (Result.isFailure(completion)) {
              const interrupted = Cause.hasInterruptsOnly(cause);
              if (Pull.isDoneCause(cause)) streamCloseFailed = true;
              else if (signal.aborted && !interrupted) streamCloseFailed = true;
              lifetime.signal.throwIfAborted();
              request?.signal?.throwIfAborted();
              if (stop.signal.aborted && interrupted) return done;
              throw Cause.squash(completion.failure);
            }
            lifetime.signal.throwIfAborted();
            request?.signal?.throwIfAborted();
            return done;
          };
          const read = async (): Promise<IteratorResult<unknown>> => {
            lifetime.signal.throwIfAborted();
            request?.signal?.throwIfAborted();
            if (stop.signal.aborted) return done;
            if (pull === undefined) {
              const acquired = await Effect.runPromiseExit(Effect.provideService(Stream.toPull(stream), Runtime.Scope.Scope, streamScope), { signal });
              if (Exit.isFailure(acquired)) return failure(acquired.cause);
              pull = acquired.value;
            }
            for (;;) {
              const next = buffer?.next();
              if (next !== undefined && !next.done) return { done: false, value: payload(next.value) };
              const result = await Effect.runPromiseExit(pull, { signal });
              if (Exit.isFailure(result)) return failure(result.cause);
              lifetime.signal.throwIfAborted();
              request?.signal?.throwIfAborted();
              buffer = array(result.value, "stream chunk")[Symbol.iterator]();
            }
          };
          const finish = (): Promise<IteratorResult<unknown>> => {
            if (returned !== undefined) return returned;
            request?.signal?.removeEventListener("abort", onAbort);
            stop.abort();
            const cleanup = (async () => {
              await tail;
              await Effect.runPromise(Scope.close(streamScope, Exit.void));
              return done;
            })();
            returned = bounded(cleanup, "stream termination")
              .catch((error) => { streamCloseFailed = true; throw error; })
              .finally(() => iterators.delete(owned));
            return returned;
          };
          const onAbort = () => { void finish().catch(() => undefined); };
          const owned: AsyncIterator<unknown> = {
            next() {
              const operation = tail.then(read);
              tail = operation.then(() => undefined, () => undefined);
              return operation.then(async (result) => {
                if (result.done) await finish();
                return result;
              }, async (error) => { await finish(); throw error; });
            },
            return: finish,
          };
          iterators.add(owned);
          request?.signal?.addEventListener("abort", onAbort, { once: true });
          return owned;
        } }),
        interrupt: async (input, request) => {
          const value = record(await invoke("sessions.interrupt", input, request?.signal), "interrupt result");
          if (typeof value.interrupted !== "boolean") throw drift("interrupt.interrupted");
          return { interrupted: value.interrupted };
        },
      },
      permission: { create: async (input, request) => {
        const value = record(await invoke("permission.create", input, request?.signal), "permission result");
        const effect = value.effect;
        if (effect !== "allow" && effect !== "deny" && effect !== "ask") throw drift("permission.effect");
        return { id: string(value.id, "permission id"), effect };
      } },
      provider: { list: async (input, request) => {
        const value = record(await invoke("provider.list", input, request?.signal), "provider.list result");
        return { data: array(value.data, "providers").map((item) => {
          const provider = record(item, "provider");
          const activation = provider.activation;
          if (activation !== "auto" && activation !== "enabled" && activation !== "disabled") throw drift("provider.activation");
          return { id: string(provider.id, "provider id"), name: string(provider.name, "provider name"), activation };
        }) };
      } },
      model: { list: async (input, request) => {
        const value = record(await invoke("model.list", input, request?.signal), "model.list result");
        return { data: array(value.data, "models").map((item) => {
          const model = record(item, "model");
          const status = model.status;
          if (status !== "alpha" && status !== "beta" && status !== "deprecated" && status !== "active") throw drift("model.status");
          if (typeof model.enabled !== "boolean") throw drift("model.enabled");
          return { id: string(model.id, "model id"), ...(model.modelID === undefined ? {} : { modelID: string(model.modelID, "modelID") }), providerID: string(model.providerID, "model provider"), name: string(model.name, "model name"), enabled: model.enabled, status, variants: array(model.variants, "model variants").map((variant) => ({ id: string(record(variant, "variant").id, "variant id") })) };
        }) };
      } },
      close,
    };
    // Inspection belongs to creation: a malformed/listening host is never
    // returned, and failure still releases the one owning Scope.
    if ((await host.server.info({ signal: creationSignal })).urls.length !== 0) throw new KerbsFlowError("OPENCODE_LISTENER_UNEXPECTED", "embedded OpenCode host reported a listener URL");
    return host;
  } catch (error) {
    await close();
    throw error;
  }
};

function constrainNode(module: Record<string, unknown>, label: string, adapt: (original: Record<string, unknown>) => Runtime.Effect.Effect<unknown, unknown, unknown>): unknown {
  if (!Context.isKey(module.Service)) throw drift(`${label}.Service`);
  const service: Runtime.Context.Key<unknown, unknown> = module.Service;
  const node = record(module.node, `${label}.node`);
  const mapLayer = callable(node.mapLayer, `${label}.node.mapLayer`);
  const replace = callable(node.replace, `${label}.node.replace`);
  const mapped = mapLayer.call(node, (layer: unknown) => {
    if (!Layer.isLayer(layer)) throw drift(`${label} layer`);
    return Layer.provide(Layer.effect(service, Effect.flatMap(service, original => adapt(record(original, `${label} service`)))), layer);
  });
  const replacement = replace.call(node, mapped);
  if (typeof replacement !== "object" || replacement === null) throw drift(`${label} replacement`);
  return replacement;
}

function runtimeEffect(value: unknown): Runtime.Effect.Effect<unknown, unknown, Runtime.Scope.Scope> {
  if (!Effect.isEffect(value)) throw drift("Effect result");
  return value as Runtime.Effect.Effect<unknown, unknown, Runtime.Scope.Scope>;
}

function session(value: unknown): Session {
  const data = record(value, "session");
  const outcome = data.outcome;
  if (outcome !== undefined && outcome !== "succeeded" && outcome !== "failed" && outcome !== "interrupted") throw drift("session outcome");
  return { id: string(data.id, "session id"), ...(outcome === undefined ? {} : { outcome }), ...(data.metadata === undefined ? {} : { metadata: jsonRecord(data.metadata, "session metadata") }) };
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function payload(value: unknown): Json | undefined {
  return value === undefined ? undefined : json(value, 0);
}
function json(value: unknown, depth: number): Json {
  if (depth > 64) throw drift("payload nesting");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
  if (typeof value !== "object" || value === null || Object.prototype.toString.call(value) !== "[object Object]") throw drift("JSON payload");
  return Object.fromEntries(Object.entries(record(value, "JSON payload")).map(([key, item]) => [key, json(item, depth + 1)]));
}
function jsonRecord(value: unknown, label: string): Record<string, Json> {
  const parsed = json(value, 0);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw drift(label);
  return parsed;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || Array.isArray(value)) throw drift(label);
  return value as Record<string, unknown>;
}
function callable(value: unknown, label: string): RuntimeCall {
  if (typeof value !== "function") throw drift(label);
  return value as RuntimeCall;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw drift(label);
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw drift(label);
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw drift(label);
  return value;
}
function drift(label: string): KerbsFlowError {
  return new KerbsFlowError("OPENCODE_RUNTIME_SHAPE_INVALID", `Pinned OpenCode runtime has an unexpected ${label}`);
}
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new KerbsFlowError("OPENCODE_CLOSE_UNCERTAIN", `OpenCode ${label} exceeded its lifecycle deadline`)), LIFECYCLE_TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
