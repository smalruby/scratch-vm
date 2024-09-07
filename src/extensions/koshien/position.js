/**
 * Position = x:y
 */
class Position {
    constructor (xOrPosition = null, y = null) {
        if (xOrPosition instanceof Position) {
            this._x = xOrPosition.x;
            this._y = xOrPosition.y;
        } else if (typeof xOrPosition === 'string') {
            [this._x, this._y] = xOrPosition.split(':').map((s) => Number(s));
        } else if (xOrPosition instanceof Array) {
            [this._x, this._y] = xOrPosition;
        } else {
            this._x = xOrPosition === null ? null : Number(xOrPosition);
            this._y = y === null ? null : Number(y);
        }
    }

    set x (value) {
        this._x = value;
    }

    get x () {
        return this._x;
    }

    set y (value) {
        this._y = value;
    }

    get y () {
        return this._y;
    }

    toString () {
        if (this._x === null || this._x === undefined || this._y === null || this._y === undefined) return '';

        return `${this._x}:${this._y}`;
    }

    toArray () {
        return [this._x, this._y];
    }

    equals (xOrPosition = null, y = null) {
        let otherX;
        let otherY;
        if (xOrPosition instanceof Position) {
            otherX = xOrPosition.x;
            otherY = xOrPosition.y;
        } else if (typeof xOrPosition === 'string') {
            [otherX, otherY] = xOrPosition.split(':').map((s) => Number(s));
        } else if (xOrPosition instanceof Array) {
            [otherX, otherY] = xOrPosition;
        } else {
            otherX = xOrPosition === null ? null : Number(xOrPosition);
            otherY = y === null ? null : Number(y);
        }
        return this._x === otherX && this._y === otherY;
    }
}

export default Position;
