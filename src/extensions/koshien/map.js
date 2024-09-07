/**
 * Map information
 */
class Map {
    // Square
    static UNKNOWN = -1; // 未探索
    static UNKNOWN_ALIAS = '-'; // 未探索の1文字表現
    static SPACE = 0; // 空間
    static WALL = 1; // 壁
    static STOREHOUSE = 2; // 蔵
    static GOAL = 3; // ゴール
    static WATER = 4; // 水たまり
    static BREAKABLE_WALL = 5; // 壊せる壁

    // Point-added items
    static TEA = 'a'; // お茶
    static SWEETS = 'b'; // 和菓子
    static COIN = 'c'; // 丁銀
    static DOLPHIN = 'd'; // シロイルカ
    static SWORD = 'e'; // 草薙剣

    // Demerit item
    static POISON = 'A'; // 毒キノコ
    static SNEAK = 'B'; // 蛇
    static TRAP = 'C'; // トラバサミ
    static BOMB = 'D'; // 爆弾

    static SIZE = 15;

    constructor (map) {
        if (typeof map === 'string') {
            this._map = map.split(',').map((x) => x.split('').map((xy) => {
                if (xy === this.UNKNOWN_ALIAS) {
                    return this.UNKNOWN;
                }
                if (/[0-9]/.test(xy)) {
                    return Number(xy);
                }
                return xy;
            }));
        } else if (map instanceof Array) {
            this._map = map;
        } else {
            this._map = new Array(this.SIZE);
            for (let i = 0; i < this._map.length; i++) {
                this._map[i] = new Array(this.SIZE).fill(this.UNKNOWN);
            }
        }
    }

    data (position) {
        if (!this._map) return -1;

        return this._map[position.y][position.x];
    }

    toString () {
        if (this._map === null || this._map === undefined) return '';

        return this._map.map((x) => x.map((xy) => xy === this.UNKNOWN ? this.UNKNOWN_ALIAS : xy.toString()).join(''))
            .join(',');
    }

    toArray () {
        return this._map;
    }
}

export default Map;
