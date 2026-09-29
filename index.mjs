import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { isPathUnderParent, tryParse } from '../../src/util.js';

const PLUGIN_ID = 'chat-memory-window';
const VERSION = '1.3.0';

export const info = {
    id: PLUGIN_ID,
    name: '聊天内存限制助手',
    version: VERSION,
    description: 'Loads only a bounded tail of character chats in the browser and safely merges windowed saves.',
};

const HEADER_WINDOW = 'X-Chat-Memory-Window';
const HEADER_START = 'X-Chat-Memory-Window-Start';
const HEADER_TOTAL = 'X-Chat-Memory-Window-Total';
const HEADER_LIMIT = 'X-Chat-Memory-Window-Limit';
const FULL_HISTORY_SUFFIX = '.chat-memory-window.full';

function fullHistoryPath(chatFilePath) {
    return `${chatFilePath}${FULL_HISTORY_SUFFIX}`;
}

function ensureFullHistorySnapshot(chatFilePath) {
    const snapshotPath = fullHistoryPath(chatFilePath);
    if (!fs.existsSync(chatFilePath)) return null;
    if (!fs.existsSync(snapshotPath)) {
        try {
            fs.copyFileSync(chatFilePath, snapshotPath);
        } catch (error) {
            console.warn('[chat-memory-window] Could not create full-history snapshot:', error);
            return chatFilePath;
        }
    }
    return snapshotPath;
}

function refreshFullHistorySnapshot(chatFilePath) {
    const snapshotPath = fullHistoryPath(chatFilePath);
    try {
        fs.copyFileSync(chatFilePath, snapshotPath);
    } catch (error) {
        console.warn('[chat-memory-window] Could not refresh full-history snapshot:', error);
    }
}

function clampLimit(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return 20;
    return Math.min(500, Math.max(1, parsed));
}

function parseInteger(value, fallback = null) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) ? parsed : fallback;
}

function isTruthy(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
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

/**
 * Keep only the database V2 replay metadata on an evicted message.
 *
 * The chat-memory window intentionally removes message text and all unrelated
 * message fields. The database plugin, however, replays its V2 frames directly
 * from the host chat array. Dropping those frames at the window boundary leaves
 * only orphan log entries; the next database write then tries a temporary
 * template baseline and correctly rejects it with boundary_after_data_mismatch.
 *
 * Vector-index metadata is deliberately not copied here: its durable snapshot
 * is maintained separately and the V2 table replay only consumes storageFrame.
 */
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

function makeWindowPlaceholder(index, isUser = true, replayData = null) {
    const placeholder = {
        name: '',
        // Preserve the original user/AI role so existing floor counters keep
        // the full-chat AI count. The system flag keeps placeholders out of
        // prompt construction and the marker lets save logic discard them.
        is_user: Boolean(isUser),
        is_system: true,
        send_date: '',
        mes: '',
        extra: { __chatMemoryWindowPlaceholder: true, floor: index },
        __chatMemoryWindowPlaceholder: true,
    };

    if (replayData) {
        placeholder.TavernDB_ACU_IsolatedData = replayData;
    }
    return placeholder;
}

function isWindowPlaceholder(message) {
    return message?.__chatMemoryWindowPlaceholder === true
        || message?.extra?.__chatMemoryWindowPlaceholder === true;
}

function extractIncomingWindow(messages, start, limit) {
    if (messages.length <= limit) return messages;

    // The browser keeps a full logical array, but the prefix consists only of
    // lightweight placeholders. Preserve only the real tail for disk merge.
    const fromStart = messages.slice(start);
    if (fromStart.length > 0 && fromStart.every(message => !isWindowPlaceholder(message))) {
        return fromStart;
    }

    const firstReal = messages.findIndex((message, index) => index >= start && !isWindowPlaceholder(message));
    if (firstReal >= 0) return messages.slice(firstReal);

    // Compatibility with an older compact-window client that sends only a
    // small tail even when its array length is below the absolute floor.
    return messages.length <= limit * 2 ? messages : [];
}

function resolveCharacterChatPath(request) {
    const base = request.user?.directories?.chats;
    const avatarUrl = String(request.body?.avatar_url ?? '');
    const fileName = String(request.body?.file_name ?? '');

    if (!base || !avatarUrl || !fileName) {
        const error = new Error('Missing chat path parameters.');
        error.statusCode = 400;
        throw error;
    }

    const directoryName = avatarUrl.replace('.png', '');
    const directoryPath = path.join(base, directoryName);
    const chatFileName = `${fileName.endsWith('.jsonl') ? fileName.slice(0, -6) : fileName}.jsonl`;
    const chatFilePath = path.join(directoryPath, sanitize(chatFileName));

    if (!isPathUnderParent(base, directoryPath) || !isPathUnderParent(base, chatFilePath)) {
        const error = new Error('Invalid chat path.');
        error.statusCode = 400;
        throw error;
    }

    return { base, directoryPath, chatFilePath };
}

function parseJsonLine(line) {
    if (typeof line !== 'string' || line.trim() === '') return null;
    const parsed = tryParse(line);
    return parsed && typeof parsed === 'object' ? parsed : null;
}

/**
 * Read only the header, a bounded tail, and the bounded V2 replay metadata
 * needed by placeholders. The file is streamed so the server does not create a
 * second full in-memory copy of the chat.
 */
async function readChatWindow(chatFilePath, limit) {
    const sourcePath = ensureFullHistorySnapshot(chatFilePath);
    if (!sourcePath) {
        return { exists: false, header: null, messages: [], start: 0, total: 0 };
    }

    const messages = [];
    const prefixRoles = [];
    // A placeholder normally carries no plugin data. Retain only the smallest
    // database-replay slice: the latest V2 full checkpoint for each isolation
    // key and the V2 artifacts after that checkpoint. Older artifacts are
    // superseded by the newer full checkpoint and are safe to discard.
    const replayFramesByIndex = new Map();
    let header = null;
    let total = 0;
    const input = fs.createReadStream(sourcePath, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });

    try {
        for await (const line of reader) {
            const parsed = parseJsonLine(line);
            if (!parsed) continue;

            if (!header) {
                header = parsed;
                continue;
            }

            const messageIndex = total;
            const replayData = extractReplayTagData(parsed);
            if (replayData) {
                for (const [isolationKey, tagData] of Object.entries(replayData)) {
                    const frame = tagData.storageFrame;
                    if (frame.checkpoint?.kind === 'full') {
                        // A newer full checkpoint supersedes every earlier
                        // replay artifact for the same isolation key.
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

            total += 1;
            messages.push(parsed);
            if (messages.length > limit) {
                const evicted = messages.shift();
                prefixRoles.push(Boolean(evicted?.is_user));
            }
        }
    } finally {
        reader.close();
        input.destroy();
    }

    const start = Math.max(0, total - messages.length);
    const prefixReplayData = Array.from({ length: start }, (_, index) => {
        const frameData = replayFramesByIndex.get(index);
        if (!frameData || frameData.size === 0) return null;
        return Object.fromEntries(frameData.entries());
    });
    return { exists: true, header, messages, prefixRoles, prefixReplayData, start, total };
}

/**
 * Read the existing header, count all messages, and retain only the prefix
 * needed for a windowed save. Prefix lines are kept as JSONL text so the
 * server does not need to clone the old message objects.
 */
async function readChatPrefix(chatFilePath, prefixLength) {
    const sourcePath = ensureFullHistorySnapshot(chatFilePath);
    if (!sourcePath) {
        return { exists: false, header: null, prefixLines: [], total: 0 };
    }

    const prefixLines = [];
    let header = null;
    let total = 0;
    const input = fs.createReadStream(sourcePath, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });

    try {
        for await (const line of reader) {
            const parsed = parseJsonLine(line);
            if (!parsed) continue;

            if (!header) {
                header = parsed;
                continue;
            }

            if (total < prefixLength) {
                prefixLines.push(line);
            }
            total += 1;
        }
    } finally {
        reader.close();
        input.destroy();
    }

    return { exists: true, header, prefixLines, total };
}

function getIntegrity(chatData) {
    return chatData?.[0]?.chat_metadata?.integrity;
}

function checkIntegrity(existingHeader, incomingHeader, force) {
    if (force) return true;
    const existing = existingHeader?.chat_metadata?.integrity;
    const incoming = incomingHeader?.chat_metadata?.integrity;
    return !existing || !incoming || existing === incoming;
}

function saveBackup(chatFilePath) {
    if (!fs.existsSync(chatFilePath)) return;
    const backupPath = `${chatFilePath}.bak-chat-memory-window`;
    try {
        fs.copyFileSync(chatFilePath, backupPath);
    } catch (error) {
        console.warn('[chat-memory-window] Could not create rolling backup:', error);
    }
}

function writeChatAtomic(chatFilePath, lines) {
    fs.mkdirSync(path.dirname(chatFilePath), { recursive: true });
    saveBackup(chatFilePath);
    const data = lines.join('\n');
    writeFileAtomicSync(chatFilePath, data, { encoding: 'utf8' });
    refreshFullHistorySnapshot(chatFilePath);
}

function serializeChatData(chatData) {
    return chatData.map(item => JSON.stringify(item));
}

async function saveFullChat(chatFilePath, chatData, force) {
    const existing = await readChatPrefix(chatFilePath, 0);
    const header = chatData[0];
    if (!checkIntegrity(existing.header, header, force)) {
        return { ok: false, conflict: true };
    }

    writeChatAtomic(chatFilePath, serializeChatData(chatData));
    return { ok: true, total: Math.max(0, chatData.length - 1), start: 0 };
}

async function saveWindowedChat(chatFilePath, chatData, query) {
    const start = parseInteger(query.window_start, null);
    const baseTotal = parseInteger(query.base_total, null);
    const force = isTruthy(query.force);

    if (start === null || start < 0) {
        return { ok: false, conflict: true, reason: 'missing_window_start' };
    }

    const incomingHeader = chatData[0];
    const windowLimit = clampLimit(query.window_limit);
    const incomingMessages = extractIncomingWindow(chatData.slice(1), start, windowLimit);
    const existing = await readChatPrefix(chatFilePath, start);

    if (!existing.exists) {
        if (start !== 0) {
            return { ok: false, conflict: true, reason: 'chat_missing' };
        }
        writeChatAtomic(chatFilePath, serializeChatData(chatData));
        return { ok: true, total: incomingMessages.length, start: 0 };
    }

    if (start > existing.total || (baseTotal !== null && baseTotal !== existing.total)) {
        return { ok: false, conflict: true, reason: 'chat_changed_externally', total: existing.total };
    }

    // A windowed save with start=0 must never replace a longer existing
    // history with only the visible tail. This is the hard data-loss guard
    // for old clients, failed bridge initialization, and chat-name races.
    if (!force && start === 0 && existing.total > incomingMessages.length) {
        return { ok: false, conflict: true, reason: 'window_start_invalid', total: existing.total };
    }

    if (!checkIntegrity(existing.header, incomingHeader, force)) {
        return { ok: false, conflict: true, reason: 'integrity' };
    }

    const prefix = existing.prefixLines;
    if (prefix.length !== start) {
        return { ok: false, conflict: true, reason: 'prefix_mismatch' };
    }

    const outputLines = [JSON.stringify(incomingHeader), ...prefix, ...serializeChatData(incomingMessages)];
    writeChatAtomic(chatFilePath, outputLines);

    return {
        ok: true,
        total: start + incomingMessages.length,
        start,
        loaded: incomingMessages.length,
    };
}

function setWindowHeaders(response, result, limit) {
    response.setHeader(HEADER_WINDOW, '1');
    response.setHeader(HEADER_START, String(result.start ?? 0));
    response.setHeader(HEADER_TOTAL, String(result.total ?? 0));
    response.setHeader(HEADER_LIMIT, String(limit));
}

function sendConflict(response, result) {
    return response.status(409).json({
        ok: false,
        error: 'window_conflict',
        reason: result.reason || 'unknown',
        total: result.total,
    });
}

export async function init(router) {
    router.post('/chat/get', async (request, response) => {
        try {
            const { chatFilePath } = resolveCharacterChatPath(request);
            const limit = clampLimit(request.query?.window_size);
            const result = await readChatWindow(chatFilePath, limit);

            setWindowHeaders(response, result, limit);
            if (!result.exists || !result.header) {
                return response.json([]);
            }

            const placeholders = Array.from({ length: result.start }, (_, index) => makeWindowPlaceholder(
                index,
                result.prefixRoles?.[index] ?? true,
                result.prefixReplayData?.[index] ?? null,
            ));
            return response.json([result.header, ...placeholders, ...result.messages]);
        } catch (error) {
            const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
            console.error('[chat-memory-window] Chat load failed:', error);
            return response.status(status).json({ error: error.message || 'Chat load failed.' });
        }
    });

    router.post('/chat/save', async (request, response) => {
        try {
            const { chatFilePath } = resolveCharacterChatPath(request);
            const chatData = request.body?.chat;
            if (!Array.isArray(chatData) || chatData.length === 0 || !chatData[0]) {
                return response.status(400).json({ error: 'The request body.chat is not a non-empty array.' });
            }

            const isWindowed = isTruthy(request.query?.windowed);
            const force = isTruthy(request.body?.force);
            const result = isWindowed
                ? await saveWindowedChat(chatFilePath, chatData, { ...request.query, force })
                : await saveFullChat(chatFilePath, chatData, force);

            if (!result.ok) {
                return sendConflict(response, result);
            }

            response.setHeader(HEADER_WINDOW, isWindowed ? '1' : '0');
            response.setHeader(HEADER_TOTAL, String(result.total ?? 0));
            response.setHeader(HEADER_START, String(result.start ?? 0));
            return response.json({ ok: true, total: result.total ?? 0, start: result.start ?? 0 });
        } catch (error) {
            const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
            console.error('[chat-memory-window] Chat save failed:', error);
            return response.status(status).json({ error: error.message || 'Chat save failed.' });
        }
    });

    console.log(`[chat-memory-window] Server plugin ${VERSION} loaded.`);
}

