import * as winston from "winston";
import * as WebSocket from "ws";
import * as amqplib from "amqplib";
import { SocketMessage } from "./SocketMessage";
import { Message, JSONfn } from "./Messages/Message";
import { User } from "./User";
import { DatabaseConnection, mapFunc, reduceFunc, finalizeFunc } from "./DatabaseConnection";
import { Config } from "./Config";
// import { amqp_consumer } from "./amqp_consumer";
import { QueueMessage } from "./Messages/QueueMessage";
import { QueryMessage } from "./Messages/QueryMessage";
import { MapReduceMessage } from "./Messages/MapReduceMessage";
import { InsertOneMessage } from "./Messages/InsertOneMessage";
import { UpdateOneMessage } from "./Messages/UpdateOneMessage";
import { DeleteOneMessage } from "./Messages/DeleteOneMessage";
import { Base } from "./base";
import { UpdateManyMessage } from "./Messages/UpdateManyMessage";
import { Util } from "./Util";
import { amqpwrapper, QueueMessageOptions } from "./amqpwrapper";

interface IHashTable<T> {
    [key: string]: T;
}
type QueuedMessageCallback = (msg: any) => any;
export class QueuedMessage {
    constructor(message: any, cb: QueuedMessageCallback) {
        this.id = message.id;
        this.message = message;
        this.cb = cb;
    }
    public cb: QueuedMessageCallback;
    public id: string;
    public message: any;
}
export class WebSocketClient {
    public jwt: string;
    public _logger: winston.Logger;
    private _socketObject: WebSocket;
    private _receiveQueue: SocketMessage[];
    private _sendQueue: SocketMessage[];
    public messageQueue: IHashTable<QueuedMessage> = {};
    public remoteip: string;
    public clientagent: string;
    public clientversion: string;


    user: User;
    // public consumers: amqp_consumer[] = [];
    private queues: IHashTable<string> = {};

    constructor(logger: winston.Logger, socketObject: WebSocket) {
        this._logger = logger;
        this._socketObject = socketObject;
        this._receiveQueue = [];
        this._sendQueue = [];
        if ((socketObject as any)._socket != undefined) {
            this.remoteip = (socketObject as any)._socket.remoteAddress;
        }
        logger.info("new client ");;
        socketObject.on("open", (e: Event): void => this.open(e));
        socketObject.on("message", (e: string): void => this.message(e)); // e: MessageEvent
        socketObject.on("error", (e: Event): void => this.error(e));
        socketObject.on("close", (e: CloseEvent): void => this.close(e));
    }
    private open(e: Event): void {
        this._logger.info("WebSocket connection opened " + e);
    }
    private close(e: CloseEvent): void {
        this._logger.info("WebSocket connection closed " + e);
    }
    private error(e: Event): void {
        this._logger.error("WebSocket error encountered " + e);
    }
    private message(message: string): void { // e: MessageEvent
        try {
            //this._logger.silly("WebSocket message received " + message);
            let msg: SocketMessage = SocketMessage.fromjson(message);
            this._logger.silly("WebSocket message received id: " + msg.id + " index: " + msg.index + " count: " + msg.count);
            this._receiveQueue.push(msg);
            this.ProcessQueue();
        } catch (error) {
            this._logger.error("WebSocket error encountered " + error.message);
            var errormessage: Message = new Message(); errormessage.command = "error"; errormessage.data = error.message;
            this._socketObject.send(JSON.stringify(errormessage));
        }
    }
    public async CloseConsumers(): Promise<void> {
        var keys = Object.keys(this.queues);
        for (let i = 0; i < keys.length; i++) {
            try {
                await this.CloseConsumer(keys[i]);
            } catch (error) {
                this._logger.error("WebSocketclient::closeconsumers " + error);
            }
        }
    }
    public async Close(): Promise<void> {
        await this.CloseConsumers();
        if (this._socketObject != null) {
            try {
                this._socketObject.close();
            } catch (error) {
                this._logger.error("WebSocketclient::Close " + error);
            }
        }
    }
    public async CloseConsumer(queuename: string): Promise<void> {
        if (this.queues[queuename] != null) {
            try {
                await amqpwrapper.Instance().RemoveQueueConsumer(queuename);
                delete this.queues[queuename];
            } catch (error) {
                this._logger.error("WebSocketclient::CloseConsumer " + error);
            }
        }
    }
    public async CreateConsumer(queuename: string): Promise<string> {
        var autoDelete: boolean = false; // Should we keep the queue around ? for robots and roles
        if (Util.IsNullEmpty(queuename)) {
            if (this.clientagent == "nodered") {
                queuename = "nodered." + Math.random().toString(36).substr(2, 9); autoDelete = true;
            } else if (this.clientagent == "webapp") {
                queuename = "webapp." + Math.random().toString(36).substr(2, 9); autoDelete = true;
            } else if (this.clientagent == "web") {
                queuename = "web." + Math.random().toString(36).substr(2, 9); autoDelete = true;
            } else {
                queuename = "unknown." + Math.random().toString(36).substr(2, 9); autoDelete = true;
            }
        }
        var AssertQueueOptions: any = new Object(amqpwrapper.Instance().AssertQueueOptions);
        AssertQueueOptions.autoDelete = autoDelete;
        var queuename = await amqpwrapper.Instance().AddQueueConsumer(queuename, AssertQueueOptions, this.jwt, async (msg: any, options: QueueMessageOptions, ack: any, done: any) => {
            var _data = msg;
            try {
                _data = await this.Queue(msg, queuename, options);
                ack();
                done(_data);
            } catch (error) {
                setTimeout(() => {
                    ack(false);
                    // ack(); // just eat the error 
                    done(_data);
                    if (error.message != null && error.message != "") {
                        console.log(queuename + " failed message queue message, nack and re queue message: ", error.message);
                    } else {
                        console.log(queuename + " failed message queue message, nack and re queue message: ", error);
                    }
                }, Config.amqp_requeue_time);
            }
        });
        this.queues[queuename] = queuename;
        return queuename;
    }
    sleep(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms)
        })
    }
    public ping(): boolean {
        try {
            let msg: SocketMessage = SocketMessage.fromcommand("ping");
            if (this._socketObject.readyState === this._socketObject.CLOSED
                || this._socketObject.readyState === this._socketObject.CLOSING) {
                this.CloseConsumers();
                return false;
            }
            this._socketObject.send(msg.tojson());
            return true;
        } catch (error) {
            this._logger.error("WebSocketclient::WebSocket error encountered " + error);
            this._receiveQueue = [];
            this._sendQueue = [];
            this.CloseConsumers();
            return false;
        }
    }
    private ProcessQueue(): void {
        let username: string = "Unknown";
        if (!Util.IsNullUndefinded(this.user)) { username = this.user.username; }
        let ids: string[] = [];
        this._receiveQueue.forEach(msg => {
            if (ids.indexOf(msg.id) === -1) { ids.push(msg.id); }
        });
        ids.forEach(id => {
            var msgs: SocketMessage[] = this._receiveQueue.filter(function (msg: SocketMessage): boolean { return msg.id === id; });
            if (this._receiveQueue.length > Config.websocket_max_package_count) {
                this._logger.error("_receiveQueue containers more than " + Config.websocket_max_package_count + " messages for id '" + id + "' so discarding all !!!!!!!");
                this._receiveQueue = this._receiveQueue.filter(function (msg: SocketMessage): boolean { return msg.id !== id; });
            }
            var first: SocketMessage = msgs[0];
            if (first.count === msgs.length) {
                msgs.sort((a, b) => a.index - b.index);
                if (msgs.length === 1) {
                    this._receiveQueue = this._receiveQueue.filter(function (msg: SocketMessage): boolean { return msg.id !== id; });
                    var singleresult: Message = Message.frommessage(first, first.data);
                    singleresult.Process(this);
                } else {
                    var buffer: string = "";
                    msgs.forEach(msg => {
                        if (!Util.IsNullUndefinded(msg.data)) { buffer += msg.data; }
                    });
                    this._receiveQueue = this._receiveQueue.filter(function (msg: SocketMessage): boolean { return msg.id !== id; });
                    var result: Message = Message.frommessage(first, buffer);
                    result.Process(this);
                }
            } else {
                // this._logger.debug("[" + username + "] WebSocketclient::ProcessQueue receiveQueue: Cannot process i have " + msgs.length + " out of " + first.count + " for message " + first.id);
            }
        });
        this._sendQueue.forEach(msg => {
            let id: string = msg.id;
            try {
                this._socketObject.send(JSON.stringify(msg));
            } catch (error) {
                this._logger.error("WebSocket error encountered " + error);
            }
            this._sendQueue = this._sendQueue.filter(function (msg: SocketMessage): boolean { return msg.id !== id; });
        });
        // if (this._receiveQueue.length > 25 || this._sendQueue.length > 25) {
        //     this._logger.debug("[" + username + "] WebSocketclient::ProcessQueue receiveQueue: " + this._receiveQueue.length + " sendQueue: " + this._sendQueue.length);
        // }
    }
    public async Send<T>(message: Message): Promise<T> {
        return new Promise<T>(async (resolve, reject) => {
            this._Send(message, ((msg) => {
                if (!Util.IsNullUndefinded(msg.error)) { return reject(msg.error); }
                resolve(msg);
            }).bind(this));
        });
    }
    private _Send(message: Message, cb: QueuedMessageCallback): void {
        var messages: string[] = this.chunkString(message.data, 500);
        if (Util.IsNullUndefinded(messages) || messages.length === 0) {
            var singlemessage: SocketMessage = SocketMessage.frommessage(message, "", 1, 0);
            if (Util.IsNullEmpty(message.replyto)) {
                this.messageQueue[singlemessage.id] = new QueuedMessage(singlemessage, cb);
            }
            this._sendQueue.push(singlemessage);
            return;
        }
        if (Util.IsNullEmpty(message.id)) { message.id = Math.random().toString(36).substr(2, 9); }
        for (let i: number = 0; i < messages.length; i++) {
            var _message: SocketMessage = SocketMessage.frommessage(message, messages[i], messages.length, i);
            this._sendQueue.push(_message);
        }
        if (Util.IsNullEmpty(message.replyto)) {
            this.messageQueue[message.id] = new QueuedMessage(message, cb);
        }
        // setTimeout(() => {
        //     this.ProcessQueue();
        // }, 500);
        this.ProcessQueue();
    }
    public chunkString(str: string, length: number): string[] {
        if (Util.IsNullEmpty(str)) { return null; }
        // tslint:disable-next-line: quotemark
        return str.match(new RegExp('.{1,' + length + '}', 'g'));
    }
    async Queue(data: string, queuename: string, options: QueueMessageOptions): Promise<any[]> {
        var d: any = JSON.parse(data);
        var q: QueueMessage = new QueueMessage();
        if (this.clientversion == "1.0.80.0" || this.clientversion == "1.0.81.0" || this.clientversion == "1.0.82.0" || this.clientversion == "1.0.83.0" || this.clientversion == "1.0.84.0" || this.clientversion == "1.0.85.0") {
            q.data = d.payload;
        } else {
            q.data = d;
        }
        // q.data = d.payload; 
        q.replyto = options.replyTo;
        q.error = d.error;
        q.correlationId = options.correlationId; q.queuename = queuename;
        q.consumerTag = options.consumerTag;
        q.routingkey = options.routingkey;
        q.exchange = options.exchange;

        let m: Message = Message.fromcommand("queuemessage");
        if (Util.IsNullEmpty(q.correlationId)) { q.correlationId = m.id; }
        m.data = JSON.stringify(q);
        q = await this.Send<QueueMessage>(m);
        if ((q as any).command == "error") throw new Error(q.data);
        return q.data;
    }

    async Query<T extends Base>(collection: string, query: any, projection: any = null, orderby: any = { _created: -1 }, top: number = 500, skip: number = 0): Promise<any[]> {
        var q: QueryMessage<T> = new QueryMessage<T>();
        q.collectionname = collection; q.query = query;
        q.projection = projection; q.orderby = orderby; q.top = top; q.skip = skip;
        var msg: Message = new Message(); msg.command = "query"; msg.data = JSON.stringify(q);
        q = await this.Send<QueryMessage<T>>(msg);
        return q.result;
    }
    async MapReduce(collection: string, map: mapFunc, reduce: reduceFunc, finalize: finalizeFunc, query: any, out: string | any, scope: any): Promise<any> {
        var q: MapReduceMessage<any> = new MapReduceMessage(map, reduce, finalize, query, out);
        q.collectionname = collection; q.scope = scope;
        var msg: Message = new Message(); msg.command = "mapreduce"; q.out = out;
        msg.data = JSONfn.stringify(q);
        q = await this.Send<MapReduceMessage<any>>(msg);
        return q.result;
    }
    async Insert<T extends Base>(collection: string, model: any): Promise<any> {
        var q: InsertOneMessage<T> = new InsertOneMessage();
        q.collectionname = collection; q.item = model;
        var msg: Message = new Message(); msg.command = "insertone"; msg.data = JSONfn.stringify(q);
        q = await this.Send<InsertOneMessage<T>>(msg);
        return q.result;
    }
    async Update<T extends Base>(collection: string, model: any): Promise<any> {
        var q: UpdateOneMessage<T> = new UpdateOneMessage();
        q.collectionname = collection; q.item = model;
        var msg: Message = new Message(); msg.command = "updateone"; msg.data = JSONfn.stringify(q);
        q = await this.Send<UpdateOneMessage<T>>(msg);
        return q.result;
    }
    async UpdateMany<T extends Base>(collection: string, query: any, document: any): Promise<any> {
        var q: UpdateManyMessage<T> = new UpdateManyMessage();
        q.collectionname = collection; q.item = document; q.query = query;
        var msg: Message = new Message(); msg.command = "updateone"; msg.data = JSONfn.stringify(q);
        q = await this.Send<UpdateManyMessage<T>>(msg);
        return q.result;
    }
    async Delete(collection: string, id: any): Promise<void> {
        var q: DeleteOneMessage = new DeleteOneMessage();
        q.collectionname = collection; q._id = id;
        var msg: Message = new Message(); msg.command = "deleteone"; msg.data = JSON.stringify(q);
        q = await this.Send<DeleteOneMessage>(msg);
    }


}