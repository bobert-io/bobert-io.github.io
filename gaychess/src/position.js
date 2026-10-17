export const FILES='abcdefgh';
export const START_FEN='rnbkkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBKKBNR w KQDEkqde - 0 1';
export const PIECE_ASSET_ROOT=new URL('../assets/pieces/',import.meta.url).href.replace(/\/$/,'');

export function pieceImage(color,type){return `${PIECE_ASSET_ROOT}/${color}${type.toUpperCase()}.svg`}

export function parseFen(fen){
  const [placement,turn,castling,enPassant,halfmove='0',fullmove='1']=fen.trim().split(/\s+/);
  const board=placement.split('/').map(row=>{
    const squares=[];
    for(const token of row){
      if(/\d/.test(token))squares.push(...Array(Number(token)).fill(null));
      else squares.push({color:token===token.toUpperCase()?'w':'b',type:token.toLowerCase()});
    }
    return squares;
  });
  if(board.length!==8||board.some(row=>row.length!==8))throw new Error(`Invalid engine FEN: ${fen}`);
  return {fen,board,turn,castling,enPassant,halfmove:Number(halfmove),fullmove:Number(fullmove)};
}

export function squareName(r,c){return `${FILES[c]}${8-r}`}

export function squareCoords(square){
  const c=FILES.indexOf(square[0]),r=8-Number(square[1]);
  return r>=0&&r<8&&c>=0?[r,c]:null;
}

export function uciParts(uci){
  if(!/^[a-h][1-8][a-h][1-8][a-z]?$/.test(uci||''))return null;
  return {uci,from:squareCoords(uci.slice(0,2)),to:squareCoords(uci.slice(2,4)),promotion:uci[4]||null};
}

export function kingCount(position,color){
  return position.board.flat().filter(piece=>piece?.color===color&&piece.type==='k').length;
}
