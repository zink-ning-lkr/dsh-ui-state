window.__ModuleLoader__.load({
	id: "@zink-ning-lkr/dsh-ui-state",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants
		const NS = "ui-state";
		/** Official auto-collapse breakpoint (ui-layout SIDEBAR_AUTO_COLLAPSE). */
		const NARROW_BREAKPOINT = 1024;
		/** Debounce before persisting a sidebar/details change. */
		const PERSIST_DEBOUNCE_MS = 600;
		/** Debounce before persisting a chat scroll position. */
		const SCROLL_DEBOUNCE_MS = 300;
		/** Distance (px) from the bottom treated as "following new output". */
		const BOTTOM_THRESHOLD_PX = 25;
		/** Width difference (px) below which a restore is skipped. */
		const WIDTH_EPSILON = 4;
		/**
		 * Safety fallback cadence. The primary path is event-driven (mutation /
		 * resize observers); this tick only catches anything the observers could
		 * miss (unobserved DOM swaps, portal re-renders) and re-persists state.
		 */
		const SAFETY_TICK_MS = 60000;
		/** Restore retry cadence while the shell is still mounting. */
		const RESTORE_RETRY_MS = 600;
		/** Cap on restore retries per event burst (3.6s), then the next event re-arms. */
		const RESTORE_MAX_RETRIES = 6;
		/** Cap on persisted per-session chat scroll entries, newest first. */
		const MAX_CHAT_SCROLL_ENTRIES = 200;
		//#endregion

		//#region settings bridge controller
		/**
		 * Minimal SettingsScope controller over the loopback bridge routes (same
		 * pattern as dsh-node-nav). Carries the raw user layer so the restorer
		 * can tell "user configured" from "schema default".
		 */
		class UiStateController {
			constructor(loopback) {
				this.loopback = loopback;
				this.readGeneration = 0;
				this.state = {
					status: loopback ? "loading" : "unavailable",
					value: {},
					user: void 0,
					revision: void 0,
					writable: false,
					error: null
				};
				this.listeners = new Set();
				this.tail = Promise.resolve();
			}
			getSnapshot() {
				return this.state;
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			_emit() {
				for (const listener of this.listeners) listener();
			}
			async _read() {
				const response = await fetch("/api/dsh-ui-state/settings/describe", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				});
				const json = await response.json();
				if (!json.ok) throw new Error(json.message ?? "settings describe failed");
				const view = json.value.namespaces.find((candidate) => candidate.ns === NS);
				if (view === void 0) throw new Error("settings namespace not exposed");
				return view;
			}
			async load() {
				if (!this.loopback) {
					this.state = { ...this.state, status: "unavailable" };
					this._emit();
					return;
				}
				const generation = ++this.readGeneration;
				try {
					const view = await this._read();
					if (generation !== this.readGeneration) return;
					this.state = {
						status: "ready",
						value: view.value,
						user: view.user,
						revision: view.revision,
						writable: true
					};
				} catch {
					if (generation !== this.readGeneration) return;
					this.state = {
						status: "unavailable",
						value: {},
						user: void 0,
						revision: void 0,
						writable: false
					};
				}
				this._emit();
			}
			/** Queue one field write (convenience wrapper over mutate). */
			set(field, value) {
				return this.mutate([{ op: "set", path: [field], value }]);
			}
			/** Queue one batched write of several path ops in a single mutate. */
			mutate(ops) {
				if (ops.length === 0) return Promise.resolve();
				return this._write(ops);
			}
			async _postMutate(ops, expectedRevision) {
				const response = await fetch("/api/dsh-ui-state/settings/mutate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						ns: NS,
						ops,
						...(expectedRevision === void 0 ? {} : { expectedRevision })
					}),
					// keepalive: an unload flush must not be dropped mid-navigation.
					keepalive: true
				});
				return response.json();
			}
			_write(ops) {
				if (!this.loopback) return Promise.resolve();
				this.readGeneration += 1;
				const task = this.tail.then(async () => {
					// A stale expectedRevision (another plugin wrote the same
					// namespace first) is retried exactly once with a refreshed
					// revision instead of dropping the user's last interaction.
					let attempts = 0;
					for (;;) {
						attempts += 1;
						const json = await this._postMutate(ops, this.state.revision);
						if (json.ok) {
							this.state = {
								...this.state,
								value: json.value.value,
								user: json.value.user,
								revision: json.value.revision,
								error: null
							};
							this._emit();
							return;
						}
						const code = json.code ?? "settings-rejected";
						if (attempts >= 2 || code !== "settings-conflict") {
							const error = new Error(json.message ?? "settings mutate failed");
							error.code = code;
							throw error;
						}
						// Refresh the optimistic-lock revision, then re-apply.
						await this.load();
					}
				});
				this.tail = task.catch((error) => {
					this.state = {
						...this.state,
						error: error instanceof Error ? error.message : String(error)
					};
					this._emit();
					this.load();
				});
				// Settled: callers may ignore the outcome; a failed write never
				// surfaces as an unhandled rejection, only via state.error.
				return task.then(() => void 0, () => void 0);
			}
		}
		//#endregion

		//#region sidebar observation
		/**
		 * Locate the AppFrame element. The overlay layer ([data-shell-overlay])
		 * is a direct child of the frame, which carries the sidebar/detail state
		 * attributes and the inline grid-template-columns. If a future shell
		 * moves the overlay out of the frame, the frame itself can still be
		 * found by its own state attributes — the plugin never hard-fails on
		 * DOM drift, it just degrades to the probe that still matches.
		 * @returns the frame element, or null.
		 */
		function frameOf() {
			const overlay = document.querySelector("[data-shell-overlay]");
			if (overlay !== null && overlay.parentElement !== null) return overlay.parentElement;
			return document.querySelector("[data-sidebar-collapsed], [data-details-collapsed]");
		}

		/**
		 * Read the current sidebar/details state from the frame.
		 * @param frame - the AppFrame element.
		 * @returns {collapsed, width, detailsCollapsed, narrow} - narrow = viewport
		 *   below the auto-collapse breakpoint (sidebar collapsed by the shell,
		 *   not by the user); detailsCollapsed = right details panel closed
		 *   (also true while no session is open, since the column is forced to 0).
		 */
		function stateOf(frame) {
			const rect = frame.getBoundingClientRect();
			const collapsed = frame.hasAttribute("data-sidebar-collapsed");
			const raw = (frame.style.gridTemplateColumns ?? "").split(" ")[0];
			const width = Number.parseFloat(raw);
			return {
				collapsed,
				width: Number.isFinite(width) ? width : 280,
				detailsCollapsed: frame.hasAttribute("data-details-collapsed"),
				narrow: rect.width < NARROW_BREAKPOINT
			};
		}

		/** Whether a conversation is currently open (details only exists with one). */
		function conversationOpen() {
			return document.querySelector("[data-chat-flow]") !== null;
		}

		/** The sidebar drag handle inside the frame (rendered only when expanded). */
		function sidebarHandleOf(frame) {
			return frame.querySelector('[data-side="sidebar"]');
		}

		/**
		 * Simulate a drag on the sidebar handle by dispatching the same pointer
		 * sequence the real DragHandle listens for. React 18 delegates pointer
		 * events at the root, so dispatched events reach the handlers; the
		 * handle's setPointerCapture/hasPointerCapture calls are stubbed for the
		 * synchronous dispatch window because synthetic pointer ids are not
		 * actually active.
		 * @param handle - the [data-side="sidebar"] handle element.
		 * @param dx - delta in px (positive widens the sidebar).
		 */
		function dragSidebarHandle(handle, dx) {
			const rect = handle.getBoundingClientRect();
			const startX = rect.left + rect.width / 2;
			const endX = startX + dx;
			const origSet = Element.prototype.setPointerCapture;
			const origHas = Element.prototype.hasPointerCapture;
			const origRelease = Element.prototype.releasePointerCapture;
			Element.prototype.setPointerCapture = function () { return undefined; };
			Element.prototype.hasPointerCapture = function () { return true; };
			Element.prototype.releasePointerCapture = function () { return undefined; };
			try {
				handle.dispatchEvent(new PointerEvent("pointerdown", {
					bubbles: true, cancelable: true, clientX: startX, pointerId: 7,
					pointerType: "mouse", isPrimary: true, buttons: 1
				}));
				handle.dispatchEvent(new PointerEvent("pointermove", {
					bubbles: true, cancelable: true, clientX: endX, pointerId: 7,
					pointerType: "mouse", isPrimary: true, buttons: 1
				}));
				handle.dispatchEvent(new PointerEvent("pointerup", {
					bubbles: true, cancelable: true, clientX: endX, pointerId: 7,
					pointerType: "mouse", isPrimary: true, buttons: 0
				}));
			} finally {
				Element.prototype.setPointerCapture = origSet;
				Element.prototype.hasPointerCapture = origHas;
				Element.prototype.releasePointerCapture = origRelease;
			}
		}
		//#endregion

		//#region chat scroll persistence
		/** Current selected session id, if any. */
		function currentSessionId(sessionsService) {
			const list = sessionsService?.list?.getSnapshot?.();
			const current = list?.current;
			return typeof current === "string" ? current : void 0;
		}

		/** The active conversation scrollport. */
		function scrollportOf() {
			return document.querySelector("[data-conversation-scroll]") ??
				document.querySelector("[data-chat-flow]")?.parentElement ??
				null;
		}

		/** The rendered chat flow list (contains [data-chat-anchor-key] rows). */
		function flowListOf() {
			return document.querySelector("[data-chat-flow]");
		}

		/** Find an already-rendered anchor row by its stable key. */
		function anchorElement(list, key) {
			for (const row of list.querySelectorAll("[data-chat-anchor-key]")) {
				if (row.dataset.chatAnchorKey === key) return row;
			}
			return null;
		}

		/** Row position in scrollport coordinates (viewport-independent). */
		function flowTop(row, scrollport) {
			return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
		}

		/** Pick a visible stable anchor row, falling back to the first row. */
		function pagingAnchor(list, scrollport) {
			const viewport = scrollport.getBoundingClientRect();
			const visibleBottom = scrollport.querySelector("[data-composer-seat]")?.getBoundingClientRect().top ?? viewport.bottom;
			const rows = [...list.querySelectorAll("[data-chat-anchor-key]")];
			return rows.find((row) => {
				const rect = row.getBoundingClientRect();
				return rect.bottom > viewport.top && rect.top < visibleBottom;
			}) ?? rows[0] ?? null;
		}

		/** Capture a reflow-resistant reader position from the current window. */
		function scrollPosition(list, scrollport) {
			const row = pagingAnchor(list, scrollport);
			const anchorKey = row?.dataset.chatAnchorKey;
			if (row === null || anchorKey === void 0) return null;
			return {
				anchorKey,
				anchorTop: flowTop(row, scrollport),
				scrollTop: scrollport.scrollTop
			};
		}

		/** Whether the scrollport is close enough to the bottom to follow new output. */
		function atBottom(scrollport) {
			return scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight <= BOTTOM_THRESHOLD_PX;
		}

		/** Whether an added/removed node belongs to the conversation area. */
		function touchesConversation(record) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== 1) continue;
				if (typeof node.matches === "function" &&
					node.matches("[data-chat-flow], [data-chat-anchor-key], [data-conversation-scroll]")) return true;
				if (typeof node.querySelectorAll === "function" &&
					node.querySelectorAll("[data-chat-flow], [data-chat-anchor-key]").length > 0) return true;
			}
			if (record.target.nodeType === 1 && typeof record.target.matches === "function" &&
				record.target.matches("[data-chat-flow], [data-conversation-scroll]")) return true;
			return false;
		}
		//#endregion

		//#region apply
		/**
		 * Required services: layout (official sidebar panel actions), sessions
		 * (current conversation identity) and connection (loopback probe).
		 */
		const inject = ["layout", "sessions", "connection"];

		/**
		 * Mount sidebar state persistence and restore.
		 *
		 * Event-driven: state is read on AppFrame attribute/resize mutations and
		 * conversation flow mount/session changes; a 60s safety tick re-reads in
		 * case anything was missed. Writes are debounced into a single batched
		 * mutate per burst and flushed synchronously on unload (keepalive fetch).
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const loopback = ctx.get("connection")?.isLoopback !== false;
			const controller = new UiStateController(loopback);
			const sessionsService = ctx.get("sessions");
			let restoredCollapsed = false;
			let restoredWidth = false;
			let restoredDetails = false;
			let persistTimer = null;
			let scrollPersistTimer = null;
			let pendingState = null;
			let pendingScrollNext = void 0;
			let lastScrollEl = null;
			let lastScrollSession = null;
			let lastSeen = null;        // last DOM state observed
			let lastFrame = null;
			let lastHasFlow = false;
			let frameObserver = null;
			let frameResizeObserver = null;
			let bodyObserver = null;
			let safetyTimer = null;
			let restoreRetries = 0;

			/** Build the batched ops for one sidebar/details state snapshot. */
			const buildOps = (state) => {
				const ops = [
					{ op: "set", path: ["sidebarCollapsed"], value: state.collapsed }
				];
				if (!state.collapsed) {
					ops.push({ op: "set", path: ["sidebarWidth"], value: Math.round(state.width) });
				}
				// A details "closed" is only persisted while a conversation is
				// actually open — outside one the column is forced closed by the
				// shell and that would be mistaken for user intent.
				if (!state.detailsCollapsed || conversationOpen()) {
					ops.push({ op: "set", path: ["detailsOpen"], value: !state.detailsCollapsed });
				}
				return ops;
			};

			/**
			 * Persist a changed sidebar/details state (debounced). Narrow viewports
			 * are ignored entirely: the shell collapses the sidebar itself there,
			 * and the column width is layout-constrained, so neither reflects user
			 * intent. The latest snapshot wins within the debounce window; the
			 * fired write sends all fields in one batched mutate.
			 */
			const persistFrom = (state) => {
				if (!loopback || state.narrow) return;
				pendingState = state;
				if (persistTimer !== null) clearTimeout(persistTimer);
				persistTimer = setTimeout(() => {
					persistTimer = null;
					const target = pendingState;
					pendingState = null;
					if (target !== null) commitPersist(target);
				}, PERSIST_DEBOUNCE_MS);
			};

			/** Immediately write the pending sidebar/details snapshot, if any. */
			const commitPersist = (state) => {
				if (!loopback || state.narrow) return;
				const ops = buildOps(state);
				if (ops.length > 0) controller.mutate(ops);
			};

			/** Flush a pending debounced sidebar/details write immediately. */
			const flushPersist = () => {
				if (persistTimer !== null) {
					clearTimeout(persistTimer);
					persistTimer = null;
					const target = pendingState;
					pendingState = null;
					if (target !== null) commitPersist(target);
				}
			};

			/**
			 * Persist the current chat scroll position. If the user is at the
			 * bottom (the normal follow position), the saved entry is removed so
			 * the official view can keep auto-following new output without
			 * fighting a stale restore.
			 */
			const saveChatScroll = () => {
				if (!loopback) return;
				const sessionId = currentSessionId(sessionsService);
				const list = flowListOf();
				const scrollport = scrollportOf();
				if (sessionId === void 0 || list === null || scrollport === null) return;
				if (scrollport.scrollHeight <= 0) return;
				const user = controller.getSnapshot().user;
				const savedMap = (user && typeof user.chatScroll === "object" && user.chatScroll !== null)
					? user.chatScroll
					: {};
				const next = { ...savedMap };
				if (atBottom(scrollport)) {
					delete next[sessionId];
				} else {
					const position = scrollPosition(list, scrollport);
					if (position === null) return;
					next[sessionId] = {
						...position,
						updatedAt: Date.now()
					};
				}
				pendingScrollNext = next;
				// A long-lived machine accumulates one entry per ever-opened
				// session; keep the ledger bounded (newest wins) so settings.yaml
				// never grows without limit.
				const capped = Object.entries(next)
					.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
					.slice(0, MAX_CHAT_SCROLL_ENTRIES);
				pendingScrollNext = Object.fromEntries(capped);
				if (scrollPersistTimer !== null) clearTimeout(scrollPersistTimer);
				scrollPersistTimer = setTimeout(() => {
					scrollPersistTimer = null;
					const target = pendingScrollNext;
					pendingScrollNext = void 0;
					if (target !== void 0) controller.set("chatScroll", target);
				}, SCROLL_DEBOUNCE_MS);
			};

			/** Flush a pending debounced chat-scroll write immediately. */
			const flushScroll = () => {
				if (scrollPersistTimer !== null) {
					clearTimeout(scrollPersistTimer);
					scrollPersistTimer = null;
					const target = pendingScrollNext;
					pendingScrollNext = void 0;
					if (target !== void 0 && loopback) controller.set("chatScroll", target);
				}
			};

			/** Flush everything pending on unload/leave. */
			const flushAll = () => {
				flushPersist();
				saveChatScroll();
				flushScroll();
			};

			/**
			 * Restore a saved chat scroll position after the conversation view is
			 * rebuilt (reconnect/resync/remount). Only restores non-bottom reader
			 * positions, and only once per scrollport instance so it never fights
			 * the user after the view has settled.
			 */
			const restoreChatScroll = () => {
				const sessionId = currentSessionId(sessionsService);
				const list = flowListOf();
				const scrollport = scrollportOf();
				if (sessionId === void 0 || list === null || scrollport === null) return;
				const user = controller.getSnapshot().user;
				const savedMap = (user && typeof user.chatScroll === "object" && user.chatScroll !== null)
					? user.chatScroll
					: {};
				const saved = savedMap[sessionId];
				if (saved === null || typeof saved !== "object") return;
				if (lastScrollEl === scrollport && lastScrollSession === sessionId) return;
				if (list.querySelectorAll("[data-chat-anchor-key]").length === 0) return;
				const row = anchorElement(list, saved.anchorKey);
				let top = typeof saved.scrollTop === "number" ? saved.scrollTop : 0;
				if (row !== null) top += flowTop(row, scrollport) - saved.anchorTop;
				const max = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight);
				scrollport.scrollTop = Math.max(0, Math.min(top, max));
				lastScrollEl = scrollport;
				lastScrollSession = sessionId;
			};

			/**
			 * Restore the saved sidebar/details state once the shell is mounted.
			 * Collapse and width restore on separate ticks: toggling re-renders
			 * the frame and the drag handle, so the width drag must wait for the
			 * handle to render again. Details are only restored while a
			 * conversation is open (the details column exists only then). Any
			 * failure just leaves the flag unset and the retry chain re-runs.
			 */
			const restore = () => {
				const snapshot = controller.getSnapshot();
				const user = snapshot.user;
				if (user === null || typeof user !== "object") return;
				const frame = frameOf();
				if (frame === null) return;
				const state = stateOf(frame);
				if (state.narrow) return; // never fight the auto-collapse
				if (user.sidebarCollapsed === true && !state.collapsed && !restoredCollapsed) {
					try {
						ctx.layout.toggleSidebar();
						restoredCollapsed = true;
					} catch {
						// layout service not wired yet; the retry chain re-runs
					}
				}
				if (typeof user.sidebarWidth === "number" && !state.collapsed && !restoredWidth) {
					// Clamp into the official contract range: a stale value from
					// an old version or a hand edit must never drag the panel
					// outside what the shell can render.
					const target = Math.min(420, Math.max(264, user.sidebarWidth));
					if (Math.abs(target - state.width) > WIDTH_EPSILON) {
						const handle = sidebarHandleOf(frame);
						if (handle !== null) {
							dragSidebarHandle(handle, target - state.width);
							restoredWidth = true;
						}
					} else {
						restoredWidth = true;
					}
				}
				if (typeof user.detailsOpen === "boolean" && conversationOpen() && !restoredDetails) {
					try {
						if (user.detailsOpen && state.detailsCollapsed) ctx.layout.openDetails();
						else if (!user.detailsOpen && !state.detailsCollapsed) ctx.layout.closeDetails();
						restoredDetails = true;
					} catch {
						// layout service not wired yet; the retry chain re-runs
					}
				}
			};

			/**
			 * Run the restore now and, while any flag is still pending, retry a
			 * few times so the shell can finish mounting (settings arrive late,
			 * the layout service wires a tick later, the drag handle renders after
			 * the collapse toggle). After the cap, the next event re-arms it.
			 */
			const scheduleRestore = () => {
				if (restoredCollapsed && restoredWidth && restoredDetails) return;
				try {
					restore();
				} catch {
					// defensive; restore already guards its services
				}
				if (!(restoredCollapsed && restoredWidth && restoredDetails) && restoreRetries < RESTORE_MAX_RETRIES) {
					restoreRetries += 1;
					setTimeout(scheduleRestore, RESTORE_RETRY_MS);
				} else {
					restoreRetries = 0;
				}
			};

			/**
			 * Re-read the frame state, persist any change, and opportunistically
			 * finish a pending restore. Called by the frame observers only.
			 */
			const onFrameUpdate = () => {
				const frame = lastFrame;
				if (frame === null) return;
				const state = stateOf(frame);
				const changed = lastSeen === null ||
					lastSeen.collapsed !== state.collapsed ||
					lastSeen.detailsCollapsed !== state.detailsCollapsed ||
					Math.abs(lastSeen.width - state.width) > 1;
				lastSeen = state;
				if (changed) persistFrom(state);
				if (!(restoredCollapsed && restoredWidth && restoredDetails)) scheduleRestore();
				restoreChatScroll();
			};

			const detachFrame = () => {
				if (frameObserver !== null) {
					frameObserver.disconnect();
					frameObserver = null;
				}
				if (frameResizeObserver !== null) {
					frameResizeObserver.disconnect();
					frameResizeObserver = null;
				}
			};

			const attachFrame = (frame) => {
				detachFrame();
				lastFrame = frame;
				frameObserver = new MutationObserver(onFrameUpdate);
				frameObserver.observe(frame, {
					attributes: true,
					attributeFilter: ["style", "data-sidebar-collapsed", "data-details-collapsed", "data-dragging"],
					childList: true,
					subtree: true
				});
				frameResizeObserver = new ResizeObserver(onFrameUpdate);
				frameResizeObserver.observe(frame);
				onFrameUpdate();
			};

			/**
			 * Body-level watch: rewire the frame observers when the shell mounts
			 * (or is replaced by a portal), and react to conversation flow
			 * mount/unmount plus live row rebuilds without scanning the DOM on
			 * every streaming mutation.
			 */
			const onBodyMutation = (mutations) => {
				const frame = frameOf();
				if (frame !== lastFrame) {
					if (frame === null) {
						detachFrame();
						lastFrame = null;
						lastSeen = null;
					} else {
						attachFrame(frame);
					}
				}
				const hasFlow = flowListOf() !== null;
				if (hasFlow !== lastHasFlow) {
					lastHasFlow = hasFlow;
					scheduleRestore();
					restoreChatScroll();
				} else if (hasFlow && mutations.some(touchesConversation)) {
					restoreChatScroll();
				}
			};

			ctx.effect(() => {
				bodyObserver = new MutationObserver(onBodyMutation);
				bodyObserver.observe(document.body, { childList: true, subtree: true });

				// Safety fallback: re-read state once a minute in case an
				// unobserved DOM swap happened (cheap; the busy path is events).
				safetyTimer = setInterval(() => {
					const frame = frameOf();
					if (frame !== lastFrame) {
						if (frame === null) {
							detachFrame();
							lastFrame = null;
							lastSeen = null;
						} else {
							attachFrame(frame);
						}
					} else if (frame !== null) {
						onFrameUpdate();
					}
					if (!(restoredCollapsed && restoredWidth && restoredDetails)) scheduleRestore();
				}, SAFETY_TICK_MS);

				controller.load();
				const unsubscribe = controller.subscribe(() => {
					// Once the settings arrive, attempt the restore immediately.
					scheduleRestore();
					restoreChatScroll();
				});

				const onBlur = () => {
					flushPersist();
					saveChatScroll();
				};
				const onVisibility = () => {
					if (document.hidden) flushAll();
				};
				const onPageHide = () => flushAll();
				const onFreeze = () => flushAll();
				window.addEventListener("blur", onBlur);
				document.addEventListener("visibilitychange", onVisibility);
				window.addEventListener("pagehide", onPageHide);
				document.addEventListener("freeze", onFreeze);

				const initialFrame = frameOf();
				if (initialFrame !== null) attachFrame(initialFrame);
				lastHasFlow = flowListOf() !== null;
				scheduleRestore();

				return () => {
					clearInterval(safetyTimer);
					if (bodyObserver !== null) bodyObserver.disconnect();
					detachFrame();
					unsubscribe();
					window.removeEventListener("blur", onBlur);
					document.removeEventListener("visibilitychange", onVisibility);
					window.removeEventListener("pagehide", onPageHide);
					document.removeEventListener("freeze", onFreeze);
					if (persistTimer !== null) clearTimeout(persistTimer);
					if (scrollPersistTimer !== null) clearTimeout(scrollPersistTimer);
				};
			}, "dsh-ui-state: sidebar state + chat scroll");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});