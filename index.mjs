import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { isPathUnderParent, tryParse } from '../../src/util.js';

const PLUGIN_ID = 'tavern-memory-limit-assistant';
const VERSION = '1.4.0';

export const info = {
    id: PLUGIN_ID,
    name: '聊天内存限制助手',
    version: VERSION,
    description: 'Loads only a bounded tail of character chats in the browser and safely merges windowed saves.',
};

const HEADER_WINDOW = 'X-Tavern-Memory-Limit-Assistant';
const HEADER_START = 'X-Tavern-Memory-Limit-Assistant-Start';
const HEADER_TOTAL = 'X-Tavern-Memory-Limit-Assistant-Total';
const HEADER_LIMIT = 'X-Tavern-Memory-Limit-Assistant-Limit';
const FULL_HISTORY_SUFFIX = '.tavern-memory-limit-assistant.full';

function fullHistoryPath(chatFilePath) {
    return `${chatFilePath}${FULL_HISTORY_SUFFIX}`;
}

function getFileVersion(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
        return null;
    }
}

function sameFileVersion(firstPath, secondPath) {
    const first = getFileVersion(firstPath);
    const second = getFileVersion(secondPath);
    return Boolean(first && second && first.size === second.size && first.mtimeMs === second.mtimeMs);
}

/**
 * The .full file is a cache, not an independent history. Native SillyTavern
 * saves continue to update the .jsonl file while this extension is disabled.
 * Refresh the cache when the live file changed so re-enabling the extension
 * cannot resurrect the chat from the first time the window was enabled.
 */
function ensureFullHistorySnapshot(chatFilePath) {
    const snapshotPath = fullHistoryPath(chatFilePath);
    if (!fs.existsSync(chatFilePath)) return null;

    if (!fs.existsSync(snapshotPath) || !sameFileVersion(chatFilePath, snapshotPath)) {
        try {
            fs.copyFileSync(chatFilePath, snapshotPath);
            if (fs.existsSync(snapshotPath) && !sameFileVersion(chatFilePath, snapshotPath)) {
                throw new Error('snapshot version did not match the live chat after copy');
            }
            console.info(`[tavern-memory-limit-assistant] Refreshed full-history snapshot for ${path.basename(chatFilePath)}`);
        } catch (error) {
            // The live chat is still the authoritative file. Falling back to it
            // is safer than serving an old snapshot and silently rolling the
            // user back to an earlier chat state.
            console.warn('[tavern-memory-limit-assistant] Could not refresh full-history snapshot; using the live chat:', error);
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
        console.warn('[tavern-memory-limit-assistant] Could not refresh full-history snapshot:', error);
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

function extractIncomingWindow(messages, start, limit) {
    // With start > 0 the client must send the logical prefix placeholders as
    // well as the visible tail. A compact tail-only payload is ambiguous: it
    // could be a valid edit or could overwrite the full history. The caller
    // rejects that shape before this function is used.
    if (start > 0 && messages.length < start) return null;
    if (start === 0 && messages.length <= limit) return messages;

    // The browser keeps a full logical array, but the prefix consists only of
    // lightweight placeholders. Preserve only the real tail for disk merge.
    const fromStart = messages.slice(start);
    const firstReal = fromStart.findIndex(message => !isWindowPlaceholder(message));
    if (firstReal >= 0) return fromStart.slice(firstReal);

    // All remaining entries are placeholders, so the new chat has no tail.
    return [];
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
    const backupPath = `${chatFilePath}.bak-tavern-memory-limit-assistant`;
    try {
        fs.copyFileSync(chatFilePath, backupPath);
    } catch (error) {
        console.warn('[tavern-memory-limit-assistant] Could not create rolling backup:', error);
    }
}

/**
 * The rolling .bak- file is overwritten by every save and the .full snapshot
 * follows the chat file, so a silent truncation would otherwise leave nothing to
 * restore from. Whenever a write would shrink the chat drastically, keep a
 * timestamped copy of the longer version first.
 *
 * @param {string} chatFilePath Chat file about to be written
 * @param {number} nextSize Byte length of the content that is about to replace it
 */
function saveTruncationGuardBackup(chatFilePath, nextSize) {
    if (!fs.existsSync(chatFilePath)) return;

    let currentSize;
    try {
        currentSize = fs.statSync(chatFilePath).size;
    } catch {
        return;
    }

    // Tiny chats are not worth guarding, and ordinary edits stay well above the
    // threshold. Only a drastic shrink is treated as a possible truncation.
    if (currentSize < 64 * 1024) return;
    if (nextSize >= currentSize * 0.7) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const guardPath = `${chatFilePath}.before-truncate-${stamp}`;
    if (fs.existsSync(guardPath)) return;

    try {
        fs.copyFileSync(chatFilePath, guardPath);
        console.warn(`[tavern-memory-limit-assistant] Save would shrink the chat from ${currentSize} to ${nextSize} bytes; kept a copy at ${path.basename(guardPath)}`);
    } catch (error) {
        console.warn('[tavern-memory-limit-assistant] Could not create truncation guard backup:', error);
    }
}

function writeChatAtomic(chatFilePath, lines) {
    fs.mkdirSync(path.dirname(chatFilePath), { recursive: true });
    saveBackup(chatFilePath);
    const data = lines.join('\n');
    saveTruncationGuardBackup(chatFilePath, Buffer.byteLength(data, 'utf8'));
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
    const rawMessages = chatData.slice(1);
    if (!force && start > 0 && rawMessages.length < start) {
        return { ok: false, conflict: true, reason: 'window_state_missing_prefix' };
    }
    const incomingMessages = extractIncomingWindow(rawMessages, start, windowLimit);
    if (!Array.isArray(incomingMessages)) {
        return { ok: false, conflict: true, reason: 'window_state_invalid' };
    }
    if (!force && incomingMessages.some(isWindowPlaceholder)) {
        return { ok: false, conflict: true, reason: 'window_state_invalid' };
    }
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

    // When the on-disk chat is larger than the configured window, start=0 can
    // only be valid for a genuinely full-chat payload. A short tail-only
    // payload would otherwise replace the complete history. Small chats are
    // intentionally exempt: reroll/delete/edit operations on a chat shorter
    // than the window are ordinary full-chat saves and may reduce its length.
    if (!force && start === 0 && existing.total > windowLimit && existing.total > incomingMessages.length) {
        return { ok: false, conflict: true, reason: 'window_start_invalid', total: existing.total };
    }

    if (!checkIntegrity(existing.header, incomingHeader, force)) {
        return { ok: false, conflict: true, reason: 'integrity' };
    }

    const prefix = existing.prefixLines;
    if (prefix.length !== start) {
        return { ok: false, conflict: true, reason: 'prefix_mismatch' };
    }

    // A reroll or delete can legitimately remove many messages after the
    // visible window start. Once base_total and the logical prefix have been
    // verified, do not reject that intentional truncation merely because it is
    // larger than an arbitrary shrink threshold.
    const resultTotal = start + incomingMessages.length;
    const outputLines = [JSON.stringify(incomingHeader), ...prefix, ...serializeChatData(incomingMessages)];
    writeChatAtomic(chatFilePath, outputLines);

    return {
        ok: true,
        total: resultTotal,
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
            console.error('[tavern-memory-limit-assistant] Chat load failed:', error);
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
            console.error('[tavern-memory-limit-assistant] Chat save failed:', error);
            return response.status(status).json({ error: error.message || 'Chat save failed.' });
        }
    });

    console.log(`[tavern-memory-limit-assistant] Server plugin ${VERSION} loaded.`);
}

