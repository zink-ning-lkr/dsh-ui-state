window.__ModuleLoader__.load({
	id: "dsh-ui-state",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants
		const NS = "ui-state";
		/** Official auto-collapse breakpoint (ui-layout SIDEBAR_AUTO_COLLAPSE). */
		const NARROW_BREAKPOINT = 1024;
		/** Poll interval for sidebar state. */
		const POLL_MS = 400;
		/** Debounce before persisting a change. */
		const PERSIST_DEBOUNCE_MS = 600;
		/** Width difference (px) below which a restore is skipped. */
		const WIDTH_EPSILON = 4;
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
			/** Queue one field write; on failure reload host state. */
			set(field, value) {
				return this._write([{ op: "set", path: [field], value }]);
			}
			_write(ops) {
				if (!this.loopback) return Promise.resolve();
				this.readGeneration += 1;
				const task = this.tail.then(async () => {
					const expectedRevision = this.state.revision;
					const response = await fetch("/api/dsh-ui-state/settings/mutate", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							ns: NS,
							ops,
							...(expectedRevision === void 0 ? {} : { expectedRevision })
						})
					});
					const json = await response.json();
					if (!json.ok) throw new Error(json.message ?? "settings mutate failed");
					this.state = {
						...this.state,
						value: json.value.value,
						user: json.value.user,
						revision: json.value.revision,
						error: null
					};
					this._emit();
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
		 * attributes and the inline grid-template-columns.
		 * @returns the frame element, or null.
		 */
		function frameOf() {
			const overlay = document.querySelector("[data-shell-overlay]");
			if (overlay === null) return null;
			const frame = overlay.parentElement;
			if (frame === null) return null;
			return frame;
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
			return document.querySelector('[data-chat-flow=""]') !== null;
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
		const SCROLL_DEBOUNCE_MS = 300;
		const BOTTOM_THRESHOLD_PX = 25;

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
		//#endregion

		//#region apply
		/**
		 * Required services: layout (official sidebar panel actions), sessions
		 * (current conversation identity) and connection (loopback probe).
		 */
		const inject = ["layout", "sessions", "connection"];

		/**
		 * Mount sidebar state persistence and restore.
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
			let lastScrollEl = null;
			let lastScrollSession = null;

			/**
			 * Persist a changed sidebar/details state (debounced). Narrow viewports
			 * are ignored entirely: the shell collapses the sidebar itself there,
			 * and the column width is layout-constrained, so neither reflects user
			 * intent. A details "closed" is only persisted while a conversation is
			 * actually open — outside one the column is forced closed by the shell
			 * and that would be mistaken for user intent.
			 */
			const persist = (state) => {
				if (!loopback || state.narrow) return;
				if (persistTimer !== null) clearTimeout(persistTimer);
				persistTimer = setTimeout(() => {
					persistTimer = null;
					controller.set("sidebarCollapsed", state.collapsed);
					if (!state.collapsed) controller.set("sidebarWidth", Math.round(state.width));
					if (!state.detailsCollapsed || conversationOpen()) {
						controller.set("detailsOpen", !state.detailsCollapsed);
					}
				}, PERSIST_DEBOUNCE_MS);
			};

			/**
			 * Persist the current chat scroll position when leaving the app or
			 * hiding the page. If the user is at the bottom (the normal follow
			 * position), the saved entry is removed so the official view can keep
			 * auto-following new output without fighting a stale restore.
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
				if (scrollPersistTimer !== null) clearTimeout(scrollPersistTimer);
				scrollPersistTimer = setTimeout(() => {
					scrollPersistTimer = null;
					controller.set("chatScroll", next);
				}, SCROLL_DEBOUNCE_MS);
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
			 * next poll round. Details are only restored while a conversation is
			 * open (the details column exists only then). Any failure just leaves
			 * the flag unset and the next poll retries.
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
						// layout service not wired yet; retry on the next poll
					}
				}
				if (typeof user.sidebarWidth === "number" && !state.collapsed &&
					Math.abs(user.sidebarWidth - state.width) > WIDTH_EPSILON && !restoredWidth) {
					const handle = sidebarHandleOf(frame);
					if (handle !== null) {
						dragSidebarHandle(handle, user.sidebarWidth - state.width);
						restoredWidth = true;
					}
				}
				if (typeof user.detailsOpen === "boolean" && conversationOpen() && !restoredDetails) {
					try {
						if (user.detailsOpen && state.detailsCollapsed) ctx.layout.openDetails();
						else if (!user.detailsOpen && !state.detailsCollapsed) ctx.layout.closeDetails();
						restoredDetails = true;
					} catch {
						// layout service not wired yet; retry on the next poll
					}
				}
			};

			let last = null;
			const tick = () => {
				const frame = frameOf();
				if (frame !== null) {
					if (!(restoredCollapsed && restoredWidth && restoredDetails)) restore();
					restoreChatScroll();
					const state = stateOf(frame);
					const changed = last === null ||
						last.collapsed !== state.collapsed ||
						last.detailsCollapsed !== state.detailsCollapsed ||
						Math.abs(last.width - state.width) > 1;
					last = state;
					if (changed) persist(state);
				} else {
					last = null;
				}
			};

			ctx.effect(() => {
				const poll = setInterval(tick, POLL_MS);
				controller.load();
				const unsubscribe = controller.subscribe(() => {
					// Once the settings arrive, attempt the restore immediately.
					tick();
				});
				const onBlur = () => saveChatScroll();
				const onVisibility = () => {
					if (document.hidden) saveChatScroll();
				};
				const onPageHide = () => saveChatScroll();
				window.addEventListener("blur", onBlur);
				document.addEventListener("visibilitychange", onVisibility);
				window.addEventListener("pagehide", onPageHide);
				tick();
				return () => {
					clearInterval(poll);
					unsubscribe();
					window.removeEventListener("blur", onBlur);
					document.removeEventListener("visibilitychange", onVisibility);
					window.removeEventListener("pagehide", onPageHide);
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
