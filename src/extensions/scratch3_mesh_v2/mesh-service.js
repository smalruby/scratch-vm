const log = require('../../util/log');
const {getClient} = require('./mesh-client');
const RateLimiter = require('./rate-limiter');
const BlockUtility = require('../../engine/block-utility');
const Variable = require('../../engine/variable');
const {
    LIST_GROUPS_BY_DOMAIN,
    CREATE_DOMAIN,
    CREATE_GROUP,
    JOIN_GROUP,
    LEAVE_GROUP,
    DISSOLVE_GROUP,
    RENEW_HEARTBEAT,
    SEND_MEMBER_HEARTBEAT,
    REPORT_DATA,
    FIRE_EVENTS,
    RECORD_EVENTS,
    GET_EVENTS_SINCE,
    ON_MESSAGE_IN_GROUP,
    LIST_GROUP_STATUSES
} = require('./gql-operations');

const {getForcePollingFromUrl} = require('./utils');

const {GRAPHQL_ENDPOINT} = require('./mesh-client');

/**
 * Parses an environment variable as an integer with validation.
 * @param {string} envVar - The environment variable value.
 * @param {number} defaultValue - The default value if parsing fails or is out of range.
 * @param {number} min - Minimum allowed value (inclusive).
 * @param {number} max - Maximum allowed value (inclusive).
 * @returns {number} The parsed integer or default value.
 */
const parseEnvInt = (envVar, defaultValue, min = 0, max = Infinity) => {
    if (!envVar) return defaultValue;
    const parsed = parseInt(envVar, 10);
    if (isNaN(parsed) || parsed < min || parsed > max) return defaultValue;
    return parsed;
};

// Mesh v2 configuration parameters

/**
 * GraphQL error types that indicate the connection is no longer valid.
 * These are defined in infra/mesh-v2/js/functions/*.js
 */
const DISCONNECT_ERROR_TYPES = new Set([
    'GroupNotFound', // Group doesn't exist, expired, or heartbeat expired
    'Unauthorized', // Not authorized for this operation
    'NodeNotFound' // Node doesn't exist
]);

/* istanbul ignore next */
class MeshV2Service {
    constructor (blocks, meshId, domain) {
        log.info('Initializing MeshV2Service (GraphQL)');
        this.blocks = blocks;
        this.runtime = blocks.runtime;
        this.meshId = meshId;
        this.domain = domain;
        this.client = getClient();
        this.groupId = null;
        this.groupName = null;
        this.expiresAt = null;
        this.isHost = false;
        this.forcePolling = getForcePollingFromUrl();
        this.useWebSocket = !this.forcePolling;
        if (this.forcePolling) {
            log.info('Mesh V2: Forced polling mode enabled via URL parameter');
        }
        this.pollingIntervalSeconds = 2;
        this.lastFetchTime = '';

        this.subscriptions = [];
        this.connectionTimer = null;
        this.heartbeatTimer = null;
        this.dataSyncTimer = null;
        this.pollingTimer = null;

        // Last data send promise to track completion of the most recent data transmission
        this.lastDataSendPromise = Promise.resolve();

        this.hostHeartbeatInterval = 60; // Default 1 min
        this.memberHeartbeatInterval = 120; // Default 2 min

        // Data from other nodes: { nodeId: { key: { value: string, timestamp: number } } }
        this.remoteData = {};

        // Rate limiters
        // Data update interval (default: 1000ms)
        const dataInterval = parseEnvInt(
            process.env.MESH_DATA_UPDATE_INTERVAL_MS,
            1000, // default
            100, // min: 100ms
            10000 // max: 10 seconds
        );
        log.info(`Mesh V2: Data update interval set to ${dataInterval}ms`);
        this.dataRateLimiter = new RateLimiter(dataInterval, {
            enableMerge: true,
            mergeKeyField: 'key'
        });

        // Event queue for batch sending: { eventName, payload, firedAt } の配列
        this.eventQueue = [];
        // Event batch interval (default: 1000ms)
        this.eventBatchInterval = parseEnvInt(
            process.env.MESH_EVENT_BATCH_INTERVAL_MS,
            1000, // default
            100, // min: 100ms
            10000 // max: 10 seconds
        );
        log.info(`Mesh V2: Event batch interval set to ${this.eventBatchInterval}ms`);
        this.eventBatchTimer = null;

        // Periodic data sync interval (default: 15000ms)
        this.periodicDataSyncInterval = parseEnvInt(
            process.env.MESH_PERIODIC_DATA_SYNC_INTERVAL_MS,
            15000, // default
            1000, // min: 1 second
            3600000 // max: 1 hour
        );
        log.info(`Mesh V2: Periodic data sync interval set to ${this.periodicDataSyncInterval}ms`);

        // Event queue limits
        this.MAX_EVENT_QUEUE_SIZE = 100; // 最大100イベント
        this.eventQueueStats = {
            duplicatesSkipped: 0,
            dropped: 0,
            lastReportTime: Date.now()
        };

        // Last sent data to detect changes (confirmed by server)
        this.lastSentData = {};
        // Latest data queued for sending (may not be confirmed yet)
        this.latestQueuedData = {};

        // イベントキュー: {event, offsetMs} の配列
        this.pendingBroadcasts = [];
        this.batchStartTime = null; // バッチ処理開始時刻（実時間）
        this.lastBroadcastOffset = 0; // 最後に処理したイベントのオフセット（ms）

        // runtimeのBEFORE_STEPイベントにフック
        // boundメソッドを保持（cleanup時にoff()で使用）
        this._processNextBroadcastBound = this.processNextBroadcast.bind(this);
        this.runtime.on('BEFORE_STEP', this._processNextBroadcastBound);

        /**
         * Bound reference to _reportData for RateLimiter merge comparison.
         * This ensures consistent sendFunction reference across multiple calls.
         * @private
         */
        this._reportDataBound = this._reportData.bind(this);

        this.disconnectCallback = null;

        // Cost tracking
        this.costTracking = {
            connectionStartTime: null,
            queryCount: 0, // LIST_GROUPS_BY_DOMAIN, LIST_GROUP_STATUSES
            mutationCount: 0, // CREATE_DOMAIN, CREATE_GROUP, JOIN_GROUP, etc.
            heartbeatCount: 0, // RENEW_HEARTBEAT, SEND_MEMBER_HEARTBEAT
            reportDataCount: 0, // REPORT_DATA
            fireEventsCount: 0, // FIRE_EVENTS
            dataUpdateReceived: 0, // ON_DATA_UPDATE
            batchEventReceived: 0, // ON_BATCH_EVENT
            dissolveReceived: 0 // ON_GROUP_DISSOLVE
        };
    }

    /**
     * Check if the error indicates the group/node is no longer valid.
     * Uses errorType from GraphQL response for robust error detection.
     * @param {Error} error - The error to check.
     * @returns {string|null} The error reason if should disconnect, null otherwise.
     */
    shouldDisconnectOnError (error) {
        if (!error) return null;

        // Primary check: GraphQL errorType (most reliable)
        if (error.graphQLErrors && error.graphQLErrors.length > 0) {
            const errorType = error.graphQLErrors[0].errorType;
            if (DISCONNECT_ERROR_TYPES.has(errorType)) {
                log.info(`Mesh V2: Disconnecting due to errorType: ${errorType}`);
                return errorType;
            }
        }

        // Fallback: check message string (backward compatibility)
        // This ensures old behavior is preserved if errorType is missing
        if (error.message) {
            const message = error.message.toLowerCase();
            if (message.includes('not found') ||
                message.includes('expired') ||
                message.includes('unauthorized')) {
                log.warn('Mesh V2: Disconnecting based on error message (fallback). Consider checking errorType.');
                return 'expired';
            }
        }

        return null;
    }

    setDisconnectCallback (callback) {
        this.disconnectCallback = callback;
    }

    cleanupAndDisconnect (reason = 'unknown') {
        this.cleanup();
        if (this.disconnectCallback) {
            this.disconnectCallback(reason);
        }
    }

    /**
     * Test if WebSocket connection is possible in the current environment.
     * @returns {Promise<boolean>} True if WebSocket is available.
     */
    testWebSocket () {
        return new Promise(resolve => {
            try {
                // Derived from https://xxx.appsync-api.region.amazonaws.com/graphql
                // to wss://xxx.appsync-realtime-api.region.amazonaws.com/graphql
                // or for custom domains, to wss://api.example.com/graphql/realtime
                let wsUrl = GRAPHQL_ENDPOINT.replace('https://', 'wss://');
                if (wsUrl.includes('appsync-api')) {
                    wsUrl = wsUrl.replace('appsync-api', 'appsync-realtime-api');
                } else {
                    wsUrl = wsUrl.replace(/\/graphql$/, '/graphql/realtime');
                }

                const socket = new WebSocket(wsUrl, 'graphql-ws');
                const timeout = setTimeout(() => {
                    log.warn('Mesh V2: WebSocket test timed out');
                    socket.close();
                    resolve(false);
                }, 3000); // 3 seconds timeout for test

                socket.onopen = () => {
                    log.info('Mesh V2: WebSocket test successful');
                    clearTimeout(timeout);
                    socket.close();
                    resolve(true);
                };

                socket.onerror = err => {
                    log.warn(`Mesh V2: WebSocket test failed: ${err}`);
                    clearTimeout(timeout);
                    resolve(false);
                };
            } catch (error) {
                log.warn(`Mesh V2: WebSocket not supported or failed to initialize: ${error}`);
                resolve(false);
            }
        });
    }

    async createDomain () {
        if (!this.client) throw new Error('Client not initialized');

        try {
            this.costTracking.mutationCount++;
            const result = await this.client.mutate({
                mutation: CREATE_DOMAIN
            });

            this.domain = result.data.createDomain;
            log.info(`Mesh V2: Created domain ${this.domain} from source IP`);
            return this.domain;
        } catch (error) {
            log.error(`Mesh V2: Failed to create domain: ${error}`);
            throw error;
        }
    }

    async createGroup (groupName) {
        if (!this.client) throw new Error('Client not initialized');

        try {
            if (!this.domain) {
                await this.createDomain();
            }

            // Test WebSocket availability
            if (this.forcePolling) {
                this.useWebSocket = false;
            } else {
                this.useWebSocket = await this.testWebSocket();
            }
            log.info(`Mesh V2: WebSocket available: ${this.useWebSocket}`);

            this.costTracking.mutationCount++;
            this.lastFetchTime = new Date().toISOString();
            log.info(`Mesh V2: Initialized lastFetchTime to ${this.lastFetchTime} (before createGroup)`);
            const result = await this.client.mutate({
                mutation: CREATE_GROUP,
                variables: {
                    name: groupName,
                    hostId: this.meshId,
                    domain: this.domain,
                    useWebSocket: this.useWebSocket
                }
            });

            const group = result.data.createGroup;
            this.groupId = group.id;
            this.groupName = group.name;
            this.domain = group.domain; // Update domain from server
            this.expiresAt = group.expiresAt;
            this.useWebSocket = group.useWebSocket;
            if (group.pollingIntervalSeconds) {
                this.pollingIntervalSeconds = group.pollingIntervalSeconds;
            }
            this.isHost = true;
            if (group.heartbeatIntervalSeconds) {
                this.hostHeartbeatInterval = group.heartbeatIntervalSeconds;
            }

            this.costTracking.connectionStartTime = Date.now();
            if (this.useWebSocket) {
                this.startSubscriptions();
            } else {
                this.startPolling();
            }
            this.startHeartbeat();
            this.startEventBatchTimer();
            this.startConnectionTimer();
            this.startPeriodicDataSync();

            await this.sendAllGlobalVariables();

            log.info(`Mesh V2: Created group ${this.groupName} (${this.groupId}) in domain ${this.domain} ` +
                `(Protocol: ${this.useWebSocket ? 'WebSocket' : 'Polling'})`);
            return group;
        } catch (error) {
            log.error(`Mesh V2: Failed to create group: ${error}`);
            throw error;
        }
    }

    async listGroups () {
        if (!this.client) throw new Error('Client not initialized');

        try {
            if (!this.domain) {
                await this.createDomain();
            }

            this.costTracking.queryCount++;
            const result = await this.client.query({
                query: LIST_GROUPS_BY_DOMAIN,
                variables: {
                    domain: this.domain
                },
                fetchPolicy: 'network-only'
            });

            const groups = result.data.listGroupsByDomain;
            return groups;
        } catch (error) {
            log.error(`Mesh V2: Failed to list groups: ${error}`);
            throw error;
        }
    }

    async joinGroup (groupId, domain, groupName) {
        if (!this.client) throw new Error('Client not initialized');

        try {
            this.costTracking.mutationCount++;
            this.lastFetchTime = new Date().toISOString();
            log.info(`Mesh V2: Initialized lastFetchTime to ${this.lastFetchTime} (before joinGroup)`);
            const result = await this.client.mutate({
                mutation: JOIN_GROUP,
                variables: {
                    groupId: groupId,
                    domain: domain || this.domain,
                    nodeId: this.meshId
                }
            });

            const node = result.data.joinGroup;
            this.groupId = groupId;
            this.groupName = groupName || groupId;
            this.domain = node.domain; // Update domain from server
            this.expiresAt = node.expiresAt;
            this.useWebSocket = this.forcePolling ? false : node.useWebSocket;
            if (node.pollingIntervalSeconds) {
                this.pollingIntervalSeconds = node.pollingIntervalSeconds;
            }
            this.isHost = false;
            if (node.heartbeatIntervalSeconds) {
                this.memberHeartbeatInterval = node.heartbeatIntervalSeconds;
            }

            this.costTracking.connectionStartTime = Date.now();
            if (this.useWebSocket) {
                this.startSubscriptions();
            } else {
                this.startPolling();
            }
            this.startHeartbeat(); // Start heartbeat for member too
            this.startEventBatchTimer();
            this.startConnectionTimer();
            this.startPeriodicDataSync();

            await this.sendAllGlobalVariables();
            await this.fetchAllNodesData();

            log.info(`Mesh V2: Joined group ${this.groupId} in domain ${this.domain} ` +
                `(Protocol: ${this.useWebSocket ? 'WebSocket' : 'Polling'})`);
            return node;
        } catch (error) {
            log.error(`Mesh V2: Failed to join group: ${error}`);
            throw error;
        }
    }

    async leaveGroup () {
        if (!this.groupId) return;

        const groupId = this.groupId;
        const domain = this.domain;
        const isHost = this.isHost;
        const hostId = this.meshId;
        const nodeId = this.meshId;

        this.cleanupAndDisconnect();

        if (!this.client) return;

        try {
            if (isHost) {
                this.costTracking.mutationCount++;
                await this.client.mutate({
                    mutation: DISSOLVE_GROUP,
                    variables: {
                        groupId: groupId,
                        domain: domain,
                        hostId: hostId
                    }
                });
                log.info(`Mesh V2: Dissolved group ${groupId}`);
            } else {
                this.costTracking.mutationCount++;
                await this.client.mutate({
                    mutation: LEAVE_GROUP,
                    variables: {
                        groupId: groupId,
                        domain: domain,
                        nodeId: nodeId
                    }
                });
                log.info(`Mesh V2: Left group ${groupId}`);
            }
        } catch (error) {
            log.error(`Mesh V2: Error during leave/dissolve (background): ${error}`);
        }
    }

    cleanup () {
        // コスト計算とログ出力
        if (this.costTracking.connectionStartTime) {
            const connectionDurationSeconds = (Date.now() - this.costTracking.connectionStartTime) / 1000;
            const connectionDurationMinutes = connectionDurationSeconds / 60;

            // Query/Mutation costs
            const queryCost = this.costTracking.queryCount * 0.000004;
            const mutationCost = this.costTracking.mutationCount * 0.000004;

            // Subscription message costs
            const dataUpdateCost = this.costTracking.dataUpdateReceived * 0.000002;
            const batchEventCost = this.costTracking.batchEventReceived * 0.000002;
            const dissolveCost = this.costTracking.dissolveReceived * 0.000002;

            // Subscription connection cost (1 subscription)
            const connectionCost = (connectionDurationMinutes / 1000000) * 1 * 0.08;

            const totalCost = queryCost + mutationCost + dataUpdateCost + batchEventCost +
                dissolveCost + connectionCost;

            log.info(`Mesh V2: Cost Summary for ${connectionDurationMinutes.toFixed(2)} minutes connection`);
            log.info(`  Role: ${this.isHost ? 'Host' : 'Member'}`);
            log.info(`  Queries: ${this.costTracking.queryCount} ops = $${queryCost.toFixed(8)}`);
            log.info(`  Mutations: ${this.costTracking.mutationCount} ops = $${mutationCost.toFixed(8)}`);
            log.info(`    - Heartbeats: ${this.costTracking.heartbeatCount}`);
            log.info(`    - REPORT_DATA: ${this.costTracking.reportDataCount}`);
            log.info(`    - FIRE_EVENTS: ${this.costTracking.fireEventsCount}`);
            log.info(`  Subscription Messages:`);
            log.info(`    - Data Updates: ${this.costTracking.dataUpdateReceived} msgs = ` +
                `$${dataUpdateCost.toFixed(8)}`);
            log.info(`    - Batch Events: ${this.costTracking.batchEventReceived} msgs = ` +
                `$${batchEventCost.toFixed(8)}`);
            log.info(`    - Dissolve: ${this.costTracking.dissolveReceived} msgs = ` +
                `$${dissolveCost.toFixed(8)}`);
            log.info(`  Subscription Connection: ${connectionDurationMinutes.toFixed(2)} min × 1 = ` +
                `$${connectionCost.toFixed(8)}`);
            log.info(`  TOTAL ESTIMATED COST: $${totalCost.toFixed(8)} ` +
                `(${(totalCost * 1000000).toFixed(2)} per million operations equivalent)`);
            log.info(`  Average cost per second: $${(totalCost / connectionDurationSeconds).toFixed(10)}`);
        }

        // 統計情報を出力
        if (this.eventQueueStats &&
            (this.eventQueueStats.duplicatesSkipped > 0 || this.eventQueueStats.dropped > 0)) {
            log.info(`Mesh V2: Final Event Queue Stats: ` +
                `duplicates skipped=${this.eventQueueStats.duplicatesSkipped}, ` +
                `dropped=${this.eventQueueStats.dropped}`);
        }

        // キューをクリア
        this.pendingBroadcasts = [];
        this.batchStartTime = null;
        this.lastBroadcastOffset = 0;

        this.stopSubscriptions();
        this.stopPolling();
        this.stopHeartbeat();
        this.stopEventBatchTimer();
        this.stopConnectionTimer();
        this.stopPeriodicDataSync();
        this.groupId = null;
        this.groupName = null;
        this.expiresAt = null;
        this.isHost = false;
        this.remoteData = {};
        this.lastSentData = {};
        this.latestQueuedData = {};
    }

    startSubscriptions () {
        if (!this.groupId || !this.client) return;

        const variables = {
            groupId: this.groupId,
            domain: this.domain
        };

        const messageSub = this.client.subscribe({
            query: ON_MESSAGE_IN_GROUP,
            variables
        }).subscribe({
            next: result => {
                const message = result.data.onMessageInGroup;
                if (!message) return;

                // MeshMessage has three fields: nodeStatus, batchEvent, groupDissolve
                // Only one field will be non-null per message
                // Count all received messages for accurate cost estimation (AppSync delivers to sender too)
                if (message.nodeStatus) {
                    this.costTracking.dataUpdateReceived++;
                    this.handleDataUpdate(message.nodeStatus);
                } else if (message.batchEvent) {
                    this.costTracking.batchEventReceived++;
                    this.handleBatchEvent(message.batchEvent);
                } else if (message.groupDissolve) {
                    this.costTracking.dissolveReceived++;
                    log.info('Mesh V2: Group dissolved by host');
                    this.cleanupAndDisconnect();
                } else {
                    log.warn('Mesh V2: Received message with all fields null');
                }
            },
            error: err => log.error(`Mesh V2: Subscription error: ${err}`)
        });

        this.subscriptions.push(messageSub);
    }

    stopSubscriptions () {
        this.subscriptions.forEach(sub => sub.unsubscribe());
        this.subscriptions = [];
    }

    /**
     * Start polling for events when WebSocket is not available.
     */
    startPolling () {
        this.stopPolling();
        if (!this.groupId) return;

        log.info(`Mesh V2: Starting event polling (Interval: ${this.pollingIntervalSeconds}s)`);

        this.pollingTimer = setInterval(() => {
            this.pollEvents();
        }, this.pollingIntervalSeconds * 1000);
    }

    /**
     * Stop event polling.
     */
    stopPolling () {
        if (this.pollingTimer) {
            log.info('Mesh V2: Stopping event polling');
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
        this.lastFetchTime = '';
    }

    /**
     * Fetch new events from the server since the last fetch time.
     */
    async pollEvents () {
        if (!this.groupId || !this.client || this.useWebSocket) return;

        if (!this.lastFetchTime) {
            log.warn('Mesh V2: pollEvents called but lastFetchTime is empty. Falling back to current time.');
            this.lastFetchTime = new Date().toISOString();
        }

        log.debug(`Mesh V2: pollEvents for group ${this.groupId}. since=${this.lastFetchTime}`);

        try {
            this.costTracking.queryCount++;
            const result = await this.client.query({
                query: GET_EVENTS_SINCE,
                variables: {
                    groupId: this.groupId,
                    domain: this.domain,
                    since: this.lastFetchTime
                },
                fetchPolicy: 'network-only'
            });

            if (result.data && result.data.getEventsSince) {
                const events = result.data.getEventsSince;
                if (events.length > 0) {
                    log.info(`Mesh V2: Polled ${events.length} events`);

                    // Filter out events from self and sort by timestamp to preserve order
                    const otherEvents = events
                        .filter(event => event.firedByNodeId !== this.meshId);

                    if (otherEvents.length > 0) {
                        this._queueEventsForPlayback(otherEvents);
                    }

                    // ALWAYS update lastFetchTime from the LAST event in the result (including our own)
                    // to ensure we don't fetch the same events again.
                    const lastEvent = events[events.length - 1];
                    if (lastEvent.cursor) {
                        this.lastFetchTime = lastEvent.cursor;
                    }
                }
            }
        } catch (error) {
            log.error(`Mesh V2: Event polling failed: ${error}`);
        }
    }

    handleDataUpdate (nodeStatus) {
        if (!nodeStatus || nodeStatus.nodeId === this.meshId) return;

        const nodeId = nodeStatus.nodeId;
        if (!this.remoteData[nodeId]) {
            this.remoteData[nodeId] = {};
        }

        // Use server timestamp with fallback to current time
        const serverTimestamp = nodeStatus.timestamp ?
            new Date(nodeStatus.timestamp).getTime() :
            (log.warn('Mesh V2: Missing server timestamp, using client time'), Date.now());

        nodeStatus.data.forEach(item => {
            this.remoteData[nodeId][item.key] = {
                value: item.value,
                timestamp: serverTimestamp
            };
        });
    }

    handleBatchEvent (batchEvent) {
        if (!batchEvent || batchEvent.firedByNodeId === this.meshId) return;

        const events = batchEvent.events ?
            batchEvent.events.filter(event => event.firedByNodeId !== this.meshId) :
            [];
        if (events.length === 0) return;

        log.info(`Mesh V2: Received ${events.length} events from ${batchEvent.firedByNodeId}`);

        this._queueEventsForPlayback(events);
    }

    /**
     * Internal method to queue events for playback with relative timing.
     * @param {Array} events - Array of events to queue.
     * @private
     */
    _queueEventsForPlayback (events) {
        if (!events || events.length === 0) return;

        // タイムスタンプでソート（副作用を避けるためコピーを作成）
        const sortedEvents = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // 最初のイベントを基準にオフセットを計算
        const baseTime = new Date(sortedEvents[0].timestamp).getTime();

        // キューに追加
        sortedEvents.forEach(event => {
            const eventTime = new Date(event.timestamp).getTime();
            const offsetMs = eventTime - baseTime;

            this.pendingBroadcasts.push({
                event: event,
                offsetMs: offsetMs
            });
            log.info(`Mesh V2: Queued event: ${event.name} ` +
                `(offset: ${offsetMs}ms, original timestamp: ${event.timestamp})`);
        });

        // バッチ処理開始時刻を記録（未開始の場合のみ）
        if (this.batchStartTime === null && this.pendingBroadcasts.length > 0) {
            this.batchStartTime = Date.now();
            this.lastBroadcastOffset = 0;
        }

        log.info(`Mesh V2: Total pending broadcasts: ${this.pendingBroadcasts.length}`);
    }

    /**
     * Process pending broadcast events that should fire based on elapsed real time.
     * Called once per frame via BEFORE_STEP event.
     *
     * Strategy:
     * - Process events whose timing has arrived (offsetMs <= elapsedMs)
     * - Limit processing to a 33ms window of event time per frame to avoid spikes
     * - Execute them in order (maintains event sequence)
     * - Different event types don't cause RESTART (different handlers)
     */
    processNextBroadcast () {
        if (!this.groupId) {
            // 切断されている場合はなにもしない
            return;
        }

        if (this.pendingBroadcasts.length === 0) {
            // キューが空になったらリセット
            this.batchStartTime = null;
            this.lastBroadcastOffset = 0;
            return;
        }

        const now = Date.now();
        const elapsedMs = this.batchStartTime ? now - this.batchStartTime : 0;

        // 処理すべきイベントを収集（タイミングが来ているもの）
        const eventsToProcess = [];
        let windowBase = null;

        while (this.pendingBroadcasts.length > 0) {
            const {event, offsetMs} = this.pendingBroadcasts[0];

            // まだタイミングが来ていない場合は待機
            if (offsetMs > elapsedMs) {
                log.debug(`Mesh V2: Waiting for event ${event.name} ` +
                    `(needs ${offsetMs}ms, elapsed ${elapsedMs}ms)`);
                break;
            }

            // 1フレーム(33ms)のウィンドウ制限を適用
            // （バックログがある場合でも1フレームで大量のブロードキャストを避ける）
            if (windowBase === null) {
                windowBase = offsetMs;
            } else if (offsetMs >= windowBase + 33) {
                log.debug(`Mesh V2: Window limit reached (33ms). ` +
                    `Remaining events will be processed in next frames.`);
                break;
            }

            // タイミングが来たイベントをキューから取り出し
            const item = this.pendingBroadcasts.shift();
            eventsToProcess.push(item);
        }

        // 収集したイベントを処理
        if (eventsToProcess.length > 0) {
            log.info(`Mesh V2: Broadcasting ${eventsToProcess.length} events ` +
                `(${this.pendingBroadcasts.length} remaining in queue)`);

            eventsToProcess.forEach(({event, offsetMs}) => {
                log.info(`Mesh V2: Broadcasting event: ${event.name} ` +
                    `(offset: ${offsetMs}ms, elapsed: ${elapsedMs}ms)`);

                this.broadcastEvent(event);
                this.lastBroadcastOffset = offsetMs;
            });
        }
    }

    broadcastEvent (event) {
        log.info(`Mesh V2: Executing broadcastEvent for: ${event.name}`);
        try {
            const stage = this.runtime.getTargetForStage();
            let broadcastVar = stage.lookupBroadcastByInputValue(event.name);
            if (!broadcastVar) {
                log.info(`Mesh V2: Creating missing broadcast message: ${event.name}`);
                stage.createVariable(null, event.name, Variable.BROADCAST_MESSAGE_TYPE);
                broadcastVar = stage.lookupBroadcastByInputValue(event.name);
                if (broadcastVar) {
                    broadcastVar.isPersistent = true;
                }
                this.runtime.requestBlocksUpdate();
            }

            const args = {
                BROADCAST_OPTION: {
                    id: broadcastVar ? broadcastVar.id : null,
                    name: broadcastVar ? broadcastVar.name : event.name
                }
            };
            const util = BlockUtility.lastInstance();
            if (util) {
                if (!util.sequencer) {
                    util.sequencer = this.runtime.sequencer;
                }
                log.info(`Mesh V2: Triggering event_broadcast: ${event.name}`);
                this.blocks.opcodeFunctions.event_broadcast(args, util);
            } else {
                log.warn(`Mesh V2: No BlockUtility instance available for broadcast: ${event.name}`);
            }
        } catch (error) {
            log.error(`Mesh V2: Failed to broadcast event: ${error}`);
        }
    }

    startEventBatchTimer () {
        this.stopEventBatchTimer();
        log.debug(`Mesh V2: Starting event batch timer (Interval: ${this.eventBatchInterval}ms)`);
        this.eventBatchTimer = setInterval(() => {
            this.processBatchEvents();
        }, this.eventBatchInterval);
    }

    stopEventBatchTimer () {
        if (this.eventBatchTimer) {
            clearInterval(this.eventBatchTimer);
            this.eventBatchTimer = null;
        }
    }

    async processBatchEvents () {
        if (this.eventQueue.length === 0) return;

        // キューから全イベントを取り出す
        const events = this.eventQueue.splice(0);
        log.info(`Mesh V2: Processing ${events.length} queued events for sending`);

        try {
            // ペイロードサイズ制限を考慮して分割送信（約1,000イベントごと）
            const MAX_BATCH_SIZE = 1000;
            while (events.length > 0) {
                const batch = events.splice(0, MAX_BATCH_SIZE);
                await this.fireEventsBatch(batch);
            }
        } catch (error) {
            log.error(`Mesh V2: Failed to process batch events: ${error}`);
        }
    }

    async fireEventsBatch (events) {
        if (!this.groupId || !this.client || events.length === 0) return;

        try {
            // Wait for last data send to complete
            await this.lastDataSendPromise;

            this.costTracking.mutationCount++;
            this.costTracking.fireEventsCount++;
            log.info(`Mesh V2: Sending batch of ${events.length} events to group ${this.groupId} ` +
                `(Protocol: ${this.useWebSocket ? 'WebSocket' : 'Polling'})`);

            if (this.useWebSocket) {
                await this.client.mutate({
                    mutation: FIRE_EVENTS,
                    variables: {
                        groupId: this.groupId,
                        domain: this.domain,
                        nodeId: this.meshId,
                        events: events
                    }
                });
            } else {
                const result = await this.client.mutate({
                    mutation: RECORD_EVENTS,
                    variables: {
                        groupId: this.groupId,
                        domain: this.domain,
                        nodeId: this.meshId,
                        events: events
                    }
                });
                if (result.data && result.data.recordEventsByNode && result.data.recordEventsByNode.nextSince) {
                    this.lastFetchTime = result.data.recordEventsByNode.nextSince;
                }
            }
        } catch (error) {
            log.error(`Mesh V2: Failed to fire batch events: ${error}`);
            const reason = this.shouldDisconnectOnError(error);
            if (reason) {
                this.cleanupAndDisconnect(reason);
            }
        }
    }

    startHeartbeat () {
        this.stopHeartbeat();
        if (!this.groupId) return;

        log.info(`Mesh V2: Starting heartbeat timer (Role: ${this.isHost ? 'Host' : 'Member'}, ` +
            `Interval: ${this.isHost ? this.hostHeartbeatInterval : this.memberHeartbeatInterval}s)`);
        const interval = (this.isHost ? this.hostHeartbeatInterval : this.memberHeartbeatInterval) * 1000;

        this.heartbeatTimer = setInterval(() => {
            if (this.isHost) {
                this.renewHeartbeat();
            } else {
                this.sendMemberHeartbeat();
            }
        }, interval);
    }

    stopHeartbeat () {
        if (this.heartbeatTimer) {
            log.info('Mesh V2: Stopping heartbeat timer');
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    async renewHeartbeat () {
        if (!this.groupId || !this.client || !this.isHost) return;

        try {
            this.costTracking.mutationCount++;
            this.costTracking.heartbeatCount++;
            const result = await this.client.mutate({
                mutation: RENEW_HEARTBEAT,
                variables: {
                    groupId: this.groupId,
                    domain: this.domain,
                    hostId: this.meshId
                }
            });

            this.expiresAt = result.data.renewHeartbeat.expiresAt;
            log.info(`Mesh V2: Heartbeat renewed. Expires at: ${this.expiresAt}`);

            if (result.data.renewHeartbeat.heartbeatIntervalSeconds) {
                const newInterval = result.data.renewHeartbeat.heartbeatIntervalSeconds;
                if (newInterval !== this.hostHeartbeatInterval) {
                    this.hostHeartbeatInterval = newInterval;
                    this.startHeartbeat(); // Restart with new interval
                }
            }
            this.startConnectionTimer();
            return result.data.renewHeartbeat;
        } catch (error) {
            log.error(`Mesh V2: Heartbeat renewal failed: ${error}`);
            const reason = this.shouldDisconnectOnError(error);
            if (reason) {
                this.cleanupAndDisconnect(reason);
            }
        }
    }

    async sendMemberHeartbeat () {
        if (!this.groupId || !this.client || this.isHost) return;

        try {
            this.costTracking.mutationCount++;
            this.costTracking.heartbeatCount++;
            const result = await this.client.mutate({
                mutation: SEND_MEMBER_HEARTBEAT,
                variables: {
                    groupId: this.groupId,
                    domain: this.domain,
                    nodeId: this.meshId
                }
            });

            log.info('Mesh V2: Member heartbeat sent');
            if (result.data.sendMemberHeartbeat.expiresAt) {
                this.expiresAt = result.data.sendMemberHeartbeat.expiresAt;
            }

            return result.data.sendMemberHeartbeat;
        } catch (error) {
            log.error(`Mesh V2: Member heartbeat failed: ${error}`);
            const reason = this.shouldDisconnectOnError(error);
            if (reason) {
                this.cleanupAndDisconnect(reason);
            }
        }
    }

    startConnectionTimer () {
        this.stopConnectionTimer();
        if (!this.expiresAt) return;

        const timeout = new Date(this.expiresAt).getTime() - Date.now();
        if (timeout <= 0) {
            log.warn('Mesh V2: Group is already expired');
            this.leaveGroup();
            return;
        }

        const timeoutMinutes = Math.round(timeout / 60000);
        this.connectionTimer = setTimeout(() => {
            log.warn(`Mesh V2: Connection timeout (${timeoutMinutes} minutes)`);
            this.leaveGroup();
        }, timeout);
    }

    stopConnectionTimer () {
        if (this.connectionTimer) {
            clearTimeout(this.connectionTimer);
            this.connectionTimer = null;
        }
    }

    async sendData (dataArray) {
        if (!this.groupId || !this.client) return;

        // Delta transmission: Filter out items that haven't changed since they were LAST QUEUED.
        // This avoids redundant mutations if values change back within the rate-limit interval.
        const filteredData = dataArray.filter(item => this.latestQueuedData[item.key] !== item.value);

        log.debug(`Mesh V2: sendData called with ${dataArray.length} items, ` +
            `${filteredData.length} items changed: ${JSON.stringify(filteredData)}`);

        if (filteredData.length === 0) {
            return;
        }

        // Update latestQueuedData IMMEDIATELY before sending to RateLimiter
        filteredData.forEach(item => {
            this.latestQueuedData[item.key] = item.value;
        });

        try {
            // Save Promise to track completion (including queue time)
            this.lastDataSendPromise = this.dataRateLimiter.send(filteredData, this._reportDataBound);
            await this.lastDataSendPromise;
        } catch (error) {
            log.error(`Mesh V2: Failed to send data: ${error}`);
            const reason = this.shouldDisconnectOnError(error);
            if (reason) {
                this.cleanupAndDisconnect(reason);
            }
        }
    }

    /**
     * Internal method to send data to the server.
     * Used as sendFunction in dataRateLimiter.
     * @param {Array} payload - Array of {key, value} objects.
     * @returns {Promise} - Resolves with the mutation result.
     * @private
     */
    async _reportData (payload) {
        if (!this.groupId || !this.client) return;

        // Final delta check: Filter out items that haven't changed since the LAST SUCCESSFUL transmission.
        // This handles cases where values changed back while an earlier mutation was in flight.
        const finalPayload = payload.filter(item => this.lastSentData[item.key] !== item.value);

        if (finalPayload.length === 0) {
            log.debug('Mesh V2: Skipping mutation as all data is already up-to-date on server');
            return {
                data: {
                    reportDataByNode: {
                        nodeStatus: {
                            data: payload // Return original payload to satisfy caller expectation
                        }
                    }
                }
            };
        }

        try {
            this.costTracking.mutationCount++;
            this.costTracking.reportDataCount++;

            // Save Promise to track completion
            this.lastDataSendPromise = this.client.mutate({
                mutation: REPORT_DATA,
                variables: {
                    groupId: this.groupId,
                    domain: this.domain,
                    nodeId: this.meshId,
                    data: finalPayload
                }
            });

            const result = await this.lastDataSendPromise;

            // Update last sent data on success
            finalPayload.forEach(item => {
                this.lastSentData[item.key] = item.value;
            });

            return result;
        } catch (error) {
            log.error(`Mesh V2: Failed to report data: ${error}`);
            const reason = this.shouldDisconnectOnError(error);
            if (reason) {
                this.cleanupAndDisconnect(reason);
            }
            throw error;
        }
    }

    fireEvent (eventName, payload = '') {
        if (!this.groupId || !this.client) {
            log.warn(`Mesh V2: Cannot fire event ${eventName} - groupId: ${this.groupId}, client: ${!!this.client}`);
            return;
        }

        // ステップ1: 重複チェック
        const isDuplicate = this.eventQueue.some(item =>
            item.eventName === eventName && item.payload === payload
        );

        if (isDuplicate) {
            this.eventQueueStats.duplicatesSkipped++;
            this.reportEventStatsIfNeeded();

            log.debug(`Mesh V2: Event already in queue, skipping: ${eventName}`);
            return;
        }

        // ステップ2: サイズ制限チェック（保険）
        if (this.eventQueue.length >= this.MAX_EVENT_QUEUE_SIZE) {
            const dropped = this.eventQueue.shift(); // 古いイベントを破棄（FIFO）
            this.eventQueueStats.dropped++;

            if (this.eventQueueStats.dropped % 10 === 1) { // 10イベントごとに警告
                log.warn(`Mesh V2: Event queue full (${this.MAX_EVENT_QUEUE_SIZE}). ` +
                    `Dropped ${this.eventQueueStats.dropped} events. ` +
                    `Latest: ${dropped.eventName}`);
            }
        }

        log.debug(`Mesh V2: Queuing event for sending: ${eventName} ` +
            `(queue size: ${this.eventQueue.length})`);

        // キューに追加（発火日時を記録）
        this.eventQueue.push({
            eventName: eventName,
            payload: payload,
            firedAt: new Date().toISOString()
        });
    }

    /**
     * Report event queue statistics if needed (every 10 seconds).
     */
    reportEventStatsIfNeeded () {
        const now = Date.now();
        const elapsed = now - this.eventQueueStats.lastReportTime;

        if (elapsed >= 10000 &&
            (this.eventQueueStats.duplicatesSkipped > 0 || this.eventQueueStats.dropped > 0)) {
            log.info(`Mesh V2: Event Queue Stats (last ${(elapsed / 1000).toFixed(1)}s): ` +
                `duplicates skipped=${this.eventQueueStats.duplicatesSkipped}, ` +
                `dropped=${this.eventQueueStats.dropped}, ` +
                `current queue size=${this.eventQueue.length}`);

            this.eventQueueStats.duplicatesSkipped = 0;
            this.eventQueueStats.dropped = 0;
            this.eventQueueStats.lastReportTime = now;
        }
    }

    /**
     * Fetch data from all nodes in the group.
     * @returns {Promise<void>} A promise that resolves when data is fetched and updated.
     */
    async fetchAllNodesData () {
        if (!this.groupId || !this.client) return;

        try {
            this.costTracking.queryCount++;
            const result = await this.client.query({
                query: LIST_GROUP_STATUSES,
                variables: {
                    groupId: this.groupId,
                    domain: this.domain
                },
                fetchPolicy: 'network-only'
            });

            const nodeStatuses = result.data.listGroupStatuses;

            // Update remoteData
            nodeStatuses.forEach(status => {
                if (status.nodeId === this.meshId) return;

                if (!this.remoteData[status.nodeId]) {
                    this.remoteData[status.nodeId] = {};
                }
                const serverTimestamp = status.timestamp ?
                    new Date(status.timestamp).getTime() :
                    (log.warn('Mesh V2: Missing server timestamp, using client time'), Date.now());
                status.data.forEach(item => {
                    this.remoteData[status.nodeId][item.key] = {
                        value: item.value,
                        timestamp: serverTimestamp
                    };
                });
            });

            log.info(`Mesh V2: Fetched data from ${nodeStatuses.length} nodes`);
        } catch (error) {
            log.error(`Mesh V2: Failed to fetch group data: ${error}`);
        }
    }

    /**
     * Start periodic data synchronization to ensure data consistency.
     */
    startPeriodicDataSync () {
        this.stopPeriodicDataSync();

        const interval = this.periodicDataSyncInterval;
        log.info(`Mesh V2: Starting periodic data sync timer (Interval: ${interval / 1000}s)`);
        this.dataSyncTimer = setInterval(() => {
            log.info('Mesh V2: Periodic data sync');
            this.fetchAllNodesData();
        }, interval);
    }

    /**
     * Stop periodic data synchronization.
     */
    stopPeriodicDataSync () {
        if (this.dataSyncTimer) {
            log.info('Mesh V2: Stopping periodic data sync timer');
            clearInterval(this.dataSyncTimer);
            this.dataSyncTimer = null;
        }
    }

    /**
     * Get all global scalar variables.
     * @returns {Array} Array of {key, value} objects.
     */
    getGlobalVariables () {
        const stage = this.runtime.getTargetForStage();
        if (!stage || !stage.variables) return [];

        const variables = [];
        for (const varId in stage.variables) {
            const currVar = stage.variables[varId];
            if (currVar.type === Variable.SCALAR_TYPE) {
                variables.push({
                    key: currVar.name,
                    value: String(currVar.value)
                });
            }
        }
        return variables;
    }

    /**
     * Send all global variables to other nodes in the group.
     * @returns {Promise<void>} A promise that resolves when variables are queued for sending.
     */
    async sendAllGlobalVariables () {
        if (!this.groupId || !this.client) return;

        const allVariables = this.getGlobalVariables();
        if (allVariables.length === 0) {
            log.info('Mesh V2: No global variables to send');
            return;
        }

        await this.sendData(allVariables);
        log.info(`Mesh V2: Sent ${allVariables.length} global variables`);
    }

    getRemoteVariable (name) {
        let latestValue = null;
        let latestTimestamp = 0;

        // Search across all nodes for the variable name
        for (const nodeId in this.remoteData) {
            if (Object.prototype.hasOwnProperty.call(this.remoteData[nodeId], name)) {
                const data = this.remoteData[nodeId][name];
                if (data.timestamp > latestTimestamp) {
                    latestTimestamp = data.timestamp;
                    latestValue = data.value;
                }
            }
        }
        return latestValue;
    }
}

module.exports = MeshV2Service;
