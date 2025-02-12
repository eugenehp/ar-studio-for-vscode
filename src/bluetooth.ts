import { receiveRawData } from "./repl";
import { replHandleResponse,onDisconnect } from "./repl";
import { nordicDfuHandleControlResponse } from './nordicdfu.js';
var util = require('util');
let device:any = null;
var bluetooth = require('./ble/index').webbluetooth;
let nordicDfuControlCharacteristic:any = null;
let nordicDfuPacketCharacteristic:any = null;
const nordicDfuServiceUuid = 0xfe59;
const nordicDfuControlCharacteristicUUID = '8ec90001-f315-4f60-9fb8-838830daea50';
const nordicDfuPacketCharacteristicUUID = '8ec90002-f315-4f60-9fb8-838830daea50';

let replRxCharacteristic:any = null;
let replTxCharacteristic:any = null;
const replDataServiceUuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const replRxCharacteristicUuid = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const replTxCharacteristicUuid = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let rawDataRxCharacteristic:any = null;
let rawDataTxCharacteristic = null;
const rawDataServiceUuid = "e5700001-7bac-429a-b4ce-57ff900f479d";
const rawDataRxCharacteristicUuid = "e5700002-7bac-429a-b4ce-57ff900f479d";
const rawDataTxCharacteristicUuid = "e5700003-7bac-429a-b4ce-57ff900f479d";

export const replDataTxQueue = [];
export const rawDataTxQueue = [];

let replTxTaskIntervalId:any = null;
let replDataTxInProgress = false;
let rawDataTxInProgress = false;

// Web-Bluetooth doesn't have any MTU API, so we just set it to something reasonable
const maxmtu:any = 100;

export function isConnected() {

    if (device && device.gatt.connected) {
        return true;
    }

    return false;
}

export async function connect() {

    if (!bluetooth) {
        return Promise.reject("This browser doesn't support WebBluetooth. " +
            "Make sure you're on Chrome Desktop/Android or BlueFy iOS.")
    }
        setTimeout(()=>{
            bluetooth.cancelRequest();
            if(!isConnected()){
                onDisconnect();
                console.log("couldn't find device");
            }

        },10000);
        device = await bluetooth.requestDevice({
            filters: [
                { services: [replDataServiceUuid] },
                { services: [nordicDfuServiceUuid] },
            ],
            optionalServices: [rawDataServiceUuid]
        });
    // }

    const server = await device.gatt.connect();
    device.addEventListener('gattserverdisconnected', disconnect);
    const nordicDfuService = await server.getPrimaryService(nordicDfuServiceUuid)
        .catch(() => { });
    const replService = await server.getPrimaryService(replDataServiceUuid)
        .catch((err:any) => { console.log(err); });
    const rawDataService = await server.getPrimaryService(rawDataServiceUuid)
        .catch(() => { });

    if (nordicDfuService) {
        nordicDfuControlCharacteristic = await nordicDfuService.getCharacteristic(nordicDfuControlCharacteristicUUID);
        nordicDfuPacketCharacteristic = await nordicDfuService.getCharacteristic(nordicDfuPacketCharacteristicUUID);
        await nordicDfuControlCharacteristic.startNotifications();
        nordicDfuControlCharacteristic.addEventListener('characteristicvaluechanged', receiveNordicDfuControlData);
        return Promise.resolve("dfu connected");
    }

    if (replService) {
        replRxCharacteristic = await replService.getCharacteristic(replRxCharacteristicUuid);
        replTxCharacteristic = await replService.getCharacteristic(replTxCharacteristicUuid);
        await replTxCharacteristic.startNotifications();
        replTxCharacteristic.addEventListener('characteristicvaluechanged', receiveReplData);
        replTxTaskIntervalId = setInterval(transmitReplData);
    }

    
    if (rawDataService) {
        rawDataRxCharacteristic = await rawDataService.getCharacteristic(rawDataRxCharacteristicUuid);
        rawDataTxCharacteristic = await rawDataService.getCharacteristic(rawDataTxCharacteristicUuid);
        await rawDataTxCharacteristic.startNotifications();
        rawDataTxCharacteristic.addEventListener('characteristicvaluechanged', receiveRawData);
    }
    return Promise.resolve("repl connected");
}

export async function disconnect() {

    if (device && device.gatt.connected) {
        await device.gatt.disconnect();
    }

    // Stop transmitting data
    clearInterval(replTxTaskIntervalId);

    // Callback to main.js
    onDisconnect();
}

function receiveNordicDfuControlData(event:any) {
    nordicDfuHandleControlResponse(event.target.value);
}

export async function transmitNordicDfuControlData(bytes:any) {
    await nordicDfuControlCharacteristic.writeValue(new Uint8Array(bytes));
}

export async function transmitNordicDfuPacketData(bytes:any) {
    await nordicDfuPacketCharacteristic.writeValueWithoutResponse(new Uint8Array(bytes));
}

function receiveReplData(event:any) {
    // console.log(event);
    // Decode the byte array into a UTF-8 string
    const decoder = new util.TextDecoder('utf-8');

    replHandleResponse(decoder.decode(event.target.value));
}

async function transmitReplData() {

    if (replDataTxInProgress === true) {
        return;
    }

    if (replDataTxQueue.length === 0) {
        return;
    }

    replDataTxInProgress = true;

    const payload = replDataTxQueue.slice(0, maxmtu);

    await replRxCharacteristic.writeValueWithoutResponse(new Uint8Array(payload))
        .then(() => {
            replDataTxQueue.splice(0, payload.length);
            replDataTxInProgress = false;
            return;
        })
        .catch((error:any) => {
            if (error === "NetworkError: GATT operation already in progress.") {
                // Ignore busy errors. Just wait and try again later
            }
            else {
                // Discard data on other types of error
                replDataTxQueue.splice(0, payload.length);
                replDataTxInProgress = false;
                return Promise.reject(error);
            }
        });

}

