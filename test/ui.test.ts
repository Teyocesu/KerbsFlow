import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

import { LocalApiServer } from "../src/local-api.js";
import { createFixture } from "./helpers.js";

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(
  api: LocalApiServer,
  path: string,
  host = "127.0.0.1:" + api.port(),
  origin?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: api.port(),
      path,
      method: "GET",
      headers: origin === undefined ? { host } : { host, origin },
      setHost: false,
      agent: false,
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("LocalApiServer serves fixed dashboard assets with the bootstrap and security boundary", async () => {
  const fixture = createFixture();
  const api = new LocalApiServer({
    core: fixture.core,
    store: fixture.store,
    artifacts: {
      get(artifactId) {
        const content = fixture.artifacts.get(artifactId);
        if (content === undefined) throw new Error("artifact fixture content is unavailable");
        return content;
      },
    },
  });
  try {
    await api.start();
    const root = await get(api, "/");
    assert.equal(root.status, 200);
    assert.match(root.headers["content-type"] ?? "", /^text\/html; charset=utf-8/u);
    assert.match(root.body, /<meta name="kerbsflow-token" content="[A-Za-z0-9_-]+">/u);
    assert.doesNotMatch(root.body, /__KERBSFLOW_TOKEN__/u);
    assert.match(root.body, /<script type="module" src="\/app\.js"><\/script>/u);
    assert.match(root.body, /<link rel="stylesheet" href="\/styles\.css">/u);
    assert.doesNotMatch(root.body, /<script\b(?![^>]*\bsrc=)[^>]*>/iu);
    assert.equal(root.headers["cache-control"], "no-store");
    assert.equal(root.headers["referrer-policy"], "no-referrer");
    assert.equal(root.headers["x-content-type-options"], "nosniff");
    assert.equal(root.headers["x-frame-options"], "DENY");
    assert.equal(
      root.headers["content-security-policy"],
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );

    const script = await get(api, "/app.js");
    assert.equal(script.status, 200);
    assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(script.headers["cache-control"], "no-store");
    assert.equal(script.body, readFileSync(new URL("../../src/ui/app.js", import.meta.url), "utf8"));
    const exactOriginScript = await get(
      api,
      "/app.js",
      "127.0.0.1:" + api.port(),
      "http://127.0.0.1:" + api.port(),
    );
    assert.equal(exactOriginScript.status, 200);
    const foreignOriginScript = await get(
      api,
      "/app.js",
      "127.0.0.1:" + api.port(),
      "https://foreign.example",
    );
    assert.equal(foreignOriginScript.status, 403);

    const stylesheet = await get(api, "/styles.css");
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(stylesheet.headers["cache-control"], "no-store");
    assert.equal(stylesheet.body, readFileSync(new URL("../../src/ui/styles.css", import.meta.url), "utf8"));

    const unknown = await get(api, "/unknown.js");
    assert.equal(unknown.status, 404);
    const traversal = await get(api, "/%2e%2e/src/persistence.ts");
    assert.ok(traversal.status === 400 || traversal.status === 404);
    assert.match(traversal.headers["content-type"] ?? "", /^application\/json/u);
    assert.doesNotMatch(traversal.body, /CREATE TABLE|MIGRATIONS/u);

    const wrongHost = await get(api, "/app.js", "localhost:" + api.port());
    assert.equal(wrongHost.status, 403);
    assert.equal(wrongHost.headers["x-content-type-options"], "nosniff");
    assert.equal(wrongHost.headers["access-control-allow-origin"], undefined);
  } finally {
    await api.close();
    fixture.close();
  }
});

test("dashboard module keeps snapshot text inert and stays within the read-only CSP", () => {
  const html = readFileSync(new URL("../../src/ui/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../src/ui/app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../src/ui/styles.css", import.meta.url), "utf8");
  const forbiddenSinks = ["innerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"];
  for (const sink of forbiddenSinks) assert.equal(app.includes(sink), false, "forbidden rendering sink: " + sink);
  assert.match(app, /function setText\(element, value\) \{[\s\S]*?element\.textContent = valueText\(value\);/u);
  assert.doesNotMatch(app, /\b(?:localStorage|sessionStorage)\b/u);
  assert.doesNotMatch(app, /method\s*:\s*["']POST["']/u);
  assert.doesNotMatch(html, /https?:\/\//iu);
  assert.doesNotMatch(html, /<style\b|style=/iu);
  assert.doesNotMatch(styles, /https?:\/\/|@import\b|@font-face\b/iu);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/u);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/u);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/iu);
});
