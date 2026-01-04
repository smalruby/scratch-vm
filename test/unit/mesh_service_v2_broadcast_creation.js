const test = require('tap').test;
const MeshV2Service = require('../../src/extensions/scratch3_mesh_v2/mesh-service');
const BlockUtility = require('../../src/engine/block-utility');
const Variable = require('../../src/engine/variable');

const createMockBlocks = stage => ({
    runtime: {
        sequencer: {},
        emit: () => {},
        on: () => {},
        off: () => {},
        getTargetForStage: () => stage,
        requestBlocksUpdate: () => {}
    },
    opcodeFunctions: {
        event_broadcast: () => {}
    }
});

const createMockStage = () => ({
    variables: {},
    lookupBroadcastMsg: function (id, name) {
        for (const varId in this.variables) {
            const v = this.variables[varId];
            if (v.type === Variable.BROADCAST_MESSAGE_TYPE && v.name === name) {
                return v;
            }
        }
        return null;
    },
    lookupBroadcastByInputValue: function (name) {
        for (const varId in this.variables) {
            const v = this.variables[varId];
            if (v.type === Variable.BROADCAST_MESSAGE_TYPE && v.name.toLowerCase() === name.toLowerCase()) {
                return v;
            }
        }
        return null;
    },
    createVariable: function (id, name, type) {
        const varId = id || `id-${name}`;
        this.variables[varId] = new Variable(varId, name, type);
    }
});

// Mock BlockUtility.lastInstance()
const originalLastInstance = BlockUtility.lastInstance;
const mockUtil = {
    sequencer: {}
};
BlockUtility.lastInstance = () => mockUtil;

test('MeshV2Service Broadcast Creation', t => {
    t.test('broadcastEvent creates missing broadcast message', st => {
        const stage = createMockStage();
        const blocks = createMockBlocks(stage);
        let broadcastArgs = null;
        blocks.opcodeFunctions.event_broadcast = args => {
            broadcastArgs = args;
        };

        const service = new MeshV2Service(blocks, 'node1', 'domain1');
        service.groupId = 'group1';

        const event = {
            name: 'new message',
            firedByNodeId: 'node2'
        };

        service.broadcastEvent(event);

        // Check if message was created
        const broadcastVar = stage.lookupBroadcastByInputValue('new message');
        st.ok(broadcastVar, 'Broadcast message should be created');
        st.equal(broadcastVar.name, 'new message');
        st.equal(broadcastVar.type, Variable.BROADCAST_MESSAGE_TYPE);
        st.equal(broadcastVar.isPersistent, true, 'Broadcast message should be persistent');

        // Check if opcode was called with the new ID
        st.ok(broadcastArgs, 'event_broadcast should be called');
        st.equal(broadcastArgs.BROADCAST_OPTION.name, 'new message');
        st.equal(broadcastArgs.BROADCAST_OPTION.id, broadcastVar.id);

        st.end();
    });

    t.test('broadcastEvent uses existing broadcast message (case-insensitive)', st => {
        const stage = createMockStage();
        const existingVar = new Variable('existing-id', 'Existing Message', Variable.BROADCAST_MESSAGE_TYPE);
        stage.variables['existing-id'] = existingVar;

        const blocks = createMockBlocks(stage);
        let broadcastArgs = null;
        blocks.opcodeFunctions.event_broadcast = args => {
            broadcastArgs = args;
        };

        const service = new MeshV2Service(blocks, 'node1', 'domain1');
        service.groupId = 'group1';

        const event = {
            name: 'existing message',
            firedByNodeId: 'node2'
        };

        service.broadcastEvent(event);

        // Check if opcode was called with the existing ID and canonical name
        st.ok(broadcastArgs, 'event_broadcast should be called');
        st.equal(broadcastArgs.BROADCAST_OPTION.id, 'existing-id', 'Should use existing variable ID');
        st.equal(broadcastArgs.BROADCAST_OPTION.name, 'Existing Message', 'Should use canonical name');
        st.equal(Object.keys(stage.variables).length, 1, 'Should not create duplicate variable');

        st.end();
    });

    t.tearDown(() => {
        BlockUtility.lastInstance = originalLastInstance;
    });

    t.end();
});
