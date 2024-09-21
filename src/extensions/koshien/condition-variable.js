class ConditionVariable {
    constructor () {
        let _resolve, _reject;
        this._promise = new Promise((resolve, reject) => {
            _resolve = resolve;
            _reject = reject;
        });

        this._resolve = _resolve;
        this._reject = _reject;
        this._timer = null;
    }

    async wait ({ done, timeout = 0 }) {
        this._startTimer(timeout);

        return this._promise.then(value => {
            this._stopTimer();
            return done(value, null);
        }).catch(value => {
            this._stopTimer();
            return done(null, value);
        });
    }

    complete (value) {
        this._resolve(value);
    }

    cancel (value) {
        this._reject(value);
    }

    _startTimer (timeout) {
        if (timeout > 0) {
            this._timer = setTimeout(self => { self.cancel('timeout'); }, timeout, this);
        }
    }

    _stopTimer () {
        if (this._timer) {
            clearTimeout(this._timer);
        }
    }
}

export default ConditionVariable;
