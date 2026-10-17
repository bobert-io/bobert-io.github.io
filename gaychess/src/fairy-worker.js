/* global Stockfish */
// Persistent Fairy-Stockfish worker. The C++ engine owns every chess rule and
// returns complete position state; this file only queues and parses commands.
const VERSION='gaychess-6';
const BASE=new URL('../engine/wasm/',self.location.href).href;
const ASSET_ID='04ac509-7a6505d6';
const ENGINE_LOADER=`${BASE}stockfish.${ASSET_ID}.js`;
const ENGINE_FILES={
  'stockfish.wasm':`stockfish.${ASSET_ID}.wasm`,
  'stockfish.worker.js':`stockfish.${ASSET_ID}.worker.js`,
};
const VARIANT_CONFIG=`[gaychess:chess]
king = -
commoner = k
startFen = rnbkkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBKKBNR w KQDEkqde - 0 1
promotionPieceTypes = nbr
castling = true
castlingKingPiece = k
castlingKingKingsideFile = e
castlingKingQueensideFile = d
fourWayCastling = true
castlingKingAltKingsideFile = f
castlingKingAltQueensideFile = c
castlingKingsideFile = g
castlingQueensideFile = b
extinctionPieceTypes = k
extinctionPieceCount = 0
extinctionValue = loss
extinctionPseudoRoyal = true
dupleCheck = true
maxPseudoRoyalSafety = true
nMoveRule = 50
nFoldRule = 3
stalemateValue = draw
`;

let engine=null,loading=null,ready=false,active=null;
const queue=[];

function send(command){engine.postMessage(command)}
function respond(request,payload){self.postMessage({id:request.id,...payload,engine:'fairy',version:VERSION,assetId:ASSET_ID})}
function positionCommand(moves){return `position startpos${moves.length?` moves ${moves.join(' ')}`:''}`}

function fail(error){
  const message=error instanceof Error?error.message:String(error);
  if(active)respond(active,{error:message});
  while(queue.length)respond(queue.shift(),{error:message});
  active=null;
}

function pump(){
  if(!ready||active||!queue.length)return;
  active=queue.shift();
  const moves=Array.isArray(active.moves)?active.moves:[];
  send(positionCommand(moves));
  if(active.action==='state')send('positioninfo');
  else if(active.action==='best')send(`go movetime ${active.movetime}`);
  else {respond(active,{error:`Unknown engine action: ${active.action}`});active=null;pump()}
}

function onLine(raw){
  const line=(typeof raw==='string'?raw:(raw?.data||String(raw))).trim();
  if(line==='uciok'){
    send('setoption name UCI_Variant value gaychess');
    send('setoption name Use NNUE value false');
    send('setoption name Hash value 64');
    send('isready');return;
  }
  if(line==='readyok'){ready=true;pump();return}
  if(active?.action==='state'&&line.startsWith('positioninfo\t')){
    const [,status,fen,moves='']=line.split('\t');
    const request=active;active=null;
    respond(request,{status,fen,moves:moves?moves.split(' '):[]});pump();return;
  }
  if(active?.action==='best'&&line.startsWith('bestmove ')){
    const value=line.split(/\s+/)[1];
    const request=active;active=null;
    respond(request,{uci:value&&value!=='(none)'?value:null});pump();
  }
}

async function initialize(){
  if(loading)return loading;
  loading=(async()=>{
    importScripts(ENGINE_LOADER);
    engine=await Stockfish({
      // Emscripten 2.0.26 cannot infer this inside a worker. Without an
      // explicit string Firefox passes undefined to URL.createObjectURL when
      // starting the pthread worker.
      mainScriptUrlOrBlob:ENGINE_LOADER,
      locateFile:file=>`${BASE}${ENGINE_FILES[file]||file}`,
      preRun:[module=>module.FS.writeFile('gaychess.ini',VARIANT_CONFIG)]
    });
    if(engine.addMessageListener)engine.addMessageListener(onLine);
    else engine.onmessage=onLine;
    send('load gaychess.ini');send('uci');
  })().catch(error=>{fail(error);throw error});
  return loading;
}

self.onmessage=({data})=>{
  queue.push(data);
  initialize().then(pump).catch(()=>{});
};
