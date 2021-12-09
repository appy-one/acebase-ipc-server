export interface ISubscription {
    unsubscribe(): any
}
export interface IObserver<T> {
    next(value: T): any
    start?(subscription: ISubscription): void
    error?(error: any): any
    complete?(value: any): void
}
type CleanupFunction = () => any;
type CreateFunction<T> = (observer: IObserver<T>) => CleanupFunction;
type SubscribeFunction<T> = (value: T) => any;
export interface IObservableLike<T> {
    subscribe(subscriber: SubscribeFunction<T>): ISubscription
}

/**
 * Very basic Observable implementation
 * @example
 * // Create an observable for messages received through a websocket
 * const messageObservable = new SimpleObservable(observer => {
 *  const ws = new WebSocket('ws://myserver/connect');
 *  ws.addEventListener('message', event => {
 *      observer.next(event.data);
 *  })
 *  return function cleanup() {
 *      ws.close();
 *  }
 * });
 * 
 * // Subscribe to received messages:
 * const subscription = messageObservable.subscribe(msg => {
 *  console.log(`Received message:`, msg)
 * });
 * 
 * // Stop subscription:
 * subscription.unsubscribe();
 */
 export class SimpleObservable<T> implements IObservableLike<T> {
    private _active: boolean = false;
    private _create: CreateFunction<T>;
    private _cleanup?: CleanupFunction;
    private _subscribers: SubscribeFunction<T>[] = [];
    constructor (create: CreateFunction<T>) {
        this._create = create;
    }
    subscribe(subscriber: SubscribeFunction<T>) {
        if (!this._active) {
            const next = (value: T) => {
                // emit value to all subscribers
                this._subscribers.forEach(s => {
                    try { s(value); }
                    catch(err) { console.error(`Error in subscriber callback:`, err); }
                });
            }
            const observer:IObserver<T> = { next };
            this._cleanup = this._create(observer);
            this._active = true;
        }
        this._subscribers.push(subscriber);
        const unsubscribe = () => {
            this._subscribers.splice(this._subscribers.indexOf(subscriber), 1);
            if (this._subscribers.length === 0) {
                this._active = false;
                this._cleanup && this._cleanup();
            }
        }
        const subscription:ISubscription = {
            unsubscribe
        };
        return subscription;
    }
}