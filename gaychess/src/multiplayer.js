import { COMPATIBILITY_ID, MULTIPLAYER_PROTOCOL } from './version.js?v=4';

const SIGNAL_KEY='gc';
const ICE_SERVERS=[{urls:'stun:stun.cloudflare.com:3478'}];

function bytesToBase64(bytes){
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=0x8000)
    binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function base64ToBytes(value){
  const padded=value.replaceAll('-','+').replaceAll('_','/')+'==='.slice((value.length+3)%4);
  const binary=atob(padded),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}

export function encodeSignal(payload){
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeSignal(value){
  const payload=JSON.parse(new TextDecoder().decode(base64ToBytes(value)));
  if(!payload||payload.protocol!==MULTIPLAYER_PROTOCOL||!['offer','answer'].includes(payload.kind))
    throw new Error('This is not a supported Gay Chess connection link.');
  if(typeof payload.gameId!=='string'||typeof payload.compatibility!=='string'||!payload.description?.sdp)
    throw new Error('The Gay Chess connection link is incomplete.');
  return payload;
}

export function signalFromUrl(input,base='https://example.invalid/'){
  const trimmed=input.trim();
  if(!trimmed)return null;
  let token=trimmed;
  try{
    const url=new URL(trimmed,base);
    token=new URLSearchParams(url.hash.slice(1)).get(SIGNAL_KEY)||trimmed;
  }catch{}
  if(token.startsWith('#'))token=new URLSearchParams(token.slice(1)).get(SIGNAL_KEY)||token;
  return decodeSignal(token);
}

export function shareUrl(payload,currentUrl=location.href){
  const url=new URL(currentUrl);url.search='';url.hash=`${SIGNAL_KEY}=${encodeSignal(payload)}`;return url.href;
}

export function newGameId(){
  if(crypto.randomUUID)return crypto.randomUUID();
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(18)));
}

export function compatible(payload){return payload.compatibility===COMPATIBILITY_ID}

export async function historyHash(history){
  const data=new TextEncoder().encode(history.join(' '));
  const digest=await crypto.subtle.digest('SHA-256',data);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function waitForIceGathering(peer,timeout=15000){
  if(peer.iceGatheringState==='complete')return Promise.resolve();
  return new Promise(resolve=>{
    const timer=setTimeout(done,timeout);
    function done(){clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',changed);resolve()}
    function changed(){if(peer.iceGatheringState==='complete')done()}
    peer.addEventListener('icegatheringstatechange',changed);
  });
}

export class MultiplayerPeer{
  constructor({role,gameId,onOpen,onMessage,onState}){
    this.role=role;this.gameId=gameId;this.onOpen=onOpen;this.onMessage=onMessage;this.onState=onState;
    this.peer=new RTCPeerConnection({iceServers:ICE_SERVERS});this.channel=null;
    this.peer.onconnectionstatechange=()=>this.onState?.(this.peer.connectionState);
    if(role==='guest')this.peer.ondatachannel=event=>this.bindChannel(event.channel);
  }

  bindChannel(channel){
    this.channel=channel;
    channel.onopen=()=>this.onOpen?.();
    channel.onclose=()=>this.onState?.('closed');
    channel.onerror=()=>this.onState?.('failed');
    channel.onmessage=event=>{
      try{this.onMessage?.(JSON.parse(event.data))}
      catch{this.onState?.('invalid-message')}
    };
  }

  async createOffer(){
    this.bindChannel(this.peer.createDataChannel('gaychess',{ordered:true}));
    await this.peer.setLocalDescription(await this.peer.createOffer());
    await waitForIceGathering(this.peer);
    return this.payload('offer',this.peer.localDescription);
  }

  async acceptOffer(description){
    await this.peer.setRemoteDescription(description);
    await this.peer.setLocalDescription(await this.peer.createAnswer());
    await waitForIceGathering(this.peer);
    return this.payload('answer',this.peer.localDescription);
  }

  async acceptAnswer(description){await this.peer.setRemoteDescription(description)}

  payload(kind,description){
    return {protocol:MULTIPLAYER_PROTOCOL,kind,gameId:this.gameId,compatibility:COMPATIBILITY_ID,description};
  }

  send(message){
    if(this.channel?.readyState!=='open')throw new Error('The friend connection is not open.');
    this.channel.send(JSON.stringify(message));
  }

  close(){
    try{this.channel?.close()}catch{}
    try{this.peer.close()}catch{}
  }
}
