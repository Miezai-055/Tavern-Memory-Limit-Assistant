import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const EXTENSION_NAME = 'tavern-memory-limit-assistant';
const SERVER_PREFIX = '/api/plugins/tavern-memory-limit-assistant';
// The server half has to live in <SillyTavern>/plugins/. SillyTavern exposes no
// web interface for installing server plugins (they are unsandboxed, so the
// install path is deliberately CLI-only), so the panel offers the official
// plugins.js command for the user to copy and run.
const SERVER_INSTALL_COMMAND = 'node plugins.js install https://github.com/Miezai-055/Tavern-Memory-Limit-Assistant.git';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    limit: 20,
    collapsed: false,
});

const state = {
    key: null,
    avatarUrl: null,
    fileName: null,
    start: 0,
    total: 0,
    loaded: 0,
    limit: DEFAULT_SETTINGS.limit,
    serverAvailable: false,
    windowLoaded: false,
    loadingChat: false,
    lastError: '',
};

let settings = null;
let uiReady = false;
let trimScheduled = false;

function getSettings() {
    if (!extension_settings[EXTENSION_NAME] || typeof extension_settings[EXTENSION_NAME] !== 'object') {
        extension_settings[EXTENSION_NAME] = {};
    }

    settings = extension_settings[EXTENSION_NAME];
    if (typeof settings.enabled !== 'boolean') settings.enabled = DEFAULT_SETTINGS.enabled;
    if (typeof settings.collapsed !== 'boolean') settings.collapsed = DEFAULT_SETTINGS.collapsed;
    settings.limit = clampLimit(settings.limit);
    return settings;
}

function clampLimit(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.limit;
    return Math.min(500, Math.max(1, parsed));
}

function isObjectRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isReplayArtifactFrame(frame) {
    if (!isObjectRecord(frame) || frame.version !== 2 || !Array.isArray(frame.logEntries)) {
        return false;
    }

    const hasPerSheetCheckpointArtifact = Object.prototype.hasOwnProperty.call(frame, 'perSheetCheckpoints')
        && (frame.perSheetCheckpoints === null
            || !isObjectRecord(frame.perSheetCheckpoints)
            || Object.keys(frame.perSheetCheckpoints).length > 0);
    const hasHeadRevisionArtifact = frame.headRevision !== undefined
        && frame.headRevision !== null
        && (typeof frame.headRevision !== 'string' || frame.headRevision.length > 0);

    return frame.logEntries.length > 0
        || hasPerSheetCheckpointArtifact
        || frame.manualRefillProgress !== undefined
        || hasHeadRevisionArtifact
        || frame.checkpoint !== undefined;
}

function extractReplayTagData(message) {
    const isolatedData = message?.TavernDB_ACU_IsolatedData;
    if (!isObjectRecord(isolatedData)) return null;

    const replayData = {};
    for (const [isolationKey, tagData] of Object.entries(isolatedData)) {
        if (!isObjectRecord(tagData) || !isReplayArtifactFrame(tagData.storageFrame)) continue;
        replayData[isolationKey] = {
            _acu_storage_version: tagData._acu_storage_version ?? 2,
            storageFrame: tagData.storageFrame,
        };
    }

    return Object.keys(replayData).length > 0 ? replayData : null;
}

function collectReplayDataForPrefix(chat, prefixLength) {
    const replayFramesByIndex = new Map();
    const upperBound = Math.max(0, Math.min(prefixLength, chat.length));

    // Scan the full logical array so a newer checkpoint that is still inside
    // the visible tail can also retire stale replay metadata in the prefix.
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex += 1) {
        const replayData = extractReplayTagData(chat[messageIndex]);
        if (!replayData) continue;

        for (const [isolationKey, tagData] of Object.entries(replayData)) {
            const frame = tagData.storageFrame;
            if (frame.checkpoint?.kind === 'full') {
                // A newer full checkpoint supersedes earlier artifacts for the
                // same isolation key. Keep only the replay suffix after it.
                for (const [index, frameData] of replayFramesByIndex) {
                    if (frameData.delete(isolationKey) && frameData.size === 0) {
                        replayFramesByIndex.delete(index);
                    }
                }
            }
            if (!replayFramesByIndex.has(messageIndex)) {
                replayFramesByIndex.set(messageIndex, new Map());
            }
            replayFramesByIndex.get(messageIndex).set(isolationKey, tagData);
        }
    }

    return new Map([...replayFramesByIndex.entries()]
        .filter(([index]) => index < upperBound));
}

function makeWindowPlaceholder(index, isUser = true, replayData = null) {
    const placeholder = {
        name: '',
        // Preserve the original user/AI role for absolute AI-floor counting.
        // is_system keeps the placeholder out of prompt construction.
        is_user: Boolean(isUser),
        is_system: true,
        send_date: '',
        mes: '',
        extra: { __tavernMemoryLimitAssistantPlaceholder: true, floor: index },
        __tavernMemoryLimitAssistantPlaceholder: true,
    };

    if (replayData) {
        placeholder.TavernDB_ACU_IsolatedData = replayData;
    }
    return placeholder;
}

function isWindowPlaceholder(message) {
    return message?.__tavernMemoryLimitAssistantPlaceholder === true
        || message?.extra?.__tavernMemoryLimitAssistantPlaceholder === true;
}

function keyFromBody(body) {
    if (!body || typeof body !== 'object') return null;
    const avatarUrl = String(body.avatar_url ?? '');
    const fileName = String(body.file_name ?? '');
    if (!avatarUrl || !fileName) return null;
    return `${avatarUrl}\u0000${fileName}`;
}

function parseHeaderInteger(response, name, fallback = null) {
    const parsed = Number.parseInt(response.headers.get(name) ?? '', 10);
    return Number.isInteger(parsed) ? parsed : fallback;
}

function updateStateFromResponse(response, bodyKey = null, payloadState = null) {
    if (response.headers.get('X-Tavern-Memory-Limit-Assistant') !== '1') {
        state.serverAvailable = false;
        state.lastError = '服务端桥接未返回窗口标记';
        updateStatus();
        return false;
    }

    state.serverAvailable = true;
    state.windowLoaded = true;
    state.start = Number.isInteger(payloadState?.start)
        ? payloadState.start
        : parseHeaderInteger(response, 'X-Tavern-Memory-Limit-Assistant-Start', 0);
    state.total = Number.isInteger(payloadState?.total)
        ? payloadState.total
        : parseHeaderInteger(response, 'X-Tavern-Memory-Limit-Assistant-Total', 0);
    state.limit = Number.isInteger(payloadState?.limit)
        ? payloadState.limit
        : parseHeaderInteger(response, 'X-Tavern-Memory-Limit-Assistant-Limit', getSettings().limit);
    state.loaded = Math.max(0, Math.min(state.limit, state.total));
    if (bodyKey) state.key = bodyKey;
    state.lastError = '';
    updateStatus();
    return true;
}

function getActiveContext() {
    try {
        return getContext() || null;
    } catch {
        return null;
    }
}

function hasActiveChat() {
    const context = getActiveContext();
    if (!context?.chatId) return false;
    return (context.characterId !== undefined && context.characterId !== null)
        || (context.groupId !== undefined && context.groupId !== null);
}

function currentChatFileName() {
    return String(getActiveContext()?.chatId ?? '');
}

function saveBelongsToActiveWindow(body) {
    const bodyKey = keyFromBody(body);
    if (bodyKey) return bodyKey === state.key;

    // Compressed save requests cannot be inspected without decompressing and
    // recompressing the body. The active chat id is a safe conservative check.
    return Boolean(state.fileName) && currentChatFileName() === state.fileName;
}

async function readRequestJson(request) {
    try {
        return await request.clone().json();
    } catch {
        return null;
    }
}

// cocktail-plus wraps window.fetch. Passing a Request constructed from
// another Request makes that wrapper attempt to forward a disturbed stream
// and Chromium reports only "Failed to fetch". Rebuild the request as a
// normal URL + init object instead. This also preserves gzip bodies used by
// SillyTavern's request-compression path.
async function buildForwardInit(request) {
    const method = String(request.method || 'GET').toUpperCase();
    const init = {
        method,
        headers: new Headers(request.headers),
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity,
        keepalive: request.keepalive,
        signal: request.signal,
    };

    if (method !== 'GET' && method !== 'HEAD') {
        init.body = await request.clone().arrayBuffer();
    }

    return init;
}

function routedUrl(pathname) {
    return new URL(pathname, window.location.origin);
}

function blockedSaveResponse(message) {
    return new Response(JSON.stringify({
        ok: false,
        error: 'chat_memory_window_unavailable',
        message,
    }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
    });
}

function skippedSaveResponse() {
    return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function scheduleTrim() {
    const currentSettings = getSettings();
    if (!currentSettings.enabled || !state.serverAvailable || trimScheduled) return;

    trimScheduled = true;
    queueMicrotask(() => {
        trimScheduled = false;
        trimChatArray();
    });
}

function trimChatArray() {
    const currentSettings = getSettings();
    if (!currentSettings.enabled || !state.serverAvailable) return;

    let chat;
    try {
        chat = getContext()?.chat;
    } catch {
        return;
    }

    if (!Array.isArray(chat)) return;

    const limit = clampLimit(currentSettings.limit);
    state.limit = limit;

    // Keep the logical array length and absolute indexes intact. Older floors
    // become tiny system placeholders instead of being spliced away. This
    // lets database/automation plugins continue to see floor 150 as index 150
    // while the old message payloads are no longer held in memory.
    const previousTotal = Number.isInteger(state.total) ? state.total : chat.length;
    // New messages advance the tail and may evict old floors. Deletions do
    // not move the start backward: the current window simply contains fewer
    // messages until a later new message fills it again. Moving backward on a
    // deletion would create a placeholder at the window start and make the
    // server mistake the save for an external conflict.
    const desiredStart = chat.length > previousTotal
        ? Math.max(state.start, chat.length - limit)
        : Math.min(state.start, Math.max(0, chat.length));
    const replayFramesByIndex = collectReplayDataForPrefix(chat, desiredStart);
    for (let index = 0; index < desiredStart; index += 1) {
        const frameData = replayFramesByIndex.get(index);
        const replayData = frameData && frameData.size > 0
            ? Object.fromEntries(frameData.entries())
            : null;
        if (!isWindowPlaceholder(chat[index])) {
            chat[index] = makeWindowPlaceholder(index, chat[index]?.is_user, replayData);
        } else {
            if (typeof chat[index].is_user !== 'boolean') {
                chat[index].is_user = true;
            }
            chat[index].is_system = true;
            chat[index].extra = {
                ...(chat[index].extra || {}),
                __tavernMemoryLimitAssistantPlaceholder: true,
                floor: index,
            };
        }
    }
    state.start = desiredStart;
    // state.total is the last server-confirmed disk length. Do not replace it
    // with chat.length here: a delete or a newly appended message must be
    // saved against the old base_total, otherwise the server correctly treats
    // the request as a conflict.
    state.loaded = Math.max(0, chat.length - desiredStart);

    // Older floors are deliberately not available through the normal
    // "show more" button; loading them would defeat the memory bound.
    const chatElement = globalThis.jQuery?.('#chat');
    if (chatElement?.length) {
        chatElement.find('.mes').filter((_, element) => {
            const messageId = Number(element.getAttribute('mesid'));
            return Number.isInteger(messageId) && messageId < desiredStart;
        }).remove();
    }
    globalThis.jQuery?.('#show_more_messages').remove();

    updateStatus();
}

function installFetchBridge() {
    if (globalThis.__tavernMemoryLimitAssistantFetchInstalled) return;

    const originalFetch = window.fetch.bind(window);
    globalThis.__tavernMemoryLimitAssistantFetchInstalled = true;
    globalThis.__tavernMemoryLimitAssistantOriginalFetch = originalFetch;

    window.fetch = async function tavernMemoryLimitAssistantFetch(input, init) {
        const currentSettings = getSettings();
        if (!currentSettings.enabled) {
            return originalFetch(input, init);
        }

        let request;
        try {
            request = input instanceof Request ? input : new Request(input, init);
        } catch {
            return originalFetch(input, init);
        }

        const requestUrl = new URL(request.url, window.location.origin);
        if (requestUrl.origin !== window.location.origin || request.method !== 'POST') {
            return originalFetch(input, init);
        }

        const isChatGet = requestUrl.pathname === '/api/chats/get';
        const isChatSave = requestUrl.pathname === '/api/chats/save';
        if (!isChatGet && !isChatSave) {
            return originalFetch(input, init);
        }

        const fallbackRequest = request.clone();

        if (isChatGet) {
            const body = await readRequestJson(request);
            const bodyKey = keyFromBody(body);
            // /api/chats/get is also used during startup and neutral-chat
            // loading. Without a concrete character chat, never redirect it
            // to the window server route; otherwise the chat list/welcome
            // surface can be replaced by an empty/error response.
            if (!bodyKey || !hasActiveChat()) {
                return originalFetch(input, init);
            }

            state.loadingChat = true;
            const target = routedUrl(`${SERVER_PREFIX}/chat/get`);
            target.searchParams.set('window_size', String(clampLimit(currentSettings.limit)));

            let response;
            try {
                response = await originalFetch(target.href, await buildForwardInit(request));
            } catch (error) {
                state.serverAvailable = false;
                state.windowLoaded = false;
                state.key = null;
                state.fileName = null;
                state.loadingChat = false;
                state.lastError = `服务端桥接请求失败: ${error?.message || error}`;
                updateStatus();
                return originalFetch(fallbackRequest);
            }

            // Any non-success response from the optional bridge must fall
            // back to the native endpoint for loading. This keeps startup,
            // chat lists, and older friends' installations usable.
            if (!response.ok) {
                state.serverAvailable = false;
                state.windowLoaded = false;
                state.key = null;
                state.fileName = null;
                state.loadingChat = false;
                state.lastError = response.status === 404 || response.status === 405
                    ? '未找到服务端插件'
                    : `服务端窗口接口返回 HTTP ${response.status}`;
                updateStatus();
                return originalFetch(fallbackRequest);
            }

            let payloadState = null;
            try {
                const payload = await response.clone().json();
                if (Array.isArray(payload)) {
                    const messages = payload.slice(1);
                    const firstReal = messages.findIndex(message => !isWindowPlaceholder(message));
                    const start = firstReal < 0 ? messages.length : firstReal;
                    payloadState = {
                        total: messages.length,
                        start,
                        limit: Math.max(0, messages.length - start),
                    };
                }
            } catch {
                // Header values remain the fallback for native/browser wrappers.
            }

            if (updateStateFromResponse(response, bodyKey, payloadState)) {
                state.avatarUrl = body?.avatar_url ?? null;
                state.fileName = body?.file_name ?? null;
                state.loadingChat = false;
                scheduleTrim();
            }
            return response;
        }

        if (state.loadingChat) {
            // Core and third-party listeners may issue a debounced save while
            // the old chat is being cleared and the new chat is loading. It
            // is not a user edit; acknowledge it without writing anything.
            return skippedSaveResponse();
        }

        if (!state.windowLoaded) {
            return originalFetch(input, init);
        }

        // Once a windowed chat has been loaded, never fall back to native save:
        // native save would serialize placeholders/tail-only data and can
        // destroy the full on-disk history. Wait for the bridge or block.
        if (!state.serverAvailable || !state.key) {
            state.lastError = '窗口聊天已加载，但保存桥接未就绪，已阻止原生保存以保护完整历史';
            updateStatus();
            return blockedSaveResponse(state.lastError);
        }

        // When the request is plain JSON we can verify the target chat name
        // exactly. Gzipped requests are checked against the active chat id
        // instead, without touching or reserializing their body.
        if (!saveBelongsToActiveWindow(null)) {
            state.lastError = '保存目标不是当前窗口聊天，已阻止覆盖以保护历史';
            updateStatus();
            return blockedSaveResponse(state.lastError);
        }

        const windowLimit = clampLimit(currentSettings.limit);
        // Recover a stale start value from the confirmed disk length before
        // sending a save. This is especially important after a hard refresh or
        // when a fetch wrapper hid the custom response headers.
        state.start = Math.max(state.start, Math.max(0, state.total - windowLimit));
        const makeSaveTarget = () => {
            const saveTarget = routedUrl(`${SERVER_PREFIX}/chat/save`);
            saveTarget.searchParams.set('windowed', '1');
            saveTarget.searchParams.set('window_start', String(Math.max(0, state.start)));
            saveTarget.searchParams.set('base_total', String(Math.max(0, state.total)));
            saveTarget.searchParams.set('window_limit', String(windowLimit));
            return saveTarget;
        };

        let target = makeSaveTarget();
        let response;
        try {
            response = await originalFetch(target.href, await buildForwardInit(request));
        } catch (error) {
            state.lastError = `服务端保存请求失败: ${error?.message || error}`;
            updateStatus();
            // Never fall back to the native save after a windowed chat has
            // been loaded: the native endpoint would overwrite the disk
            // file with only the in-memory tail.
            return blockedSaveResponse(state.lastError);
        }

        if (response.status === 404 || response.status === 405) {
            state.serverAvailable = false;
            state.lastError = '未找到服务端保存路由，已阻止保存以保护旧历史';
            updateStatus();
            return blockedSaveResponse(state.lastError);
        }

        if (response.ok) {
            let resultBody = null;
            try {
                resultBody = await response.clone().json();
            } catch {
                // Some fetch wrappers may expose headers but not a readable
                // JSON clone; header fallback remains below.
            }
            const total = Number.isInteger(resultBody?.total)
                ? resultBody.total
                : parseHeaderInteger(response, 'X-Tavern-Memory-Limit-Assistant-Total', null);
            const start = Number.isInteger(resultBody?.start)
                ? resultBody.start
                : parseHeaderInteger(response, 'X-Tavern-Memory-Limit-Assistant-Start', null);
            if (total !== null) state.total = total;
            if (start !== null) state.start = start;
            state.serverAvailable = true;
            state.windowLoaded = true;
            state.lastError = '';
            scheduleTrim();
        } else if (response.status === 409) {
            let conflictBody = null;
            try {
                conflictBody = await response.clone().json();
            } catch {
                // Keep the conservative conflict path below.
            }

            const serverTotal = Number.isInteger(conflictBody?.total) ? conflictBody.total : null;
            const logicalLength = getActiveContext()?.chat?.length;
            const canRebase = Number.isInteger(serverTotal)
                && serverTotal > state.total
                && Number.isInteger(logicalLength)
                && logicalLength >= Math.max(0, serverTotal - 1);

            // A common harmless race is: generation succeeds, the response
            // state is stale, and the next edit/delete still sends the old
            // base_total. Rebase once to the server-confirmed total only when
            // the current in-memory chat is at least that long. This prevents
            // the repeated error loop without allowing a shorter tail to
            // overwrite a longer external history.
            if (canRebase) {
                state.total = serverTotal;
                state.start = Math.max(state.start, serverTotal - windowLimit);
                target = makeSaveTarget();
                try {
                    response = await originalFetch(target.href, await buildForwardInit(request));
                } catch {
                    // Leave the original conflict response and show the safe
                    // error below.
                }

                if (response.ok) {
                    let retryBody = null;
                    try {
                        retryBody = await response.clone().json();
                    } catch {
                        // Header fallback below.
                    }
                    const retryTotal = Number.isInteger(retryBody?.total)
                        ? retryBody.total
                        : parseHeaderInteger(response, 'X-Tavern-Memory-Limit-Assistant-Total', null);
                    const retryStart = Number.isInteger(retryBody?.start)
                        ? retryBody.start
                        : parseHeaderInteger(response, 'X-Tavern-Memory-Limit-Assistant-Start', null);
                    if (retryTotal !== null) state.total = retryTotal;
                    if (retryStart !== null) state.start = retryStart;
                    state.serverAvailable = true;
                    state.windowLoaded = true;
                    state.lastError = '';
                    scheduleTrim();
                    return response;
                }
            }

            state.lastError = '聊天文件在窗口保存期间发生变化，已阻止覆盖以保护数据';
            updateStatus();
            try {
                globalThis.toastr?.error('聊天窗口保存冲突，已阻止覆盖。请重新加载当前聊天后再继续。');
            } catch {
                // SillyTavern may not have toastr available during early boot.
            }
        }

        return response;
    };
}

function updateStatus() {
    if (!uiReady) return;
    const currentSettings = getSettings();
    const status = document.querySelector('#tavern-memory-limit-assistant-status');
    const reloadButton = document.querySelector('#tavern-memory-limit-assistant-reload');
    const serverHint = document.querySelector('#tavern-memory-limit-assistant-server-hint');
    if (!status) return;

    const activeChat = hasActiveChat();
    if (reloadButton) reloadButton.disabled = !activeChat;

    if (!currentSettings.enabled) {
        if (serverHint) serverHint.hidden = true;
        status.textContent = '状态：已关闭（酒馆将使用完整聊天记录）';
        return;
    }

    if (!activeChat) {
        if (serverHint) serverHint.hidden = true;
        status.textContent = '状态：已启用，等待进入聊天；未进入聊天时不会执行重载或拦截。';
        return;
    }

    if (!state.serverAvailable) {
        // The panel is the first place a new user looks, so surface the exact
        // command that installs the missing server half.
        if (serverHint) serverHint.hidden = false;
        status.textContent = `状态：服务端窗口桥接未就绪。${state.lastError || '请确认已重启酒馆。'}`;
        return;
    }

    if (serverHint) serverHint.hidden = true;
    const end = state.total > 0 ? state.start + state.loaded - 1 : state.start;
    status.textContent = `状态：已启用；磁盘总消息 ${state.total}，浏览器窗口 ${state.loaded} 条（索引 ${state.start}-${Math.max(state.start, end)}）`;
}

function persistSettings() {
    getSettings();
    saveSettingsDebounced();
    updateStatus();
}

async function reloadCurrentChat() {
    if (!hasActiveChat()) {
        state.lastError = '当前未进入聊天，已跳过重载以保护聊天列表。请先打开一个聊天。';
        updateStatus();
        return false;
    }

    try {
        await getContext().reloadCurrentChat();
        return true;
    } catch (error) {
        console.error('[tavern-memory-limit-assistant] Failed to reload current chat:', error);
        try {
            globalThis.toastr?.error(`重新加载聊天失败：${error?.message || error}`);
        } catch {
            // Ignore UI-only errors.
        }
        return false;
    }
}

function createUI() {
    if (uiReady) return;
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;

    const currentSettings = getSettings();
    const wrapper = document.createElement('div');
    wrapper.id = 'tavern-memory-limit-assistant-settings';
    wrapper.innerHTML = `
        <details id="tavern-memory-limit-assistant-panel" class="cmw-panel">
            <summary class="cmw-summary">
                <span class="cmw-summary-title"><i class="fa-solid fa-memory"></i><span>聊天内存限制助手</span></span>
                <span class="cmw-summary-hint">点击展开设置</span>
            </summary>
            <div class="cmw-body">
                <div class="cmw-row cmw-switch-row">
                    <label for="tavern-memory-limit-assistant-enabled">启用真实内存窗口</label>
                    <input id="tavern-memory-limit-assistant-enabled" type="checkbox">
                </div>
                <div class="cmw-row">
                    <label for="tavern-memory-limit-assistant-limit">浏览器加载最近消息数</label>
                    <input id="tavern-memory-limit-assistant-limit" class="text_pole cmw-number" type="number" min="1" max="500" step="1">
                </div>
                <div class="cmw-actions">
                    <button id="tavern-memory-limit-assistant-reload" class="menu_button cmw-button" type="button">重新加载当前聊天</button>
                </div>
                <div id="tavern-memory-limit-assistant-status" class="cmw-status"></div>
                <div id="tavern-memory-limit-assistant-server-hint" class="cmw-server-hint" hidden>
                    <div class="cmw-server-hint-title">还差最后一步：安装服务端插件</div>
                    <div>点击下面的按钮复制安装命令，然后在<strong>酒馆根目录</strong>打开终端执行它，最后<strong>完全重启酒馆</strong>：</div>
                    <code id="tavern-memory-limit-assistant-server-cmd" class="cmw-server-cmd"></code>
                    <div class="cmw-server-hint-actions">
                        <button id="tavern-memory-limit-assistant-copy-cmd" class="menu_button cmw-button" type="button">一键复制安装命令</button>
                    </div>
                    <div class="cmw-server-hint-alt">
                        不方便用命令行？也可以把 <code>public/scripts/extensions/third-party/Tavern-Memory-Limit-Assistant</code>
                        整个文件夹复制到 <code>plugins/</code> 下，效果完全一样。
                    </div>
                </div>
                <div class="cmw-warning">完整历史仍保存在磁盘。窗口外只保留轻量楼层占位，因此楼层号继续正常增长；旧消息正文、变量和数据库快照不会进入浏览器内存。未进入聊天时启用不会执行重载。</div>
            </div>
        </details>
    `;
    host.appendChild(wrapper);

    const enabled = wrapper.querySelector('#tavern-memory-limit-assistant-enabled');
    const limit = wrapper.querySelector('#tavern-memory-limit-assistant-limit');
    const reload = wrapper.querySelector('#tavern-memory-limit-assistant-reload');
    const panel = wrapper.querySelector('#tavern-memory-limit-assistant-panel');
    const serverCmd = wrapper.querySelector('#tavern-memory-limit-assistant-server-cmd');
    const copyCmd = wrapper.querySelector('#tavern-memory-limit-assistant-copy-cmd');

    if (serverCmd) serverCmd.textContent = SERVER_INSTALL_COMMAND;

    copyCmd?.addEventListener('click', async () => {
        const command = SERVER_INSTALL_COMMAND;
        try {
            if (globalThis.navigator?.clipboard?.writeText) {
                await globalThis.navigator.clipboard.writeText(command);
            } else {
                throw new Error('clipboard unavailable');
            }
            globalThis.toastr?.success?.('安装命令已复制');
        } catch {
            // Clipboard API needs a secure context; fall back to a selectable field.
            try {
                const range = document.createRange();
                range.selectNodeContents(serverCmd);
                const selection = globalThis.getSelection?.();
                selection?.removeAllRanges();
                selection?.addRange(range);
                globalThis.toastr?.info?.('请手动复制已选中的命令');
            } catch {
                globalThis.toastr?.info?.(command);
            }
        }
    });

    enabled.checked = Boolean(currentSettings.enabled);
    limit.value = String(currentSettings.limit);
    panel.open = !currentSettings.collapsed;

    panel.addEventListener('toggle', () => {
        currentSettings.collapsed = !panel.open;
        persistSettings();
    });

    enabled.addEventListener('change', async () => {
        const nextEnabled = enabled.checked;
        if (nextEnabled && !hasActiveChat()) {
            enabled.checked = false;
            currentSettings.enabled = false;
            persistSettings();
            state.lastError = '当前未进入聊天，已拒绝启用以保护聊天列表。请先打开聊天后再启用。';
            updateStatus();
            globalThis.toastr?.info?.('请先打开一个聊天，再启用聊天内存限制助手。');
            return;
        }

        currentSettings.enabled = nextEnabled;
        persistSettings();
        if (!nextEnabled) state.windowLoaded = false;
        state.serverAvailable = false;
        state.lastError = nextEnabled ? '请重新加载当前聊天以启用窗口' : '正在重新载入完整聊天以安全关闭窗口';
        updateStatus();
        // Reload in both directions. In particular, disabling the extension
        // must restore the full chat before native saves are allowed again.
        await reloadCurrentChat();
    });

    limit.addEventListener('change', async () => {
        currentSettings.limit = clampLimit(limit.value);
        limit.value = String(currentSettings.limit);
        persistSettings();
        state.lastError = '窗口数已保存，请重新加载当前聊天';
        updateStatus();
        if (currentSettings.enabled && hasActiveChat()) await reloadCurrentChat();
        else updateStatus();
    });

    reload.addEventListener('click', reloadCurrentChat);

    uiReady = true;
    updateStatus();
}

function installEventHooks() {
    const eventNames = [
        event_types.CHAT_LOADED,
        event_types.MESSAGE_SENT,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_SWIPE_DELETED,
    ].filter(Boolean);

    for (const eventName of eventNames) {
        eventSource.on(eventName, scheduleTrim);
    }

    eventSource.on(event_types.CHAT_CHANGED, updateStatus);
    eventSource.on(event_types.APP_READY, () => {
        getSettings();
        createUI();
        updateStatus();
    });
}

getSettings();
installFetchBridge();
installEventHooks();

globalThis.TavernMemoryLimitAssistant = Object.freeze({
    getState: () => ({ ...state, settings: { ...getSettings() } }),
    reload: reloadCurrentChat,
    setLimit: async (value) => {
        const currentSettings = getSettings();
        currentSettings.limit = clampLimit(value);
        persistSettings();
        if (hasActiveChat()) await reloadCurrentChat();
        else updateStatus();
    },
});

jQuery(() => {
    createUI();
});



