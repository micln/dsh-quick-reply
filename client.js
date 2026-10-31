/**
 * `dsh-quick-reply`, browser half. Registers a "快捷发送" button in the
 * conversation composer dock. Clicking it opens a popover listing every saved
 * phrase:
 *   - click a phrase to send it into the current session;
 *   - drag the handle on the left of a phrase to change its order;
 *   - click ✎ on a phrase to edit it; the row then shows ✓ 保存, ✕ 取消, 🗑 删除;
 *   - click + at the top right to add a new phrase.
 *
 * Storage: the list lives in this browser's localStorage. It is not synced
 * across browsers or machines.
 *
 * Sending: the phrase goes through the session's conversation service
 * `send(text)`, which submits in `queue` mode.
 */

window.__ModuleLoader__.load({
  id: 'dsh-quick-reply',
  factory(require) {
    const React = require('react');
    const ReactDom = require('react-dom');
    const Primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const name = 'dsh-quick-reply';
    // `remote.skills` is the session-addressed skill catalog Remote; without it
    // the plugin still works, it just cannot offer `/name` candidates.
    // Only the services the dock cannot run without. Cordis treats every name here as
    // mandatory, so optional services (skills, terminal, sidebar) are read with `scope.get`
    // and degrade when absent.
    const inject = ['slots', 'locale', 'sessions'];

    const NS = 'conversation.quickReply';
    const STORAGE_KEY = 'dsh-quick-reply:items:v1';
    const DEFAULT_ITEMS = Object.freeze(['按推荐执行', '我已做完，你继续', '端到端测试一下', '/handoff']);
    const MAX_ITEMS = 20;
    const MAX_TEXT_LENGTH = 2000;
    const MAX_MATCHES = 50;

    // ---- Pure logic (exported on the returned object for node tests) ----

    /**
     * The host's own `/name` gesture grammar (dsh-tool-skill): a
     * whitespace-bounded kebab-case token. Only text matching this shape can
     * load a skill, so this is exactly what a phrase row may advertise.
     */
    const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

    /** Every `/name` token in `text`, in first-seen order. */
    function skillTokens(text) {
      const names = [];
      for (const match of String(text).matchAll(SKILL_GESTURE)) {
        const name = match[2];
        if (!names.includes(name)) names.push(name);
      }
      return names;
    }

    /**
     * The first `/name` token that resolves in `names` (the catalog), or
     * undefined. A phrase naming no installed skill stays plain text.
     */
    function phraseSkill(text, names) {
      if (!Array.isArray(names) || names.length === 0) return undefined;
      for (const name of skillTokens(text)) {
        if (names.includes(name)) return name;
      }
      return undefined;
    }

    /**
     * The skill reference being typed at the END of the text: the host's
     * gesture is whitespace-bounded, so only a trailing `/token` can be the
     * one under construction. Returns the filter ('' for a bare trigger), or
     * null when the caret text is not finishing a skill reference.
     */
    function skillQuery(text) {
      const match = /(?:^|\s)\/([a-z0-9-]*)$/.exec(String(text));
      return match === null ? null : match[1];
    }

    /** Whether `text` already ends at a whitespace boundary (so `/` needs no separator). */
    function atBoundary(text) {
      return text === '' || /\s$/.test(text);
    }

    /**
     * Replace the trailing `/token` with `/${name} `, or append it at a
     * whitespace boundary when there is none. The trailing space closes the
     * reference: the picker collapses and further typing is ordinary prose,
     * while the token itself stays a valid whitespace-bounded gesture.
     */
    function withSkill(text, name) {
      const string = String(text);
      const token = /(^|\s)\/([a-z0-9-]*)$/.exec(string);
      if (token !== null) return `${string.slice(0, token.index)}${token[1]}/${name} `;
      return `${string}${atBoundary(string) ? '' : ' '}/${name} `;
    }

    /**
     * Start a skill reference at the end of `text`: a trailing `/token` is
     * replaced (the button re-aims the picker), anything else gets a new
     * whitespace-bounded `/`.
     */
    function withSkillTrigger(text) {
      const string = String(text);
      const token = /(^|\s)\/([a-z0-9-]*)$/.exec(string);
      if (token !== null) return `${string.slice(0, token.index)}${token[1]}/`;
      return `${string}${atBoundary(string) ? '' : ' '}/`;
    }

    /**
     * The `/` menu's rule (ui-primitives `rankByName`): an ordered-subsequence
     * match on the name, prefix hits first, then the tighter match, then the
     * catalog order. Names only — candidates carry no second search key.
     */
    function rankSkills(skills, rawQuery) {
      const query = String(rawQuery).toLowerCase();
      if (query === '') return skills.slice(0, MAX_MATCHES);
      const ranked = [];
      skills.forEach((skill, index) => {
        const name = skill.name.toLowerCase();
        let cursor = 0;
        for (const char of name) {
          if (cursor < query.length && char === query[cursor]) cursor += 1;
        }
        if (cursor !== query.length) return;
        ranked.push({ skill, index, prefix: name.startsWith(query) ? 0 : 1, length: name.length });
      });
      ranked.sort((left, right) =>
        left.prefix - right.prefix || left.length - right.length || left.index - right.index);
      return ranked.slice(0, MAX_MATCHES).map(entry => entry.skill);
    }

    /**
     * Keep only non-empty strings, trimmed, within the configured limits.
     * Returns null when the input is not an array.
     */
    function normalizeItems(list) {
      if (!Array.isArray(list)) return null;
      return list
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item.length > 0)
        .slice(0, MAX_ITEMS)
        .map(item => item.slice(0, MAX_TEXT_LENGTH));
    }

    /** Read the saved list; fall back to defaults when absent or unreadable. */
    function loadItems(storage) {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw === null) return [...DEFAULT_ITEMS];
        const parsed = normalizeItems(JSON.parse(raw));
        return parsed ?? [...DEFAULT_ITEMS];
      } catch {
        return [...DEFAULT_ITEMS];
      }
    }

    /** Persist the normalized list. Throws when storage is unavailable. */
    function saveItems(storage, items) {
      const normalized = normalizeItems(items) ?? [];
      storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /** Move the entry at `from` so it lands at `to`. Returns `list` itself when nothing changes. */
    function reorderItem(list, from, to) {
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    }

    /**
     * A phrase starting with `! ` is a command: it runs in the DSH terminal
     * instead of being sent to the Agent. Returns the command, or null.
     */
    const RUN_PREFIX = '! ';
    // Command phrases are switched off: `! ...` is sent to the Agent as plain text.
    // Flip to true to restore terminal execution.
    const RUN_ENABLED = false;
    function parseRun(text) {
      if (typeof text !== 'string' || !text.startsWith(RUN_PREFIX)) return null;
      const command = text.slice(RUN_PREFIX.length).trim();
      return command.length > 0 ? command : null;
    }

    const core = Object.freeze({
      STORAGE_KEY,
      DEFAULT_ITEMS,
      MAX_ITEMS,
      MAX_TEXT_LENGTH,
      SKILL_GESTURE,
      RUN_PREFIX,
      parseRun,
      normalizeItems,
      loadItems,
      saveItems,
      reorderItem,
      skillTokens,
      phraseSkill,
      skillQuery,
      atBoundary,
      withSkill,
      withSkillTrigger,
      rankSkills,
    });

    // ---- Locales ----

    const DICTS = {
      en: {
        trigger: 'Quick send',
        triggerTitle: 'Quick phrases',
        panelTitle: 'Quick phrases',
        add: 'Add phrase',
        edit: 'Edit',
        save: 'Save',
        cancel: 'Cancel',
        remove: 'Delete',
        dragHandle: 'Drag to reorder',
        placeholder: 'Phrase text',
        empty: 'No phrases yet. Click + to add one.',
        emptyText: 'Phrase text cannot be empty',
        limitReached: `At most ${MAX_ITEMS} phrases`,
        tooLong: `Each phrase is limited to ${MAX_TEXT_LENGTH} characters`,
        sending: 'Sending…',
        sendFailed: 'Failed to send: ',
        runFailed: 'Failed to run in terminal: ',
        noTerminal: 'The terminal service is unavailable.',
        noSession: 'No session is selected.',
        noConversation: 'Conversation service is unavailable for this session.',
        storageFailed: 'Could not save to browser storage: ',
        skillPick: 'Insert a skill',
        runPick: 'Make this a command (! prefix)',
        skillLoading: 'Loading…',
        skillSearch: 'Filter skills',
        skillNone: 'No matching skill',
        skillUnavailable: 'Skill list unavailable for this session',
        skillUserOnly: 'user-only',
      },
      zh: {
        trigger: '快捷发送',
        triggerTitle: '快捷短语',
        panelTitle: '快捷短语',
        add: '新增条目',
        edit: '编辑',
        save: '保存',
        cancel: '取消',
        remove: '删除',
        dragHandle: '拖动调整顺序',
        placeholder: '短语内容',
        empty: '还没有短语，点右上角 + 添加。',
        emptyText: '短语内容不能为空',
        limitReached: `最多 ${MAX_ITEMS} 条`,
        tooLong: `单条最多 ${MAX_TEXT_LENGTH} 字`,
        sending: '发送中…',
        sendFailed: '发送失败：',
        runFailed: '运行失败：',
        noTerminal: '终端服务不可用。',
        noSession: '未选择会话。',
        noConversation: '当前会话的 conversation 服务不可用。',
        storageFailed: '无法写入浏览器存储：',
        skillPick: '插入技能',
        runPick: '设为命令（! 前缀）',
        skillLoading: '加载中…',
        skillSearch: '筛选技能',
        skillNone: '没有匹配的技能',
        skillUnavailable: '当前会话的技能列表不可用',
        skillUserOnly: '仅用户',
      },
    };

    // ---- Styles (host tokens with fallbacks; scoped under the plugin's data attribute) ----

    let liveInstalls = 0;

    function installStyles() {
      let disposed = false;
      liveInstalls += 1;
      let element = document.querySelector('style[data-dsh-quick-reply-css]');
      if (element === null) {
        element = document.createElement('style');
        element.dataset.dshQuickReplyCss = '';
        element.textContent = CSS;
        document.head.append(element);
      }
      return () => {
        if (disposed) return;
        disposed = true;
        liveInstalls -= 1;
        if (liveInstalls <= 0) {
          liveInstalls = 0;
          element?.remove();
        }
      };
    }

    const CSS = `
[data-dsh-quick-reply] {
  display: inline-flex;
  align-items: center;
  flex: none;
}
[data-dsh-quick-reply] .dqr-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 1px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #888);
  font-family: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
[data-dsh-quick-reply] .dqr-trigger svg {
  width: 14px;
  height: 14px;
  flex: none;
}
[data-dsh-quick-reply] .dqr-trigger[aria-expanded='true'],
[data-dsh-quick-reply] .dqr-trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
  color: var(--dsw-alias-label-secondary, #555);
}
.dqr-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: 168px;
  max-width: min(264px, calc(100vw - 24px));
  max-height: min(70vh, 480px);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 8px;
  padding: 4px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
}
.dqr-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; box-sizing: border-box; padding: 0 4px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dqr-list { box-sizing: border-box; width: 100%; margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; overflow-y: auto; min-height: 0; overscroll-behavior: contain; }
.dqr-row { display: flex; align-items: center; gap: 4px; min-height: 28px; padding: 2px 0; }
.dqr-row + .dqr-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.dqr-row:not(.dqr-editing):hover .dqr-text { background: var(--dsw-alias-interactive-bg-hover); }
.dqr-row.dqr-dragging { opacity: .45; }
.dqr-row.dqr-editing { flex-wrap: nowrap; padding: 4px; background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.dqr-handle { flex: none; padding: 0 2px; color: var(--dsw-alias-label-tertiary); cursor: grab; touch-action: none; user-select: none; letter-spacing: -2px; }
.dqr-handle:active { cursor: grabbing; }
.dqr-text { flex: 1 1 auto; min-width: 0; max-width: 100%; padding: 3px 6px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.dqr-text:disabled { opacity: .5; cursor: default; }
.dqr-icon-btn { flex: none; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; line-height: 20px; cursor: pointer; }
.dqr-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dqr-icon-btn:disabled { opacity: .35; cursor: default; }
.dqr-icon-btn.dqr-danger { color: var(--dsw-alias-state-error-primary); }
.dqr-input { flex: 1 1 auto; min-width: 0; box-sizing: border-box; height: 26px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: inherit; font: inherit; }
.dqr-edit-actions { display: flex; flex: none; align-items: center; gap: 2px; }
.dqr-skill-toggle { font-family: var(--dsw-font-markdown-code-block-small, ui-monospace, monospace); }
.dqr-skills { box-sizing: border-box; width: 100%; max-height: 156px; margin: 0; padding: 2px 0; list-style: none; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--dsw-alias-border-l1); }
.dqr-skill-item { display: flex; flex-direction: column; align-items: stretch; gap: 0; width: 100%; box-sizing: border-box; padding: 3px 6px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.dqr-skill-item:hover, .dqr-skill-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
.dqr-skill-name svg { display: block; flex: none; }
.dqr-skill-name { display: flex; align-items: center; gap: 4px; line-height: 16px; max-width: 100%; overflow: hidden; white-space: nowrap; font-family: var(--dsw-font-markdown-code-block-small, ui-monospace, monospace); }
.dqr-skill-desc { max-width: 100%; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dqr-note { padding: 8px; color: var(--dsw-alias-label-tertiary, #888); font-size: 12px; }
.dqr-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
`;

    // ---- Browser-side helpers ----

    function browserStorage() {
      return globalThis.localStorage;
    }

    /** Resolve the session-scoped conversation service, or an error key. */
    function conversationFor(sessions, sessionId) {
      if (sessionId === undefined) return { error: 'noSession' };
      const scope = sessions.scope(sessionId);
      const conversation = scope?.get('conversation');
      if (conversation === undefined || typeof conversation.send !== 'function') {
        return { error: 'noConversation' };
      }
      return { send: text => conversation.send(text) };
    }

    /** Resolve when the view can accept input; reject when it fails or closes first. */
    function untilWritable(state, timeoutMs) {
      return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
        const finish = (error) => {
          clearTimeout(timer);
          unsubscribe();
          if (error === undefined) resolve(); else reject(error);
        };
        const check = () => {
          const snapshot = state.getSnapshot();
          if (snapshot.writable) return finish(undefined);
          if (snapshot.phase === 'failed' || snapshot.phase === 'closed') {
            return finish(new Error(snapshot.error?.message ?? snapshot.issue ?? snapshot.phase));
          }
          return undefined;
        };
        unsubscribe = state.subscribe(check);
        check();
      });
    }

    /**
     * Run a command in a DSH terminal of the Session, reusing the built-in
     * terminal: the Host terminal is created through the terminal service,
     * given the command as input, then surfaced in the sidebar's terminal tab
     * so the user can watch and manage the process there. Closing that tab
     * closes the process.
     * @returns { ok: true } or { error: <locale key> }.
     */
    async function runInTerminal(services, sessionId, command) {
      const webTerminals = services?.webTerminals;
      const sidebarRight = services?.sidebarRight;
      if (webTerminals === undefined || sidebarRight === undefined) return { error: 'noTerminal' };
      const key = `dsh-quick-reply:${globalThis.crypto.randomUUID()}`;
      // Without a terminalId the service allocates a new Host terminal and
      // exposes its identity as `view.id`.
      const view = webTerminals.view(sessionId, key, key);
      const id = view.id;
      // A mounted view attaches the input channel; unmounting keeps the process alive.
      const unmount = view.mount();
      try {
        await untilWritable(view.state, 10000);
        view.write(`${command}\r`);
      } catch (cause) {
        unmount();
        void view.close();
        throw cause;
      }
      sidebarRight.openTab('terminal', { params: { terminalId: id } });
      // write() only queues input; unmounting drops the queue, so wait for the Host ack first.
      await new Promise(resolve => setTimeout(resolve, 1500));
      unmount();
      return { ok: true };
    }

    /**
     * Per-session skill catalog reader. `skills/list` is session-addressed
     * (the host resolves cwd and agent preset from the Session), so one cache
     * key per session; a failed read is not cached, the next open retries.
     * The RPC holds a retained reference for its own lifetime: the catalog
     * requires an open Client Session, not merely an address.
     */
    function createSkillCatalog(sessions, remotes) {
      const cache = new Map();
      return function catalog(sessionId) {
        const cached = cache.get(sessionId);
        if (cached !== undefined) return cached;
        const promise = sessions.using(
          sessionId,
          { source: 'quickReplySkills' },
          async reference => {
            const state = reference.binding.session.getSnapshot();
            if (state.openState !== 'open') {
              throw state.openError ?? new Error(`session "${sessionId}" is not open`);
            }
            const result = await remotes.skills.list({ sessionId });
            if (!result.ok) {
              throw new Error(`skills/list failed: ${result.error.code}: ${result.error.message}`);
            }
            return result.value.skills;
          },
        ).catch(cause => {
          if (cache.get(sessionId) === promise) cache.delete(sessionId);
          throw cause;
        });
        cache.set(sessionId, promise);
        return promise;
      };
    }

    /** Icon glyph for one row or candidate, or null when the host exports none. */
    function skillIcon(size) {
      const Icon = Primitives.IconSkillOutlineRegular;
      return typeof Icon === 'function' ? h(Icon, { size }) : null;
    }

    // ---- Dock button and popover ----

    function QuickReplyDock(props, t, sessions, catalog, services) {
      const sessionId = props.sessionId;
      const available = sessionId !== undefined;
      const [items, setItems] = React.useState(() => loadItems(browserStorage()));
      const [open, setOpen] = React.useState(false);
      // editor: null, or { index: number | 'new', text: string }
      const [editor, setEditor] = React.useState(null);
      const [sendingIndex, setSendingIndex] = React.useState(null);
      const [error, setError] = React.useState(null);
      // drag: null, or { from, to } while a handle is being dragged
      const [drag, setDrag] = React.useState(null);
      // skills: null until a catalog read settles; { list } or { error: true }.
      const [skills, setSkills] = React.useState(null);
      const dragRef = React.useRef(null);
      const listRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const skillInputRef = React.useRef(null);
      const skillRequestRef = React.useRef({ sessionId: undefined, started: false });

      // One catalog read per session, started the first time it is needed:
      // phrase rows use it for the skill glyph, the editor for candidates.
      const requestSkills = React.useCallback(() => {
        if (sessionId === undefined) return;
        if (skillRequestRef.current.sessionId !== sessionId) {
          skillRequestRef.current = { sessionId, started: false };
          setSkills(null);
        }
        if (skillRequestRef.current.started) return;
        skillRequestRef.current.started = true;
        if (catalog === undefined) {
          setSkills({ error: true });
          return;
        }
        catalog(sessionId).then(
          list => setSkills({ list }),
          () => setSkills({ error: true }),
        );
      }, [sessionId, catalog]);
      const skillNames = skills?.list === undefined ? undefined : skills.list.map(skill => skill.name);

      /** Put the caret at the end of the editor input after a programmatic write. */
      const focusSkillInput = () => {
        const input = skillInputRef.current;
        if (input === null) return;
        requestAnimationFrame(() => {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        });
      };

      const position = Primitives.useAnchoredPosition({
        open: open && available,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        align: 'end',
        gap: 8,
        margin: 12,
      });

      const closePanel = React.useCallback(() => {
        setOpen(false);
        setEditor(null);
        setError(null);
        setDrag(null);
        dragRef.current = null;
      }, []);

      Primitives.useDismissOnOutsidePointer(rootRef, open && available, closePanel, panelRef);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = event => { if (event.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); };
      }, [open, closePanel]);

      /** Persist a new list. Returns true on success; shows the error otherwise. */
      const commit = next => {
        try {
          setItems(saveItems(browserStorage(), next));
          setError(null);
          return true;
        } catch (cause) {
          setError(`${t('storageFailed')}${String(cause?.message ?? cause)}`);
          return false;
        }
      };

      const toggle = () => {
        if (open) {
          closePanel();
          return;
        }
        setItems(loadItems(browserStorage()));
        setError(null);
        setOpen(true);
        requestSkills();
      };

      const sendItem = async (text, index) => {
        if (sendingIndex !== null) return;
        const command = RUN_ENABLED ? parseRun(text) : null;
        if (command !== null) {
          await runCommand(command, index);
          return;
        }
        const target = conversationFor(sessions, sessionId);
        if (target.error !== undefined) {
          setError(t(target.error));
          return;
        }
        setSendingIndex(index);
        setError(null);
        try {
          await target.send(text);
          closePanel();
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          setError(`${t('sendFailed')}${reason}`);
        } finally {
          setSendingIndex(null);
        }
      };

      const runCommand = async (command, index) => {
        if (!available) {
          setError(t('noSession'));
          return;
        }
        setSendingIndex(index);
        setError(null);
        try {
          const result = await runInTerminal(services, sessionId, command);
          if (result.error !== undefined) setError(t(result.error));
          else closePanel();
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          setError(`${t('runFailed')}${reason}`);
        } finally {
          setSendingIndex(null);
        }
      };

      const startEdit = index => {
        setError(null);
        setEditor({ index, text: items[index], picking: false });
        requestSkills();
      };

      const startAdd = () => {
        if (items.length >= MAX_ITEMS) {
          setError(t('limitReached'));
          return;
        }
        setError(null);
        setEditor({ index: 'new', text: '', picking: false });
        requestSkills();
      };

      const cancelEdit = () => {
        setEditor(null);
        setError(null);
      };

      /** Insert `/` at the end, so the input starts a skill reference. */
      const insertSkillTrigger = () => {
        setError(null);
        setEditor(prev => ({ ...prev, text: withSkillTrigger(prev.text) }));
        focusSkillInput();
      };

      /** Start a command phrase: a leading `! ` marks it as a terminal command. */
      const insertRunPrefix = () => {
        setError(null);
        setEditor(prev => ({ ...prev, text: prev.text.startsWith(RUN_PREFIX) ? prev.text : RUN_PREFIX + prev.text }));
        focusSkillInput();
      };

      const pickSkill = name => {
        setEditor(prev => ({ ...prev, text: withSkill(prev.text, name) }));
        focusSkillInput();
      };

      const saveEdit = () => {
        const text = editor.text.trim();
        if (text.length === 0) {
          setError(t('emptyText'));
          return;
        }
        if (text.length > MAX_TEXT_LENGTH) {
          setError(t('tooLong'));
          return;
        }
        const next = editor.index === 'new'
          ? [...items, text]
          : items.map((item, i) => (i === editor.index ? text : item));
        if (commit(next)) setEditor(null);
      };

      const deleteItem = index => {
        if (commit(items.filter((_, i) => i !== index))) setEditor(null);
      };

      // Drag to reorder: pointer down on the handle, move vertically, release to commit.
      const onHandleDown = (event, index) => {
        if (editor !== null || event.button !== 0) return;
        const rows = listRef.current ? [...listRef.current.querySelectorAll('.dqr-row')] : [];
        const measured = rows.length > 1
          ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
          : (rows[0]?.getBoundingClientRect().height ?? 34) + 4;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = { from: index, to: index, startY: event.clientY, step: Math.max(measured, 1) };
        setDrag({ from: index, to: index });
      };

      const onHandleMove = event => {
        const d = dragRef.current;
        if (d === null) return;
        const offset = Math.round((event.clientY - d.startY) / d.step);
        const to = Math.min(items.length - 1, Math.max(0, d.from + offset));
        if (to !== d.to) {
          d.to = to;
          setDrag({ from: d.from, to });
        }
      };

      const onHandleUp = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (d !== null && d.to !== d.from) commit(reorderItem(items, d.from, d.to));
      };

      if (!available) return null;

      const trigger = h('button', {
        type: 'button',
        className: 'dqr-trigger',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: t('triggerTitle'),
        onClick: toggle,
      }, h(Primitives.IconQueueOutlineRegular, { size: 14 }), t('trigger'));

      let panel = null;
      if (open) {
        const entries = items.map((text, i) => ({ text, i }));
        const ordered = drag !== null ? reorderItem(entries, drag.from, drag.to) : entries;

        // Typing a trailing `/token` opens the candidate list under the editor;
        // the row's `/` button starts one without typing.
        // A plain saved phrase stays plain: no `/` button, no candidate list.
        const allowSkill = editor !== null && (editor.index === 'new' || skillTokens(items[editor.index]).length > 0);
        const query = allowSkill ? skillQuery(editor.text) : null;
        const candidates = query === null || skills?.list === undefined
          ? null
          : rankSkills(skills.list, query);

        const renderEdit = key => {
          const input = h('input', {
            ref: skillInputRef,
            className: 'dqr-input',
            value: editor.text,
            autoFocus: true,
            maxLength: MAX_TEXT_LENGTH,
            placeholder: t('placeholder'),
            'aria-label': t('placeholder'),
            onChange: event => {
              const value = event.target.value;
              setEditor(prev => ({ ...prev, text: value }));
            },
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                // Enter on a lone `/filter` takes the top candidate first.
                if (candidates !== null && candidates.length > 0 && query !== '') {
                  event.preventDefault();
                  pickSkill(candidates[0].name);
                  return;
                }
                saveEdit();
              }
            },
          });

          const parts = [
            h('li', { key: `${key}-row`, className: 'dqr-row dqr-editing' },
              input,
              h('div', { className: 'dqr-edit-actions' },
                allowSkill ? h('button', {
                  type: 'button',
                  className: 'dqr-icon-btn dqr-skill-toggle',
                  title: t('skillPick'),
                  'aria-label': t('skillPick'),
                  onClick: insertSkillTrigger,
                }, '/') : null,
                RUN_ENABLED ? h('button', {
                  type: 'button',
                  className: 'dqr-icon-btn dqr-skill-toggle',
                  title: t('runPick'),
                  'aria-label': t('runPick'),
                  onClick: insertRunPrefix,
                }, '!') : null,
                editor.index === 'new' ? null : h('button', {
                  type: 'button',
                  className: 'dqr-icon-btn dqr-danger',
                  title: t('remove'),
                  'aria-label': t('remove'),
                  onClick: () => deleteItem(editor.index),
                }, '🗑'),
                h('button', {
                  type: 'button',
                  className: 'dqr-icon-btn',
                  title: t('cancel'),
                  'aria-label': t('cancel'),
                  onClick: cancelEdit,
                }, '✕'),
                h('button', {
                  type: 'button',
                  className: 'dqr-icon-btn',
                  title: t('save'),
                  'aria-label': t('save'),
                  onClick: saveEdit,
                }, '✓'))),
          ];

          if (query !== null) {
            let body;
            if (skills?.error === true) {
              body = [h('li', { key: 'none', className: 'dqr-note' }, t('skillUnavailable'))];
            } else if (candidates === null) {
              body = [h('li', { key: 'none', className: 'dqr-note' }, t('skillLoading'))];
            } else if (candidates.length === 0) {
              body = [h('li', { key: 'none', className: 'dqr-note' }, t('skillNone'))];
            } else {
              body = candidates.map(skill => h('li', { key: skill.name },
                h('button', {
                  type: 'button',
                  className: 'dqr-skill-item',
                  title: skill.description,
                  onMouseDown: event => event.preventDefault(),
                  onClick: () => pickSkill(skill.name),
                },
                    h('span', { className: 'dqr-skill-name' }, skillIcon(12), `/${skill.name}`),
                  h('span', { className: 'dqr-skill-desc' },
                    skill.modelInvocable ? skill.description : `${t('skillUserOnly')} · ${skill.description}`))));
            }
            parts.push(h('ul', { key: `${key}-skills`, className: 'dqr-skills', 'aria-label': t('skillSearch') }, body));
          }

          return h(React.Fragment, { key }, parts);
        };

        const rows = ordered.map(entry => {
          if (editor !== null && editor.index === entry.i) return renderEdit(`i${entry.i}`);
          const dragging = drag !== null && drag.from === entry.i;
          // A phrase carrying a resolvable `/name` shows the skill glyph and the
          // skill's own description, the same affordance the `/` menu offers.
          const resolved = phraseSkill(entry.text, skillNames);
          const known = resolved === undefined ? undefined : skills.list.find(skill => skill.name === resolved);
          return h('li', {
            key: `i${entry.i}`,
            className: `dqr-row${dragging ? ' dqr-dragging' : ''}`,
          },
            h('span', {
              className: 'dqr-handle',
              title: t('dragHandle'),
              'aria-label': t('dragHandle'),
              onPointerDown: event => onHandleDown(event, entry.i),
              onPointerMove: onHandleMove,
              onPointerUp: onHandleUp,
              onPointerCancel: onHandleUp,
            }, '⋮⋮'),
            h('button', {
              type: 'button',
              className: 'dqr-text',
              title: known === undefined ? entry.text : `${entry.text}\n${known.description}`,
              disabled: sendingIndex !== null || drag !== null,
              onClick: () => { void sendItem(entry.text, entry.i); },
            }, sendingIndex === entry.i
              ? t('sending')
              : entry.text),
            h('button', {
              type: 'button',
              className: 'dqr-icon-btn',
              title: t('edit'),
              'aria-label': t('edit'),
              disabled: sendingIndex !== null || drag !== null,
              onClick: () => startEdit(entry.i),
            }, '✎'));
        });

        if (editor !== null && editor.index === 'new') rows.push(renderEdit('new'));

        panel = ReactDom.createPortal(
          h('div', {
            ref: panelRef,
            className: 'dqr-panel',
            role: 'dialog',
            'aria-label': t('panelTitle'),
            'data-dsh-quick-reply': true,
            style: position ?? { visibility: 'hidden', left: 0, top: 0 },
          },
            h('div', { className: 'dqr-head' },
              h('span', null, t('panelTitle')),
              h('button', {
                type: 'button',
                className: 'dqr-icon-btn',
                title: t('add'),
                'aria-label': t('add'),
                onClick: startAdd,
              }, '+')),
            items.length === 0 && editor === null ? h('div', { className: 'dqr-note' }, t('empty')) : null,
            h('ul', { ref: listRef, className: 'dqr-list' }, rows),
            error !== null ? h('div', { className: 'dqr-error' }, error) : null),
          document.body,
        );
      }

      return h('span', { ref: rootRef, 'data-dsh-quick-reply': true }, trigger, panel);
    }

    // ---- Browser plugin apply ----

    async function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'quick-reply: dictionaries');
      ctx.effect(() => installStyles(), 'quick-reply: stylesheet');

      ctx.inject(['slots', 'locale', 'sessions'], (scope) => {
        const slots = scope.get('slots');
        const sessions = scope.get('sessions');
        const remotes = scope.get('remote');
        const t = scope.locale.bind(NS);
        if (sessions === undefined) return;
        // Absent `skills` only costs the picker; phrases still send as text.
        const catalog = remotes?.skills === undefined ? undefined : createSkillCatalog(sessions, remotes);
        // Absent terminal services only disable `! ` command phrases.
        const services = { webTerminals: scope.get('webTerminals'), sidebarRight: scope.get('sidebarRight') };
        slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'quick-reply',
          // Row start, ahead of the MCP trigger (order -50).
          order: -100,
        }, (props) => QuickReplyDock(props, t, sessions, catalog, services)));
      });
    }

    return { name, inject, apply, core };
  },
});
