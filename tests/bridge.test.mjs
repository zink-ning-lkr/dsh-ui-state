/**
 * dsh-ui-state — bridge tests (Node half).
 *
 * Exercises the loopback settings bridge against an injectable fake settings
 * seam: wire shapes, batched mutate, revision conflicts, malformed bodies and
 * the loopback fence. Runs with the Node built-in test runner:
 *
 *   npm install --no-audit --no-fund   # once, resolves @deepseek-ai deps
 *   node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeBridgeHandlers, makeBridgeRoutes } from "../lib/index.js";
import { settingsNamespace, SettingsConflictError } from "@deepseek-ai/dsh-settings";

const NS = settingsNamespace("ui-state");

/** Minimal settings seam double matching the host service surface. */
function makeFakeSettings(initial = {}) {
	let user = { ...initial };
	let revision = 0;
	return {
		writable: true,
		describe({ redactSecrets } = {}) {
			void redactSecrets;
			return [{
				ns: NS,
				schema: {},
				value: { ...user },
				user: { ...user },
				revision
			}];
		},
		async mutate(targetNs, ops, expectedRevision) {
			assert.equal(String(targetNs), String(NS), "mutate must target the ui-state namespace");
			if (expectedRevision !== void 0 && expectedRevision !== revision) {
				throw new SettingsConflictError(String(NS), expectedRevision, revision);
			}
			for (const op of ops) {
				if (op.op === "set") {
					user[op.path[0]] = op.value;
				} else if (op.op === "unset") {
					delete user[op.path[0]];
				} else {
					throw new TypeError(`unexpected op ${op.op}`);
				}
			}
			revision += 1;
			return user;
		}
	};
}

/** Loopback fakes for routing tests; body optional (describe needs none). */
function fakeRequest(method, body, options = {}) {
	const chunks = body === void 0 ? [] : [
		Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8")
	];
	return {
		method,
		socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
		headers: {
			host: options.host ?? "localhost:11443",
			"sec-fetch-site": options.secFetchSite ?? "same-origin",
			...(options.origin === void 0 ? {} : { origin: options.origin })
		},
		resume() { /* drain marker for oversized bodies */ },
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		}
	};
}

function fakeResponse() {
	return {
		status: void 0,
		headers: void 0,
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(payload) {
			this.body = payload;
		}
	};
}

test("describe: loopback request returns the namespace view with writable flag", async () => {
	const routes = makeBridgeRoutes({ settings: makeFakeSettings({ sidebarWidth: 360 }) });
	const describe = routes.find((r) => r.path === "/api/dsh-ui-state/settings/describe");
	const res = fakeResponse();
	await describe.handler(fakeRequest("POST"), res);
	assert.equal(res.status, 200);
	const json = JSON.parse(res.body);
	assert.equal(json.ok, true);
	assert.equal(json.value.writable, true);
	assert.equal(json.value.namespaces.length, 1);
	assert.equal(json.value.namespaces[0].ns, String(NS));
	assert.deepEqual(json.value.namespaces[0].user, { sidebarWidth: 360 });
});

test("describe: bridge response is never cached (no-store + nosniff)", async () => {
	const routes = makeBridgeRoutes({ settings: makeFakeSettings() });
	const describe = routes.find((r) => r.path === "/api/dsh-ui-state/settings/describe");
	const res = fakeResponse();
	await describe.handler(fakeRequest("POST"), res);
	assert.equal(res.headers["cache-control"], "no-store");
	assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test("mutate: batched ops apply in one call and the wire view returns updated state", async () => {
	const settings = makeFakeSettings({});
	const handlers = makeBridgeHandlers({ settings });
	const out = await handlers.mutate({
		ops: [
			{ op: "set", path: ["sidebarCollapsed"], value: true },
			{ op: "set", path: ["sidebarWidth"], value: 360 }
		]
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.value.user, { sidebarCollapsed: true, sidebarWidth: 360 });
	assert.equal(out.value.revision, 1);
});

test("mutate: stale expectedRevision is refused with settings-conflict", async () => {
	const settings = makeFakeSettings();
	const handlers = makeBridgeHandlers({ settings });
	await handlers.mutate({ ops: [{ op: "set", path: ["sidebarCollapsed"], value: true }] });
	const out = await handlers.mutate({
		expectedRevision: 0,
		ops: [{ op: "set", path: ["sidebarWidth"], value: 320 }]
	});
	assert.equal(out.ok, false);
	assert.equal(out.code, "settings-conflict");
});

test("mutate: malformed body is refused with settings-rejected", async () => {
	const handlers = makeBridgeHandlers({ settings: makeFakeSettings() });
	const out = await handlers.mutate({ nope: true });
	assert.equal(out.ok, false);
	assert.equal(out.code, "settings-rejected");
});

test("routes: non-loopback remote address is fenced with 403", async () => {
	const routes = makeBridgeRoutes({ settings: makeFakeSettings() });
	const describe = routes.find((r) => r.path === "/api/dsh-ui-state/settings/describe");
	const res = fakeResponse();
	await describe.handler(fakeRequest("POST", void 0, { remoteAddress: "203.0.113.9" }), res);
	assert.equal(res.status, 403);
});

test("routes: cross-site sec-fetch-site is fenced with 403", async () => {
	const routes = makeBridgeRoutes({ settings: makeFakeSettings() });
	const describe = routes.find((r) => r.path === "/api/dsh-ui-state/settings/describe");
	const res = fakeResponse();
	await describe.handler(fakeRequest("POST", void 0, { secFetchSite: "cross-site" }), res);
	assert.equal(res.status, 403);
});

test("routes: non-POST method is refused with 405", async () => {
	const routes = makeBridgeRoutes({ settings: makeFakeSettings() });
	const describe = routes.find((r) => r.path === "/api/dsh-ui-state/settings/describe");
	const res = fakeResponse();
	await describe.handler(fakeRequest("GET"), res);
	assert.equal(res.status, 405);
});

test("routes: loopback mutate roundtrip through the HTTP fence", async () => {
	const settings = makeFakeSettings({});
	const routes = makeBridgeRoutes({ settings });
	const mutate = routes.find((r) => r.path === "/api/dsh-ui-state/settings/mutate");
	const res = fakeResponse();
	await mutate.handler(fakeRequest("POST", {
		ops: [{ op: "set", path: ["detailsOpen"], value: true }]
	}), res);
	assert.equal(res.status, 200);
	const json = JSON.parse(res.body);
	assert.equal(json.ok, true);
	assert.deepEqual(json.value.user, { detailsOpen: true });
});

test("routes: malformed JSON body is refused with 400", async () => {
	const routes = makeBridgeRoutes({ settings: makeFakeSettings() });
	const mutate = routes.find((r) => r.path === "/api/dsh-ui-state/settings/mutate");
	const res = fakeResponse();
	await mutate.handler(fakeRequest("POST", Buffer.from("{oops")), res);
	assert.equal(res.status, 400);
	const json = JSON.parse(res.body);
	assert.equal(json.ok, false);
	assert.equal(json.code, "settings-rejected");
});