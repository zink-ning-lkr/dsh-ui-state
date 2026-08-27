/**
 * dsh-ui-state — Node half.
 *
 * Registers the `ui-state` settings namespace (sidebarCollapsed / sidebarWidth /
 * detailsOpen / chatScroll) on the host settings seam, and mounts a
 * loopback-only HTTP bridge (describe + mutate) so the browser client can
 * persist and restore the official sidebar layout. Same pattern as
 * dsh-node-nav / dsh-chat-width.
 *
 * `makeBridgeHandlers` / `makeBridgeRoutes` / `namespaceSchema` are exported for
 * tests: the first two take the settings seam as an injectable dependency, so a
 * fake seam exercises the full request path without a host; the schema lets a
 * test pin down the tolerance behavior of hand-edited stored sections.
 */
import z from "@deepseek-ai/schemastery";
import { SettingsConflictError, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Required services before the bridge routes can mount. */
const inject = ["webServer"];

/** The namespace this plugin owns. */
const NAMESPACE = settingsNamespace("ui-state");

/**
 * One chat-scroll entry per session. Fields stay optional (no defaults): an
 * absent field means "never observed / do not restore". `loose()` only guards
 * the read path — a hand-edited or cross-plugin-written malformed entry
 * resolves to `{}` instead of failing the whole namespace registration, so a
 * bad row in settings.yaml can never take the bridge down.
 */
const ChatScrollEntry = z.object({
	anchorKey: z.string(),
	anchorTop: z.number(),
	scrollTop: z.number(),
	updatedAt: z.number()
}).loose();

/**
 * Schema resolving the namespace value. Fields are optional (no defaults):
 * an absent field means "never observed / do not restore".
 * - sidebarCollapsed: whether the official left sidebar sits collapsed (rail).
 * - sidebarWidth: last expanded sidebar width in px (official contract 264-420).
 * - detailsOpen: whether the official right details panel is open.
 *
 * Every field rides `.loose()`: the registry validates the *stored* section at
 * registration time, so an out-of-contract or mistyped value in settings.yaml
 * (hand edit, older plugin version, another plugin) must degrade to a missing
 * field instead of throwing and killing the namespace — the raw section keeps
 * its bytes, the bridge keeps serving, and the next clean write replaces it.
 */
const Config = z.object({
	sidebarCollapsed: z.boolean().loose(),
	sidebarWidth: z.number().min(264).max(420).loose(),
	detailsOpen: z.boolean().loose(),
	chatScroll: z.dict(ChatScrollEntry).loose()
});

/** Cap on JSON request bodies (a single mutate is tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Loopback literal check plus browser same-origin markers (mirrors the dsh-ssh route fence). */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		// Settings are configuration state: never let any layer cache the
		// response (a stale describe would mislead the UI) and always send an
		// explicit type so no downstream sniffing can reinterpret it.
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) {
			// Draining the remainder keeps the keep-alive connection reusable;
			// an abandoned half-read body would desync the next request.
			req.resume();
			return void 0;
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return;
	}
}

/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor) {
	return {
		ns: String(descriptor.ns),
		schema: descriptor.schema,
		value: descriptor.value,
		...(descriptor.base === void 0 ? {} : { base: descriptor.base }),
		...(descriptor.user === void 0 ? {} : { user: descriptor.user }),
		revision: descriptor.revision
	};
}

/** Map a seam failure onto the official-shaped refusal envelope. */
function failureOf(error) {
	if (error instanceof SettingsConflictError) {
		return {
			ok: false,
			code: "settings-conflict",
			message: error.message
		};
	}
	return {
		ok: false,
		code: "settings-rejected",
		message: error instanceof Error ? error.message : String(error)
	};
}

/**
 * Build the bridge handlers. The namespace is re-read on every call, so edits
 * to settings.yaml take effect without a host restart.
 * @param deps - the settings seam.
 * @returns the handlers.
 */
function makeBridgeHandlers(deps) {
	const viewOf = () => {
		const descriptors = deps.settings.describe({ redactSecrets: true });
		return descriptors.find((descriptor) => String(descriptor.ns) === NAMESPACE);
	};
	return {
		async describe() {
			const descriptor = viewOf();
			if (descriptor === void 0) {
				return {
					ok: false,
					code: "settings-rejected",
					message: `settings namespace "${NAMESPACE}" is not registered`
				};
			}
			return {
				ok: true,
				value: {
					namespaces: [toView(descriptor)],
					writable: deps.settings.writable !== false
				}
			};
		},
		async mutate(request) {
			const body = request;
			if (body === null || typeof body !== "object" || !Array.isArray(body.ops)) {
				return {
					ok: false,
					code: "settings-rejected",
					message: "malformed bridge settings request"
				};
			}
			const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : void 0;
			try {
				await deps.settings.mutate(NAMESPACE, body.ops, expectedRevision);
			} catch (error) {
				return failureOf(error);
			}
			const descriptor = viewOf();
			if (descriptor === void 0) {
				return {
					ok: false,
					code: "internal",
					message: `settings namespace "${NAMESPACE}" was disposed after the mutate`
				};
			}
			return { ok: true, value: toView(descriptor) };
		}
	};
}

/**
 * Build the loopback-only bridge routes.
 * @param deps - handler dependencies.
 * @returns the exact-path route registrations.
 */
function makeBridgeRoutes(deps) {
	const handlers = makeBridgeHandlers(deps);
	const guard = (req, res) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "loopback requests only" });
			return false;
		}
		if (req.method !== "POST") {
			writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: "/api/dsh-ui-state/settings/describe",
			handler: async (req, res) => {
				if (!guard(req, res)) return;
				writeJson(res, 200, await handlers.describe());
			}
		},
		{
			kind: "exact",
			path: "/api/dsh-ui-state/settings/mutate",
			handler: async (req, res) => {
				if (!guard(req, res)) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, {
						ok: false,
						code: "settings-rejected",
						message: "unreadable JSON body"
					});
					return;
				}
				writeJson(res, 200, await handlers.mutate(body));
			}
		}
	];
}

/**
 * Mount the namespace and the bridge.
 * @param ctx - host plugin context.
 */
function apply(ctx) {
	ctx.inject(["settings"], (sctx) => {
		sctx.effect(() => {
			// The namespace registration's cleanup effect rides the (long-lived)
			// settings provider fiber, not this plugin's fiber — so a reload /
			// hot-install of a second instance can meet the previous instance's
			// registration and exact routes still in place. Treat that as
			// idempotent reuse instead of a mount failure: the bridge keeps
			// serving exactly the same view either way.
			let scope;
			try {
				scope = sctx.settings.register(NAMESPACE, Config);
			} catch (error) {
				if (!(error instanceof Error && /already registered/.test(error.message))) throw error;
				scope = void 0;
			}
			// Registration rides the fiber; keep the owner scope referenced.
			void scope;
			const disposers = [];
			for (const route of makeBridgeRoutes({
				settings: sctx.settings
			})) {
				try {
					disposers.push(sctx.webServer.register(route));
				} catch (error) {
					if (!(error instanceof Error && /duplicate/.test(error.message))) throw error;
					// The identical route from the stale instance is still live.
				}
			}
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-ui-state: settings namespace + bridge");
	});
}

/** Public alias for tests: the live namespace schema (also used by apply). */
const namespaceSchema = Config;

export { apply, inject, makeBridgeHandlers, makeBridgeRoutes, namespaceSchema };
