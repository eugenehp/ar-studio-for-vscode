import { isConnected, replDataTxQueue,connect,disconnect } from './bluetooth';
import { checkForUpdates, startFirmwareUpdate, startFpgaUpdate } from "./update";
import { writeEmitter,updateStatusBarItem,outputChannel,updatePublishStatus } from './extension';
import { startNordicDFU } from './nordicdfu'; 
import * as vscode from 'vscode';
import { resolve } from 'path';
import { time, timeEnd } from 'console';
let util = require('util');
let cursorPosition = 0;
let replRawModeEnabled = false;
let rawReplResponseString = '';
let rawReplResponseCallback:any;
let fileWriteStart = false;
let internalOperation = false;
const decoder = new util.TextDecoder('utf-8');
const RESET_CMD = '\x03\x04';
const FILE_WRITE_MAX = 1000000;
let DIR_MAKE_CMD = `import os
def md(p):
    c=""
    for d in p.split("/"):
        c += "/"+d
        try:
            os.mkdir(c)
        except:
            pass
`;
export async function replRawMode(enable:boolean) {

    if (enable === true) {
        replRawModeEnabled = true;
        outputChannel.appendLine("Entering raw REPL mode");
        await replSend('\x03\x01');
        return;
    }

     outputChannel.appendLine("Leaving raw REPL mode");
    await replSend('\x03\x02');
    replRawModeEnabled = false;
    
}

export async function replSend(string:string) {

    ensureConnected();
    // Strings will be thrown away if not connected
    if (!isConnected()) {
        return;
    }

    if (replRawModeEnabled) {

        // If string contains printable characters, append Ctrl-D
        if (/[\x20-\x7F]/.test(string)) {
            string += '\x04';
        }
        
        outputChannel.appendLine('Raw REPL ⬆️: ' +
        string
            .replaceAll('\n', '\\n')
            .replaceAll('\x01', '\\x01')
            .replaceAll('\x02', '\\x02')
            .replaceAll('\x03', '\\x03')
            .replaceAll('\x04', '\\x04'));

    }

    // Encode the UTF-8 string into an array and populate the buffer
    const encoder = new util.TextEncoder('utf-8');
    replDataTxQueue.push.apply(replDataTxQueue, encoder.encode(string));

    // Return a promise which calls a function that'll eventually run when the
    // response handler calls the function associated with rawReplResponseCallback
    return new Promise(resolve => {
        rawReplResponseCallback = function (responseString:string) {
            outputChannel.appendLine('Raw REPL ⬇️: ' + responseString.replaceAll('\r\n', '\\r\\n'));
            resolve(responseString);
        };
        setTimeout(() => {
            resolve(null);
        }, 5000);
    });
}

let initializedWorkspace = false;
export async function ensureConnected() {
    
    if (isConnected() === true) {
        return;
    }
    updateStatusBarItem("progress");
    try {
        let connectionResult = await connect();

        if (connectionResult === "dfu connected") {
            // infoText.innerHTML = "Starting firmware update..";
            updateStatusBarItem("connected","$(cloud-download) Updating");
            await startNordicDFU()
                .catch((error) => {
                    console.log(error);
                    disconnect();
                    throw Error("Bluetooth error. Reconnect or check console for details");
                });
            await disconnect();
            vscode.window.showInformationMessage("Firmware Update done");
            updateStatusBarItem("progress");
            // after 2 sec try to connect;
            setTimeout(ensureConnected,2000);
            
            // return;
        }

        if (connectionResult === "repl connected") {
            updatePublishStatus();
            // infoText.innerHTML = "Connected";
            // replResetConsole();
            vscode.commands.executeCommand('setContext', 'monocle.deviceConnected', true);
                // writeEmitter.fire("Connected\r\n");
                updateStatusBarItem("connected");
               let updateInfo = await checkForUpdates();
           
            if(!initializedWorkspace){
                // setupWorkSpace();
                // initializedWorkspace = true;
            }
           
            // console.log(updateInfo);
            if (updateInfo !== "") {
                let newFirmware = updateInfo?.includes('New firmware');
                let newFpga = updateInfo?.includes('New FPGA');
                let items:string[] =["Update Now","Later"] ;
                const updateMsg = new vscode.MarkdownString(updateInfo);
               
                if(newFirmware){
                    vscode.window.showInformationMessage(updateMsg.value,...items).then(op=>{
                        if(op==="Update Now"){
                            // if(newFirmware){
                             startFirmwareUpdate();
                            // }else if(newFpga){
                                // triggerFpgaUpdate();
                            // }
                        }
                    });
                }else if(newFpga){
                    vscode.commands.executeCommand('setContext', 'monocle.fpgaAvailable', newFpga);
                }else{
                    vscode.window.showInformationMessage(updateMsg.value);
                }
            }
            await vscode.commands.executeCommand('workbench.actions.treeView.fileExplorer.refresh');
            let allTerminals = vscode.window.terminals.filter(ter=>ter.name==='REPL');
            if(allTerminals.length>0){
                allTerminals[0].show();
                vscode.commands.executeCommand('workbench.action.terminal.clear');
                
            }  
            await replSend('\x02'); 
        }
    }

    catch (error:any) {
        // Ignore User cancelled errors
        if (error.message && error.message.includes("cancelled")) {
            return;
        }
        // infoText.innerHTML = error;
        // console.error(error);
        updateStatusBarItem("Disconnected");
    }
}

export function replHandleResponse(string:string) {

    if (replRawModeEnabled === true) {

        // Combine the string until it's ready to handle
        rawReplResponseString += string;

        // Once the end of response '>' is received, run the callbacks
        if (string.endsWith('>') || string.endsWith('>>> ')) {
            rawReplResponseCallback(rawReplResponseString);
            rawReplResponseString = '';
        }

        // Don't show these strings on the console
        return;
    }
    if(fileWriteStart){
    writeEmitter.fire(string.slice(string.indexOf('>>>')));
        return;
    }
    if(internalOperation){
        return;
    }
    writeEmitter.fire(string);
}

export async function sendFileUpdate(update:any){
    // console.log(JSON.stringify(update));
    if(replRawModeEnabled){
        vscode.window.showInformationMessage("Device Busy");
        return [];
    }
    fileWriteStart = true;
    await replRawMode(true);
    let response:any = await replSend(decoder.decode(update));
    // replDataTxQueue.push.apply(replDataTxQueue,update);
    if(response!==null && typeof(response)!=='undefined'){
        let textToEcho =response.slice(response.indexOf('OK')+2,response.indexOf('>'));
        if(typeof textToEcho!=='undefined' || textToEcho!==null){
            writeEmitter.fire("\r\n"+textToEcho);
        }
    }
    replRawModeEnabled = false;
    await replRawMode(false);
    fileWriteStart  = false;
  
}
export function onDisconnect() {
    
    vscode.commands.executeCommand('setContext', 'monocle.deviceConnected', false);
    updateStatusBarItem("disconnected");
	writeEmitter.fire("Disconnected \r\n");
}

export function reportUpdatePercentage(perc:number){
    updateStatusBarItem("updating", perc.toFixed(2));
    
}
export function receiveRawData(data:any){
    console.log(data);
}

export async function triggerFpgaUpdate(binPath?:vscode.Uri){
    updateStatusBarItem("connected","$(cloud-download) Updating");
    await startFpgaUpdate(binPath).catch(err=>{
        vscode.window.showErrorMessage(err);
    });
    vscode.window.showInformationMessage("FPGA Update done");
    updateStatusBarItem("connected");
}

//  close the file operation and raw mode
async function exitRawReplInternal(){
    await replRawMode(false);
    internalOperation = false;
}

//  enter raw repl for file operation
async function enterRawReplInternal(){
    if (!isConnected()) {
        return false;
    }
    //  check if already a file operation going on
    if(replRawModeEnabled || internalOperation){
        await new Promise(r => {
            let interval = setInterval(()=>{
                if(!replRawModeEnabled && !internalOperation){
                    setTimeout(()=>{
                        r("");
                    },10);
                    clearInterval(interval);
                }
            },10);
        });
    }
    internalOperation = true;
    await replRawMode(true);
    await new Promise(r => setTimeout(r, 10));
    return true;
}

// list files and folders for the device under given path
export async function listFilesDevice(currentPath="/"):Promise<string[]>{

    if(!await enterRawReplInternal()){return[];};
    let cmd = `import os,ujson;
d="${currentPath}"
l =[]
if os.stat(d)[0] & 0x4000:
    for f in os.ilistdir(d):
        if f[0] not in ('.', '..'):
            l.append({"name":f[0],"file":not f[1] & 0x4000})
print(ujson.dumps(l))
del(os,l,d)`;
    let response:any = await replSend(cmd);

    await exitRawReplInternal();

    if(response){
        try{
            let strList = response.slice(response.indexOf('OK')+2,response.indexOf('\r\n\x04'));
            strList = JSON.parse(strList);
            // strList.push('main.py');
            return strList;
        }catch(error:any){
            outputChannel.appendLine(error);
            return [];
        }
    }
    return [];
}

//  create directory recursively
export async function createDirectoryDevice(devicePath:string):Promise<boolean>{
   
    if(!await enterRawReplInternal()){return false;};
    let dirMakeCmd = DIR_MAKE_CMD+`md('${devicePath}');del(md,os)`;
    let response:any = await replSend(dirMakeCmd);
    await exitRawReplInternal();
    if(response && !response.includes("Error")){
        return true;
    }
    return false;
}

//  upload files recursively to device
export async function uploadFileBulkDevice(uris:vscode.Uri[], devicePath:string):Promise<boolean>{
    
    if(!await enterRawReplInternal()){return false;};
    let dirMakeCmd = DIR_MAKE_CMD+`md('${devicePath}')`;
    await replSend(dirMakeCmd);

    await new Promise((res,rej)=>{
        uris.forEach(async (uri:vscode.Uri,index:number)=>{
            let absPath = uri.path.replaceAll("\\","/");
            let dPath = absPath.slice(absPath.indexOf(devicePath));
            let segments = dPath.split('/');
            let fileWriteCmd = "";
            if(segments.length>1){
                let newDirTocreate = segments.slice(0,segments.length-1).join("/");
                if(newDirTocreate!==devicePath){
                    fileWriteCmd += `md('${newDirTocreate}')\n`;
                }
            }
            let fileData = await vscode.workspace.fs.readFile(uri);
    
            if(fileData.byteLength===0){
                fileWriteCmd += "f = open('"+ devicePath +"', 'w');f.write('');f.close()";
                 let response:any = await replSend(fileWriteCmd);
                 if(response &&  response.includes("Error")){
                    vscode.window.showInformationMessage('File Transfer failed for '+uri.path);
                };
            }
            if(fileData.byteLength<=FILE_WRITE_MAX){
                fileWriteCmd +=`f=open('${dPath}', 'w');f.write('''${decoder.decode(fileData)}''');f.close()`;
                let response:any = await replSend(fileWriteCmd);
               
                if(response &&  response.includes("Error")){
                    vscode.window.showInformationMessage('File Transfer failed for '+uri.path);
                };
            }else{   
                vscode.window.showInformationMessage('Please keep files smaller. Meanwhile we are wroking to allow larger files :'+uri.path);
        
            }
            if(index===(uris.length-1)){
                res("");
            }
        });
       
    });
    await replSend("del(md,os,f)");
    await replSend(RESET_CMD);
    await exitRawReplInternal();
    return true;
}
//  create or update individual file on device
export async function creatUpdateFileDevice(uri:vscode.Uri, devicePath:string):Promise<boolean>{
    
    if(!await enterRawReplInternal()){return false;};
    let absPath = uri.path.replaceAll("\\","/");
    let dPath = absPath.slice(absPath.indexOf(devicePath));
    let segments = dPath.split('/');
    if(segments.length>1){
        let newDirTocreate = segments.slice(0,segments.length-1).join("/");
            if(newDirTocreate!==devicePath){
                let dirCreate = DIR_MAKE_CMD+`md('${newDirTocreate}');del(os,md)`;
                    await replSend(dirCreate);
            }
    }
    let fileData = await vscode.workspace.fs.readFile(uri);

    if(fileData.byteLength===0){
         let response:any = await replSend("f = open('"+ devicePath +"', 'w');f.write('');f.close()");
        await exitRawReplInternal();
        if(response &&  !response.includes("Error")){return true;};
    }
    if(fileData.byteLength<=FILE_WRITE_MAX){
        // TODO: transfer files in chunks once file size  bug is fixed over firmware
        // if file size less write in one attempt
        // attempt to write larger file
        // let asciiFile =Buffer.from(fileData).toString('base64');
        // await replSend('import ubinascii, bluetooth');
        // let response:any = await replSend(`f=open('${devicePath}', 'w');print(bluetooth.max_length())`);
        // const maxMtu = parseInt(response.match(/\d/g).join(''), 10);
        // let chunksize = (Math.floor(Math.floor((maxMtu - 100) / 3) / 4) * 4 * 3);
        // let chunks = Math.ceil(asciiFile.length / chunksize);
        // outputChannel.appendLine("Chunk size = " + chunksize + ". Total chunks = " + chunks);

        // for (let chk = 0; chk < chunks; chk++) {
        //     response = await replSend("f.write(ubinascii.a2b_base64('" +
        //         asciiFile.slice(chk * chunksize, (chk * chunksize) + chunksize)
        //         + "'))");
    
        //     if (response && response.includes("Error")) {
        //         outputChannel.appendLine("Retrying this chunk");
        //         chk--;
        //     }else if(response===null){
        //         return  Promise.reject("Not responding");
        //     }
        //     await replSend("f.close();f = open('"+devicePath+"','a')");
        // }
        // response = await replSend("f.close();del(f,ubinascii,bluetooth)");
        let response:any = await replSend(`f=open('${devicePath}', 'w');f.write('''${decoder.decode(fileData)}''');f.close()`);
        await replSend(RESET_CMD);
        await exitRawReplInternal();
        if(response &&  !response.includes("Error")){return true;};
    }else{
        await exitRawReplInternal();
        vscode.window.showInformationMessage('Please keep files smaller. Meanwhile we are wroking to allow larger files');
        return false;
    }
    
    return false;
}
//  rename or move files and folders on device
export async function renameFileDevice(oldDevicePath:string, newDevicePath:string):Promise<boolean>{
    
    if(!await enterRawReplInternal()){return false;};

    let cmd = `import os;
os.rename('${oldDevicePath}','${newDevicePath}'); del(os)`;
    let response:any = await replSend(cmd);
    await replSend(RESET_CMD);
    await exitRawReplInternal();
    if(response &&  !response.includes("Error")){return true;};
    return false;
}

//  reading a individual file data from device
export async function readFileDevice(devicePath:string):Promise<boolean|string>{
   
    if(!await enterRawReplInternal()){return false;};

    let cmd = `f=open('${devicePath}');print(f.read());f.close();del(f)`;
    let response:any = await replSend(cmd);
    await exitRawReplInternal();
    if(response &&  !response.includes("Error")){return response.slice(response.indexOf('OK')+2,response.indexOf('\r\n\x04'));};
    return false;
}

//  delete files/directory recursively from device
export async function deleteFilesDevice(devicePath:string):Promise<boolean>{

    if(!await enterRawReplInternal()){return false;};

    let cmd = `import os;
def rm(d):
    try:
        if os.stat(d)[0] & 0x4000:
            for f in os.ilistdir(d):
                if f[0] not in ('.', '..'):
                    rm("/".join((d, f[0])))
            os.rmdir(d)
        else:
            os.remove(d)
    except Exception as e:
        print("rm of '%s' failed" % d,e)
rm('${devicePath}'); del(os);del(rm)`;
    let response:any = await replSend(cmd);
    await replSend(RESET_CMD);
    await exitRawReplInternal();
    if(response &&  !response.includes("failed")){return true;};
    return false;
}

// handle data from terminal input 
export async function terminalHandleInput(data:string){
    if(replRawModeEnabled || internalOperation){
        await new Promise(r => {
            let interval = setInterval(()=>{
                if(!replRawModeEnabled && !internalOperation){
                    setTimeout(()=>{
                        r("");
                    },10);
                    clearInterval(interval);
                }
            },10);
        });
    }
    replSend(data);
}
