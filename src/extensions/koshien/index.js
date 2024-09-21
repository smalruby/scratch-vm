import ArgumentType from '../../extension-support/argument-type';
import BlockType from '../../extension-support/block-type';
import TargetType from '../../extension-support/target-type';
import Variable from '../../engine/variable';
import Cast from '../../util/cast';

import KoshienClient from './koshien-client';
import Position from './position';
import Map from './map';
import {v4 as uuidv4} from 'uuid';
import log from '../../util/log';
import ConditionVariable from './condition-variable';

import blockIcon from './block-icon.png';
import translations from './translations.json';

let formatMessage = messageData => messageData.defaultMessage;

/**
 * Setup format-message for this extension.
 */
const setupTranslations = () => {
    const localeSetup = formatMessage.setup();
    if (localeSetup && localeSetup.translations[localeSetup.locale]) {
        Object.assign(
            localeSetup.translations[localeSetup.locale],
            translations[localeSetup.locale]
        );
    }
};

const EXTENSION_ID = 'koshien';

// プレイヤー名の最大長
const PLAYER_NAME_LIMIT = 14;

/**
 * Enum for item.
 * @readonly
 * @enum {string}
 */
const KoshienItemName = {
    DYNAMITE: 'dynamite',
    BOMB: 'bomb'
};

/**
 * Enum for coordinate.
 * @readonly
 * @enum {string}
 */
const KoshienCoordinateName = {
    POSITION: 'position',
    X: 'x',
    Y: 'y'
};

/**
 * Enum for target.
 * @readonly
 * @enum {string}
 */
const KoshienTargetName = {
    OTHER: 'other_player',
    ENEMY: 'enemy',
    GOAL: 'goal',
    PLAYER: 'player'
};

/**
 * Enum for object
 * @readonly
 * @enum {string}
 */
const KoshienObjectName = {
    UNKNOWN: 'unknown',
    SPACE: 'space',
    WALL: 'wall',
    STOREHOUSE: 'storehouse',
    GOAL: 'goal',
    WATER: 'water',
    BREAKABLE_WALL: 'breakable wall',
    TEA: 'tea',
    SWEETS: 'sweets',
    COIN: 'COIN',
    DOLPHIN: 'dolphin',
    SWORD: 'sword',
    POISON: 'poison',
    SNAKE: 'snake',
    TRAP: 'trap',
    BOMB: 'bomb'
};

const ConnectionStatus = {
    INITIAL: 'initial',
    CONNECTING: 'connecting',
    CONNECTED: 'connected'
};

/**
 * Scratch 3.0 blocks to make Smalruby Koshien AI.
 */
class KoshienBlocks {

    /**
     * A translation object which is used in this class.
     * @param {FormatObject} formatter - translation object
     */
    static set formatMessage (formatter) {
        formatMessage = formatter;
        if (formatMessage) setupTranslations();
    }

    /**
     * @return {string} - the name of this extension.
     */
    static get EXTENSION_NAME () {
        return formatMessage({
            id: 'koshien.name',
            default: 'Smalruby Koshien',
            description: 'name of the extension'
        });
    }

    /**
     * @return {string} - the ID of this extension.
     */
    static get EXTENSION_ID () {
        return EXTENSION_ID;
    }

    get ITEMS_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'koshien.itemsMenu.dynamite',
                    default: 'dynamite',
                    description: 'label for dynamite item in item picker for koshien extension'
                }),
                value: KoshienItemName.DYNAMITE
            },
            {
                text: formatMessage({
                    id: 'koshien.itemsMenu.bomb',
                    default: 'bomb',
                    description: 'label for bomb item in item picker for koshien extension'
                }),
                value: KoshienItemName.BOMB
            }
        ];
    }

    get TARGETS_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'koshien.targetsMenu.other',
                    default: 'other',
                    description: 'label for other player in target picker for koshien extension'
                }),
                value: KoshienTargetName.OTHER
            },
            {
                text: formatMessage({
                    id: 'koshien.targetsMenu.enemy',
                    default: 'enemy',
                    description: 'label for enemy in target picker for koshien extension'
                }),
                value: KoshienTargetName.ENEMY
            },
            {
                text: formatMessage({
                    id: 'koshien.targetsMenu.goal',
                    default: 'goal',
                    description: 'label for goal in target picker for koshien extension'
                }),
                value: KoshienTargetName.GOAL
            },
            {
                text: formatMessage({
                    id: 'koshien.targetsMenu.player',
                    default: 'player',
                    description: 'label for player in target picker for koshien extension'
                }),
                value: KoshienTargetName.PLAYER
            }
        ];
    }

    get COORDINATES_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'koshien.coordinatesMenu.x',
                    default: 'x',
                    description: 'label for x in coordinate picker for koshien extension'
                }),
                value: KoshienCoordinateName.X
            },
            {
                text: formatMessage({
                    id: 'koshien.coordinatesMenu.y',
                    default: 'y',
                    description: 'label for y in coordinate picker for koshien extension'
                }),
                value: KoshienCoordinateName.Y
            }
        ];
    }

    get COORDINATES_AND_POSITION_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'koshien.coordinatesMenu.position',
                    default: 'position',
                    description: 'label for position in coordinate picker for koshien extension'
                }),
                value: KoshienCoordinateName.POSITION
            }
        ].concat(this.COORDINATES_MENU);
    }

    get OBJECTS_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.unknown',
                    default: 'unknown',
                    description: 'label for unknown in object picker for koshien extension'
                }),
                value: KoshienObjectName.UNKNOWN
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.space',
                    default: 'space',
                    description: 'label for space in object picker for koshien extension'
                }),
                value: KoshienObjectName.SPACE
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.wall',
                    default: 'wall',
                    description: 'label for wall in object picker for koshien extension'
                }),
                value: KoshienObjectName.WALL
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.storehouse',
                    default: 'storehouse',
                    description: 'label for storehouse in object picker for koshien extension'
                }),
                value: KoshienObjectName.STOREHOUSE
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.goal',
                    default: 'goal',
                    description: 'label for goal in object picker for koshien extension'
                }),
                value: KoshienObjectName.GOAL
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.water',
                    default: 'water',
                    description: 'label for water in object picker for koshien extension'
                }),
                value: KoshienObjectName.WATER
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.breakableWall',
                    default: 'breakable wall',
                    description: 'label for breakable_wall in object picker for koshien extension'
                }),
                value: KoshienObjectName.BREAKABLE_WALL
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.tea',
                    default: 'tea',
                    description: 'label for tea in object picker for koshien extension'
                }),
                value: KoshienObjectName.TEA
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.sweets',
                    default: 'sweets',
                    description: 'label for sweets in object picker for koshien extension'
                }),
                value: KoshienObjectName.SWEETS
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.coin',
                    default: 'coin',
                    description: 'label for coin in object picker for koshien extension'
                }),
                value: KoshienObjectName.COIN
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.dolphin',
                    default: 'dolphin',
                    description: 'label for dolphin in object picker for koshien extension'
                }),
                value: KoshienObjectName.DOLPHIN
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.sword',
                    default: 'sword',
                    description: 'label for sword in object picker for koshien extension'
                }),
                value: KoshienObjectName.SWORD
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.poison',
                    default: 'poison',
                    description: 'label for poison in object picker for koshien extension'
                }),
                value: KoshienObjectName.POISON
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.snake',
                    default: 'snake',
                    description: 'label for snake in object picker for koshien extension'
                }),
                value: KoshienObjectName.SNAKE
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.trap',
                    default: 'trap',
                    description: 'label for trap in object picker for koshien extension'
                }),
                value: KoshienObjectName.TRAP
            },
            {
                text: formatMessage({
                    id: 'koshien.objectsMenu.bomb',
                    default: 'bomb',
                    description: 'label for bomb in object picker for koshien extension'
                }),
                value: KoshienObjectName.BOMB
            }
        ];
    }

    /**
     * Construct a set of Koshien blocks.
     * @param {Runtime} runtime - the Scratch 3.0 runtime.
     */
    constructor (runtime) {
        /**
         * The Scratch 3.0 runtime.
         * @type {Runtime}
         */
        this.runtime = runtime;

        if (runtime.formatMessage) {
            // Replace 'formatMessage' to a formatter which is used in the runtime.
            formatMessage = runtime.formatMessage;
        }

        this._koshienClient = new KoshienClient(this.runtime);

        this._isStarted = false;
        this._isConnected = false;
        this._connecting = new ConditionVariable();
        this._connecting.cancel('not started');

        this._playerName = 'player1';
        this._host = '127.0.0.1:3000';
        this._playerId = uuidv4();
        this._playerSide = 1;
        this._score = 0;
        this._requestCount = 0;
        this._moved = false;
        this._turn = 1;

        this._connectionStatus = ConnectionStatus.INITIAL;
        this._goal = new Position(null);
        this._myMap = new Map(null);
        this._x = null;
        this._y = null;
        this._otherPlayerPos = new Position(null);
        this._enemyPos = new Position(null);

        this.runtime.on('PROJECT_START', () => {
            this._isStarted = true;
            this._isConnected = false;

            this.runtime.startHats('koshien_connectGame');
        });
        this.runtime.on('PROJECT_STOP_ALL', () => {
            this._isConnected = false;
            this._isStarted = false;
        });
    }

    /**
     * @returns {object} metadata for this extension and its blocks.
     */
    getInfo () {
        setupTranslations();
        return {
            id: KoshienBlocks.EXTENSION_ID,
            name: KoshienBlocks.EXTENSION_NAME,
            blockIconURI: blockIcon,
            showStatusButton: false,
            blocks: [
                {
                    opcode: 'connectGame',
                    blockType: BlockType.HAT,
                    isEdgeActivated: false,
                    text: formatMessage({
                        id: 'koshien.connectGame',
                        default: 'connect game server with the player name [NAME]',
                        description: 'connect game server with the player name'
                    }),
                    arguments: {
                        NAME: {
                            type: ArgumentType.STRING,
                            defaultValue: 'player1'
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'getMapArea',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'koshien.getMapArea',
                        default: 'get map around [POSITION]',
                        description: 'get map information around position'
                    }),
                    arguments: {
                        POSITION: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'map',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'koshien.map',
                        default: 'map at [POSITION]',
                        description: 'map information at position'
                    }),
                    arguments: {
                        POSITION: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'moveTo',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'koshien.moveTo',
                        default: 'move to [POSITION]',
                        description: 'move to position'
                    }),
                    arguments: {
                        POSITION: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'calcGoalRoute',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'koshien.calcGoalRoute',
                        default: 'store shortest goal path to list: [RESULT]',
                        description: 'store shortest path between player and goal to list'
                    }),
                    arguments: {
                        RESULT: {
                            type: ArgumentType.STRING,
                            menu: 'listNames',
                            defaultValue: ' '
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'calcRoute',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'koshien.calcRoute',
                        // eslint-disable-next-line max-len
                        default: 'store shortest path (begin [SRC] end x: [DST] except list: [EXCEPT_CELLS]) to list: [RESULT]',
                        description: 'store shortest path between two points to list'
                    }),
                    arguments: {
                        SRC: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        },
                        DST: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        },
                        EXCEPT_CELLS: {
                            type: ArgumentType.STRING,
                            menu: 'listNames',
                            defaultValue: ' '
                        },
                        RESULT: {
                            type: ArgumentType.STRING,
                            menu: 'listNames',
                            defaultValue: ' '
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'setItem',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'koshien.setItem',
                        default: 'place a [ITEM] at [POSITION]',
                        description: 'place an item at position'
                    }),
                    arguments: {
                        ITEM: {
                            type: ArgumentType.STRING,
                            menu: 'itemMenu',
                            defaultValue: KoshienItemName.DYNAMITE
                        },
                        POSITION: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'mapFrom',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'koshien.mapFrom',
                        default: 'map at [POSITION] from [MAP]',
                        description: 'map information at position from variable'
                    }),
                    arguments: {
                        POSITION: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        },
                        MAP: {
                            type: ArgumentType.STRING,
                            menu: 'variableNames',
                            defaultValue: ' '
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'mapAll',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'koshien.mapAll',
                        default: 'all map',
                        description: 'all map information'
                    }),
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'locateObjects',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'koshien.locateObjects',
                        // eslint-disable-next-line max-len
                        default: 'store terrain and items within range (center [POSITION] range [SQ_SIZE] terrain/items [OBJECTS]) to list: [RESULT]',
                        description: 'store terrain and items within range to list'
                    }),
                    arguments: {
                        POSITION: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        },
                        SQ_SIZE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 5
                        },
                        OBJECTS: {
                            type: ArgumentType.STRING,
                            defaultValue: 'ABCD'
                        },
                        RESULT: {
                            type: ArgumentType.STRING,
                            menu: 'listNames',
                            defaultValue: ' '
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'targetCoordinate',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'koshien.targetCoordinate',
                        default: '[TARGET] of [COORDINATE]',
                        description: 'target of coordinate'
                    }),
                    arguments: {
                        TARGET: {
                            type: ArgumentType.STRING,
                            menu: 'targetMenu',
                            defaultValue: KoshienTargetName.OTHER
                        },
                        COORDINATE: {
                            type: ArgumentType.STRING,
                            menu: 'coordinateAndPositionMenu',
                            defaultValue: KoshienCoordinateName.POSITION
                        }
                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'turnOver',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'koshien.turnOver',
                        default: 'turn over',
                        description: 'turn over'
                    }),
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'position',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'koshien.position',
                        default: 'position [X] [Y]',
                        description: 'x and y convert to position'
                    }),
                    arguments: {
                        X: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        Y: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        }

                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'positionOf',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'koshien.positionOf',
                        default: '[POSITION] of [COORDINATE]',
                        description: 'position of coordinate'
                    }),
                    arguments: {
                        POSITION: {
                            type: ArgumentType.STRING,
                            defaultValue: '0:0'
                        },
                        COORDINATE: {
                            type: ArgumentType.STRING,
                            menu: 'coordinateMenu',
                            defaultValue: KoshienCoordinateName.X
                        }

                    },
                    filter: [TargetType.SPRITE]
                },
                {
                    opcode: 'object',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'koshien.object',
                        default: '[OBJECT]',
                        description: 'object of code'
                    }),
                    arguments: {
                        OBJECT: {
                            type: ArgumentType.STRING,
                            menu: 'objectMenu',
                            defaultValue: KoshienObjectName.UNKNOWN
                        }

                    },
                    filter: [TargetType.SPRITE]
                }
            ],
            menus: {
                variableNames: {
                    acceptReporters: false,
                    items: 'getVariableNamesMenuItems'
                },
                listNames: {
                    acceptReporters: false,
                    items: 'getListNamesMenuItems'
                },
                itemMenu: {
                    acceptReporters: false,
                    items: this.ITEMS_MENU
                },
                coordinateMenu: {
                    acceptReporters: false,
                    items: this.COORDINATES_MENU
                },
                coordinateAndPositionMenu: {
                    acceptReporters: false,
                    items: this.COORDINATES_AND_POSITION_MENU
                },
                targetMenu: {
                    acceptReporters: false,
                    items: this.TARGETS_MENU
                },
                objectMenu: {
                    acceptReporters: false,
                    items: this.OBJECTS_MENU
                }
            },
            translationMap: translations
        };
    }

    getVariableNamesMenuItems () {
        return this.getVariableOrListNamesMenuItems(Variable.SCALAR_TYPE);
    }

    getListNamesMenuItems () {
        return this.getVariableOrListNamesMenuItems(Variable.LIST_TYPE);
    }

    getVariableOrListNamesMenuItems (type) {
        const sprite = this.runtime.getEditingTarget();
        return [' '].concat(sprite.getAllVariableNamesInScopeByType(type));
    }

    /**
     * connect game server with the player name
     * @param {object} args - the block's arguments.
     * @param {string} args.NAME - name of the player.
     * @return {boolean} - true if the event raised.
     */
    // eslint-disable-next-line no-unused-vars
    connectGame (args) {
        if (!this._isStarted) return false;
        if (this._isConnected) return false;

        const playerName = Cast.toString(args.NAME);
        if (!playerName) {
            log.error(`プレイヤー名を付けてください（最大${PLAYER_NAME_LIMIT}文字まで）`);
            return false;
        }
        if (playerName.length > PLAYER_NAME_LIMIT) {
            log.error(`プレイヤー名が長すぎます（最大${PLAYER_NAME_LIMIT}文字までで命名してください）: ${playerName}`);
            return false;
        }

        this._koshienClient.playerName = playerName;
        this._koshienClient.playerId = uuidv4();
        this._koshienClient.playerSide = 1;

        this._connecting = new ConditionVariable();

        this._connectionStatus = ConnectionStatus.CONNECTING;
        this._koshienClient.connectGame()
            .then((result) => {
                this.updatePlayerInfo(result);
                this._isConnected = true;
                this._connecting.complete(true);
            })
            .catch((err) => {
                log.error(err);
                this._connecting.cancel(err);
            });
        return true;
    }

    /**
     * get map information around position
     * @param {object} args - the block's arguments.
     * @param {string} args.POSITION - position
     */
    // eslint-disable-next-line no-unused-vars
    getMapArea (args) {
        if (!this._isConnected) {
            // done の return で Promise を返さないといけないような気がする。
            return this._connecting.wait({ done: (success, error) => {
                if (error) {
                    log.error(error);
                }
                if (success) {
                    return this.getMapArea(args);
                }
                return Promise.resolve();
            }});
        }

        const position = new Position(Cast.toString(args.POSITION));
        return this._koshienClient.getMapArea({ x: position.x, y: position.y });
    }

    /**
     * map at position
     * @param {object} args - the block's arguments.
     * @param {string} args.POSITION - position.
     * @return {number} - map information.
     */
    // eslint-disable-next-line no-unused-vars
    map (args) {
        // wip
        return -1;
    }

    /**
     * move to x, y
     * @param {object} args - the block's arguments.
     * @param {number} args.POSITION - position.
     * @return {Promise} - promise
     */
    moveTo (args) {
        return new Promise(resolve => resolve());
    }

    /**
     * shortest path between player and goal
     * @param {object} args - the block's arguments.
     * @param {string} args.RESULT - result.
     * @return {Promise} - promise
     */
    // eslint-disable-next-line no-unused-vars
    calcGoalRoute (args) {
        // return this._client.calcRoute({result: args.RESULT});
    }

    /**
     * shortest path between two points
     * @param {object} args - the block's arguments.
     * @param {string} args.SRC - src.
     * @param {string} args.DST - dst.
     * @param {string} args.EXCEPT_CELLS - except cells.
     * @param {string} args.RESULT - result.
     * @return {Promise} - promise
     */
    // eslint-disable-next-line no-unused-vars
    calcRoute (args) {
        // return this._client.calcRoute(
        //    {src: args.SRC, dst: args.DST, exceptCells: args.EXCEPT_CELLS, result: args.RESULT}
        // );
    }

    /**
     * place an item at position
     * @param {object} args - the block's arguments.
     * @param {string} args.ITEM - item.
     * @param {string} args.POSITION - position.
          */
    // eslint-disable-next-line no-unused-vars
    setItem (args) {
        // wip
    }

    /**
     * map from location at position
     * @param {object} args - the block's arguments.
     * @param {string} args.MAP - map.
     * @param {string} args.POSITION - position.
     * @return {number} - map information.
     */
    // eslint-disable-next-line no-unused-vars
    mapFrom (args) {
        const map = new Map(Cast.toString(args.MAP));
        const position = new Position(Cast.toString(args.POSITION));
        return map.data(position);
    }

    /**
     * all map information
     */
    mapAll () {
        return this._myMap.toString();
    }

    /**
     * terrain and items within range
     * @param {object} args - the block's arguments.
     * @param {string} args.POSITION - position.
     * @param {number} args.SQ_SIZE - size.
     * @param {string} args.OBJECTS - item.
     * @param {string} args.RESULT - result.
     */
    // eslint-disable-next-line no-unused-vars
    locateObjects (args) {
        // wip
    }

    /**
     * target of coordinate
     * @param {object} args - the block's arguments.
     * @param {string} args.TARGET - target.
     * @param {string} args.COORDINATE - coordinate.
     */
    // eslint-disable-next-line no-unused-vars
    targetCoordinate (args) {
        const target = Cast.toString(args.TARGET);
        const coordinate = Cast.toString(args.COORDINATE);

        let targetPosition;
        switch (target) {
        case KoshienTargetName.ENEMY:
            targetPosition = this._enemyPos;
            break;
        case KoshienTargetName.GOAL:
            targetPosition = this._goal;
            break;
        case KoshienTargetName.PLAYER:
            targetPosition = new Position(this._x, this._y);
            break;
        case KoshienTargetName.OTHER:
            targetPosition = this._otherPlayerPos;
            break;
        default:
            log.error(`invalid target: ${args.TARGET}`);
            return null;
        }

        switch (coordinate) {
        case KoshienCoordinateName.POSITION:
            return targetPosition;
        case KoshienCoordinateName.X:
            return targetPosition.x;
        case KoshienCoordinateName.Y:
            return targetPosition.y;
        default:
            log.error(`invalid coordinate: ${args.COORDINATE}`);
            return null;
        }
    }

    /**
     * turn over
     */
    // eslint-disable-next-line no-unused-vars
    turnOver (args) {
        // wip
    }

    /**
     * x and y convert to position
     * @param {object} args - the block's arguments.
     * @param {number} args.X - x.
     * @param {number} args.Y - y.
     * @return {string} - position
     */
    // eslint-disable-next-line no-unused-vars
    position (args) {
        return `${args.X}:${args.Y}`;
    }

    /**
     * position of coordinate
     * @param {object} args - the block's arguments.
     * @param {string} args.POSITION - position.
     * @param {string} args.COORDINATE - coordinate.
     * @return {number} - position of x or y
     */
    positionOf (args) {
        const position = args.POSITION.split(':');
        return Number(args.COORDINATE === 'x' ? position[0] : position[1]);
    }

    /**
     * object of code
     * @param {object} args - the block's arguments.
     * @param {string} args.OBJECT - object.
     * @return {number} - object of code
     */
    object (args) {
        switch (args.OBJECT) {
        case KoshienObjectName.UNKNOWN:
            return -1;
        case KoshienObjectName.SPACE:
            return 0;
        case KoshienObjectName.WALL:
            return 1;
        case KoshienObjectName.STOREHOUSE:
            return 2;
        case KoshienObjectName.GOAL:
            return 3;
        case KoshienObjectName.WATER:
            return 4;
        case KoshienObjectName.BREAKABLE_WALL:
            return 5;
        case KoshienObjectName.TEA:
            return 'a';
        case KoshienObjectName.SWEETS:
            return 'b';
        case KoshienObjectName.COIN:
            return 'c';
        case KoshienObjectName.DOLPHIN:
            return 'd';
        case KoshienObjectName.SWORD:
            return 'e';
        case KoshienObjectName.POISON:
            return 'A';
        case KoshienObjectName.SNAKE:
            return 'B';
        case KoshienObjectName.TRAP:
            return 'C';
        case KoshienObjectName.BOMB:
            return 'D';
        default:
            return -1;
        }
    }

    updatePlayerInfo (info) {
        if (!info) return;

        if (Object.hasOwn(info, 'goal')) {
            this._goal = new Position(info.goal);
        }
        if (Object.hasOwn(info, 'map')) {
            this._myMap = new Map(info.map);
        }
        if (Object.hasOwn(info, 'x')) {
            this._x = info.x;
        }
        if (Object.hasOwn(info, 'y')) {
            this._y = info.y;
        }
        if (Object.hasOwn(info, 'other_player')) {
            this._otherPlayerPos = new Position(info.other_player);
        }
        if (Object.hasOwn(info, 'enemy')) {
            this._enemyPos = new Position(info.enemy);
        }
    }
}

export {
    KoshienBlocks as default,
    KoshienBlocks as blockClass
};
