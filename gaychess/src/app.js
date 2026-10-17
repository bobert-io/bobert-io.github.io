import { MultiplayerPeer, compatible, historyHash, newGameId, shareUrl, signalFromUrl } from './multiplayer.js?v=4';
import { FILES, START_FEN, kingCount, parseFen, pieceImage, squareName, uciParts } from './position.js?v=3';
import { APP_BUILD, COMPATIBILITY_ID, ENGINE_ASSET_ID } from './version.js?v=4';

const $=selector=>document.querySelector(selector);
const boardEl=$('#board'),statusEl=$('#statusText'),moveList=$('#moveList'),undo=$('#undo'),level=$('#level'),side=$('#side');
const multiplayerDialog=$('#multiplayerDialog'),gameOverDialog=$('#gameOverDialog');
let position=parseFen(START_FEN),history=[],snapshots=[],legalUcis=[],selected=null;
let thinking=false,loading=true,engineError=null,engineStatus='ongoing',gameEpoch=0,toastTimer=null;
let announcedResult=null;
let engineWorker=null,requestSequence=0,mode='computer',localColor='w',online=null;
const engineRequests=new Map();
const signalBus=typeof BroadcastChannel==='function'?new BroadcastChannel('gaychess-signaling-v1'):null;

function disposeEngine(error=new Error('Fairy-Stockfish stopped')){
  if(engineWorker)engineWorker.terminate();
  engineWorker=null;
  for(const pending of engineRequests.values()){clearTimeout(pending.timer);pending.reject(error)}
  engineRequests.clear();
}

function ensureEngine(){
  if(engineWorker)return engineWorker;
  const worker=new Worker(new URL('./fairy-worker.js?v=8',import.meta.url));
  worker.onmessage=({data})=>{
    const pending=engineRequests.get(data.id);if(!pending)return;
    clearTimeout(pending.timer);engineRequests.delete(data.id);
    if(data.error)pending.reject(new Error(data.error));else pending.resolve(data);
  };
  worker.onerror=event=>disposeEngine(event.error||new Error(event.message||'Fairy-Stockfish worker failed'));
  engineWorker=worker;return worker;
}

function engineRequest(action,payload={},timeout=15000){
  return new Promise((resolve,reject)=>{
    const id=++requestSequence,worker=ensureEngine();
    const timer=setTimeout(()=>disposeEngine(new Error('Fairy-Stockfish timed out')),timeout);
    engineRequests.set(id,{resolve,reject,timer});worker.postMessage({id,action,...payload});
  });
}

function legalParts(){return legalUcis.map(uciParts).filter(Boolean)}
function movesFromSelected(){
  if(!selected)return [];
  return legalParts().filter(move=>move.from[0]===selected[0]&&move.from[1]===selected[1]);
}

function winnerText(){
  if(engineStatus==='draw')return 'Draw';
  if(engineStatus==='ongoing')return null;
  const winningSide=engineStatus==='win'?position.turn:(position.turn==='w'?'b':'w');
  return `${winningSide==='w'?'White':'Black'} wins`;
}

function render(){
  boardEl.innerHTML='';
  const choices=movesFromSelected(),last=uciParts(history.at(-1));
  const flipped=localColor==='b';
  for(let displayRow=0;displayRow<8;displayRow++)for(let displayCol=0;displayCol<8;displayCol++){
    const r=flipped?7-displayRow:displayRow,c=flipped?7-displayCol:displayCol;
    const piece=position.board[r][c],square=document.createElement('button');
    square.className=`square ${(r+c)%2?'dark':'light'}`;
    square.dataset.r=r;square.dataset.c=c;square.setAttribute('role','gridcell');
    if(selected?.[0]===r&&selected?.[1]===c)square.classList.add('selected');
    if(last&&(last.from[0]===r&&last.from[1]===c||last.to[0]===r&&last.to[1]===c))square.classList.add('last');
    const target=choices.find(move=>move.to[0]===r&&move.to[1]===c);
    if(target)square.classList.add('legal',piece?'capture':'quiet');
    if(piece){
      const image=document.createElement('img');image.className=`piece piece-${piece.type} ${piece.color==='w'?'white':'black'}`;
      image.crossOrigin='anonymous';image.src=pieceImage(piece.color,piece.type);image.alt='';
      image.draggable=piece.color===localColor&&position.turn===localColor&&canInteract();
      image.ondragstart=event=>startDrag(r,c,event);image.ondragend=()=>render();square.append(image);
      square.setAttribute('aria-label',`${piece.color==='w'?'White':'Black'} ${piece.type} on ${squareName(r,c)}`);
    }
    if(displayCol===0){const label=document.createElement('i');label.className='coord rank';label.textContent=8-r;square.append(label)}
    if(displayRow===7){const label=document.createElement('i');label.className='coord file';label.textContent=FILES[c];square.append(label)}
    square.onclick=()=>clickSquare(r,c);
    square.ondragover=event=>{if(choices.some(move=>move.to[0]===r&&move.to[1]===c))event.preventDefault()};
    square.ondrop=event=>dropPiece(r,c,event);boardEl.append(square);
  }
  renderPlayers();renderMoves();renderStatus();renderControls();renderGameOver();
}

function renderPlayers(){
  const bottom=localColor,top=bottom==='w'?'b':'w';
  $('#topAvatarImage').src=pieceImage(top,'k');$('#bottomAvatarImage').src=pieceImage(bottom,'k');
  $('#topAvatar').className=`avatar ${top==='w'?'light':'dark'}`;$('#bottomAvatar').className=`avatar ${bottom==='w'?'light':'dark'}`;
  $('#topPlayerName').textContent=mode==='computer'?'Fairy-Stockfish':'Friend';
  $('#topPlayerMeta').textContent=mode==='computer'?`${level.options[level.selectedIndex].text} · ${top==='w'?'White':'Black'}`:`${top==='w'?'White':'Black'} · Peer-to-peer`;
  $('#bottomPlayerMeta').textContent=bottom==='w'?'White':'Black';
  renderLives(top,'#topLives');renderLives(bottom,'#bottomLives');
}

function renderLives(color,selector){
  const count=kingCount(position,color),root=$(selector);root.innerHTML='';root.setAttribute('aria-label',`${color==='w'?'White':'Black'} kings remaining`);
  for(let i=0;i<2;i++){
    const image=document.createElement('img');image.crossOrigin='anonymous';image.src=pieceImage(color,'k');image.alt='';
    if(i>=count)image.className='lost';root.append(image);
  }
}

function renderMoves(){
  if(!history.length){moveList.innerHTML='<p class="empty">Make the first move.</p>';return}
  moveList.innerHTML='';
  for(let i=0;i<history.length;i+=2){
    const number=document.createElement('span');number.className='move-number';number.textContent=`${i/2+1}.`;moveList.append(number);
    for(let offset=0;offset<2;offset++){
      const move=document.createElement('span');move.className='move';move.textContent=history[i+offset]||'';moveList.append(move);
    }
  }
  moveList.scrollTop=moveList.scrollHeight;
}

function renderStatus(){
  if(engineError){statusEl.textContent='Engine unavailable — play cannot continue';return}
  if(online?.error){statusEl.textContent=online.error;return}
  if(loading){statusEl.textContent='Asking Fairy-Stockfish for the position…';return}
  if(winnerText()){statusEl.textContent=winnerText();return}
  if(mode==='online'){
    if(!online?.connected){statusEl.textContent=online?.connectionState==='connecting'?'Connecting to friend…':'Waiting for friend…';return}
    statusEl.textContent=position.turn===localColor?'Your move — click or drag':'Friend’s move';return;
  }
  if(thinking){statusEl.textContent='Fairy-Stockfish is thinking…';return}
  if(selected){statusEl.textContent='Choose a highlighted square';return}
  statusEl.textContent=position.turn===localColor?'Your move — click or drag':'Engine’s move';
}

function renderControls(){
  $('#engineStrength').hidden=mode==='online';
  $('#computerSide').hidden=mode==='online';
  $('#playFriend').textContent=mode==='online'?'Connection details':'Play a friend';
  undo.disabled=mode==='online'||thinking||loading||snapshots.length===0;
}

function renderGameOver(){
  if(loading||engineError)return;
  if(engineStatus==='ongoing'){announcedResult=null;return}
  const resultKey=`${history.length}:${position.fen}:${engineStatus}`;
  if(announcedResult===resultKey)return;
  announcedResult=resultKey;
  let title=winnerText(),reason;
  if(engineStatus==='draw'){
    title='Draw';
    if(legalUcis.length===0)reason='Draw by stalemate — the player to move has no legal move.';
    else if(position.halfmove>=100)reason='Draw by the fifty-move rule.';
    else reason='Draw by threefold repetition.';
  }else{
    const winner=title.startsWith('White')?'White':'Black',loser=winner==='White'?'Black':'White';
    reason=kingCount(position,loser==='White'?'w':'b')===0
      ? `Both ${loser} kings have been captured.`
      : `${loser} has no legal move that can save a king.`;
  }
  $('#gameOverTitle').textContent=title;$('#gameOverReason').textContent=reason;
  setTimeout(()=>{if(!gameOverDialog.open)gameOverDialog.showModal()},0);
}

async function refreshState(epoch){
  const result=await engineRequest('state',{moves:history});
  if(epoch!==gameEpoch)return false;
  if(result.assetId!==ENGINE_ASSET_ID)throw new Error('Cached engine build does not match this app. Reload the page.');
  position=parseFen(result.fen);legalUcis=result.moves;engineStatus=result.status;
  loading=false;engineError=null;render();return true;
}

function canInteract(){
  if(thinking||loading||engineError||engineStatus!=='ongoing'||position.turn!==localColor)return false;
  return mode==='computer'||Boolean(online?.connected&&!online.error);
}

async function clickSquare(r,c){
  if(!canInteract())return;
  const choices=movesFromSelected().filter(move=>move.to[0]===r&&move.to[1]===c);
  if(choices.length){const move=choices.length>1?await pickPromotion(choices):choices[0];if(move)await playerMove(move.uci);return}
  selected=position.board[r][c]?.color===localColor?[r,c]:null;render();
}

function startDrag(r,c,event){
  if(!canInteract()||position.board[r][c]?.color!==localColor){event.preventDefault();return}
  selected=[r,c];event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',squareName(r,c));render();
}

async function dropPiece(r,c,event){
  event.preventDefault();
  const choices=movesFromSelected().filter(move=>move.to[0]===r&&move.to[1]===c);
  if(!choices.length){selected=null;render();return}
  const move=choices.length>1?await pickPromotion(choices):choices[0];if(move)await playerMove(move.uci);
}

function pickPromotion(moves){
  return new Promise(resolve=>{
    const picker=$('#promotionPicker'),box=picker.querySelector('div');box.innerHTML='';picker.hidden=false;
    for(const move of moves){
      const button=document.createElement('button'),image=document.createElement('img');
      image.crossOrigin='anonymous';image.src=pieceImage(localColor,move.promotion);image.alt=move.promotion;
      button.append(image);button.onclick=()=>{picker.hidden=true;resolve(move)};box.append(button);
    }
  });
}

async function playerMove(uci){
  if(!canInteract()||!legalUcis.includes(uci))return;
  if(mode==='online'){await onlineLocalMove(uci);return}
  await computerPlayerMove(uci);
}

async function computerPlayerMove(uci){
  const epoch=gameEpoch;snapshots.push(history.slice());history.push(uci);selected=null;legalUcis=[];loading=true;render();
  try{
    if(!await refreshState(epoch)||engineStatus!=='ongoing')return;
    await computerMove(epoch);
  }catch(error){handleEngineFailure(error,epoch)}
}

async function computerMove(epoch){
  thinking=true;render();
  const movetime={1:400,2:1500,3:5000}[Number(level.value)]||1500;
  const result=await engineRequest('best',{moves:history,movetime},movetime+15000);
  if(epoch!==gameEpoch)return;
  if(!result.uci||!legalUcis.includes(result.uci))throw new Error('Fairy-Stockfish returned an illegal move');
  history.push(result.uci);legalUcis=[];thinking=false;loading=true;render();await refreshState(epoch);
}

async function onlineLocalMove(uci){
  const epoch=gameEpoch,session=online;history.push(uci);selected=null;legalUcis=[];loading=true;render();
  try{
    if(!await refreshState(epoch)||session!==online)return;
    session.peer.send({type:'move',gameId:session.gameId,ply:history.length,uci,fen:position.fen,status:engineStatus,historyHash:await historyHash(history)});
  }catch(error){failOnline(`Connection stopped: ${error.message}`)}
}

async function receiveRemoteMove(message){
  const session=online;if(!session?.connected||session.error)return;
  const remoteColor=localColor==='w'?'b':'w';
  if(message.gameId!==session.gameId||message.ply!==history.length+1)throw new Error('Move number mismatch');
  if(position.turn!==remoteColor||typeof message.uci!=='string'||!legalUcis.includes(message.uci))throw new Error('Friend sent an illegal move');
  const epoch=gameEpoch;history.push(message.uci);selected=null;legalUcis=[];loading=true;render();
  if(!await refreshState(epoch)||session!==online)return;
  const digest=await historyHash(history);
  if(message.fen!==position.fen||message.status!==engineStatus||message.historyHash!==digest)
    throw new Error('Game state mismatch — both boards were stopped');
}

function handleEngineFailure(error,epoch){
  if(epoch!==gameEpoch)return;
  thinking=false;loading=false;engineError=error;disposeEngine(error);render();console.error(error);
}

function makePeer(session){
  return new MultiplayerPeer({
    role:session.role,gameId:session.gameId,
    onOpen:()=>{
      if(online!==session)return;
      session.connectionState='connecting';
      session.peer.send({type:'hello',gameId:session.gameId,compatibility:COMPATIBILITY_ID,role:session.role});render();
    },
    onMessage:message=>{
      if(online!==session)return;
      session.messageQueue=session.messageQueue.then(()=>handlePeerMessage(session,message)).catch(error=>failOnline(error.message));
    },
    onState:state=>{
      if(online!==session||session.closing)return;
      session.connectionState=state;
      if(state==='failed'||state==='invalid-message')failOnline('Friend connection failed');
      else if(state==='closed')failOnline('Friend disconnected',false);
      else{
        if(state==='disconnected')session.connected=false;
        if(state==='connected'&&session.handshakeComplete)session.connected=true;
        render();
      }
    }
  });
}

async function handlePeerMessage(session,message){
  if(message?.type==='hello'){
    if(message.gameId!==session.gameId||message.compatibility!==COMPATIBILITY_ID||message.role===session.role)
      throw new Error('Friend is using an incompatible Gay Chess build');
    session.handshakeComplete=true;session.connected=true;session.connectionState='connected';multiplayerDialog.close();render();showToast('Friend connected');return;
  }
  if(message?.type==='move'){await receiveRemoteMove(message);return}
  throw new Error('Friend sent an unsupported message');
}

function closeOnline(){
  if(!online)return;
  online.closing=true;online.peer?.close();online=null;
}

function failOnline(message,close=true){
  if(!online)return;
  online.error=message;online.connected=false;
  if(close){online.closing=true;online.peer?.close()}
  loading=false;render();showToast(message);
}

async function initializeBoard(){
  const epoch=++gameEpoch;disposeEngine();history=[];snapshots=[];position=parseFen(START_FEN);legalUcis=[];selected=null;
  thinking=false;loading=true;engineError=null;engineStatus='ongoing';announcedResult=null;$('#promotionPicker').hidden=true;
  if(gameOverDialog.open)gameOverDialog.close();render();
  try{return await refreshState(epoch)}catch(error){handleEngineFailure(error,epoch);return false}
}

async function startComputer(){
  closeOnline();mode='computer';localColor=side.value==='random'?(crypto.getRandomValues(new Uint8Array(1))[0]&1?'w':'b'):side.value;multiplayerDialog.close();
  if(!await initializeBoard())return;
  showToast(`New game — you’re ${localColor==='w'?'White':'Black'}`);
  if(localColor==='b'){
    const epoch=gameEpoch;
    try{await computerMove(epoch)}catch(error){handleEngineFailure(error,epoch)}
  }
}

async function beginHost(){
  if(!await requireCurrentBuild())return;
  closeOnline();mode='online';localColor='w';
  const session=online={role:'host',gameId:newGameId(),connected:false,connectionState:'gathering network details',messageQueue:Promise.resolve(),offerLink:null};
  if(!await initializeBoard()||online!==session)return;
  try{
    session.peer=makePeer(session);showMultiplayer({title:'Creating invitation…',message:'Gathering direct connection details. This can take a few seconds.'});
    const offer=await session.peer.createOffer();if(online!==session)return;
    session.offerLink=shareUrl(offer);
    showMultiplayer({title:'Invite a friend',message:'Send this link to your friend, then keep this tab open. They will send an answer link back.',link:session.offerLink,answer:true,note:'The link contains WebRTC connection details, which can include your public IP address. Game traffic is encrypted and peer-to-peer.'});
    render();
  }catch(error){failOnline(`Could not create invitation: ${error.message}`)}
}

async function joinOffer(payload){
  if(!await requireCurrentBuild())return;
  if(!compatible(payload)){showVersionMismatch();return}
  closeOnline();mode='online';localColor='b';multiplayerDialog.close();
  const session=online={role:'guest',gameId:payload.gameId,connected:false,connectionState:'creating answer',messageQueue:Promise.resolve(),answerLink:null};
  if(!await initializeBoard()||online!==session)return;
  try{
    session.peer=makePeer(session);
    const answer=await session.peer.acceptOffer(payload.description);if(online!==session)return;
    session.answerLink=shareUrl(answer);
    showMultiplayer({title:'Send the answer back',message:'Send this return link to White and keep this tab open. The game starts when they apply it.',link:session.answerLink,note:'If White opens the link on the same browser as the original invitation tab, it is delivered automatically. They can also paste it there.'});
    render();
  }catch(error){failOnline(`Could not join invitation: ${error.message}`)}
}

async function applyAnswerPayload(payload){
  if(!online||online.role!=='host'||payload.kind!=='answer'||payload.gameId!==online.gameId)throw new Error('This answer belongs to a different invitation.');
  if(!compatible(payload))throw new Error('Your friend is using a different Gay Chess build. Both players must reload.');
  await online.peer.acceptAnswer(payload.description);online.connectionState='connecting';
  showMultiplayer({title:'Connecting…',message:'Answer accepted. Waiting for the encrypted peer-to-peer channel to open.'});render();
}

function showVersionMismatch(){
  showMultiplayer({title:'Different game versions',message:'This invitation was created by a different Gay Chess build. Both players should reload the site, then create a new invitation.',note:'Incompatible engines are blocked before a game starts so the boards cannot silently fall out of sync.'});
}

async function requireCurrentBuild(){
  try{
    const url=new URL('version.json',document.baseURI);url.searchParams.set('check',Date.now());
    const response=await fetch(url,{cache:'no-store'});if(!response.ok)return true;
    const latest=await response.json();
    if(latest.appBuild===APP_BUILD)return true;
    showMultiplayer({title:'Update required',message:'A newer Gay Chess build is available. Reload before creating or joining a peer-to-peer game.',action:{label:'Reload latest version',run:()=>{
      const reload=new URL(location.href);reload.searchParams.set('build',latest.appBuild);location.replace(reload.href);
    }},note:'Online games require matching application, rules, and engine builds.'});
    return false;
  }catch{return true}
}

function showMultiplayer({title,message,link=null,answer=false,action=null,note=''}){
  $('#multiplayerTitle').textContent=title;$('#multiplayerMessage').textContent=message;$('#multiplayerNote').textContent=note;
  $('#shareBox').hidden=!link;$('#shareLink').value=link||'';$('#answerBox').hidden=!answer;
  const button=$('#multiplayerAction');button.hidden=!action;button.textContent=action?.label||'';button.onclick=action?.run||null;
  if(!multiplayerDialog.open)multiplayerDialog.showModal();
}

function showConnectionDetails(){
  if(!online){beginHost();return}
  if(online.role==='host'&&online.offerLink)
    showMultiplayer({title:online.connected?'Friend connected':'Invite a friend',message:online.connected?'This game is connected directly to your friend.':'Send the invitation and paste the returned answer below.',link:online.offerLink,answer:!online.connected});
  else if(online.role==='guest'&&online.answerLink)
    showMultiplayer({title:online.connected?'Friend connected':'Send the answer back',message:online.connected?'This game is connected directly to your friend.':'White needs this return link before the game can begin.',link:online.answerLink});
  else showMultiplayer({title:'Peer-to-peer game',message:'Preparing connection details…'});
}

async function copyText(value){
  await navigator.clipboard.writeText(value);showToast('Link copied');
}

function showToast(message){
  const toast=$('#toast');toast.textContent=message;toast.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),1800);
}

$('#newGame').onclick=startComputer;
$('#playFriend').onclick=showConnectionDetails;
undo.onclick=async()=>{
  if(mode!=='computer'||!snapshots.length||thinking||loading)return;
  const epoch=++gameEpoch;history=snapshots.pop();selected=null;legalUcis=[];loading=true;engineError=null;render();
  try{await refreshState(epoch)}catch(error){handleEngineFailure(error,epoch)}
};
level.onchange=render;
$('#rulesButton').onclick=()=>$('#rulesDialog').showModal();
$('#closeRules').onclick=$('#playButton').onclick=()=>$('#rulesDialog').close();
$('#closeMultiplayer').onclick=()=>multiplayerDialog.close();
$('#closeGameOver').onclick=()=>gameOverDialog.close();
$('#playAgain').onclick=startComputer;
$('#copyShareLink').onclick=()=>copyText($('#shareLink').value);
$('#applyAnswer').onclick=async()=>{
  try{await applyAnswerPayload(signalFromUrl($('#answerLink').value,location.href))}
  catch(error){showToast(error.message)}
};
$('#copyMoves').onclick=async()=>{
  const text=history.map((move,index)=>`${index%2===0?`${index/2+1}. `:''}${move}`).join(' ');
  await navigator.clipboard.writeText(text);$('#copyMoves').textContent='Copied!';setTimeout(()=>$('#copyMoves').textContent='Copy',1200);
};

signalBus?.addEventListener('message',event=>{
  if(event.data?.type==='answer')applyAnswerPayload(event.data.payload).catch(error=>showToast(error.message));
});

async function boot(){
  let incoming=null,incomingError=null;
  if(location.hash.startsWith('#gc=')){
    try{incoming=signalFromUrl(location.href)}catch(error){incomingError=error}
  }
  if(incoming?.kind==='answer')signalBus?.postMessage({type:'answer',payload:incoming});
  await startComputer();
  if(incomingError){showMultiplayer({title:'Invalid connection link',message:incomingError.message});return}
  if(incoming?.kind==='offer'){
    if(!compatible(incoming)){showVersionMismatch();return}
    showMultiplayer({title:'Gay Chess invitation',message:'Your friend invited you to play as Black. Both browsers will validate every move with the same Fairy-Stockfish build.',action:{label:'Join as Black',run:()=>joinOffer(incoming)},note:'This uses a direct encrypted WebRTC connection with STUN and no game server.'});
  }else if(incoming?.kind==='answer'){
    showMultiplayer({title:'Answer delivered',message:'Return to the original Gay Chess tab that created the invitation. It will connect automatically.',note:'If that tab does not react, copy this URL and paste it into the answer field there.'});
  }
}

boot();
